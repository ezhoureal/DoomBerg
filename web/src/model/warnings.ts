import type { GraphNode, RiskSnapshot, Warning } from "../protocol";
import type { PortfolioRisk } from "./risk";
import { severityRank } from "./risk";

/** Rule-based warnings derived from node metrics, incidents and portfolio exposure. */
export function nodeWarnings(node: GraphNode, snapshot: RiskSnapshot, risk: PortfolioRisk): Warning[] {
  const p = snapshot.riskParams;
  const m = node.metrics ?? {};
  const w: Warning[] = [...(node.flags ?? [])];

  for (const inc of risk.nodeRisk.get(node.id)?.incidents ?? []) {
    w.push({ code: `incident.${inc.kind}`, severity: inc.severity, message: inc.title });
  }

  if (node.type === "oracle") {
    if (m.sourceCount === 1)
      w.push({ code: "oracle.single_source", severity: "medium", message: "Single price-discovery source" });
    if (m.deviationPct !== undefined) {
      if (m.deviationPct >= p.oracleDeviationCritPct)
        w.push({ code: "oracle.deviation", severity: "high", message: `Oracle deviates ${m.deviationPct}% from market` });
      else if (m.deviationPct >= p.oracleDeviationWarnPct)
        w.push({ code: "oracle.deviation", severity: "medium", message: `Oracle deviates ${m.deviationPct}% from market` });
    }
    if (m.stalenessSec !== undefined && m.heartbeatSec !== undefined && m.stalenessSec > m.heartbeatSec)
      w.push({ code: "oracle.stale", severity: "high", message: `Stale: ${m.stalenessSec}s since update (heartbeat ${m.heartbeatSec}s)` });
  }

  if (m.utilization !== undefined && m.utilization >= p.utilizationWarn)
    w.push({
      code: "market.utilization",
      severity: m.utilization >= 0.97 ? "high" : "medium",
      message: `Utilization ${(m.utilization * 100).toFixed(0)}%: withdrawals may be blocked`,
    });

  if (m.pegDeviationPct !== undefined && Math.abs(m.pegDeviationPct) >= p.pegDeviationWarnPct)
    w.push({
      code: "asset.depeg",
      severity: Math.abs(m.pegDeviationPct) >= 2 ? "high" : "medium",
      message: `Off peg by ${m.pegDeviationPct}%`,
    });

  if (m.fundingRateApr !== undefined && m.fundingRateApr < 0)
    w.push({ code: "funding.negative", severity: "medium", message: `Negative funding ${m.fundingRateApr}% APR` });

  if (m.tvlShareOfChain !== undefined && m.tvlShareOfChain >= p.tvlShareWarn)
    w.push({
      code: "protocol.tvl_concentration",
      severity: "low",
      message: `Holds ${(m.tvlShareOfChain * 100).toFixed(0)}% of chain TVL`,
    });

  const exp = risk.nodeExposure.get(node.id);
  if (exp && node.type !== "chain") {
    const pct = (exp.aumUsd / snapshot.portfolio.aumUsd) * 100;
    if (pct >= p.concentrationPct)
      w.push({ code: "portfolio.concentration", severity: "low", message: `${pct.toFixed(0)}% of AUM depends on this` });
  }

  if (node.type === "bridge")
    w.push({ code: "bridge.dependency", severity: "info", message: "Bridged assets: failure is chain-agnostic" });
  if (node.type === "curator" || node.type === "custodian")
    w.push({ code: "offchain.trust", severity: "info", message: "Off-chain trust assumption" });

  return w.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

export function maxSeverity(ws: Warning[]) {
  return ws.reduce<Warning["severity"] | null>(
    (acc, w) => (acc === null || severityRank(w.severity) > severityRank(acc) ? w.severity : acc),
    null,
  );
}
