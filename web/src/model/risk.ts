import type { GraphEdge, Incident, Position, RiskSnapshot, Severity } from "../protocol";

/**
 * Risk model
 * ----------
 * 1. Effective node risk: each node has a baseline (pFail, lossGivenFailure) over the
 *    horizon. Active incidents on a node override it (probabilities combine as
 *    independent events, LGF takes the max).
 *
 * 2. Reach weights: for a position entering the graph at node E, the share of its
 *    value hit by node f failing is
 *        r(f) = min( sum over paths E -> f of prod(exposure * transmission),
 *                    max over paths E -> f of prod(max(1, transmission)) )
 *    Summing over paths handles vault allocations correctly (35% + 40% + 25% of a
 *    vault all reaching Morpho Blue = 100%); the cap stops redundant paths to a shared
 *    dependency (every leg settling on Ethereum) from being counted twice, while still
 *    allowing leverage (transmission > 1).
 *    A failure at f costs the position min(1, LGF_f * r(f)) of its value.
 *
 * 3. Expected loss (EL): treating node failures as independent,
 *        EL = 1 - prod_f (1 - p_f * min(1, LGF_f * r(f)))
 *    Shared nodes (chains, USDC, Pyth...) are sampled once per Monte Carlo draw for
 *    portfolio VaR, so cross-position correlation through common dependencies is kept.
 *
 * 4. Decision: exiting costs C = slippage + fixed costs (certain). Staying costs the
 *    *incremental* EL caused by active incidents (uncertain): baseline risk was
 *    underwritten at entry, is paid for by the yield, and would follow the capital into
 *    any redeployment, so exiting does not avoid it. EXIT when incident EL >= C; WATCH
 *    when incident EL is within `watchRatio` of C, total EL exceeds carry, the
 *    stressed loss (active incidents materialise) is large, or a high-severity incident
 *    sits in the dependency tree. The break-even incident probability p* tells the PM
 *    how confident they must be the incident materialises before exiting pays.
 */

export type Decision = "STAY" | "WATCH" | "EXIT";

export interface NodeRisk {
  p: number;
  lgf: number;
  incidents: Incident[];
}

export interface Contribution {
  nodeId: string;
  reach: number; // r(f)
  lossIfFails: number; // min(1, LGF * r) — fraction of position value
  p: number;
  elUsd: number; // marginal contribution to expected loss
}

export interface PositionRisk {
  position: Position;
  reach: Map<string, number>;
  elPct: number;
  elUsd: number;
  stressedLossPct: number; // all active incidents in the tree materialise
  stressedLossUsd: number;
  baselineElUsd: number; // with active incidents removed
  excessElUsd: number; // EL attributable to active incidents — what exiting actually avoids
  carryUsd: number; // yield earned over the horizon by staying
  exitCostUsd: number;
  exitCostPct: number;
  exitableFraction: number;
  /** Incident probability at which EL == exit cost (null if no incident in tree). */
  breakEvenP: number | null;
  /** Current probability of the incidents in the tree (combined). */
  incidentP: number;
  incidentsInTree: Incident[];
  contributions: Contribution[];
  decision: Decision;
  reasons: string[];
}

export interface PortfolioRisk {
  positions: PositionRisk[];
  byId: Map<string, PositionRisk>;
  nodeRisk: Map<string, NodeRisk>;
  /** Per node: USD of AUM whose value reaches it, and USD of portfolio EL it contributes. */
  nodeExposure: Map<string, { aumUsd: number; elUsd: number; positions: string[] }>;
  totalElUsd: number;
  varUsd: number;
  cvarUsd: number;
  lossHistogram: { lossUsd: number; prob: number }[];
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const severityRank = (s: Severity) => SEVERITY_RANK[s];

export function buildAdjacency(edges: GraphEdge[]) {
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    if (!inc.has(e.to)) inc.set(e.to, []);
    out.get(e.from)!.push(e);
    inc.get(e.to)!.push(e);
  }
  return { out, inc };
}

/** Kahn topological order, dependents before dependencies. Throws on cycles. */
export function topoOrder(nodeIds: string[], edges: GraphEdge[]): string[] {
  const indeg = new Map(nodeIds.map((id) => [id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const { out } = buildAdjacency(edges);
  const queue = nodeIds.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of out.get(id) ?? []) {
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  if (order.length !== nodeIds.length) throw new Error("Dependency graph has a cycle");
  return order;
}

export function effectiveNodeRisk(snapshot: RiskSnapshot, incidents: Incident[]): Map<string, NodeRisk> {
  const m = new Map<string, NodeRisk>();
  for (const n of snapshot.nodes) m.set(n.id, { p: n.baseline.pFail, lgf: n.baseline.lossGivenFailure, incidents: [] });
  for (const inc of incidents) {
    if (inc.status !== "active") continue;
    const r = m.get(inc.nodeId);
    if (!r) continue;
    r.p = 1 - (1 - r.p) * (1 - inc.pFail);
    r.lgf = Math.max(r.lgf, inc.lossGivenFailure);
    r.incidents.push(inc);
  }
  return m;
}

function reachWeights(entry: string, order: string[], out: Map<string, GraphEdge[]>) {
  // sum: value share summed over paths (correct for partitioned exposure such as vault allocations).
  // lev: max leverage along any path. Redundant paths to a shared dependency (every leg of a
  // position settling on the same chain) would otherwise be double counted, so reach is capped
  // at the leverage-adjusted notional: r = min(sum, lev).
  const sum = new Map<string, number>([[entry, 1]]);
  const lev = new Map<string, number>([[entry, 1]]);
  const r = new Map<string, number>();
  for (const id of order) {
    const s = sum.get(id);
    if (!s) continue;
    const l = lev.get(id)!;
    const rid = Math.min(s, l);
    r.set(id, rid);
    for (const e of out.get(id) ?? []) {
      sum.set(e.to, (sum.get(e.to) ?? 0) + rid * e.exposure * e.transmission);
      lev.set(e.to, Math.max(lev.get(e.to) ?? 0, l * Math.max(1, e.transmission)));
    }
  }
  return r;
}

function expectedLossFraction(reach: Map<string, number>, probOf: (id: string) => number, lgfOf: (id: string) => number) {
  let survive = 1;
  for (const [id, r] of reach) survive *= 1 - probOf(id) * Math.min(1, lgfOf(id) * r);
  return 1 - survive;
}

export function exitCost(pos: Position) {
  return (pos.valueUsd * pos.exit.slippageBps) / 1e4 + pos.exit.fixedCostUsd;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function computePortfolioRisk(snapshot: RiskSnapshot, incidents: Incident[]): PortfolioRisk {
  const params = snapshot.riskParams;
  const ids = snapshot.nodes.map((n) => n.id);
  const order = topoOrder(ids, snapshot.edges);
  const { out } = buildAdjacency(snapshot.edges);
  const nodeRisk = effectiveNodeRisk(snapshot, incidents);
  const baseNode = new Map(snapshot.nodes.map((n) => [n.id, n.baseline]));
  const activeIncidentNodes = new Set(incidents.filter((i) => i.status === "active").map((i) => i.nodeId));

  const pOf = (id: string) => nodeRisk.get(id)!.p;
  const lgfOf = (id: string) => nodeRisk.get(id)!.lgf;

  const positions: PositionRisk[] = snapshot.positions.map((pos) => {
    const reach = reachWeights(pos.entryNodeId, order, out);
    const elPct = expectedLossFraction(reach, pOf, lgfOf);
    const stressedLossPct = expectedLossFraction(reach, (id) => (activeIncidentNodes.has(id) ? 1 : pOf(id)), lgfOf);
    const baselinePct = expectedLossFraction(
      reach,
      (id) => (activeIncidentNodes.has(id) ? baseNode.get(id)!.pFail : pOf(id)),
      (id) => (activeIncidentNodes.has(id) ? baseNode.get(id)!.lossGivenFailure : lgfOf(id)),
    );

    // Marginal contributions: x_f * prod_{g != f}(1 - x_g)
    const xs = [...reach].map(([id, r]) => {
      const lossIfFails = Math.min(1, lgfOf(id) * r);
      return { id, r, lossIfFails, x: pOf(id) * lossIfFails };
    });
    const survive = xs.reduce((s, { x }) => s * (1 - x), 1);
    const contributions: Contribution[] = xs
      .map(({ id, r, lossIfFails, x }) => ({
        nodeId: id,
        reach: r,
        lossIfFails,
        p: pOf(id),
        elUsd: pos.valueUsd * x * (x < 1 ? survive / (1 - x) : 1),
      }))
      .sort((a, b) => b.elUsd - a.elUsd);

    const incidentsInTree = incidents.filter((i) => i.status === "active" && reach.has(i.nodeId));
    const incidentP = 1 - incidentsInTree.reduce((s, i) => s * (1 - i.pFail), 1);
    const cost = exitCost(pos);
    const elUsd = elPct * pos.valueUsd;
    const stressedLossUsd = stressedLossPct * pos.valueUsd;
    const baselineElUsd = baselinePct * pos.valueUsd;

    let breakEvenP: number | null = null;
    if (incidentsInTree.length && stressedLossUsd > baselineElUsd) {
      breakEvenP = cost / (stressedLossUsd - baselineElUsd);
    }

    const excessElUsd = Math.max(0, elUsd - baselineElUsd);
    const carryUsd = (pos.valueUsd * pos.apr * params.horizonDays) / (100 * 365);
    const r = decide({
      pos,
      elUsd,
      excessElUsd,
      carryUsd,
      cost,
      stressedLossPct: stressedLossPct * 100,
      breakEvenP,
      incidentP,
      incidentsInTree,
      watchRatio: params.watchRatio,
      stressLossWatchPct: params.stressLossWatchPct,
    });

    return {
      position: pos,
      reach,
      elPct,
      elUsd,
      stressedLossPct,
      stressedLossUsd,
      baselineElUsd,
      excessElUsd,
      carryUsd,
      exitCostUsd: cost,
      exitCostPct: cost / pos.valueUsd,
      exitableFraction: Math.min(1, pos.exit.availableLiquidityUsd / pos.valueUsd),
      breakEvenP,
      incidentP,
      incidentsInTree,
      contributions,
      decision: r.decision,
      reasons: r.reasons,
    };
  });

  const nodeExposure = new Map<string, { aumUsd: number; elUsd: number; positions: string[] }>();
  for (const id of ids) nodeExposure.set(id, { aumUsd: 0, elUsd: 0, positions: [] });
  for (const pr of positions) {
    for (const [id, r] of pr.reach) {
      const ne = nodeExposure.get(id)!;
      ne.aumUsd += pr.position.valueUsd * Math.min(1, r);
      ne.positions.push(pr.position.id);
    }
    for (const c of pr.contributions) nodeExposure.get(c.nodeId)!.elUsd += c.elUsd;
  }

  const mc = monteCarlo(snapshot, positions, nodeRisk, params.monteCarloSamples, params.varConfidence);

  return {
    positions,
    byId: new Map(positions.map((p) => [p.position.id, p])),
    nodeRisk,
    nodeExposure,
    totalElUsd: positions.reduce((s, p) => s + p.elUsd, 0),
    ...mc,
  };
}

function decide(a: {
  pos: Position;
  elUsd: number;
  excessElUsd: number;
  carryUsd: number;
  cost: number;
  stressedLossPct: number;
  breakEvenP: number | null;
  incidentP: number;
  incidentsInTree: Incident[];
  watchRatio: number;
  stressLossWatchPct: number;
}): { decision: Decision; reasons: string[] } {
  const reasons: string[] = [];
  const ratio = a.excessElUsd / a.cost;
  const fmtP = (p: number) => `${(p * 100).toFixed(1)}%`;

  if (a.incidentsInTree.length === 0) {
    reasons.push(`No active incident in the dependency tree; remaining risk is the baseline already underwritten.`);
  } else if (a.excessElUsd >= a.cost) {
    reasons.push(`Incident-driven expected loss is ${ratio.toFixed(1)}x the cost of exiting. Exiting is cheaper than staying.`);
  } else {
    reasons.push(`Exiting costs ${(1 / Math.max(ratio, 1e-9)).toFixed(1)}x the incident-driven expected loss of staying.`);
  }
  if (a.elUsd > a.carryUsd)
    reasons.push(`Expected loss exceeds the yield earned over the horizon: carry no longer pays for the risk.`);
  if (a.breakEvenP !== null) {
    if (a.breakEvenP >= 1) reasons.push(`Exit does not pay off even if the active incident materialises with certainty.`);
    else
      reasons.push(
        `Exit pays off if P(incident materialises) > ${fmtP(a.breakEvenP)}; current estimate ${fmtP(a.incidentP)}.`,
      );
  }
  const severe = a.incidentsInTree.filter((i) => severityRank(i.severity) >= SEVERITY_RANK.high);
  if (severe.length) reasons.push(`High-severity incident in dependency tree: ${severe.map((i) => i.title).join("; ")}.`);
  if (a.stressedLossPct >= a.stressLossWatchPct)
    reasons.push(`Stressed loss if incidents materialise: ${a.stressedLossPct.toFixed(1)}% of position.`);
  if (a.pos.exit.availableLiquidityUsd < a.pos.valueUsd)
    reasons.push(
      `Only ${((a.pos.exit.availableLiquidityUsd / a.pos.valueUsd) * 100).toFixed(0)}% of the position can be exited right now.`,
    );
  if (a.pos.exit.timeToExitHours >= 24)
    reasons.push(`Full exit takes ${a.pos.exit.timeToExitHours}h, so the decision must be made early.`);

  let decision: Decision = "STAY";
  if (a.incidentsInTree.length > 0 && a.excessElUsd >= a.cost) decision = "EXIT";
  else if (
    ratio >= a.watchRatio ||
    severe.length > 0 ||
    a.stressedLossPct >= a.stressLossWatchPct ||
    a.elUsd > a.carryUsd
  )
    decision = "WATCH";
  return { decision, reasons };
}

function monteCarlo(
  snapshot: RiskSnapshot,
  positions: PositionRisk[],
  nodeRisk: Map<string, NodeRisk>,
  samples: number,
  confidence: number,
) {
  const rand = mulberry32(0xbe1e);
  const ids = snapshot.nodes.map((n) => n.id);
  const ps = ids.map((id) => nodeRisk.get(id)!.p);
  // Per node: list of (positionIndex, lossIfFails)
  const hits = ids.map((id) =>
    positions
      .map((pr, i) => [i, Math.min(1, nodeRisk.get(id)!.lgf * (pr.reach.get(id) ?? 0))] as const)
      .filter(([, l]) => l > 0),
  );
  const losses = new Float64Array(samples);
  const survive = new Float64Array(positions.length);
  for (let s = 0; s < samples; s++) {
    let any = false;
    for (let k = 0; k < ids.length; k++) {
      if (rand() >= ps[k]) continue;
      if (!any) {
        survive.fill(1);
        any = true;
      }
      for (const [i, l] of hits[k]) survive[i] *= 1 - l;
    }
    if (!any) continue;
    let loss = 0;
    for (let i = 0; i < positions.length; i++) loss += (1 - survive[i]) * positions[i].position.valueUsd;
    losses[s] = loss;
  }
  const sorted = Array.from(losses).sort((a, b) => a - b);
  const idx = Math.min(samples - 1, Math.floor(confidence * samples));
  const varUsd = sorted[idx];
  const tail = sorted.slice(idx);
  const cvarUsd = tail.reduce((a, b) => a + b, 0) / tail.length;

  const max = sorted[samples - 1] || 1;
  const bins = 24;
  const counts = new Array(bins).fill(0);
  for (const l of sorted) if (l > 0) counts[Math.min(bins - 1, Math.floor((l / max) * bins))]++;
  const lossHistogram = counts.map((c, b) => ({ lossUsd: ((b + 0.5) / bins) * max, prob: c / samples }));
  return { varUsd, cvarUsd, lossHistogram };
}
