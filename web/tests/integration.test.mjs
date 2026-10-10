import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mergeIncidents } from "../src/data/incidentEdits.ts";
import { computePortfolioRisk } from "../src/model/risk.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Build backend snapshots (base + one per event) with the real Python code. */
function snapshots() {
  const script = [
    "import json",
    "from backend.server import TEMPLATE, build_snapshot",
    "from backend.events import EVENTS",
    "t = json.loads(TEMPLATE.read_text())",
    "out = {'base': build_snapshot(t, [])}",
    "out.update({e: build_snapshot(t, [e]) for e in EVENTS})",
    "print(json.dumps(out, allow_nan=False))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", script], { cwd: root, encoding: "utf8", maxBuffer: 16 << 20 }));
}

const decisions = (risk) => Object.fromEntries(risk.positions.map((p) => [p.position.id, p.decision]));

test("refresh preserves local incident, hidden backend incident and status override", () => {
  const remote = [{ id: "remote", status: "active", title: "before" }, { id: "hidden", status: "active" }];
  const local = [{ id: "local", status: "active" }];
  const result = mergeIncidents(remote.map((i) => ({ ...i, title: "updated" })), local, { remote: "resolved" }, ["hidden"]);
  assert.deepEqual(result.map((i) => i.id), ["local", "remote"]);
  assert.equal(result[1].status, "resolved");
  assert.equal(result[1].title, "updated");
});

test("every simulated event runs through the risk engine and raises expected loss", () => {
  const all = snapshots();
  const base = computePortfolioRisk(all.base, all.base.incidents);
  for (const [id, snap] of Object.entries(all)) {
    if (id === "base") continue;
    const risk = computePortfolioRisk(snap, snap.incidents);
    assert.ok(Number.isFinite(risk.varUsd), id);
    assert.ok(risk.totalElUsd > base.totalElUsd, `${id} should raise EL`);
  }
});

test("blocked exits never produce EXIT; partial liquidity still allows a partial exit", () => {
  const all = snapshots();
  const halt = computePortfolioRisk(all["solana-outage"], all["solana-outage"].incidents);
  for (const p of halt.positions.filter((p) => p.position.chain === "solana")) {
    assert.equal(p.exitableFraction, 0);
    assert.equal(p.decision, "WATCH", p.position.id);
  }
  const run = computePortfolioRisk(all["kamino-usdc-run"], all["kamino-usdc-run"].incidents);
  const kamino = run.byId.get("pos-kamino-usdc");
  assert.ok(kamino.exitableFraction < 0.1);
  assert.equal(kamino.decision, "EXIT");
  assert.ok(Math.abs(kamino.avoidableElUsd - kamino.excessElUsd * kamino.exitableFraction) < 1e-6);
  assert.equal(decisions(computePortfolioRisk(all.base, all.base.incidents))["pos-kamino-usdc"], "STAY");
});
