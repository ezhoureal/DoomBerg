import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ageLabel,
  refreshSuggested,
  REFRESH_AFTER_MS,
  evidenceStatus,
  evidenceSummary,
  exitAmounts,
  topologyKey,
  HISTORY_LIMIT,
  newWorkspaceId,
} from "../src/ui/workspace.ts";
import { restoreWorkspace, serializeWorkspace } from "../src/ui/storage.ts";
import {
  emptyInvestments,
  investmentsReducer as reduce,
} from "../src/ui/investments.ts";

const timestamp = "2026-10-10T12:00:00.000Z";
const node = (sources = ["rpc"], unverified = false) => ({
  id: "oracle",
  type: "oracle",
  label: "Price oracle",
  attrs: {},
  risk_factors: { unverified },
  evidence: sources.map((source) => ({ source, detail: "Discovery evidence" })),
  modes: [{ id: "stale", label: "Stale price" }],
});
const analysis = (id = "server-a") => ({
  position_id: id,
  request: {
    kind: "market",
    address: "0x123",
    chain_id: 1,
    size_usd: 1000000,
    book_usd: 10000000,
  },
  graph: { root: "oracle", nodes: [node()], edges: [] },
  screening: {
    horizon_days: 30,
    total_expected_loss_pct: 0.01,
    p_any_loss_event: 0.02,
    top: [],
  },
  exit_now: {
    instant_fraction: 0.4,
    steps: [],
    cost_pct: 0.02,
    cost_pct_ci: [0.01, 0.03],
  },
  stats: {
    nodes: 1,
    edges: 0,
    evidence: 1,
    depth: 1,
    discovery_seconds: 1,
    warnings: [],
  },
});
const scenario = (id = "run-a") => ({
  id,
  analysisId: "server-a",
  createdAt: timestamp,
  refreshedAt: timestamp,
  request: analysis().request,
  horizonDays: 30,
  result: {
    position: { size_usd: 1000000 },
    shock: { node_id: "oracle" },
    probability: { horizon_days: 30 },
    decision: { verdict: "EXIT", reasons: [], break_even_table: [] },
    exit: analysis().exit_now,
    loss: { histogram: [] },
    paths: [],
    assumptions: [],
    findings: [],
  },
});
const opened = (id = "tab-a") =>
  reduce(emptyInvestments, {
    type: "open",
    id,
    analysis: analysis(),
    role: "holding",
    refreshedAt: timestamp,
  });

test("saved record IDs remain distinct when crypto.randomUUID is unavailable on LAN HTTP", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  try {
    const first = newWorkspaceId();
    const second = newWorkspaceId();
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else delete globalThis.crypto;
  }
});

test("freshness reminders advance with time without changing risk data", () => {
  const time = Date.parse(timestamp);
  assert.equal(ageLabel(timestamp, time), "Just now");
  assert.equal(ageLabel(timestamp, time + 125000), "2m ago");
  assert.equal(refreshSuggested(timestamp, time + REFRESH_AFTER_MS - 1), false);
  assert.equal(refreshSuggested(timestamp, time + REFRESH_AFTER_MS), true);
  assert.equal(ageLabel("invalid", time), "Unknown age");
  assert.equal(refreshSuggested("invalid", time), true);
});

test("evidence labels remain conservative for inferred and unverified dependencies", () => {
  assert.equal(evidenceStatus(node(["rpc"])), "On-chain evidence");
  assert.equal(evidenceStatus(node(["rpc", "heuristic"])), "Inferred");
  assert.equal(evidenceStatus(node(["rpc"], true)), "Unverified");
  assert.equal(evidenceStatus(node([])), "Unverified");
  assert.equal(evidenceStatus(node(["registry"])), "Registry reference");
  assert.equal(evidenceStatus(node(["morpho-api"])), "API evidence");
  assert.match(
    evidenceSummary(node(["rpc", "registry"])),
    /does not verify every dependency/,
  );
});

test("partial exits report withdrawable value and exposure without charging an invented partial-route cost", () => {
  const r = scenario().result;
  assert.deepEqual(exitAmounts(r), { withdrawable: 400000, remaining: 600000 });
  assert.deepEqual(
    exitAmounts({ ...r, exit: { ...r.exit, instant_fraction: 0 } }),
    { withdrawable: 0, remaining: 1000000 },
  );
  assert.deepEqual(
    exitAmounts({ ...r, exit: { ...r.exit, instant_fraction: 1 } }),
    { withdrawable: 1000000, remaining: 0 },
  );
});

test("graph layout identity ignores selection and input order but changes with topology", () => {
  const a = {
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ source: "a", target: "b", type: "priced_by" }],
  };
  assert.equal(
    topologyKey(a),
    topologyKey({ ...a, nodes: [{ id: "b", selected: true }, { id: "a" }] }),
  );
  assert.notEqual(topologyKey(a), topologyKey({ ...a, edges: [] }));
});

test("restoring retains inputs, roles and scenario snapshots but invalidates backend IDs and busy state", () => {
  let state = reduce(opened(), {
    type: "scenario",
    id: "tab-a",
    record: scenario(),
  });
  state = reduce(state, { type: "busy", id: "tab-a", busy: true });
  const restored = restoreWorkspace(serializeWorkspace(state));
  assert.equal(restored.activeId, "tab-a");
  assert.equal(restored.items[0].busy, false);
  assert.equal(restored.items[0].needsRefresh, true);
  assert.equal(restored.items[0].role, "holding");
  assert.deepEqual(restored.items[0].analysis, state.items[0].analysis);
  assert.deepEqual(restored.items[0].history, state.items[0].history);
  assert.deepEqual(restoreWorkspace(null), emptyInvestments);
});

test("invalid saved workspaces fail safely rather than rendering broken dependencies", () => {
  assert.throws(() => restoreWorkspace("broken json"));
  const saved = JSON.parse(serializeWorkspace(opened()));
  assert.throws(() =>
    restoreWorkspace(JSON.stringify({ ...saved, version: 9 })),
  );
  assert.throws(() =>
    restoreWorkspace(
      JSON.stringify({ ...saved, items: [...saved.items, ...saved.items] }),
    ),
  );
  saved.items[0].analysis.graph.nodes[0].evidence = null;
  assert.throws(() => restoreWorkspace(JSON.stringify(saved)));
});

test("scenario callbacks remain attached to their original tab and history survives a refreshed analysis", () => {
  let state = reduce(opened(), {
    type: "open",
    id: "tab-b",
    analysis: analysis("server-b"),
  });
  state = reduce(state, { type: "scenario", id: "tab-a", record: scenario() });
  assert.equal(state.activeId, "tab-b");
  assert.equal(state.items[1].history.length, 0);
  state = reduce(state, { type: "invalid", id: "tab-a" });
  assert.equal(state.items[0].needsRefresh, true);
  state = reduce(state, {
    type: "analysis",
    id: "tab-a",
    analysis: analysis("server-fresh"),
  });
  assert.equal(state.items[0].needsRefresh, false);
  assert.equal(state.items[0].history[0].analysisId, "server-a");
  assert.equal(state.items[0].role, "holding");
});

test("scenario history is bounded to the most recent runs and deduplicates callbacks", () => {
  let state = opened();
  for (let i = 0; i < HISTORY_LIMIT + 3; i++)
    state = reduce(state, {
      type: "scenario",
      id: "tab-a",
      record: scenario(`run-${i}`),
    });
  assert.equal(state.items[0].history.length, HISTORY_LIMIT);
  assert.equal(state.items[0].history[0].id, `run-${HISTORY_LIMIT + 2}`);
  state = reduce(state, {
    type: "scenario",
    id: "tab-a",
    record: state.items[0].history[0],
  });
  assert.equal(state.items[0].history.length, HISTORY_LIMIT);
  assert.equal(
    new Set(state.items[0].history.map((r) => r.id)).size,
    HISTORY_LIMIT,
  );
});
