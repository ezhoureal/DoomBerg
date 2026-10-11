"""Stage 3 - Price the exit at the real position size, now and under stress.

Exit plan:
  - Held PT: sell it, priced with a live KyberSwap quote at size (else a live quote on its Pendle market,
    with aggregator routing into a distinct USDC/USDT destination), widened by a stress multiplier because liquidity providers pull
    out during incidents. An unconfirmed route receives zero immediate loss-avoidance credit.
    Forgone fixed PT yield while the capital is redeployed.
  - Market supply: withdraw, limited by instant liquidity; during an incident other lenders race for
    the same liquidity (run share r ~ Beta). If the loan asset itself is damaged, what was withdrawn must
    also be sold. Forgone supply yield on the withdrawn part while it is redeployed.
"""

from __future__ import annotations

import numpy as np

from .graph import DependencyGraph
from .sources import pendle
from .sources.pricing import swap_quote, exit_token, output_value_usd, USDC

GAS_USD = 40.0


def _amm_impact(size: float, depth: float) -> float:
    """Constant-product price impact for selling ``size`` into a pool of total depth ``depth``."""
    if depth <= 0:
        return 0.5
    half = depth / 2
    return size / (half + size)


def quote_asset_sale(g: DependencyGraph, asset_id: str, size: float) -> dict:
    a = g.nodes[asset_id]
    # Exiting a PT backed by USDC into USDC does not escape its backing risk.
    # Include transitive backing (e.g. vault -> USDC), not just the PT itself.
    seen, pending, backing_addresses = set(), [asset_id], set()
    while pending:
        nid = pending.pop()
        if nid in seen:
            continue
        seen.add(nid)
        if g.nodes[nid].address:
            backing_addresses.add(g.nodes[nid].address.lower())
        pending.extend(e.target for e in g.out_edges(nid) if e.type == "backed_by")
    token_out = exit_token(a.address or "", a.chain_id or 1, backing_addresses)
    price = a.attrs.get("price_usd")
    if a.address and price and token_out:
        q = swap_quote(a.address, int(a.attrs.get("decimals") or 18), size, price, a.chain_id or 1, token_out=token_out)
        if q:
            out = "USDC" if token_out.lower() == USDC.get(a.chain_id or 1, "").lower() else "USDT"
            return {"impact": q["price_impact"], "source": "kyberswap",
                    "detail": f"Live KyberSwap route: sell ${size:,.0f} of {a.label} -> ${q['amount_out_usd']:,.0f} {out} "
                              f"({q['price_impact']:.2%} impact, gas ${q['gas_usd']:.2f})"}
    for e in g.out_edges(asset_id):
        if e.type != "traded_on":
            continue
        amm = g.nodes[e.target]
        decimals = a.attrs.get("decimals")
        if a.address and amm.address and token_out and price and decimals is not None:
            q = pendle.swap_quote(amm.address, a.address, token_out, int(size / price * 10 ** int(decimals)), a.chain_id or 1)
            if q:
                proceeds = output_value_usd(token_out, q["amount_out"], a.chain_id or 1)
                if proceeds is not None:
                    imp = max(0.0, 1.0 - (proceeds - GAS_USD) / size)
                    return {"impact": imp, "source": "pendle-api",
                            "detail": f"Live Pendle route on {amm.label}: sell ${size:,.0f} of {a.label} into USDC/USDT "
                                      f"worth ${proceeds:,.0f}; fees included in proceeds, gas assumed ${GAS_USD:,.0f} ({imp:.2%} cost)"}
        liq = amm.attrs.get("liquidity_usd")
        if liq is not None:
            imp = _amm_impact(size, liq)
            return {"impact": imp, "source": "assumption", "available": False,
                    "detail": f"Constant-product estimate on {amm.label} (liquidity ${liq:,.0f}): {imp:.2%}. "
                              "No complete route into USDC/USDT was confirmed; this estimate is not an executable exit"}
    return {"impact": 0.05, "source": "assumption", "available": False,
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
        if target.type != "market" and not q.get("available", True):
            instant_frac = np.zeros(n)
            assumptions.append("No complete held-PT exit route into independently priced USDC/USDT could be confirmed; no loss avoidance is credited")
        mult = rng.lognormal(np.log(2.0), 0.5, n) if stressed else np.ones(n)
        impact = np.clip(q["impact"] * mult, 0, 0.95) * instant_frac
        cost += impact
        steps.append({"step": f"{'Sell' if q.get('available', True) else 'Unconfirmed exit for'} {g.nodes[sell_asset_id].label}", "source": q["source"], "detail": q["detail"],
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
        "instant_fraction_calm": float(min(1.0, (target.attrs.get("liquidity_usd") or 0) / size)) if target.type == "market" else float(instant_frac.mean()),
        "stressed": stressed,
        "steps": steps,
        "assumptions": assumptions,
        "samples": cost,
    }
