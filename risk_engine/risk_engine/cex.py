"""Cash-and-carry on a centralised exchange: long spot and short the same amount of a USDT-margined perp.

This is basisd's position (https://github.com/ezhoureal/basisd): it buys spot, shorts the perp and collects
funding. Nothing here is on a chain, so the dependencies are the venue that holds both legs, the stablecoin the
perp is margined in, the mark price that decides liquidation, and the perp itself (funding, auto-deleveraging):

    position --holds_spot--> BTC spot --custodied_at--> exchange
    position --shorts--> perp --listed_on--> exchange
                         perp --marked_by--> mark price
                         perp --margined_in--> USDT --issued_by--> Tether

Everything is a fraction of the capital K = N + M: N the spot notional, M the margin the strategy commits to the
short (N / leverage). Price moves cancel between the legs, so they matter only through liquidation of the short:

- Not liquidated, equity = K (1 - du): a USDT depeg du costs the margin and the short alike (BTC/USDT rises
  while BTC/USD does not), so a USDT-margined short is a USDT long.
- Liquidated, the margin is gone and the spot is unhedged: equity = N (1 + true BTC/USD move). A wick of the mark
  price (the spot does not move) loses the whole margin; an ordinary rally loses only what the spot gain does not
  cover (roughly the maintenance margin).

Then the venue: everything sits on it, so a venue loss dv scales the whole equity by (1 - dv).

Signals and the exit are priced on mainnet public data even for a testnet position: testnet order books are thin
and its prices follow mainnet, so a mainnet quote is what the same position would cost to leave for real.
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np

from .graph import DependencyGraph, Edge, Evidence, Node
from .sources.http import get_json

# Only venues wired up here, as in basisd (execution.TESTNETS): Binance spot + USDⓈ-M perps.
VENUES = {
    "binance": {
        "label": "Binance", "spot_api": "https://api.binance.com", "perp_api": "https://fapi.binance.com",
        # Default taker fees (VIP 0, no BNB discount), overridable per position (``fee_rates`` in an inline position).
        "fees": {"spot_taker": 0.001, "perp_taker": 0.0005},
        # Tier-1 maintenance margin rate on BTCUSDT and ETHUSDT.
        "mmr": 0.004,
        "withdraw_usd": 5.0,
        "tier": "top", "launched": "2017-07-14",
        "note": "Largest exchange by volume; publishes proof of reserves and holds a user protection fund (SAFU)",
        "source": "https://www.binance.com/en/proof-of-reserves",
    },
}
DAY_MS = 86_400_000
TRAILING_DAYS = 7          # basisd's signal window (window_days)
REHEDGE = 0.001            # re-shorting the spot left after a liquidation or ADL: two taker legs
VOL = {"BTC": 0.55, "ETH": 0.70}  # annualised volatility for the liquidation barrier; others default to 0.9


def vol(base: str) -> float:
    return VOL.get(base.upper(), 0.9)


def parse_address(address: str) -> tuple[str, str]:
    """``binance:BTC/USDT:USDT`` -> (venue, ccxt perp symbol)."""
    venue, _, perp = address.strip().partition(":")
    venue = venue.lower()
    if venue not in VENUES:
        raise ValueError(f"Unsupported venue '{venue}'; only {', '.join(VENUES)} is wired up (as in basisd)")
    if "/" not in perp or ":" not in perp:
        raise ValueError(f"'{perp}' is not a ccxt linear perp symbol like BTC/USDT:USDT")
    return venue, perp


def native(symbol: str) -> str:
    """ccxt ``BTC/USDT:USDT`` or ``BTC/USDT`` -> Binance ``BTCUSDT``."""
    return symbol.split(":")[0].replace("/", "")


# ---------------------------------------------------------------------- basisd state
def state_name(state_path: str) -> str:
    """The basisd state directory's name (``trader``, ``trader-testnet``) for a positions.json or its directory."""
    p = Path(state_path.strip()).expanduser()
    return (p.parent if p.name.endswith(".json") else p).name or "state"


def load_basisd(state_path: str, venue: str, perp: str) -> dict:
    """The open basisd position on ``venue`` / ``perp``, from its ``positions.json`` (a file or the state directory).

    ``signals.json`` beside it adds the trader's latest trailing funding APR and its config, when present.
    """
    p = Path(state_path).expanduser()
    pos_file = p / "positions.json" if p.is_dir() else p
    if not pos_file.exists():
        raise ValueError(f"No basisd state at {pos_file}")
    raw = json.loads(pos_file.read_text(encoding="utf-8"))
    pos = next((d for d in raw.get("open", []) if d.get("venue") == venue and d.get("symbol") == perp), None)
    if pos is None:
        have = ", ".join(f"{d.get('venue')} {d.get('symbol')}" for d in raw.get("open", [])) or "none"
        raise ValueError(f"No open {venue} {perp} position in {pos_file} (open: {have})")
    out = {**pos, "state_file": str(pos_file), "state_mtime": pos_file.stat().st_mtime}
    sig_file = pos_file.parent / "signals.json"
    if sig_file.exists():
        s = json.loads(sig_file.read_text(encoding="utf-8"))
        sig = next((x for x in s.get("signals", []) if x.get("venue") == venue and x.get("symbol") == perp), None)
        out["signal"] = sig
        out["config"] = s.get("config")
        out["signals_updated_ms"] = s.get("updated_ms")
    return out


# ---------------------------------------------------------------------- market data
def market_data(venue: str, perp: str, spot: str, now_ms: int | None = None) -> dict:
    """Mainnet order books of both legs, the mark price and the trailing settled funding of the perp."""
    v = VENUES[venue]
    now_ms = now_ms or int(time.time() * 1000)
    ps, ss = native(perp), native(spot)
    spot_book = get_json(f"{v['spot_api']}/api/v3/depth", {"symbol": ss, "limit": 500}, ttl=20)
    perp_book = get_json(f"{v['perp_api']}/fapi/v1/depth", {"symbol": ps, "limit": 500}, ttl=20)
    prem = get_json(f"{v['perp_api']}/fapi/v1/premiumIndex", {"symbol": ps}, ttl=20)
    since = now_ms - TRAILING_DAYS * DAY_MS
    rates = get_json(f"{v['perp_api']}/fapi/v1/fundingRate", {"symbol": ps, "startTime": since, "limit": 1000}, ttl=300)
    interval_h = 8.0
    try:
        info = get_json(f"{v['perp_api']}/fapi/v1/fundingInfo", ttl=3600)
        interval_h = float(next((i["fundingIntervalHours"] for i in info if i.get("symbol") == ps), 8))
    except Exception:  # noqa: BLE001 - symbols missing from fundingInfo use the default 8h interval
        pass
    return {
        "spot_book": {"bids": [(float(p), float(q)) for p, q in spot_book["bids"]],
                      "asks": [(float(p), float(q)) for p, q in spot_book["asks"]]},
        "perp_book": {"bids": [(float(p), float(q)) for p, q in perp_book["bids"]],
                      "asks": [(float(p), float(q)) for p, q in perp_book["asks"]]},
        "mark": float(prem["markPrice"]), "index": float(prem["indexPrice"]),
        "funding_rate_now": float(prem["lastFundingRate"]), "next_funding_ms": int(prem["nextFundingTime"]),
        "funding": [(int(r["fundingTime"]), float(r["fundingRate"])) for r in rates if int(r["fundingTime"]) > since],
        "interval_h": interval_h, "fetched_ms": now_ms,
        "refs": {"spot_book": f"{v['spot_api']}/api/v3/depth?symbol={ss}", "perp_book": f"{v['perp_api']}/fapi/v1/depth?symbol={ps}",
                 "premium": f"{v['perp_api']}/fapi/v1/premiumIndex?symbol={ps}", "funding": f"{v['perp_api']}/fapi/v1/fundingRate?symbol={ps}"},
    }


def mid(book: dict) -> float:
    return (book["bids"][0][0] + book["asks"][0][0]) / 2


def walk(levels: list[tuple[float, float]], qty: float, ref: float) -> tuple[float, float]:
    """(price impact vs ``ref``, share of ``qty`` the book can fill) for taking ``qty`` from ``levels``."""
    left, cost = qty, 0.0
    for px, q in levels:
        take = min(left, q)
        cost += take * px
        left -= take
        if left <= 1e-12:
            break
    filled = qty - max(left, 0.0)
    if filled <= 0:
        return 0.05, 0.0
    return abs(cost / filled / ref - 1.0), filled / qty


# ---------------------------------------------------------------------- graph
def build(g: DependencyGraph, pos: Node, info: dict, md: dict, usdt_id: str, link) -> float:
    """Add the exchange, spot, perp and mark-price nodes to ``g`` and fill the position. Returns the capital K in USD.

    ``info`` is a basisd ``Position`` dict (``load_basisd``), ``md`` the ``market_data``, ``usdt_id`` the node of the
    settlement stablecoin (discovered like any token), ``link(u, v, type, evidence)`` adds an edge.
    """
    venue, perp, spot, base = info["venue"], info["symbol"], info["spot"], info.get("base") or info["spot"].split("/")[0]
    v = VENUES[venue]
    fees = {**v["fees"], **(info.get("fee_rates") or {})}  # basisd's own "fees" is what was paid
    risk = info.get("risk") or {}
    spot_qty = float(info.get("spot_qty") if info.get("spot_qty") is not None else info["qty"])
    perp_qty = float(risk.get("qty") or info["qty"])
    spot_mid, perp_mid = mid(md["spot_book"]), mid(md["perp_book"])
    N = spot_qty * spot_mid
    lev = float(risk.get("leverage") or (info.get("config") or {}).get("leverage") or 1.0)
    M = perp_qty * md["mark"] / lev
    K = N + M
    mark_venue = float(risk.get("mark") or md["mark"])
    liq = risk.get("liquidation_price")
    liq = float(liq) if liq else None
    # The venue's liquidation price reflects the whole futures wallet (cross margin); without it, isolated at `lev`.
    dist = liq / mark_venue - 1.0 if liq else 1.0 / lev - v["mmr"]
    apr7 = sum(r for _, r in md["funding"]) * 365 / TRAILING_DAYS
    rate_now_apr = md["funding_rate_now"] * 24 / md["interval_h"] * 365
    mode = info.get("mode") or "paper"
    t_ms = md["fetched_ms"]
    g.cex_books = {"spot_book": md["spot_book"], "perp_book": md["perp_book"]}

    ex_id = f"exchange:{venue}"
    g.add_node(Node(ex_id, "exchange", v["label"], None, None, attrs={
        "tier": v["tier"], "launched": v["launched"], "note": v["note"], "url": v["source"], "environment": mode,
        "subtitle": "custodies both legs" + (f" · {mode}" if mode != "mainnet" else ""),
    }, risk_factors={"exchange_tier": v["tier"]}, evidence=[
        Evidence("registry", f"{v['label']}: {v['note']}", ref=v["source"]),
        Evidence("basisd", f"Both legs are held on {v['label']} ({mode} account)", ref=info.get("state_file")),
    ]))

    spot_id = f"spot:{venue}:{spot}"
    g.add_node(Node(spot_id, "asset", f"{base} spot", None, None, attrs={
        "kind": "hedged_spot", "role": "hedged_spot", "price_usd": spot_mid, "qty": spot_qty, "notional_usd": N,
        "symbol": spot, "subtitle": f"{spot_qty:g} {base} · hedged",
    }, evidence=[Evidence("basisd", f"Long {spot_qty:g} {base} spot, bought at {info['spot_entry']:,.2f}", ref=info.get("state_file")),
                 Evidence(f"{venue}-api", f"Mainnet spot mid {spot_mid:,.2f}", ref=md["refs"]["spot_book"], fetched_at=t_ms / 1000)]))
    link(pos.id, spot_id, "holds_spot", Evidence("basisd", f"Spot leg: {spot_qty:g} {base} (${N:,.0f})"))
    link(spot_id, ex_id, "custodied_at", Evidence("basisd", f"The {base} sits in the {v['label']} spot wallet, not in self-custody"))

    perp_id = f"perp:{venue}:{perp}"
    g.add_node(Node(perp_id, "perp", f"{native(perp)} perp", None, None, attrs={
        "symbol": perp, "qty": perp_qty, "notional_usd": perp_qty * md["mark"], "mark_price": md["mark"], "index_price": md["index"],
        "perp_mid": perp_mid, "funding_apr_7d": apr7, "funding_rate_now": md["funding_rate_now"], "funding_apr_now": rate_now_apr,
        "funding_interval_h": md["interval_h"], "settlements_7d": len(md["funding"]), "next_funding_ms": md["next_funding_ms"],
        "leverage": lev, "liquidation_price": liq, "margin_ratio": risk.get("margin_ratio"),
        "exit_apr": float((info.get("config") or {}).get("exit_apr", 0.0)),
        "trader_apr": (info.get("signal") or {}).get("apr"),
        "subtitle": f"short {perp_qty:g} · {lev:g}x · funding {apr7:+.1%} APR (7d)",
    }, risk_factors={"leverage": lev}, evidence=[
        Evidence("basisd", f"Short {perp_qty:g} at {info['perp_entry']:,.2f}, leverage {lev:g}x"
                           + (f", liquidation {liq:,.2f} (venue view)" if liq else ""), ref=info.get("state_file")),
        Evidence(f"{venue}-api", f"{len(md['funding'])} settlements over {TRAILING_DAYS}d -> {apr7:+.2%} APR; "
                                 f"predicted {md['funding_rate_now']:+.4%} per {md['interval_h']:g}h", ref=md["refs"]["funding"],
                 fetched_at=t_ms / 1000),
    ]))
    link(pos.id, perp_id, "shorts", Evidence("basisd", f"Hedge leg: short {perp_qty:g} {native(perp)}, collecting funding"))
    link(perp_id, ex_id, "listed_on", Evidence("registry", f"{v['label']} runs the matching, margin and liquidation engine"))

    mark_id = f"mark:{venue}:{perp}"
    gap = md["mark"] / spot_mid - 1.0
    g.add_node(Node(mark_id, "oracle", f"{native(perp)} mark price", None, None, attrs={
        "role": "mark_price", "oracle_type": "exchange mark price", "oracle_price": md["mark"], "market_price": spot_mid,
        "index_price": md["index"], "oracle_dex_gap": gap,
        "subtitle": f"{md['mark']:,.2f} vs spot {spot_mid:,.2f} ({gap:+.2%})",
    }, risk_factors={"tracks_market": True, "composite_index": True}, evidence=[
        Evidence(f"{venue}-api", f"Mark {md['mark']:,.2f}, index {md['index']:,.2f}: the mark (not the last trade) triggers liquidation",
                 ref=md["refs"]["premium"], fetched_at=t_ms / 1000)]))
    link(perp_id, mark_id, "marked_by", Evidence("registry", "Liquidation is decided on the mark price"))
    link(perp_id, usdt_id, "margined_in", Evidence("registry", f"{native(perp)} is margined and settled in USDT"))

    pos.label = info.get("label") or f"{base} cash-and-carry on {v['label']} ({mode})"
    pos.attrs.update({
        "kind": "cex_basis", "venue": venue, "base": base, "environment": mode, "size_usd": K,
        "capital_usd": K, "notional_usd": N, "margin_usd": M, "n_frac": N / K, "m_frac": M / K,
        "leverage": lev, "rise_to_liquidation": dist, "liquidation_source": "venue" if liq else "isolated at leverage",
        "mmr": v["mmr"], "vol": vol(base), "fees": fees, "withdraw_usd": v["withdraw_usd"],
        "spot_qty": spot_qty, "perp_qty": perp_qty, "spot_entry": info["spot_entry"], "perp_entry": info["perp_entry"],
        "spot_mid": spot_mid, "perp_mid": perp_mid, "funding_received_usd": info.get("funding", 0.0),
        "fees_paid_usd": info.get("fees", 0.0), "settlements": info.get("settlements", 0), "opened_ms": info.get("opened_ms"),
        "entry_apr": info.get("entry_apr"), "state_file": info.get("state_file"), "state_mtime": info.get("state_mtime"),
    })
    pos.evidence.append(Evidence("basisd", f"Open {mode} position since "
                                           f"{time.strftime('%Y-%m-%d', time.gmtime((info.get('opened_ms') or 0) / 1000))}: "
                                           f"funding received ${info.get('funding', 0.0):,.2f}, fees ${info.get('fees', 0.0):,.2f}",
                                 ref=info.get("state_file")))
    return K


def parts(g: DependencyGraph) -> dict:
    outs = g.out_edges(g.root)
    pick = lambda es, t: next((e.target for e in es if e.type == t), None)  # noqa: E731
    perp, spot = pick(outs, "shorts"), pick(outs, "holds_spot")
    pouts = g.out_edges(perp) if perp else []
    return {"perp": perp, "spot": spot, "exchange": pick(pouts, "listed_on"), "mark": pick(pouts, "marked_by"),
            "usdt": pick(pouts, "margined_in")}


# ---------------------------------------------------------------------- loss model
def hedge_loss(n_frac: float, m_frac: float, dist: float, n: int, *, dv, du, oerr, dperp) -> np.ndarray:
    """Loss of the capital per draw: venue loss dv, USDT loss du, mark error oerr (+ over-prices), perp-only loss dperp
    (a fraction of the notional: negative funding, or the move while ADL leaves the spot unhedged)."""
    z = np.zeros(n)
    du = np.clip(du + z, 0.0, 0.999)
    # The mark in USDT: the true BTC/USDT (BTC/USD unchanged, so 1 / (1 - du)) times the mark's own error.
    rise = (1.0 + oerr + z) / (1.0 - du) - 1.0
    liquidated = rise >= dist
    equity = np.where(liquidated, n_frac * (1.0 - REHEDGE), (n_frac + m_frac) * (1.0 - du))
    equity = equity - n_frac * (dperp + z)
    equity = equity * (1.0 - (dv + z))
    return np.clip(1.0 - equity, 0.0, 1.0)


def rise_probability(dist: float, sigma: float, horizon_days: float) -> float:
    """P(a driftless lognormal price rises by ``dist`` at some point within the horizon), reflection principle."""
    if dist <= 0:
        return 1.0
    if sigma <= 0 or horizon_days <= 0:
        return 0.0
    x = math.log(1.0 + dist) / (sigma * math.sqrt(horizon_days / 365.0))
    return min(1.0, 2.0 * 0.5 * (1.0 + math.erf(-x / math.sqrt(2.0))))


def health(g: DependencyGraph, horizon_days: float) -> dict | None:
    """Hedge, margin and carry of a cash-and-carry position; ``expected_penalty_pct`` is liquidation by an ordinary rally."""
    if not g.root or g.nodes[g.root].attrs.get("kind") != "cex_basis":
        return None
    a = g.nodes[g.root].attrs
    p = parts(g)
    perp = g.nodes[p["perp"]].attrs
    dist, nf, mf = a["rise_to_liquidation"], a["n_frac"], a["m_frac"]
    p_liq = rise_probability(dist, a["vol"], horizon_days)
    # An ordinary rally to the liquidation price: the spot gains `dist`, the margin is lost, re-shorting costs fees.
    penalty = max(mf - nf * dist, 0.0) + nf * REHEDGE
    apr7 = perp["funding_apr_7d"]
    basis_entry = a["perp_entry"] / a["spot_entry"] - 1.0
    basis_now = a["perp_mid"] / a["spot_mid"] - 1.0
    drift = a["perp_qty"] / a["spot_qty"] - 1.0 if a["spot_qty"] else None
    return {
        "structure": "cash_and_carry", "venue": g.nodes[p["exchange"]].label, "environment": a["environment"],
        "base": a["base"], "symbol": perp["symbol"], "spot_qty": a["spot_qty"], "perp_qty": a["perp_qty"],
        "hedge_drift": drift, "unhedged_usd": (a["spot_qty"] - a["perp_qty"]) * a["spot_mid"],
        "capital_usd": a["capital_usd"], "notional_usd": a["notional_usd"], "margin_usd": a["margin_usd"], "leverage": a["leverage"],
        "mark_price": perp["mark_price"], "liquidation_price": perp["liquidation_price"] or perp["mark_price"] * (1 + dist),
        "liquidation_source": a["liquidation_source"], "rise_to_liquidation": dist, "margin_ratio": perp.get("margin_ratio"),
        "vol": a["vol"], "p_liquidation": p_liq, "penalty_if_liquidated_pct": penalty, "expected_penalty_pct": p_liq * penalty,
        "funding_apr_7d": apr7, "funding_apr_now": perp["funding_apr_now"], "trader_apr": perp.get("trader_apr"),
        "exit_apr": perp.get("exit_apr", 0.0), "carry_apy": apr7 * nf,
        "funding_received_usd": a["funding_received_usd"], "fees_paid_usd": a["fees_paid_usd"], "settlements": a["settlements"],
        "opened_ms": a["opened_ms"], "basis_entry": basis_entry, "basis_now": basis_now,
        "state_file": a.get("state_file"), "state_age_s": time.time() - a["state_mtime"] if a.get("state_mtime") else None,
    }


# ---------------------------------------------------------------------- exit
def exit_cost(g: DependencyGraph, size: float, rng: np.random.Generator, stressed: bool, redeploy_days: float, n: int) -> dict:
    """Close both legs (sell the spot, buy back the perp) on mainnet books, then withdraw the cash off the venue.

    Closing the trade but leaving the proceeds on the exchange does not escape the venue's failure, so the
    withdrawal is part of the exit.
    """
    from .exit_cost import _result  # local: exit_cost imports this module

    a = g.nodes[g.root].attrs
    p = parts(g)
    perp = g.nodes[p["perp"]].attrs
    books = getattr(g, "cex_books", None) or {}  # set by discovery; kept off the node so the API payload stays small
    fees = a["fees"]
    steps, assumptions = [], []
    legs = [("Sell", f"{a['spot_qty']:g} {a['base']} spot", "bids", "spot_book", a["spot_qty"], a["spot_mid"], fees["spot_taker"]),
            ("Buy back", f"{a['perp_qty']:g} {perp['symbol']} short", "asks", "perp_book", a["perp_qty"], a["perp_mid"], fees["perp_taker"])]
    mult = rng.lognormal(np.log(2.0), 0.5, n) if stressed else np.ones(n)
    cost = np.full(n, a["withdraw_usd"] / size)
    for verb, what, side, key, qty, ref, fee in legs:
        book = books.get(key)
        imp, filled = walk(book[side], qty, ref) if book else (0.0005, 1.0)
        if filled < 1.0:
            assumptions.append(f"The visible {key.replace('_', ' ')} fills only {filled:.0%} of the {what}; the rest assumed at 5% impact")
            imp = imp * filled + 0.05 * (1 - filled)
        usd = qty * ref
        leg = (np.clip(imp * mult, 0, 0.5) + fee) * usd / size
        cost = cost + leg
        steps.append({"step": f"{verb} {what}", "source": "binance-api" if book else "assumption",
                      "detail": f"Taker {fee:.3%} + {imp:.3%} impact on ${usd:,.0f} against the mainnet book"
                                + ("" if book else " (book unavailable: 0.05% assumed)"),
                      "cost_pct": float(leg.mean())})
    steps.append({"step": "Withdraw the proceeds off the exchange", "source": "assumption",
                  "detail": f"Network fee ~${a['withdraw_usd']:,.0f}; until it lands the cash still depends on the venue",
                  "cost_pct": a["withdraw_usd"] / size})
    apy = max(perp["funding_apr_7d"] * a["n_frac"], 0.0)
    if apy:
        carry = np.full(n, apy * redeploy_days / 365)
        cost = cost + carry
        steps.append({"step": "Forgone funding while redeploying", "source": "binance-api",
                      "detail": f"{perp['funding_apr_7d']:.2%} APR (7d) on the {a['n_frac']:.0%} of capital that is notional x {redeploy_days:g} days",
                      "cost_pct": float(carry.mean())})
    if a.get("environment") != "mainnet":
        assumptions.append(f"The position is on {a.get('environment')}: the exit is priced on mainnet order books, "
                           "what the same position would cost to leave for real")
    if stressed:
        assumptions.append("Order-book impact widens x2 on average (lognormal) as market makers pull quotes during incidents")
    return _result(cost, size, np.ones(n), 1.0, stressed, apy, redeploy_days, steps, assumptions)


ASSUMPTIONS = [
    "Cash-and-carry: spot and the short perp cancel price moves; a move matters only through liquidation of the short",
    "Capital = spot notional + margin committed to the short (notional / leverage); losses are a share of it",
    "A USDT-margined short is a USDT long: a USDT depeg costs the margin and the short alike, and lifts BTC/USDT toward liquidation",
    "Liquidation loses the margin and leaves the spot unhedged (re-shorting costs two taker fees); "
    "a mark wick loses the whole margin, an ordinary rally only what the spot gain does not cover",
    "Both legs sit on the exchange: a venue failure takes that share of everything, and leaving means withdrawing the proceeds",
    "Ordinary rallies: probability of touching the liquidation price from a driftless lognormal barrier over the horizon",
]
