export type Evidence = { source: string; detail: string; ref?: string | null; block?: number | null };

export type NodeRisk = {
  expected_loss_pct: number;
  share: number;
  top_mode: string | null;
  modes: { mode: string; mode_label: string; p: number; loss_given_failure: number; expected_loss_pct: number; share: number; alert: AlertLevel }[];
};

export type GNode = {
  id: string;
  type: string;
  label: string;
  chain_id: number | null;
  address: string | null;
  layer: number;
  attrs: Record<string, any>;
  risk_factors: Record<string, any>;
  evidence: Evidence[];
  risk?: NodeRisk | null;
  modes: { id: string; label: string }[];
};

export type GEdge = { id: string; source: string; target: string; type: string; weight: number; attrs: Record<string, any>; evidence: Evidence[] };

export type AlertLevel = "none" | "watch" | "alert" | "corroborated" | "confirmed";

export type ScreenRow = {
  node_id: string; label: string; type: string; node_class: string; mode: string; mode_label: string;
  p: number; prior_p: number; base_p: number; annual_rate: number; loss_given_failure: number; expected_loss_pct: number; share: number;
  reasons: string[]; alert: AlertLevel; likelihood_ratio: number | null; rate_multiplier: number; signals: string[];
};

export type Signal = {
  node_id: string; label: string; mode: string; rule: string; rule_label: string; level: "watch" | "alert";
  value: number; threshold: number; detail: string; first_seen: number | null; node_class: string;
};

export type MonitorEvent = { ts: number; position_key: string; label: string | null; kind: string; severity: "info" | "warning" | "critical"; message: string; data: Record<string, any> };

export type Monitor = {
  position_key: string; label: string; verdict: "STAY" | "EXIT" | "REVIEW";
  model_verdict?: "STAY" | "EXIT"; data_status?: "complete" | "incomplete";
  data_issues?: { node_id: string; label: string; fields: string[]; detail: string }[];
  decision_rule?: string; execution_status?: "blocked" | "available";
  expected_loss_pct: number; baseline_loss_pct: number; excess_loss_pct: number; avoidable_loss_pct: number;
  exit_cost_pct: number; instant_fraction: number; max_alert: AlertLevel; regime: "calm" | "elevated" | "stressed"; contagion_max: number;
  signals: Signal[];
  alerts: { node_id: string; label: string; mode: string; mode_label: string; level: AlertLevel; signals: Signal[] }[];
  above_break_even: { node_id: string; label: string; mode: string; mode_label: string; p: number; break_even_p: number; alert: AlertLevel }[];
  previous: { ts: number; verdict: "STAY" | "EXIT" | "REVIEW"; expected_loss_pct: number; baseline_loss_pct: number; avoidable_loss_pct: number;
    p_any: number; exit_cost_pct: number; max_alert: AlertLevel } | null;
  events: MonitorEvent[];
  recorded: boolean;
};

export type ExitInfo = {
  cost_pct: number; cost_pct_ci: [number, number]; cost_usd: number; instant_fraction: number; instant_fraction_calm: number;
  stressed: boolean; steps: { step: string; source: string; detail: string; cost_pct: number }[]; assumptions: string[]; override?: number;
};

export type Analysis = {
  position_id: string;
  request: { kind: PositionKind; address: string; chain_id: number; size_usd: number; book_usd: number; label?: string | null };
  graph: { root: string; nodes: GNode[]; edges: GEdge[] };
  screening: { horizon_days: number; total_expected_loss_pct: number; p_any_loss_event: number; top: ScreenRow[] };
  monitor: Monitor;
  exit_now: ExitInfo;
  stats: { nodes: number; edges: number; evidence: number; depth: number; discovery_seconds: number; warnings: string[] };
};

export type Hop = { node_id: string; label: string; type: string; mean_loss: number; edge_type: string | null; edge_weight: number | null; why: string | null };

export type ShockResult = {
  position: { label: string; size_usd: number; book_usd: number; kind: PositionKind };
  shock: { node_id: string; node_label: string; node_type: string; mode: string; mode_label: string; description: string; alert: string; alert_label: string;
    alert_source: "signals" | "manual"; signals: Signal[]; severity: Summary; incident?: any };
  probability: { annual_rate: number; annual_rate_ci: [number, number]; base_p: number; prior_p: number; p: number; p_ci: [number, number];
    likelihood_ratio: number | null; alert: string; rate_multiplier: number; horizon_days: number; reasons: string[] };
  loss: Summary & { histogram: { x0: number; x1: number; share: number }[] };
  exit: ExitInfo;
  decision: {
    verdict: "STAY" | "EXIT"; confidence: number; probability: number; probability_source: string;
    loss_given_failure: { mean: number; typical: number; bad_case: number };
    expected_loss_pct: number; expected_loss_usd: number; bad_case_usd: number; exit_cost_pct: number; exit_cost_usd: number; instant_fraction: number; instant_fraction_calm: number;
    break_even_probability: number | null; avoidable_loss_pct?: number; avoidable_loss_usd: number; book_impact_pct: number | null; position_share_of_book: number | null;
    reasons: string[]; break_even_table: { loss_if_fails: number; exit_above: number | null }[];
  };
  paths: { hops: Hop[]; strength: number }[];
  impacted: { node_id: string; label: string; type: string; mean_loss: number }[];
  node_losses: Record<string, number>;
  findings: string[];
  assumptions: string[];
  explanation: { text: string; provider: string; model: string | null; error: string | null } | null;
};

export type Summary = { mean: number; p05: number; p50: number; p95: number; p99: number; prob_any_loss: number };

export type PositionKind = "token" | "market";

export type Preset = { id: string; label: string; kind: PositionKind; chain_id: number; address: string; size_usd: number; note: string };

export type Catalog = {
  modes: { id: string; label: string; applies_to: string[]; description: string }[];
  alerts: { id: string; label: string }[];
  incidents: { id: string; name: string; date: string; mode: string; kind: string; severity: number; duration_h: number; summary: string; source: string }[];
};
