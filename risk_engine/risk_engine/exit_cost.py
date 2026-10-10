"""Stage 3 - Price the exit at the real position size, now and under stress.

Exit plan:
  - Held PT: sell it, priced with a live KyberSwap quote at size (or a constant-product estimate on
    its Pendle AMM), widened by a stress multiplier because liquidity providers pull out during incidents.
  - Market supply: withdraw, limited by instant liquidity; during an incident other lenders race for
    the same liquidity (run share r ~ Beta). If the loan asset itself is damaged it must also be sold.
    Forgone supply yield while the capital is redeployed.
"""

from __future__ import annotations

import numpy as np

from .graph import DependencyGraph
from .sources.pricing import swap_quote

GAS_USD = 40.0


def _amm_impact(size: float, depth: float) -> float:
    """Constant-product price impact for selling ``size`` into a pool of total depth ``depth``."""
    if depth <= 0:
        return 0.5
    half = depth / 2
    return size / (half + size)


def quote_asset_sale(g: DependencyGraph, asset_id: str, size: float) -> dict:
    a = g.nodes[asset_id]
    price = a.attrs.get("price_usd")
    if a.address and price:
        q = swap_quote(a.address, int(a.attrs.get("decimals") or 18), size, price, a.chain_id or 1)
        if q:
            out = "USDT" if a.label.upper() == "USDC" else "USDC"
            return {"impact": q["price_impact"], "source": "kyberswap",
                    "detail": f"Live KyberSwap route: sell ${size:,.0f} of {a.label} -> ${q['amount_out_usd']:,.0f} {out} "
                              f"({q['price_impact']:.2%} impact, gas ${q['gas_usd']:.2f})"}
    for e in g.out_edges(asset_id):
        if e.type == "traded_on":
            liq = g.nodes[e.target].attrs.get("liquidity_usd") or 0
            imp = _amm_impact(size, liq)
            return {"impact": imp, "source": "pendle-api",
                    "detail": f"Constant-product estimate on {g.nodes[e.target].label} (liquidity ${liq:,.0f}): {imp:.2%}"}
    return {"impact": 0.05, "source": "assumption",
            "detail": f"No route found for {a.label}; assumed 5% exit cost (unknown liquidity)"}


def exit_cost(g: DependencyGraph, size: float, rng: np.random.Generator, stressed: bool,
              sell_asset_id: str | None = None, redeploy_days: float = 7.0, n: int = 4000) -> dict:
    target = next(g.nodes[e.target] for e in g.out_edges(g.root) if e.type in ("holds", "deposits_in"))
    steps, assumptions = [], []
    instant_frac = np.ones(n)
    cost = np.zeros(n)
    apy = 0.0

    if target.type == "market":
        liq = target.attrs.get("liquidity_usd") or 0.0
        apy = target.attrs.get("supply_apy") or 0.0
        if stressed:
            run = rng.beta(2.0, 2.5, n)  # share of the instant liquidity taken by faster lenders
            assumptions.append("During an incident other lenders take 0-100% (mean ~45%) of instant liquidity first")
        else:
            run = np.zeros(n)
        instant_frac = np.clip(liq * (1 - run) / size, 0, 1)
        steps.append({"step": f"Withdraw from {target.label}", "source": "morpho-api",
                      "detail": f"Instant liquidity ${liq:,.0f} vs position ${size:,.0f} -> "
                                f"{min(1, liq / size):.0%} withdrawable now (calm), {float(instant_frac.mean()):.0%} expected under stress",
                      "cost_pct": GAS_USD / size})
        cost += GAS_USD / size
    else:
        sell_asset_id = target.id

    if sell_asset_id:
        q = quote_asset_sale(g, sell_asset_id, size)
        mult = rng.lognormal(np.log(2.0), 0.5, n) if stressed else np.ones(n)
        impact = np.clip(q["impact"] * mult, 0, 0.95)
        cost += impact
        steps.append({"step": f"Sell {g.nodes[sell_asset_id].label}", "source": q["source"], "detail": q["detail"],
                      "cost_pct": float(impact.mean())})
        if stressed:
            assumptions.append("DEX price impact widens x2 on average (lognormal) as liquidity providers withdraw during incidents")

    if apy:
        carry = apy * redeploy_days / 365
        cost += carry
        steps.append({"step": "Forgone yield while redeploying", "source": "morpho-api",
                      "detail": f"{apy:.2%} APY x {redeploy_days:g} days", "cost_pct": carry})

    return {
        "cost_pct": float(cost.mean()),
        "cost_pct_ci": [float(np.quantile(cost, 0.05)), float(np.quantile(cost, 0.95))],
        "cost_usd": float(cost.mean() * size),
        "instant_fraction": float(instant_frac.mean()),
        "instant_fraction_calm": float(min(1.0, (target.attrs.get("liquidity_usd") or 0) / size)) if target.type == "market" else 1.0,
        "stressed": stressed,
        "steps": steps,
        "assumptions": assumptions,
        "samples": cost,
    }
