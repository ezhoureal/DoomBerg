"""Offline tests for choosing the PT exit quote: KyberSwap and the Pendle SDK are monkeypatched."""

import numpy as np
import pytest

from risk_engine import exit_cost
from risk_engine.graph import DependencyGraph, Edge, Node

SIZE = 1_000_000


def held_pt(kind: str = "pt") -> DependencyGraph:
    g = DependencyGraph()
    g.root = "position"
    for n in [
        Node("position", "position", "pos"),
        Node("pt", "asset", "PT-stETH-30DEC2027", chain_id=1, address="0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
             attrs={"kind": kind, "price_usd": 3000.0, "decimals": 18}),
        Node("amm", "amm", "Pendle market PT-stETH", chain_id=1, address="0x00000000000000000000000000000000000000aa",
             attrs={"underlying": "0x00000000000000000000000000000000000000bb", "liquidity_usd": 50e6, "implied_apy": 0.03}),
    ]:
        g.add_node(n)
    g.add_edge(Edge("position", "pt", "holds"))
    g.add_edge(Edge("pt", "amm", "traded_on"))
    return g


@pytest.fixture
def quotes(monkeypatch):
    """Set ``quotes["kyber"]`` / ``quotes["pendle"]`` to a price impact (or None for no quote)."""
    q = {"kyber": None, "pendle": None, "pendle_calls": 0}

    def kyber(token_in, decimals, amount_usd, price, chain_id, token_out=None):
        if q["kyber"] is None:
            return None
        return {"amount_in_usd": amount_usd, "amount_out_usd": amount_usd * (1 - q["kyber"]), "gas_usd": 0.0,
                "price_impact": q["kyber"], "route_hops": 3}

    def pendle(market, pt, token_out, amount_raw, chain_id):
        q["pendle_calls"] += 1
        return None if q["pendle"] is None else {"price_impact": q["pendle"], "fee_usd": 0.0}

    monkeypatch.setattr(exit_cost, "swap_quote", kyber)
    monkeypatch.setattr(exit_cost.pendle, "swap_quote", pendle)
    return q


def test_pt_uses_pendle_quote_when_kyber_route_is_awful(quotes):
    quotes.update(kyber=0.9854, pendle=0.004)
    q = exit_cost.quote_asset_sale(held_pt(), "pt", SIZE)
    assert q["source"] == "pendle-api" and q["impact"] == pytest.approx(0.004)
    assert "KyberSwap route gave 98.54%" in q["detail"]

    ec = exit_cost.exit_cost(held_pt(), SIZE, np.random.default_rng(0), stressed=False)
    sell = next(s for s in ec["steps"] if s["step"].startswith("Sell"))
    assert sell["source"] == "pendle-api" and ec["cost_pct"] < 0.01


def test_pt_keeps_kyber_when_it_is_cheaper(quotes):
    quotes.update(kyber=0.002, pendle=0.004)
    q = exit_cost.quote_asset_sale(held_pt(), "pt", SIZE)
    assert q["source"] == "kyberswap" and q["impact"] == pytest.approx(0.002)
    assert "Pendle AMM quote gave 0.40%" in q["detail"]


def test_implausible_kyber_without_pendle_quote_falls_back_to_amm_estimate(quotes):
    quotes.update(kyber=0.9854, pendle=None)
    q = exit_cost.quote_asset_sale(held_pt(), "pt", SIZE)
    assert q["source"] == "pendle-api" and q["impact"] == pytest.approx(exit_cost._amm_impact(SIZE, 50e6))
    assert "discarded as implausible" in q["detail"]


def test_non_pt_with_plausible_kyber_skips_pendle(quotes):
    quotes.update(kyber=0.01, pendle=0.004)
    q = exit_cost.quote_asset_sale(held_pt(kind="lst"), "pt", SIZE)
    assert q["source"] == "kyberswap" and quotes["pendle_calls"] == 0
