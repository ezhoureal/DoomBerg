"""Orchestrates Discover -> Shock -> Price the exit -> Decide, and keeps analysed positions in memory."""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict
from pathlib import Path

import numpy as np

from .decision import decide
from .discovery import Discovery, PositionRequest
from .exit_cost import exit_cost
from .explain import explain
from .failures import MODES, applicable_modes, severity_prior
from .graph import DependencyGraph
from .probability import ALERT_LEVELS, failure_probability
from .propagation import Simulator, explain_paths, histogram, summarize

INCIDENTS = json.loads((Path(__file__).parent / "data" / "incidents.json").read_text(encoding="utf-8"))["incidents"]

PRESETS = [
    {"id": "pt-reusd-market", "label": "Brief example: PT-reUSD as collateral (USDC supply)", "kind": "market", "chain_id": 1,
     "address": "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64", "size_usd": 1_000_000,
     "note": "The 5-layer Pendle PT example from the brief: chain, yield source, oracle, PT AMM, lending market"},
    {"id": "pt-usd3-market", "label": "PT-USD3 as collateral (USDC supply)", "kind": "market", "chain_id": 1,
     "address": "0xf8c5aa31ea6b2a068a9eddb46dd110cae57bf0f12be9583a3f9a818effecba89", "size_usd": 1_000_000,
     "note": "LLTV 86%, utilization above 90%: idle liquidity runs thin once lenders rush out"},
    {"id": "pt-susde-market", "label": "PT-sUSDe as collateral (USDC supply)", "kind": "market", "chain_id": 1,
     "address": "0x5613b170ded221c588b6e9637b910f49e5508680ceede207f44aa72e5c46cb05", "size_usd": 1_000_000,
     "note": "Ethena PT lent against at LLTV 91.5%"},
    {"id": "pt-reusd", "label": "PT-reUSD (held)", "kind": "token", "chain_id": 1,
     "address": "0xecfafdc7741323a945a163ed068b5a3c43483957", "size_usd": 1_000_000,
     "note": "The Pendle PT from the brief: Re Protocol reUSD yield source, Pendle AMM, settles on Ethereum"},
    {"id": "pt-susde", "label": "PT-sUSDe (held)", "kind": "token", "chain_id": 1,
     "address": "0xb195b618ea52b77cb2a58846f452f59f8dfa9390", "size_usd": 1_000_000,
     "note": "Ethena staked USDe: delta-neutral synthetic dollar with off-exchange custody"},
    {"id": "pt-strusd", "label": "PT-strUSD (held)", "kind": "token", "chain_id": 1,
     "address": "0x74299580811e1c3c1a2831db079ba0a8f513998f", "size_usd": 1_000_000,
     "note": "Collateral in RockawayX-curated Morpho vaults"},
    {"id": "pt-fxsave", "label": "PT-fxSAVE (held)", "kind": "token", "chain_id": 1,
     "address": "0x079c3469143804af5d0d645a878c371dbe8d038e", "size_usd": 1_000_000,
     "note": "f(x) Protocol savings token; thin Pendle liquidity"},
    {"id": "pt-wsteth", "label": "PT-wstETH (held)", "kind": "token", "chain_id": 1,
     "address": "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", "size_usd": 1_000_000,
     "note": "Lido wrapped staked ETH: blue-chip LST underlying"},
]


def _clean(obj):
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items() if k != "samples"}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, float) and (obj != obj or obj in (float("inf"), float("-inf"))):
        return None
    return obj


class RiskEngine:
    def __init__(self, seed: int = 11):
        self.store: dict[str, dict] = {}
        self.seed = seed

    # ------------------------------------------------------------------ analyse
    def analyze(self, req: PositionRequest, horizon_days: float = 30) -> dict:
        g = Discovery(req).run()
        pid = hashlib.sha1(f"{req.kind}{req.address.lower()}{req.chain_id}{req.size_usd}{time.time()}".encode()).hexdigest()[:12]
        rng = np.random.default_rng(self.seed)
        screening = self.screen(g, horizon_days, rng)
        calm_exit = exit_cost(g, req.size_usd, rng, stressed=False)
        self.store[pid] = {"req": req, "graph": g, "screening": screening, "horizon": horizon_days}
        graph = g.to_dict()
        for n in graph["nodes"]:
            r = screening["nodes"].get(n["id"])
            n["risk"] = r
            n["modes"] = [{"id": m.id, "label": m.label} for m in applicable_modes(n["type"], n["attrs"])]
        return _clean({
            "position_id": pid,
            "request": asdict(req),
            "graph": graph,
            "screening": {k: v for k, v in screening.items() if k != "nodes"},
            "exit_now": calm_exit,
            "stats": {"nodes": len(g.nodes), "edges": len(g.edges),
                      "evidence": sum(len(n.evidence) for n in g.nodes.values()) + sum(len(e.evidence) for e in g.edges.values()),
                      "depth": max((n.layer for n in g.nodes.values()), default=0),
                      "discovery_seconds": g.nodes["position"].attrs.get("discovery_seconds"),
                      "warnings": g.nodes["position"].attrs.get("warnings")},
        })

    def screen(self, g: DependencyGraph, horizon_days: float, rng: np.random.Generator, n: int = 500) -> dict:
        """Base-rate risk of every (component, failure mode): P(fail in horizon) x E[position loss | fail]."""
        sim = Simulator(g, seed=self.seed)
        rows = []
        for nid, node in g.nodes.items():
            if node.type == "position":
                continue
            for m in applicable_modes(node.type, node.attrs):
                prob = failure_probability(node, m.id, horizon_days, rng, n=1000)
                res = sim.run(nid, m.id, n=n)
                lgf = float(res.loss[g.root].mean())
                rows.append({"node_id": nid, "label": node.label, "type": node.type, "mode": m.id, "mode_label": m.label,
                             "p": prob["p"], "annual_rate": prob["annual_rate"], "loss_given_failure": lgf,
                             "expected_loss_pct": prob["p"] * lgf, "reasons": prob["reasons"]})
        total = sum(r["expected_loss_pct"] for r in rows) or 1e-12
        nodes: dict[str, dict] = {}
        for r in rows:
            r["share"] = r["expected_loss_pct"] / total
            d = nodes.setdefault(r["node_id"], {"expected_loss_pct": 0.0, "share": 0.0, "modes": []})
            d["expected_loss_pct"] += r["expected_loss_pct"]
            d["share"] += r["share"]
            d["modes"].append({k: r[k] for k in ("mode", "mode_label", "p", "loss_given_failure", "expected_loss_pct", "share")})
        for d in nodes.values():
            d["modes"].sort(key=lambda x: -x["expected_loss_pct"])
            d["top_mode"] = d["modes"][0]["mode"] if d["modes"] else None
        rows.sort(key=lambda r: -r["expected_loss_pct"])
        p_any = 1 - float(np.prod([1 - r["p"] for r in rows if r["loss_given_failure"] > 1e-4]))
        return {"horizon_days": horizon_days, "total_expected_loss_pct": total, "p_any_loss_event": p_any,
                "top": rows[:12], "nodes": nodes}

    # ------------------------------------------------------------------ shock
    def shock(self, position_id: str, node_id: str, mode: str, alert: str = "alert",
              probability_override: float | None = None, exit_cost_override: float | None = None,
              horizon_days: float | None = None, n: int = 5000, fixed_severity: float | None = None,
              use_llm: bool = True, incident: dict | None = None) -> dict:
        entry = self.store.get(position_id)
        if not entry:
            raise KeyError("Unknown position_id; analyse the position first")
        g: DependencyGraph = entry["graph"]
        req: PositionRequest = entry["req"]
        if node_id not in g.nodes:
            raise KeyError(f"Unknown node {node_id}")
        if mode not in MODES:
            raise KeyError(f"Unknown failure mode {mode}")
        node = g.nodes[node_id]
        if all(m.id != mode for m in applicable_modes(node.type, node.attrs)):
            raise ValueError(f"Failure mode '{mode}' does not apply to {node.label} ({node.type})")
        horizon = horizon_days or entry["horizon"]
        rng = np.random.default_rng(self.seed + 1)

        sim = Simulator(g, seed=self.seed + 2).run(node_id, mode, n=n, fixed_severity=fixed_severity)
        pos_loss = sim.loss[g.root]
        prob = failure_probability(node, mode, horizon, rng, alert=alert, n=n)

        denom = next((e.target for e in g.out_edges(g.root) if e.type == "denominated_in"), None)
        sell = denom if denom and float(sim.loss[denom].mean()) > 1e-3 else None
        stressed = float(pos_loss.mean()) > 1e-4
        ex = exit_cost(g, req.size_usd, rng, stressed=stressed, sell_asset_id=sell, n=n)
        cost_pct = exit_cost_override if exit_cost_override is not None else ex["cost_pct"]
        if exit_cost_override is not None:
            ex["override"] = exit_cost_override

        dec = decide(req.size_usd, req.book_usd, prob["samples"], pos_loss, cost_pct,
                     None if exit_cost_override is not None else ex["samples"], ex["instant_fraction"], probability_override)

        paths = explain_paths(g, sim, node_id)
        sev_mean, sev_kappa = severity_prior(mode, node.type, {**node.attrs, **node.risk_factors})
        impacted = sorted(({"node_id": k, "label": g.nodes[k].label, "type": g.nodes[k].type, "mean_loss": float(v.mean())}
                           for k, v in sim.loss.items() if float(v.mean()) > 1e-4), key=lambda x: -x["mean_loss"])
        result = {
            "position": {"label": g.nodes[g.root].label, "size_usd": req.size_usd, "book_usd": req.book_usd, "kind": req.kind},
            "shock": {"node_id": node_id, "node_label": node.label, "node_type": node.type, "mode": mode,
                      "mode_label": MODES[mode].label, "description": MODES[mode].description,
                      "alert": alert, "alert_label": ALERT_LEVELS.get(alert, {}).get("label"),
                      "severity": summarize(sim.severity), "incident": incident},
            "probability": prob,
            "loss": {**summarize(pos_loss), "histogram": histogram(pos_loss)},
            "exit": ex,
            "decision": dec,
            "paths": paths,
            "impacted": impacted[:25],
            "node_losses": {k: float(v.mean()) for k, v in sim.loss.items()},
            "findings": self.findings(g, paths),
            "assumptions": self.assumptions(mode, sev_mean, sev_kappa, horizon, n, ex, fixed_severity),
        }
        result["explanation"] = explain(_clean(result)) if use_llm else None
        return _clean(result)

    def replay(self, position_id: str, incident_id: str, **kw) -> dict:
        entry = self.store.get(position_id)
        if not entry:
            raise KeyError("Unknown position_id")
        inc = next((i for i in INCIDENTS if i["id"] == incident_id), None)
        if not inc:
            raise KeyError("Unknown incident")
        g: DependencyGraph = entry["graph"]
        node_id = self.match_incident(g, inc, entry["screening"])
        if not node_id:
            raise ValueError(f"This position has no component comparable to '{inc['name']}' ({inc['kind']})")
        sev = inc["duration_h"] if inc["mode"] in ("chain_halt", "oracle_stale") else inc["severity"]
        return self.shock(position_id, node_id, inc["mode"], alert="confirmed", fixed_severity=sev, incident=inc, **kw)

    @staticmethod
    def match_incident(g: DependencyGraph, inc: dict, screening: dict) -> str | None:
        want = {"depeg": ("asset",), "unbacked_mint": ("mint_authority", "asset"), "oracle_wrong_price": ("oracle",),
                "oracle_stale": ("oracle",), "bridge_hack": ("bridge",), "exploit": ("protocol",),
                "chain_halt": ("chain",)}.get(inc["mode"]) or MODES[inc["mode"]].applies_to
        # Only components the mode can actually hit (e.g. a PT cannot be minted without backing).
        cands = [n for n in g.nodes.values() if n.type in want
                 and any(m.id == inc["mode"] for m in applicable_modes(n.type, n.attrs))]
        if inc["mode"] == "depeg":
            sym = [n for n in cands if inc.get("symbol") and n.label.lower() == inc["symbol"]]
            same_kind = [n for n in cands if n.attrs.get("kind") == inc["kind"]]
            near = {"fiat_stable": ("eur_stable",), "synthetic_stable": ("yield_stable", "rwa", "unknown"),
                    "yield_stable": ("synthetic_stable", "rwa", "unknown"), "lst": ("lrt",)}.get(inc["kind"], ())
            close = [n for n in cands if n.attrs.get("kind") in near]
            cands = sym or same_kind or close
        if inc["mode"] == "chain_halt":
            cands = [n for n in cands if n.chain_id == g.nodes[g.root].chain_id] or cands
        if not cands:
            return None
        score = lambda n: screening["nodes"].get(n.id, {}).get("expected_loss_pct", 0)
        return max(cands, key=score).id

    @staticmethod
    def findings(g: DependencyGraph, paths: list[dict]) -> list[str]:
        out, seen = [], set()
        for p in paths[:2]:
            for h in p["hops"]:
                n = g.nodes[h["node_id"]]
                if n.id in seen:
                    continue
                seen.add(n.id)
                a, rf = n.attrs, n.risk_factors
                if n.type == "oracle" and a.get("tracking_reason"):
                    out.append(f"{n.label}: {a['tracking_reason']} (feeds: {', '.join(a.get('feed_descriptions') or []) or 'none'})")
                if n.type == "feed" and a.get("stale"):
                    out.append(f"Feed {n.label} last updated {int((a.get('age_s') or 0) / 3600)}h ago")
                if n.type == "market":
                    out.append(f"Market {n.label}: utilization {(a.get('utilization') or 0):.0%}, LLTV {(a.get('lltv') or 0):.1%}, "
                               f"idle liquidity ${(a.get('liquidity_usd') or 0):,.0f}, age {a.get('age_days')} days")
                if n.type == "amm":
                    out.append(f"{n.label}: liquidity ${(a.get('liquidity_usd') or 0):,.0f}, expiry {a.get('expiry')}")
                if n.type == "mint_authority":
                    out.append(f"Mint / upgrade control of the token: {n.label} ({a.get('role') or 'role-based'})")
                if n.type == "asset" and rf.get("unverified"):
                    out.append(f"{n.label}: issuer and backing are not in the curated registry - classified as {a.get('kind')} by heuristic")
        return out[:8]

    @staticmethod
    def assumptions(mode, sev_mean, sev_kappa, horizon, n, ex, fixed) -> list[str]:
        a = [
            f"Horizon {horizon:g} days (Belem clients can redeem monthly)",
            f"{n:,} Monte Carlo draws",
            (f"Replay: severity fixed at the observed {fixed:g} (+/- noise)" if fixed is not None else
             f"Severity at the failing component: exponential, mean {sev_mean:g}h" if sev_kappa == 0 else
             f"Severity at the failing component: Beta(mean {sev_mean:.0%}, concentration {sev_kappa:g})"),
            "The PT loses whatever its underlying, issuer, mint controls or AMM lose (combined as independent losses)",
            "While the chain is halted a held PT cannot be sold; its price drifts with the volatility of its asset class",
            "Borrowers sit at 70-97% of LLTV on average; liquidators prevent 30-80% of insolvency only when the oracle sees the move",
            "Over-borrowing drains up to 100% of idle market liquidity once LLTV x oracle over-pricing > 1",
            "Probabilities: Gamma-Poisson base rates x risk-factor multipliers, then Bayesian update by the alert likelihood ratio",
        ]
        return a + ex.get("assumptions", [])

    # ------------------------------------------------------------------ misc
    def node_modes(self, position_id: str, node_id: str, horizon_days: float = 30) -> list[dict]:
        g: DependencyGraph = self.store[position_id]["graph"]
        node = g.nodes[node_id]
        rng = np.random.default_rng(self.seed)
        out = []
        for m in applicable_modes(node.type, node.attrs):
            pr = failure_probability(node, m.id, horizon_days, rng, n=1000)
            out.append({"id": m.id, "label": m.label, "description": m.description, "p": pr["p"],
                        "annual_rate": pr["annual_rate"], "reasons": pr["reasons"]})
        return out
