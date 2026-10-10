"""Offline tests on a synthetic graph: no network needed."""

import numpy as np

from risk_engine.decision import decide
from risk_engine.graph import DependencyGraph, Edge, Node
from risk_engine.probability import failure_probability
from risk_engine.propagation import Simulator


def build(tracks: bool = True, util: float = 0.9, lltv: float = 0.86, weight: float = 1.0) -> DependencyGraph:
    g = DependencyGraph()
    for n in [
        Node("position", "position", "pos"),
        Node("vault", "vault", "vault", attrs={"liquidity_usd": 2e6, "net_apy": 0.05}),
        Node("market", "market", "coll/usdc", attrs={"lltv": lltv, "utilization": util}),
        Node("coll", "asset", "COLL", attrs={"kind": "synthetic_stable"}),
        Node("usdc", "asset", "USDC", attrs={"kind": "fiat_stable"}),
        Node("oracle", "oracle", "oracle", risk_factors={"tracks_market": tracks}),
        Node("proto", "protocol", "Morpho Blue", risk_factors={"immutable_core": True}),
        Node("chain", "chain", "Ethereum", attrs={"chain_class": "ethereum"}, risk_factors={"chain_class": "ethereum"}),
    ]:
        g.add_node(n)
    g.root = "position"
    for u, v, t, w in [
        ("position", "vault", "deposits_in", 1), ("vault", "market", "allocates_to", weight), ("vault", "usdc", "denominated_in", 1),
        ("market", "coll", "collateral_in", 1), ("market", "oracle", "priced_by", 1), ("market", "usdc", "lends", 1),
        ("market", "proto", "runs_on", 1), ("vault", "proto", "runs_on", 1), ("proto", "chain", "settles_on", 1),
    ]:
        g.add_edge(Edge(u, v, t, weight=w))
    return g


def test_brief_examples():
    """README section 9: 30% x 50% = $150k > $110k -> EXIT; 10% x 40% = $40k < $110k -> STAY."""
    size = 1_000_000
    d1 = decide(size, 10 * size, np.full(1000, 0.30), np.full(1000, 0.50), 0.11, None, 1.0)
    assert d1["verdict"] == "EXIT" and round(d1["expected_loss_usd"]) == 150_000
    d2 = decide(size, 10 * size, np.full(1000, 0.10), np.full(1000, 0.40), 0.11, None, 1.0)
    assert d2["verdict"] == "STAY" and round(d2["expected_loss_usd"]) == 40_000
    assert abs(d1["break_even_probability"] - 0.22) < 1e-9


def test_break_even_table_matches_readme():
    d = decide(1e6, 1e7, np.full(10, 0.1), np.full(10, 0.5), 0.11, None, 1.0)
    table = {row["loss_if_fails"]: row["exit_above"] for row in d["break_even_table"]}
    assert abs(table[1.0] - 0.11) < 1e-9 and abs(table[0.5] - 0.22) < 1e-9 and abs(table[0.25] - 0.44) < 1e-9
    assert table[0.10] is None


def test_small_depeg_inside_lltv_buffer_causes_no_lender_loss():
    sim = Simulator(build(tracks=True), seed=1).run("coll", "depeg", n=2000, fixed_severity=0.03)
    assert sim.loss["market"].mean() < 0.005


def test_blind_oracle_turns_depeg_into_bad_debt():
    seen = Simulator(build(tracks=True), seed=1).run("coll", "depeg", n=4000, fixed_severity=0.4).loss["position"].mean()
    blind = Simulator(build(tracks=False), seed=1).run("coll", "depeg", n=4000, fixed_severity=0.4).loss["position"].mean()
    assert blind > seen > 0


def test_oracle_overpricing_drains_idle_liquidity_only():
    # Over-borrowing pays only once LLTV x (1 + error) > 1, i.e. error > 16% at LLTV 86%.
    small = Simulator(build(util=0.5), seed=2).run("oracle", "oracle_wrong_price", n=4000, fixed_severity=0.10).loss["market"]
    big = Simulator(build(util=0.5), seed=2).run("oracle", "oracle_wrong_price", n=4000, fixed_severity=1.0).loss["market"]
    assert small.mean() < 0.01
    assert 0.1 < big.mean() and big.max() <= 0.5 + 1e-9  # never more than the idle 50% of supply


def test_vault_loss_scales_with_allocation_weight():
    full = Simulator(build(weight=1.0), seed=3).run("coll", "unbacked_mint", n=3000).loss["vault"].mean()
    tenth = Simulator(build(weight=0.1), seed=3).run("coll", "unbacked_mint", n=3000).loss["vault"].mean()
    assert abs(tenth - 0.1 * full) < 0.02


def test_loan_asset_depeg_passes_straight_through():
    sim = Simulator(build(), seed=4).run("usdc", "depeg", n=3000, fixed_severity=0.12)
    assert abs(sim.loss["position"].mean() - 0.12) < 0.02


def test_alert_raises_probability():
    node = Node("coll", "asset", "COLL", attrs={"kind": "synthetic_stable"})
    rng = np.random.default_rng(0)
    base = failure_probability(node, "depeg", 30, rng, alert="none")["p"]
    alert = failure_probability(node, "depeg", 30, rng, alert="alert")["p"]
    confirmed = failure_probability(node, "depeg", 30, rng, alert="confirmed")["p"]
    assert base < alert < confirmed
