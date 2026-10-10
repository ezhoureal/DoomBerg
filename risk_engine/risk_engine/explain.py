"""Narrative layer: the statistics produce the numbers, the LLM explains which path causes the risk.

The LLM never computes anything. It receives the engine's structured output and is told to use only
those numbers. Without an API key a deterministic writer produces the same structure.

Environment:
  OPENAI_API_KEY   (+ optional OPENAI_MODEL, OPENAI_BASE_URL)   or
  ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL)
"""

from __future__ import annotations

import json
import os

import httpx

SYSTEM = (
    "You are the on-chain risk analyst of Belem Capital, a market-neutral DeFi asset manager. "
    "A portfolio manager must decide STAY or EXIT on a position after a dependency failure. "
    "Use ONLY the numbers and facts in the JSON you receive; never invent figures, protocols or events. "
    "Write at most 200 words in Markdown with exactly these sections:\n"
    "**Verdict** - one sentence with the verdict and the two numbers that drive it (avoidable expected loss vs exit cost).\n"
    "**What is causing the risk** - walk the main dependency path hop by hop (position -> ... -> failing component) "
    "and say what each hop does to the money. Name the weakest link and why (use the risk factors / evidence).\n"
    "**Why these numbers** - probability (and its range), loss if it fails (typical vs bad case), exit cost and what limits the exit.\n"
    "**What would change the call** - the break-even probability and the one or two facts to monitor."
)


def _pct(x):
    return "n/a" if x is None else f"{x:.1%}"


def _usd(x):
    return "n/a" if x is None else f"${x:,.0f}"


def build_context(result: dict) -> dict:
    d = result["decision"]
    return {
        "position": result["position"],
        "shock": result["shock"],
        "verdict": d["verdict"],
        "probability": d["probability"],
        "probability_range_90": result["probability"]["p_ci"],
        "probability_reasons": result["probability"]["reasons"],
        "loss_if_fails": d["loss_given_failure"],
        "expected_loss_usd": d["expected_loss_usd"],
        "avoidable_loss_usd": d["avoidable_loss_usd"],
        "exit_cost_pct": d["exit_cost_pct"],
        "exit_cost_usd": d["exit_cost_usd"],
        "exit_steps": [s["detail"] for s in result["exit"]["steps"]],
        "instant_exit_fraction": result["exit"]["instant_fraction"],
        "break_even_probability": d["break_even_probability"],
        "decision_reasons": d["reasons"],
        "main_paths": [
            [{"component": h["label"], "type": h["type"], "via": h["edge_type"], "mean_loss": round(h["mean_loss"], 4),
              "transmission": h["why"]} for h in p["hops"]]
            for p in result["paths"][:2]
        ],
        "component_findings": result.get("findings", []),
    }


def explain(result: dict, use_llm: bool = True) -> dict:
    """Narrative for a shock result. ``use_llm=False`` skips the network call and returns the template."""
    ctx = build_context(result)
    text, provider, model, error = None, "template", None, None
    try:
        if use_llm and os.getenv("OPENAI_API_KEY"):
            model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
            base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
            r = httpx.post(f"{base}/chat/completions", timeout=40,
                           headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                           json={"model": model, "temperature": 0.2,
                                 "messages": [{"role": "system", "content": SYSTEM},
                                              {"role": "user", "content": json.dumps(ctx, default=float)}]})
            r.raise_for_status()
            text, provider = r.json()["choices"][0]["message"]["content"], "openai"
        elif use_llm and os.getenv("ANTHROPIC_API_KEY"):
            model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5")
            r = httpx.post("https://api.anthropic.com/v1/messages", timeout=40,
                           headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                           json={"model": model, "max_tokens": 700, "system": SYSTEM,
                                 "messages": [{"role": "user", "content": json.dumps(ctx, default=float)}]})
            r.raise_for_status()
            text, provider = r.json()["content"][0]["text"], "anthropic"
    except Exception as e:  # network / quota / model errors fall back to the template
        error = str(e)[:200]
        text = None
    if not text:
        text, provider = template(ctx), "template"
    return {"text": text, "provider": provider, "model": model, "error": error}


def template(ctx: dict) -> str:
    v, p = ctx["verdict"], ctx["probability"]
    lf = ctx["loss_if_fails"]
    path = ctx["main_paths"][0] if ctx["main_paths"] else []
    hops = " -> ".join(h["component"] for h in path) or ctx["shock"]["node_label"]
    weakest = max(path[1:], key=lambda h: h["mean_loss"], default=None) if path else None
    lines = [
        "#### Verdict",
        f"{v}: exiting can avoid {_usd(ctx['avoidable_loss_usd'])} of the {_usd(ctx['expected_loss_usd'])} expected loss "
        f"({_pct(p)} chance x {_pct(lf['mean'])} loss x {_pct(ctx['instant_exit_fraction'])} available to exit), "
        f"versus {_usd(ctx['exit_cost_usd'])} ({_pct(ctx['exit_cost_pct'])}) exit cost.",
        "",
        "#### What is causing the risk",
        f"Path: {hops}.",
    ]
    for h in path[1:]:
        lines.append(f"- {h['component']} ({h['type']}, via {h['via']}): mean loss {_pct(h['mean_loss'])} - {h['transmission']}.")
    if weakest:
        lines.append(f"Weakest link: **{ctx['shock']['node_label']}** - {ctx['shock']['mode_label'].lower()}.")
    for f in ctx.get("component_findings", [])[:3]:
        lines.append(f"- {f}")
    lines += [
        "",
        "#### Why these numbers",
        f"Probability {_pct(p)} (90% range {_pct(ctx['probability_range_90'][0])}-{_pct(ctx['probability_range_90'][1])}): "
        + "; ".join(ctx["probability_reasons"][:4]) + ".",
        f"Loss if it fails: typical {_pct(lf['typical'])}, bad case {_pct(lf['bad_case'])}.",
        f"Exit: {' / '.join(ctx['exit_steps'][:2])}.",
        "",
        "#### What would change the call",
    ]
    be = ctx["break_even_probability"]
    if ctx['instant_exit_fraction'] <= 0:
        lines.append("No immediate complete exit route is available; check executable routing and liquidity before attempting an exit.")
    elif be is None or be >= 1:
        lines.append("Even a certain failure costs less than exiting; only a larger loss estimate would flip this.")
    else:
        lines.append(f"Exit becomes right above a {_pct(be)} failure probability. "
                     f"Watch the component's price / feed and the instant exit liquidity ({_pct(ctx['instant_exit_fraction'])} available now).")
    return "\n".join(lines)
