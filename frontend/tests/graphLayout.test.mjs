import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutGraph, NODE_WIDTH, NODE_HEIGHT, portId } from "../src/ui/graphLayout.ts";

const nodes = ["position", "market", "collateral", "oracle", "issuer", "chain"];
const links = [["position", "market"], ["position", "collateral"],
  ["market", "oracle"], ["market", "collateral"], ["market", "chain"],
  ["collateral", "issuer"], ["collateral", "chain"], ["oracle", "chain"],
  ["issuer", "chain"], ["market", "oracle"]];
const view = {
  nodes: nodes.map((id) => ({ id })),
  edges: links.map(([source, target], i) => ({ id: `edge-${i}`, source, target })),
  groups: {},
};
function rangeOverlap(a, b, c, d) {
  return Math.min(Math.max(a, b), Math.max(c, d)) - Math.max(Math.min(a, b), Math.min(c, d));
}
const equal = (a, b) => Math.abs(a - b) < 1e-6;
test("fan-out, shared dependencies and parallel relationships have separate routes outside boxes", async () => {
  const before = JSON.stringify(view), layout = await layoutGraph(view);
  assert.equal(JSON.stringify(view), before);
  const segments = [];
  for (const edge of view.edges) {
    const points = layout.routes[edge.id];
    assert.ok(points.length >= 2);
    for (const side of ["source", "target"]) {
      const id = edge[side], pos = layout.positions[id];
      const port = layout.ports[id].find((p) => p.id === portId(edge.id, side));
      const endpoint = points[side === "source" ? 0 : points.length - 1];
      assert.ok(equal(endpoint.x, pos.x + (side === "source" ? NODE_WIDTH : 0)));
      assert.ok(Math.abs(endpoint.y - pos.y - port.y) < 0.01);
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      assert.ok(equal(a.x, b.x) || equal(a.y, b.y), "Connections are orthogonal");
      segments.push({ id: edge.id, a, b });
      for (const [id, p] of Object.entries(layout.positions)) {
        const inside = equal(a.x, b.x)
          ? a.x > p.x + 0.01 && a.x < p.x + NODE_WIDTH - 0.01 && rangeOverlap(a.y, b.y, p.y, p.y + NODE_HEIGHT) > 0.01
          : a.y > p.y + 0.01 && a.y < p.y + NODE_HEIGHT - 0.01 && rangeOverlap(a.x, b.x, p.x, p.x + NODE_WIDTH) > 0.01;
        assert.equal(inside, false, `${edge.id} must not run through ${id}`);
      }
    }
  }
  for (let i = 0; i < segments.length; i++) for (const other of segments.slice(i + 1)) {
    const s = segments[i];
    if (s.id === other.id) continue;
    for (const [axis, along] of [["x", "y"], ["y", "x"]]) {
      const shared = equal(s.a[axis], s.b[axis]) && equal(s.a[axis], other.a[axis]) && equal(s.a[axis], other.b[axis])
        && rangeOverlap(s.a[along], s.b[along], other.a[along], other.b[along]) > 0.01;
      assert.equal(shared, false, `${s.id} and ${other.id} must not share a line segment`);
    }
  }
});
test("each connection gets a unique attachment even with parallel relationships", async () => {
  const graph = await layoutGraph(view);
  for (const ports of Object.values(graph.ports)) {
    for (const side of ["source", "target"]) {
      const sameSide = ports.filter((p) => p.side === side);
      assert.equal(new Set(sameSide.map((p) => p.y)).size, sameSide.length);
    }
  }
});
test("layout is repeatable and unaffected by input order", async () => {
  const a = await layoutGraph(view);
  const b = await layoutGraph({ ...view, nodes: [...view.nodes].reverse(), edges: [...view.edges].reverse() });
  assert.deepEqual(a, b);
});
