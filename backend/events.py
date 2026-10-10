"""Catalogue of simulated risk events.

An event is a set of observations: node metric changes, exit-liquidity changes and,
for signals no metric captures (an exploit report, a chain halt), an explicit
incident. Metric changes go through `detect.py` exactly as live readings will.
"""

EVENTS = {
    "usde-depeg": {
        "title": "USDe depeg",
        "description": "Ethena funding turns sharply negative and USDe slides to 0.955 on Curve. "
                       "PT-sUSDe sells off, which hits the looped position and every Morpho market "
                       "using it as collateral.",
        "metrics": {
            "asset-usde": {"pegDeviationPct": -4.5, "fundingRateApr": -18},
            "asset-pt-susde": {"pegDeviationPct": -6.0},
            "oracle-pt-susde": {"deviationPct": 5.5},
        },
        "exits": {"pos-pt-susde-loop": {"slippageBps": 420, "availableLiquidityUsd": 18_000_000}},
    },
    "btc-oracle-stale": {
        "title": "BTC/USD oracle stale",
        "description": "The Chainlink BTC/USD feed misses four heartbeats while BTC moves 3%. "
                       "The Morpho WBTC/USDC market keeps lending against the old price.",
        "metrics": {"oracle-chainlink-btc": {"stalenessSec": 14_400, "deviationPct": 3.0}},
    },
    "kamino-usdc-run": {
        "title": "Kamino USDC bank run",
        "description": "Large withdrawals push Kamino's USDC reserve to 99.7% utilisation. "
                       "Lenders can only get out as borrowers repay.",
        "metrics": {"mkt-kamino-usdc": {"utilization": 0.997}},
        "exits": {"pos-kamino-usdc": {"availableLiquidityUsd": 3_000_000, "timeToExitHours": 48}},
    },
    "drift-exploit": {
        "title": "Drift exploit report",
        "description": "Security researchers report an active exploit draining Drift insurance "
                       "and vault accounts. Withdrawals are paused pending investigation.",
        "incidents": [{
            "nodeId": "proto-drift", "kind": "exploit", "severity": "critical",
            "title": "Active exploit reported on Drift",
            "pFail": 0.5, "lossGivenFailure": 0.6, "source": "simulated exploit report",
        }],
        "exits": {"pos-drift-basis": {"availableLiquidityUsd": 0, "timeToExitHours": 168}},
    },
    "solana-outage": {
        "title": "Solana halt",
        "description": "Solana stops producing blocks. Funds are not lost, but nothing can be "
                       "withdrawn, liquidated or hedged until validators restart.",
        "metrics": {"chain-solana": {"outages12m": 1}},
        "incidents": [{
            "nodeId": "chain-solana", "kind": "outage", "severity": "high",
            "title": "Solana block production halted",
            # Chance the halt turns into losses (unmanaged hedges, liquidations at restart).
            "pFail": 0.15, "lossGivenFailure": 0.15, "source": "simulated chain monitor",
        }],
        "exits": {p: {"availableLiquidityUsd": 0, "timeToExitHours": 12}
                  for p in ("pos-kamino-usdc", "pos-jlp", "pos-drift-basis", "pos-jitosol")},
    },
}


def catalogue():
    return [{"id": k, "title": e["title"], "description": e["description"]} for k, e in EVENTS.items()]


def apply_event(snapshot, event_id, detected_at):
    """Mutate `snapshot` in place with the event's observations."""
    event = EVENTS[event_id]
    nodes = {n["id"]: n for n in snapshot["nodes"]}
    positions = {p["id"]: p for p in snapshot["positions"]}
    for node_id, metrics in event.get("metrics", {}).items():
        nodes[node_id].setdefault("metrics", {}).update(metrics)
    for pos_id, exit_patch in event.get("exits", {}).items():
        positions[pos_id]["exit"].update(exit_patch)
    for i, inc in enumerate(event.get("incidents", [])):
        snapshot["incidents"].append({
            "id": "evt-%s-%d" % (event_id, i), "status": "active", "detectedAt": detected_at,
            "description": event["description"], **inc,
        })
