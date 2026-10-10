import type { Investment, InvestmentsState } from "./investments.ts";
import { emptyInvestments } from "./investments.ts";
import { HISTORY_LIMIT } from "./workspace.ts";

export const STORAGE_KEY = "doomberg.workspace.v1";
export function serializeWorkspace(state: InvestmentsState): string {
  return JSON.stringify({
    version: 1,
    activeId: state.activeId,
    items: state.items.map(({ busy, needsRefresh, ...item }) => item),
  });
}
export function restoreWorkspace(raw: string | null): InvestmentsState {
  if (!raw) return emptyInvestments;
  const saved = JSON.parse(raw);
  if (saved.version !== 1 || !Array.isArray(saved.items))
    throw new Error("Unsupported saved workspace.");
  const ids = new Set<string>();
  const items: Investment[] = saved.items.map((item: Investment) => {
    const a = item.analysis;
    if (
      typeof item.id !== "string" ||
      ids.has(item.id) ||
      !["example", "entered", "holding"].includes(item.role) ||
      !Number.isFinite(Date.parse(item.refreshedAt)) ||
      !a ||
      typeof a.position_id !== "string" ||
      !a.request ||
      !["market", "token"].includes(a.request.kind) ||
      typeof a.request.address !== "string" ||
      !Number.isFinite(a.request.size_usd) ||
      a.request.size_usd <= 0 ||
      !Number.isFinite(a.request.book_usd) ||
      a.request.book_usd <= 0 ||
      !Number.isFinite(a.request.chain_id) ||
      !a.screening ||
      !a.exit_now ||
      !a.stats ||
      !Number.isFinite(a.screening.horizon_days) ||
      a.screening.horizon_days <= 0 ||
      !Array.isArray(a.screening.top) ||
      !Array.isArray(a.stats.warnings) ||
      !Array.isArray(a.graph?.nodes) ||
      !Array.isArray(a.graph?.edges) ||
      !Array.isArray(item.history)
    )
      throw new Error("Invalid saved investment.");
    for (const node of a.graph.nodes) {
      if (
        typeof node.id !== "string" ||
        !node.attrs ||
        !node.risk_factors ||
        !Array.isArray(node.evidence) ||
        !Array.isArray(node.modes)
      )
        throw new Error("Invalid saved dependency.");
    }
    for (const record of item.history) {
      if (
        !record ||
        typeof record.id !== "string" ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        !Number.isFinite(Date.parse(record.refreshedAt)) ||
        typeof record.analysisId !== "string" ||
        !record.request ||
        !Number.isFinite(record.horizonDays) ||
        !record.result?.decision ||
        !record.result?.shock ||
        !record.result?.position ||
        !record.result?.probability ||
        !record.result?.exit ||
        !record.result?.loss ||
        !Array.isArray(record.result.paths) ||
        !Array.isArray(record.result.loss.histogram) ||
        !Array.isArray(record.result.exit.steps) ||
        !Array.isArray(record.result.decision.reasons) ||
        !Array.isArray(record.result.decision.break_even_table) ||
        !Array.isArray(record.result.assumptions) ||
        !Array.isArray(record.result.findings)
      )
        throw new Error("Invalid saved scenario.");
    }
    ids.add(item.id);
    // Server analysis IDs cannot be trusted across reloads or process restarts.
    return {
      ...item,
      busy: false,
      needsRefresh: true,
      history: item.history.slice(0, HISTORY_LIMIT),
    };
  });
  return {
    items,
    activeId: items.some((item) => item.id === saved.activeId)
      ? saved.activeId
      : (items[0]?.id ?? null),
  };
}
