import type { ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ViewGraph } from "./graphView";

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 104;
export type Point = { x: number; y: number };
export type Port = { id: string; side: "source" | "target"; y: number };
export type RoutedLayout = {
  positions: Record<string, Point>;
  ports: Record<string, Port[]>;
  routes: Record<string, Point[]>;
};
// Keep the layout engine out of the main application bundle.
const elkReady = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
export const portId = (edgeId: string, side: "source" | "target") =>
  `${edgeId}:${side}`;

// Give every relationship a separate port: different lines must not share a
// trunk, which would suggest an extra connection in a dependency graph.
export async function layoutGraph(view: ViewGraph): Promise<RoutedLayout> {
  const elk = await elkReady;
  const ports: RoutedLayout["ports"] = {};
  const sortedEdges = [...view.edges].sort((a, b) => a.id.localeCompare(b.id));
  const children = [...view.nodes].sort((a, b) => a.id.localeCompare(b.id)).map((n) => {
    ports[n.id] = [];
    for (const side of ["source", "target"] as const) {
      const attached = sortedEdges.filter((e) => e[side] === n.id);
      attached.forEach((e, index) => ports[n.id].push({
        id: portId(e.id, side), side,
        y: 14 + (NODE_HEIGHT - 28) * (index + 1) / (attached.length + 1),
      }));
    }
    return {
      id: n.id, width: NODE_WIDTH, height: NODE_HEIGHT,
      layoutOptions: { "elk.portConstraints": "FIXED_POS" },
      ports: ports[n.id].map((p) => ({
        id: p.id, x: p.side === "source" ? NODE_WIDTH : 0,
        y: p.y, width: 0, height: 0,
        layoutOptions: { "elk.port.side": p.side === "source" ? "EAST" : "WEST" },
      })),
    };
  });
  const graph: ElkNode = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.mergeEdges": "false",
      "elk.spacing.nodeNode": "40", "elk.spacing.edgeEdge": "18",
      "elk.layered.spacing.nodeNodeBetweenLayers": "110",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
    },
    children,
    edges: sortedEdges.map((e) => ({
      id: e.id, sources: [portId(e.id, "source")], targets: [portId(e.id, "target")],
    })),
  });
  const positions = Object.fromEntries((graph.children ?? []).map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
  const routes = Object.fromEntries((graph.edges ?? []).map((e) => {
    const section = e.sections?.[0];
    if (!section) throw new Error(`No connection route for ${e.id}`);
    return [e.id, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]];
  }));
  return { positions, ports, routes };
}

export function routePath(points: Point[]) {
  return points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
}

// Keep the label on a real, long segment rather than on an unrelated box.
export function routeLabel(points: Point[]): Point {
  let best = 0, label = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const score = Math.abs(a.y - b.y) < 1e-6 ? length : length / 3;
    if (score > best) { best = score; label = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  }
  return label;
}
