import type { Analysis } from "../types.ts";

export type Investment = { id: string; analysis: Analysis; busy: boolean };
export type InvestmentsState = { items: Investment[]; activeId: string | null };
export type InvestmentsAction =
  | { type: "open"; id: string; analysis: Analysis }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | { type: "analysis"; id: string; analysis: Analysis }
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
        { id: action.id, analysis: action.analysis, busy: false },
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
    items: state.items.map((item) =>
      item.id !== action.id
        ? item
        : action.type === "analysis"
          ? { ...item, analysis: action.analysis }
          : { ...item, busy: action.busy },
    ),
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
