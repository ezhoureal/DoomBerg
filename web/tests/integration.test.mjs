import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mergeIncidents, producerStale } from "../src/data/incidentEdits.ts";
import { computePortfolioRisk } from "../src/model/risk.ts";

test("refresh preserves local incident, hidden backend incident and status override", () => {
  const remote = [{ id: "remote", status: "active", title: "before" }, { id: "hidden", status: "active" }];
  const local = [{ id: "local", status: "active" }];
  const result = mergeIncidents(remote.map((i) => ({ ...i, title: "updated" })), local,
    { remote: "resolved" }, ["hidden"]);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "local");
  assert.equal(result[1].status, "resolved");
  assert.equal(result[1].title, "updated");
  assert.equal(remote[0].status, "active");
});

test("unmodified incidents follow backend updates, and reset restores remote state", () => {
  const remote = [{ id: "remote", status: "resolved" }];
  assert.deepEqual(mergeIncidents(remote, [], {}, []), remote);
});

test("producer freeze timeout honors monitor interval", () => {
  assert.equal(producerStale(1000, 5999, 1), false);
  assert.equal(producerStale(1000, 6000, 1), true);
  assert.equal(producerStale(1000, 6000, 10), false);
  assert.equal(producerStale(1000, 31000, 10), true);
});

test("all Python demo snapshots are consumable by the actual frontend risk engine", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = [
    "import json",
    "from backend.snapshot_server import SnapshotService",
    "s = SnapshotService()",
    "for i in range(24):",
    " print(json.dumps(s.get_snapshot(), allow_nan=False))",
    " s.advance()",
  ].join("\n");
  const snapshots = execFileSync("python3", ["-c", script], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    .trim().split("\n").map(JSON.parse);
  const totals = [];
  for (const snapshot of snapshots) {
    const risk = computePortfolioRisk(snapshot, snapshot.incidents);
    assert.equal(risk.positions.length, snapshot.positions.length);
    assert.ok(Number.isFinite(risk.totalElUsd));
    assert.ok(Number.isFinite(risk.varUsd));
    assert.ok(Number.isFinite(risk.cvarUsd));
    assert.equal(snapshot.source, "mock");
    totals.push(risk.totalElUsd);
  }
  // Monitor flags are evidence, not invented probabilities: risk assumptions stay constant.
  assert.ok(totals.every((value) => value === totals[0]));
  const jump = snapshots[20].nodes.find((n) => n.id === "oracle-chainlink-btc");
  assert.ok(jump.flags.some((f) => f.code === "monitor.price_jump"));
});
