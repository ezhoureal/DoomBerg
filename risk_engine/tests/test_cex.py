"""Cash-and-carry on a centralised exchange (basisd's position) on synthetic market data. No network needed."""

import json

import numpy as np
import pytest

from risk_engine import cex
from risk_engine.discovery import PositionRequest
from risk_engine.engine import RiskEngine, position_key, request_from
from risk_engine.exit_cost import exit_cost
from risk_engine.failures import applicable_modes
from risk_engine.graph import DependencyGraph, Edge, Node
from risk_engine.propagation import Simulator
from risk_engine.signals import alert_levels, data_issues, detect

PX = 100_000.0


def book(mid: float, depth: float = 5.0, step: float = 1.0):
    return {"bids": [(mid - step * (i + 0.5), depth) for i in range(50)],
            "asks": [(mid + step * (i + 0.5), depth) for i in range(50)]}


def market(apr7: float = 0.08, rate_now: float = 0.0001, mark: float = PX) -> dict:
    per = apr7 * 7 / 365 / 21  # 21 settlements over 7 days at 8h
    return {"spot_book": book(PX), "perp_book": book(mark), "mark": mark, "index": PX, "funding_rate_now": rate_now,
            "next_funding_ms": 0, "funding": [(i, per) for i in range(21)], "interval_h": 8.0, "fetched_ms": 1_800_000_000_000,
            "refs": {k: "test" for k in ("spot_book", "perp_book", "premium", "funding")}}


def position(qty: float = 0.01, leverage: float = 1.0, liq: float | None = None, mode: str = "testnet") -> dict:
    return {"venue": "binance", "symbol": "BTC/USDT:USDT", "spot": "BTC/USDT", "base": "BTC", "qty": qty, "spot_qty": qty,
            "opened_ms": 1_790_000_000_000, "spot_entry": PX, "perp_entry": PX * 1.0005, "entry_apr": 0.06, "fees": 1.5,
            "funding": 0.4, "settlements": 6, "mode": mode,
            "risk": {"qty": qty, "leverage": leverage, "mark": PX, **({"liquidation_price": liq} if liq else {})}}


def build(info: dict | None = None, md: dict | None = None) -> DependencyGraph:
    g = DependencyGraph()
    g.root = "position"
    pos = g.add_node(Node("position", "position", "pos", attrs={"kind": "cex_basis"}))
    g.add_node(Node("usdt", "asset", "USDT", attrs={"kind": "fiat_stable", "price_usd": 1.0}, risk_factors={"price_deviation": 0.0}))
    g.add_node(Node("tether", "issuer", "Tether", risk_factors={"issuer_tier": "large"}))
    g.add_edge(Edge("usdt", "tether", "issued_by"))
    cex.build(g, pos, info or position(), md or market(), "usdt", lambda u, v, t, ev=None: g.add_edge(Edge(u, v, t)))
    return g


def ids(g):
    p = cex.parts(g)
    assert all(p.values()), p
    return p


def loss(g, node, mode, sev, n=2000, seed=3):
    return Simulator(g, seed=seed).run(node, mode, n=n, fixed_severity=sev).loss["position"]


def test_capital_is_notional_plus_margin():
    a = build(position(qty=0.01, leverage=2)).nodes["position"].attrs
    assert a["notional_usd"] == pytest.approx(1000, rel=1e-3)
    assert a["margin_usd"] == pytest.approx(500, rel=1e-3)
    assert a["capital_usd"] == pytest.approx(1500, rel=1e-3)
    # Without the venue's liquidation price: isolated at 2x, liquidation 50% above the mark less maintenance margin.
    assert a["rise_to_liquidation"] == pytest.approx(0.5 - 0.004)


def test_modes_follow_the_cex_dependencies():
    g = build()
    p = ids(g)
    assert applicable_modes(g.nodes[p["spot"]].type, g.nodes[p["spot"]].attrs) == []  # its price moves are hedged
    assert [m.id for m in applicable_modes("oracle", g.nodes[p["mark"]].attrs)] == ["oracle_wrong_price"]
    assert [m.id for m in applicable_modes("exchange", {})] == ["venue_failure"]
    assert {m.id for m in applicable_modes("perp", {})} == {"funding_flip", "auto_deleverage"}


def test_venue_failure_takes_its_share_of_everything():
    g = build()
    assert loss(g, ids(g)["exchange"], "venue_failure", 0.4).mean() == pytest.approx(0.4, abs=0.04)


def test_usdt_margined_short_is_a_usdt_long_on_the_whole_capital():
    # A 5% USDT depeg costs 5% of the capital, not just of the margin.
    g = build()
    assert loss(g, "usdt", "depeg", 0.05).mean() == pytest.approx(0.05, abs=0.01)
    # It also reaches the USDT issuer: the default of Tether flows through USDT into the position.
    assert loss(g, "tether", "issuer_default", 0.2).mean() > 0.15


def test_mark_wick_liquidates_a_levered_short_and_loses_the_margin():
    # 3x: liquidation ~33% above the mark. A 40% over-pricing of the mark closes the short; the spot did not move.
    g = build(position(leverage=3))
    res = Simulator(g, seed=5).run(ids(g)["mark"], "oracle_wrong_price", n=4000, fixed_severity=0.4)
    lo = res.loss["position"]
    m_frac = g.nodes["position"].attrs["m_frac"]
    assert lo.mean() == pytest.approx(m_frac, abs=0.03)
    # At 1x the same wick does not reach the liquidation price.
    g1 = build(position(leverage=1))
    assert Simulator(g1, seed=5).run(ids(g1)["mark"], "oracle_wrong_price", n=4000, fixed_severity=0.4).loss["position"].mean() < 1e-6


def test_venue_liquidation_price_overrides_leverage():
    g = build(position(leverage=2, liq=PX * 1.8))
    assert g.nodes["position"].attrs["rise_to_liquidation"] == pytest.approx(0.8)
    assert g.nodes["position"].attrs["liquidation_source"] == "venue"


def test_perp_losses_are_a_share_of_notional():
    g = build(position(leverage=1))
    n_frac = g.nodes["position"].attrs["n_frac"]
    assert loss(g, ids(g)["perp"], "auto_deleverage", 0.04).mean() == pytest.approx(0.04 * n_frac, abs=0.005)


def test_health_prices_liquidation_by_ordinary_rallies():
    h = cex.health(build(position(leverage=3)), 30)
    assert h["structure"] == "cash_and_carry" and h["environment"] == "testnet"
    assert 0 < h["p_liquidation"] < 0.2
    # An ordinary rally to the liquidation price: the spot gain covers the margin except the maintenance margin and fees.
    assert h["penalty_if_liquidated_pct"] < 0.01
    assert h["carry_apy"] == pytest.approx(0.08 * h["notional_usd"] / h["capital_usd"], rel=1e-6)
    assert cex.rise_probability(0.0, 0.5, 30) == 1.0
    assert cex.rise_probability(1.0, 0.55, 30) < 1e-4


def test_exit_sells_both_legs_on_the_book_and_withdraws():
    g = build()
    ex = exit_cost(g, g.nodes["position"].attrs["capital_usd"], np.random.default_rng(0), stressed=False)
    steps = [s["step"] for s in ex["steps"]]
    assert steps[0].startswith("Sell") and steps[1].startswith("Buy back") and "Withdraw" in steps[2]
    assert ex["instant_fraction"] == 1.0
    # Fees alone: 0.10% spot + 0.05% perp on half the capital each.
    assert ex["cost_pct"] > 0.00075
    assert any("mainnet order books" in a for a in ex["assumptions"])
    stressed = exit_cost(g, g.nodes["position"].attrs["capital_usd"], np.random.default_rng(0), stressed=True)
    assert stressed["cost_pct"] >= ex["cost_pct"]


def test_thin_book_is_charged_for_what_it_cannot_fill():
    imp, filled = cex.walk([(100.0, 1.0)], 4.0, 100.0)
    assert filled == pytest.approx(0.25)
    assert cex.walk([(101.0, 10.0)], 1.0, 100.0)[0] == pytest.approx(0.01)


def test_negative_funding_raises_an_alert_on_the_perp():
    g = build(md=market(apr7=-0.05, rate_now=-0.0002))
    levels = alert_levels(detect(g, 0.0))
    lv = levels[(ids(g)["perp"], "funding_flip")]
    assert lv["level"] == "alert"
    assert not data_issues(g)
    calm = alert_levels(detect(build(), 0.0))
    assert (ids(build())["perp"], "funding_flip") not in calm


def test_engine_screens_the_position_end_to_end():
    g = build()
    req = PositionRequest("cex_basis", "binance:BTC/USDT:USDT", 0, g.nodes["position"].attrs["capital_usd"], 1e6)
    out = RiskEngine().evaluate(g, req, 30)
    assert out["hedge"]["venue"] == "Binance" and out["leverage"] is None
    assert out["monitor"]["verdict"] in ("STAY", "EXIT")
    assert out["monitor"]["yield_pct"] > 0
    top = {r["mode"] for r in out["screening"]["top"]}
    assert {"venue_failure", "funding_flip", "depeg"} <= top


def test_position_key_ignores_size_and_names_the_trader(tmp_path):
    a = PositionRequest("cex_basis", "binance:BTC/USDT:USDT", 0, 1000, state_path="/opt/basisd/data/trader-testnet")
    b = PositionRequest("cex_basis", "binance:BTC/USDT:USDT", 0, 2000, state_path="/opt/basisd/data/trader-testnet/positions.json")
    paper = PositionRequest("cex_basis", "binance:BTC/USDT:USDT", 0, 1000, state_path="/opt/basisd/data/trader")
    assert position_key(a, 30) == position_key(b, 30) != position_key(paper, 30)
    req = request_from({"kind": "cex_basis", "address": "binance:BTC/USDT:USDT", "state_path": "x/trader-testnet"})
    assert req.chain_id == 0 and req.state_path == "x/trader-testnet"


def test_load_basisd_reads_the_open_position_and_its_signal(tmp_path):
    d = tmp_path / "trader-testnet"
    d.mkdir()
    (d / "positions.json").write_text(json.dumps({"open": [position()], "closed": []}))
    (d / "signals.json").write_text(json.dumps({"updated_ms": 1, "config": {"exit_apr": 0.0},
                                                "signals": [{"venue": "binance", "symbol": "BTC/USDT:USDT", "apr": 0.07}]}))
    info = cex.load_basisd(str(d), "binance", "BTC/USDT:USDT")
    assert info["qty"] == 0.01 and info["signal"]["apr"] == 0.07 and info["config"]["exit_apr"] == 0.0
    with pytest.raises(ValueError, match="No open binance ETH"):
        cex.load_basisd(str(d / "positions.json"), "binance", "ETH/USDT:USDT")
    with pytest.raises(ValueError, match="No basisd state"):
        cex.load_basisd(str(tmp_path / "missing"), "binance", "BTC/USDT:USDT")


def test_only_wired_venues_are_accepted():
    assert cex.parse_address("binance:BTC/USDT:USDT") == ("binance", "BTC/USDT:USDT")
    with pytest.raises(ValueError, match="only binance"):
        cex.parse_address("okx:BTC/USDT:USDT")
    with pytest.raises(ValueError, match="linear perp"):
        cex.parse_address("binance:BTCUSDT")
