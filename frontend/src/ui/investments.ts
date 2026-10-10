import type { Analysis } from "../types.ts";
import {
  HISTORY_LIMIT,
  type PositionRole,
  type ScenarioRecord,
} from "./workspace.ts";

export type Investment = {
  id: string;
  analysis: Analysis;
  busy: boolean;
  role: PositionRole;
  refreshedAt: string;
  needsRefresh: boolean;
  history: ScenarioRecord[];
};
export type InvestmentsState = { items: Investment[]; activeId: string | null };
export type InvestmentsAction =
  | {
      type: "open";
      id: string;
      analysis: Analysis;
      role?: PositionRole;
      refreshedAt?: string;
    }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | {
      type: "analysis";
      id: string;
      analysis: Analysis;
      role?: PositionRole;
      refreshedAt?: string;
    }
  | { type: "scenario"; id: string; record: ScenarioRecord }
  | { type: "invalid"; id: string }
  | { type: "busy"; id: string; busy: boolean };

export const emptyInvestments: InvestmentsState = { items: [], activeId: null };

export function investmentsReducer(
  state: InvestmentsState,
  action: InvestmentsAction,
): InvestmentsState {
  if (action.type === "open") {
    return {
      items: [
        ...state.items,
        {
          id: action.id,
          analysis: action.analysis,
          busy: false,
          role: action.role ?? "entered",
          refreshedAt: action.refreshedAt ?? new Date().toISOString(),
          needsRefresh: false,
          history: [],
        },
      ],
      activeId: action.id,
    };
  }
  const index = state.items.findIndex((item) => item.id === action.id);
  // A completed request must never recreate a tab the user has closed.
  if (index === -1) return state;
  if (action.type === "select") {
    return state.activeId === action.id
      ? state
      : { ...state, activeId: action.id };
  }
  if (action.type === "close") {
    if (state.items[index].busy) return state;
    const items = state.items.filter((item) => item.id !== action.id);
    return {
      items,
      activeId:
        state.activeId === action.id
          ? (items[Math.min(index, items.length - 1)]?.id ?? null)
          : state.activeId,
    };
  }
  if (action.type === "busy" && state.items[index].busy === action.busy)
    return state;
  return {
    ...state,
    items: state.items.map((item) => {
      if (item.id !== action.id) return item;
      if (action.type === "analysis")
        return {
          ...item,
          analysis: action.analysis,
          role: action.role ?? item.role,
          refreshedAt: action.refreshedAt ?? new Date().toISOString(),
          needsRefresh: false,
        };
      if (action.type === "scenario")
        return {
          ...item,
          history: [
            action.record,
            ...item.history.filter((r) => r.id !== action.record.id),
          ].slice(0, HISTORY_LIMIT),
        };
      if (action.type === "invalid") return { ...item, needsRefresh: true };
      return { ...item, busy: action.busy };
    }),
  };
}

export function investmentLabel(analysis: Analysis): string {
  return (
    analysis.request.label ||
    (analysis.request.kind === "market"
      ? analysis.graph.nodes.find((node) => node.type === "market")?.label
      : analysis.graph.nodes.find(
          (node) => node.type === "asset" && node.attrs.kind === "pt",
        )?.label) ||
    "Investment"
  );
}
