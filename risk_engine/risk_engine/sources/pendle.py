"""Pendle v2 API: resolves a PT address to its market, underlying, maturity and liquidity."""

from __future__ import annotations

from .http import get_json

BASE = "https://api-v2.pendle.finance/core"


def _strip(chain_prefixed: str | None) -> str | None:
    if not chain_prefixed:
        return None
    return chain_prefixed.split("-", 1)[-1].lower()


def active_markets(chain_id: int) -> list[dict]:
    try:
        d = get_json(f"{BASE}/v1/{chain_id}/markets/active", ttl=900)
    except Exception:
        return []
    return d.get("markets", []) if isinstance(d, dict) else []


def find_pt(pt_address: str, chain_id: int) -> dict | None:
    pt = pt_address.lower()
    for m in active_markets(chain_id):
        if _strip(m.get("pt")) == pt:
            det = m.get("details") or {}
            return {
                "market": m.get("address"),
                "name": m.get("name"),
                "expiry": m.get("expiry"),
                "pt": _strip(m.get("pt")),
                "yt": _strip(m.get("yt")),
                "sy": _strip(m.get("sy")),
                "underlying": _strip(m.get("underlyingAsset")),
                "liquidity_usd": det.get("liquidity"),
                "implied_apy": det.get("impliedApy"),
                "url": f"https://app.pendle.finance/trade/markets/{m.get('address')}?chain={chain_id}",
            }
    return None
