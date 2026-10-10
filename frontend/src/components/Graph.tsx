import { memo, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, Expand, Layers, RotateCcw } from "lucide-react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { Analysis, GNode, ShockResult } from "../types";
import { TYPE_META, lossColor, pct, riskColor } from "../format";
import {
  graphView,
  GROUPS,
  type GroupKey,
  type ViewGraph,
} from "../ui/graphView";
export type ColorMode = "risk" | "type";
const W = 220,
  H = 66;
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
  const meta = TYPE_META[n.type] ?? {
    label: "Group",
    glyph: "▤",
    color: "#78716c",
  };
  const accent =
    n.type === "group"
      ? "#78716c"
      : loss !== null
        ? lossColor(loss)
        : colorMode === "risk"
          ? riskColor(share)
          : meta.color;
  return (
    <div
      className={`dep-node ${n.type === "group" ? "group-node" : ""} ${selected ? "sel" : ""} ${onPath ? "path" : ""} ${isShock ? "shock" : ""}`}
      style={{ ["--accent" as any]: accent, opacity: dim ? 0.42 : 1 }}
    >
      <Handle type="target" position={Position.Left} className="h" />
      <div className="dep-glyph" style={{ color: accent }}>
        {n.type === "group" ? <Layers size={17} /> : meta.glyph}
      </div>
      <div className="dep-body">
        <div className="dep-type">
          {meta.label}
          {n.risk_factors.unverified ? " · unverified" : ""}
        </div>
        <div className="dep-label" title={n.label}>
          {n.label}
        </div>
        {n.type === "group" && (
          <div className="dep-sub">{n.attrs.subtitle}</div>
        )}
      </div>
      <div
        className="dep-badge"
        title={
          loss === null
            ? "Share of modeled risk, not failure probability"
            : "Modeled loss in the selected scenario"
        }
        style={{ color: accent }}
      >
        {n.type === "group" ? (
          <ChevronDown size={14} />
        ) : loss !== null ? (
          loss > 0.0001 ? (
            `−${pct(loss)}`
          ) : (
            ""
          )
        ) : colorMode === "risk" && share > 0.005 ? (
          pct(share, 0)
        ) : (
          ""
        )}
      </div>
      <Handle type="source" position={Position.Right} className="h" />
    </div>
  );
});
const nodeTypes = { dep: DepNode };
function layout(view: ViewGraph) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    ranksep: 60,
    nodesep: 28,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));
  view.nodes.forEach((n) => g.setNode(n.id, { width: W, height: H }));
  view.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return Object.fromEntries(
    view.nodes.map((n) => {
      const point = g.node(n.id);
      return [n.id, { x: point.x - W / 2, y: point.y - H / 2 }];
    }),
  );
}
function Inner({
  analysis,
  result,
  selected,
  onSelect,
  colorMode,
  fitKey,
}: Props) {
  const rf = useReactFlow();
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<GroupKey>>(new Set());
  const [pathOnly, setPathOnly] = useState(false);
  useEffect(() => {
    setExpanded(new Set());
    setAll(false);
    setPathOnly(false);
  }, [analysis.position_id]);
  const pathNodes = useMemo(
    () =>
      new Set(result?.paths.flatMap((p) => p.hops.map((h) => h.node_id)) ?? []),
    [result],
  );
  const pathEdges = useMemo(
    () =>
      new Set(
        result?.paths.flatMap((p) =>
          p.hops.slice(1).map((h, i) => `${p.hops[i].node_id}>${h.node_id}`),
        ) ?? [],
      ),
    [result],
  );
  const view = useMemo(() => {
    const reveal = [
      selected,
      result?.shock.node_id,
      ...(result ? [...pathNodes] : []),
    ].filter((id): id is string => !!id);
    const v = graphView(analysis, expanded, all, reveal);
    if (pathOnly && result)
      return {
        ...v,
        nodes: v.nodes.filter((n) => pathNodes.has(n.id)),
        edges: v.edges.filter(
          (e) => pathNodes.has(e.source) && pathNodes.has(e.target),
        ),
      };
    return v;
  }, [analysis, expanded, all, selected, result, pathNodes, pathOnly]);
  const positions = useMemo(() => layout(view), [view]);
  const nodes: Node<DepData>[] = view.nodes.map((n) => ({
    id: n.id,
    type: "dep",
    position: positions[n.id],
    data: {
      n,
      colorMode,
      share: n.risk?.share ?? 0,
      loss:
        result && n.type !== "group" ? (result.node_losses[n.id] ?? 0) : null,
      onPath: pathNodes.has(n.id),
      isShock: result?.shock.node_id === n.id,
      selected: selected === n.id,
      dim:
        !!result &&
        n.type !== "group" &&
        !pathNodes.has(n.id) &&
        (result.node_losses[n.id] ?? 0) < 0.0001,
    },
  }));
  const edges: Edge[] = view.edges.map((e) => {
    const hot = pathEdges.has(`${e.source}>${e.target}`);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      animated: hot,
      label: hot ? e.type.replace(/_/g, " ") : undefined,
      labelStyle: { fill: "#9c342b", fontSize: 10 },
      labelBgStyle: { fill: "#fff", fillOpacity: 0.95 },
      labelBgPadding: [4, 2],
      style: {
        stroke: hot ? "#b45345" : "#c9c5bd",
        strokeWidth: hot ? 2 : 1.2,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: hot ? "#b45345" : "#c9c5bd",
      },
    };
  });
  useEffect(() => {
    const t = setTimeout(
      () => rf.fitView({ padding: 0.15, duration: 250 }),
      80,
    );
    return () => clearTimeout(t);
  }, [view, rf, fitKey]);
  return (
    <>
      <div className="graph-tools">
        <div className="seg small">
          <button
            className={!all ? "on" : ""}
            aria-pressed={!all}
            onClick={() => setAll(false)}
          >
            Simplified
          </button>
          <button
            className={all ? "on" : ""}
            aria-pressed={all}
            onClick={() => {
              setAll(true);
              setPathOnly(false);
            }}
          >
            All components
          </button>
        </div>
        {result && (
          <button
            className={`tool-button ${pathOnly ? "on" : ""}`}
            aria-pressed={pathOnly}
            onClick={() => setPathOnly(!pathOnly)}
          >
            Failure path
          </button>
        )}
        <button
          className="tool-button"
          onClick={() => {
            setExpanded(new Set());
            setAll(false);
            setPathOnly(false);
          }}
          title="Collapse groups"
        >
          <RotateCcw size={13} />
          Reset view
        </button>
        <button
          className="tool-button"
          onClick={() => rf.fitView({ padding: 0.15, duration: 250 })}
          title="Fit graph"
        >
          <Expand size={14} />
        </button>
      </div>
      <div className="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => {
            const group = view.groups[n.id];
            if (group) setExpanded((old) => new Set([...old, group]));
            else onSelect(n.id);
          }}
          onPaneClick={() => onSelect(null)}
          minZoom={0.15}
          maxZoom={1.8}
          nodesDraggable
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="#d8d4cd"
          />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      </div>
      <div className="graph-footer">
        <span>
          {view.nodes.length} visible / {analysis.stats.nodes} total · Arrows
          mean “depends on”
        </span>
        <details>
          <summary>Categories</summary>
          <div className="category-legend">
            {Object.entries(TYPE_META)
              .filter(([key]) =>
                analysis.graph.nodes.some((n) => n.type === key),
              )
              .map(([key, meta]) => (
                <span key={key}>
                  <i style={{ background: meta.color }} />
                  {meta.label}
                </span>
              ))}
            {Object.entries(GROUPS).map(([key, g]) => (
              <button
                key={key}
                onClick={() =>
                  setExpanded((old) => new Set([...old, key as GroupKey]))
                }
              >
                Expand {g.label.toLowerCase()}
              </button>
            ))}
          </div>
        </details>
      </div>
    </>
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
