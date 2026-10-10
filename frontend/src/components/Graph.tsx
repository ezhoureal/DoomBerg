import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import EvidenceBadge from "./EvidenceBadge";
import { relationLabel, topologyKey } from "../ui/workspace";
import {
  graphView,
  GROUPS,
  type GroupKey,
  type ViewGraph,
} from "../ui/graphView";
export type ColorMode = "risk" | "type";
const W = 260,
  H = 104;
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
      className={`dep-node ${n.type === "group" ? "group-node" : ""} ${selected ? "graph-selected" : ""} ${onPath ? "on-failure-path" : ""} ${isShock ? "shock" : ""}`}
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
        {n.type !== "group" && <EvidenceBadge node={n} />}
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
  active = true,
}: Props) {
  const rf = useReactFlow();
  const fitted = useRef<{ positionId: string; request: number } | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [all, setAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<GroupKey>>(new Set());
  const [pathOnly, setPathOnly] = useState(false);
  const [labels, setLabels] = useState(false);
  const [dragged, setDragged] = useState<
    Record<string, { x: number; y: number }>
  >({});
  useEffect(() => {
    setExpanded(new Set());
    setAll(false);
    setPathOnly(false);
    setDragged({});
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
  const shape = topologyKey(view);
  const positions = useMemo(() => layout(view), [shape]);
  const neighbours = new Set(selected ? [selected] : []);
  view.edges.forEach((e) => {
    if (e.source === selected || e.target === selected) {
      neighbours.add(e.source);
      neighbours.add(e.target);
    }
  });
  const nodes: Node<DepData>[] = view.nodes.map((n) => ({
    id: n.id,
    type: "dep",
    position: dragged[n.id] ?? positions[n.id],
    // Use the same box dimensions for React Flow and Dagre. Selection only
    // changes the highlight, so it cannot enlarge a card into its neighbour.
    style: { width: W, height: H },
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
        (!!selected && !neighbours.has(n.id) && !pathNodes.has(n.id)) ||
        (!!result &&
          n.type !== "group" &&
          !pathNodes.has(n.id) &&
          (result.node_losses[n.id] ?? 0) < 0.0001),
    },
  }));
  const edges: Edge[] = view.edges.map((e) => {
    const hot = pathEdges.has(`${e.source}>${e.target}`);
    const connected = e.source === selected || e.target === selected;
    const color = hot ? "#b45345" : connected ? "#4e645d" : "#8b8780";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      animated: hot,
      label: hot || connected || labels ? relationLabel(e.type) : undefined,
      labelStyle: {
        fill: hot ? "#9c342b" : "#4a4843",
        fontSize: 11,
        fontWeight: 500,
      },
      labelBgStyle: { fill: "#fff", fillOpacity: 0.95 },
      labelBgPadding: [4, 2],
      style: {
        stroke: color,
        strokeWidth: hot || connected ? 2.4 : 1.8,
        opacity: selected && !connected && !hot ? 0.3 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 20,
        height: 20,
        markerUnits: "userSpaceOnUse",
        color,
      },
    };
  });
  useEffect(() => {
    // Fit a newly loaded investment or an explicit reset. Selecting nodes,
    // expanding groups and switching tabs must preserve the user's zoom.
    if (
      !active ||
      (fitted.current?.positionId === analysis.position_id &&
        fitted.current.request === fitRequest)
    )
      return;
    const t = setTimeout(() => {
      rf.fitView({ padding: 0.15, duration: 250 });
      fitted.current = {
        positionId: analysis.position_id,
        request: fitRequest,
      };
    }, 80);
    return () => clearTimeout(t);
  }, [analysis.position_id, fitRequest, rf, active]);
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
          className={`tool-button ${labels ? "on" : ""}`}
          aria-pressed={labels}
          onClick={() => setLabels(!labels)}
        >
          Connection labels
        </button>
        <button
          className="tool-button"
          onClick={() => {
            setExpanded(new Set());
            setAll(false);
            setPathOnly(false);
            setDragged({});
            setFitRequest((request) => request + 1);
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
          onNodeDragStop={(_, n) =>
            setDragged((old) => ({ ...old, [n.id]: n.position }))
          }
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
          mean “depends on” · Select a component to highlight connections
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
  active?: boolean;
};
export default function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
