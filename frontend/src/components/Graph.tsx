import { memo, useEffect, useMemo } from "react";
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow,
  useReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { Analysis, GNode, ShockResult } from "../types";
import { TYPE_META, lossColor, pct, riskColor, usd } from "../format";

export type ColorMode = "risk" | "type";

const W = 214;
const H = 66;

type DepData = {
  n: GNode;
  colorMode: ColorMode;
  share: number;
  loss: number | null;
  onPath: boolean;
  isShock: boolean;
  selected: boolean;
  dim: boolean;
};

const DepNode = memo(({ data }: NodeProps<Node<DepData>>) => {
  const { n, share, loss, onPath, isShock, selected, dim, colorMode } = data;
  const meta = TYPE_META[n.type] ?? TYPE_META.asset;
  const accent = loss !== null ? lossColor(loss) : colorMode === "risk" ? riskColor(share) : meta.color;
  const sub = n.attrs.subtitle || (n.attrs.tvl_usd ? `TVL ${usd(n.attrs.tvl_usd)}` : meta.label);
  return (
    <div
      className={`dep-node ${selected ? "sel" : ""} ${onPath ? "path" : ""} ${isShock ? "shock" : ""}`}
      style={{ ["--accent" as any]: accent, ["--type" as any]: meta.color, opacity: dim ? 0.28 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="h" />
      <div className="dep-glyph" style={{ color: meta.color }}>{meta.glyph}</div>
      <div className="dep-body">
        <div className="dep-type">{meta.label}{n.risk_factors?.unverified ? " · unverified" : ""}</div>
        <div className="dep-label" title={n.label}>{n.label}</div>
        <div className="dep-sub" title={sub}>{sub}</div>
      </div>
      <div className="dep-badge" style={{ color: accent }}>
        {loss !== null ? (loss > 0.0001 ? `−${pct(loss)}` : "") : share > 0.005 ? pct(share, 0) : ""}
      </div>
      <Handle type="source" position={Position.Right} className="h" />
    </div>
  );
});

const nodeTypes = { dep: DepNode };

function layout(a: Analysis) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", ranksep: 70, nodesep: 14, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  a.graph.nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }));
  a.graph.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  const pos: Record<string, { x: number; y: number }> = {};
  a.graph.nodes.forEach((n) => {
    const p = g.node(n.id);
    pos[n.id] = { x: p.x - W / 2, y: p.y - H / 2 };
  });
  return pos;
}

function Inner({ analysis, result, selected, onSelect, colorMode, fitKey }: Props) {
  const rf = useReactFlow();
  const pos = useMemo(() => layout(analysis), [analysis]);

  const pathNodes = useMemo(() => new Set(result?.paths.flatMap((p) => p.hops.map((h) => h.node_id)) ?? []), [result]);
  const pathEdges = useMemo(() => {
    const s = new Set<string>();
    result?.paths.forEach((p) => p.hops.forEach((h, i) => i && s.add(`${p.hops[i - 1].node_id}>${h.node_id}`)));
    return s;
  }, [result]);

  const nodes: Node<DepData>[] = useMemo(() => analysis.graph.nodes.map((n) => ({
    id: n.id,
    type: "dep",
    position: pos[n.id],
    data: {
      n,
      colorMode,
      share: n.risk?.share ?? 0,
      loss: result ? result.node_losses[n.id] ?? 0 : null,
      onPath: pathNodes.has(n.id),
      isShock: result?.shock.node_id === n.id,
      selected: selected === n.id,
      dim: !!result && !pathNodes.has(n.id) && (result.node_losses[n.id] ?? 0) < 0.0001,
    },
  })), [analysis, pos, result, selected, pathNodes, colorMode]);

  const edges: Edge[] = useMemo(() => analysis.graph.edges.map((e) => {
    const hot = pathEdges.has(`${e.source}>${e.target}`);
    const loss = result ? result.node_losses[e.target] ?? 0 : 0;
    const w = e.type === "allocates_to" ? 1 + 5 * e.weight : 1.2;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: hot,
      label: hot || e.type === "allocates_to" ? (e.type === "allocates_to" ? `${pct(e.weight, 0)}` : e.type.replace("_", " ")) : undefined,
      labelStyle: { fill: hot ? "#ffb4bb" : "#8b97b5", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#0b1020", fillOpacity: 0.85 },
      labelBgPadding: [4, 2] as [number, number],
      style: {
        stroke: hot ? "#ff5d6c" : result && loss > 0.0001 ? "rgba(255,159,67,0.45)" : "rgba(148,163,200,0.22)",
        strokeWidth: hot ? Math.max(2.2, w) : w,
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: hot ? "#ff5d6c" : "rgba(148,163,200,0.45)" },
    };
  }), [analysis, result, pathEdges]);

  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ padding: 0.06, duration: 500 }), 80);
    return () => clearTimeout(t);
  }, [analysis, rf, fitKey]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => onSelect(n.id)}
      onPaneClick={() => onSelect(null)}
      minZoom={0.15}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgba(148,163,200,0.12)" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

type Props = {
  analysis: Analysis;
  result: ShockResult | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  colorMode: ColorMode;
  fitKey: string;
};

export default function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
