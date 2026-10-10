"""Stage 3 - Price the exit at the real position size, now and under stress.

Exit plan:
  - Held PT: sell it, priced with the cheaper of a live quote on its Pendle market and a live KyberSwap
    quote at size (else a constant-product estimate), widened by a stress multiplier because liquidity
    providers pull out during incidents. Forgone fixed PT yield while the capital is redeployed.
  - Market supply: withdraw, limited by instant liquidity; during an incident other lenders race for
    the same liquidity (run share r ~ Beta). If the loan asset itself is damaged, what was withdrawn must
    also be sold. Forgone supply yield on the withdrawn part while it is redeployed.
"""

from __future__ import annotations

import numpy as np

from .graph import DependencyGraph
from .sources import pendle
from .sources.pricing import swap_quote

GAS_USD = 40.0
# Above this, a KyberSwap quote is treated as a bad route and a Pendle AMM quote is sought.
IMPLAUSIBLE_IMPACT = 0.20


def _amm_impact(size: float, depth: float) -> float:
    """Constant-product price impact for selling ``size`` into a pool of total depth ``depth``."""
    if depth <= 0:
        return 0.5
    half = depth / 2
    return size / (half + size)


def _kyber_quote(a, size: float, price: float | None) -> dict | None:
    if not (a.address and price):
        return None
    q = swap_quote(a.address, int(a.attrs.get("decimals") or 18), size, price, a.chain_id or 1)
    if not q:
        return None
    out = "USDT" if a.label.upper() == "USDC" else "USDC"
    return {"impact": q["price_impact"], "source": "kyberswap",
            "detail": f"Live KyberSwap route: sell ${size:,.0f} of {a.label} -> ${q['amount_out_usd']:,.0f} {out} "
                      f"({q['price_impact']:.2%} impact, gas ${q['gas_usd']:.2f})"}


def _pendle_quote(a, amm, size: float, price: float | None) -> dict | None:
    under, decimals = amm.attrs.get("underlying"), a.attrs.get("decimals")
    if not (a.address and amm.address and under and price and decimals):
        return None
    q = pendle.swap_quote(amm.address, a.address, under, int(size / price * 10 ** int(decimals)), a.chain_id or 1)
    if not q:
        return None
    imp = q["price_impact"] + q["fee_usd"] / size
    return {"impact": imp, "source": "pendle-api",
            "detail": f"Live Pendle quote on {amm.label}: sell ${size:,.0f} of {a.label} -> "
                      f"{q['price_impact']:.2%} impact + ${q['fee_usd']:,.0f} swap fee ({imp:.2%})"}


def quote_asset_sale(g: DependencyGraph, asset_id: str, size: float) -> dict:
    """Cheapest credible live quote for selling ``size`` USD of the asset.

    Aggregators often route a PT through thin pools and quote 90%+ impact while its own Pendle AMM fills the
    same size for well under 1%, so for a PT (or whenever KyberSwap looks implausible) the Pendle quote is
    also taken and the cheaper of the two kept.
    """
    a = g.nodes[asset_id]
    price = a.attrs.get("price_usd")
    amms = [g.nodes[e.target] for e in g.out_edges(asset_id) if e.type == "traded_on"]
    kyber = _kyber_quote(a, size, price)
    kyber_ok = kyber is not None and kyber["impact"] <= IMPLAUSIBLE_IMPACT

    pendle_q = None
    if a.attrs.get("kind") == "pt" or not kyber_ok:
        pendle_q = next((q for q in (_pendle_quote(a, amm, size, price) for amm in amms) if q), None)

    best = min((q for q in (pendle_q, kyber) if q), key=lambda q: q["impact"], default=None)
    if best is not None and (pendle_q is not None or kyber_ok):
        other = kyber if best is pendle_q else pendle_q
        if other is not None:
            name = "KyberSwap route" if other is kyber else "Pendle AMM quote"
            best = {**best, "detail": f"{best['detail']}. Chose the cheaper quote; the {name} gave {other['impact']:.2%}"}
        return best

    # No credible live quote: estimate on the Pendle AMM's liquidity, unless KyberSwap's (implausible) quote is cheaper.
    for amm in amms:
        liq = amm.attrs.get("liquidity_usd")
        if liq is None:
            continue
        imp = _amm_impact(size, liq)
        if kyber is not None and kyber["impact"] <= imp:
            break
        detail = (f"Constant-product estimate on {amm.label} (liquidity ${liq:,.0f}): {imp:.2%}. "
                  f"Rough upper bound: Pendle concentrates liquidity around the implied rate")
        if kyber is not None:
            detail += f". The KyberSwap route gave {kyber['impact']:.2%}, discarded as implausible"
        return {"impact": imp, "source": "pendle-api", "detail": detail}
    if kyber is not None:
        return kyber
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
        amm = next((g.nodes[e.target] for e in g.out_edges(target.id) if e.type == "traded_on"), None)
        apy = (amm.attrs.get("implied_apy") if amm else None) or 0.0

    # Only what was withdrawn can be sold; impact is a fraction of the amount sold.
    sell_size = size * float(instant_frac.mean())
    if sell_asset_id and sell_size > 0:
        q = quote_asset_sale(g, sell_asset_id, sell_size)
        mult = rng.lognormal(np.log(2.0), 0.5, n) if stressed else np.ones(n)
        impact = np.clip(q["impact"] * mult, 0, 0.95) * instant_frac
        cost += impact
        steps.append({"step": f"Sell {g.nodes[sell_asset_id].label}", "source": q["source"], "detail": q["detail"],
                      "cost_pct": float(impact.mean())})
        if stressed:
            assumptions.append("DEX price impact widens x2 on average (lognormal) as liquidity providers withdraw during incidents")

    if apy:
        carry = apy * redeploy_days / 365 * instant_frac
        cost += carry
        what = "supply APY" if target.type == "market" else "fixed PT yield (implied APY)"
        steps.append({"step": "Forgone yield while redeploying", "source": "morpho-api" if target.type == "market" else "pendle-api",
                      "detail": f"{apy:.2%} {what} x {redeploy_days:g} days on the {float(instant_frac.mean()):.0%} withdrawn",
                      "cost_pct": float(carry.mean())})

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
