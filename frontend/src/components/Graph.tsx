import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
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
// View settings live in the workspace so they survive the graph unmounting while Results is open.
export type GraphUi = {
  all: boolean;
  labels: boolean;
  expanded: Set<GroupKey>;
  pathOnly: boolean;
  // "Reset view" collapses even the groups holding the selection or scenario, until either changes.
  collapsedFor: string | null;
};
export const initialGraphUi: GraphUi = {
  all: false,
  labels: false,
  expanded: new Set(),
  pathOnly: false,
  collapsedFor: null,
};
function Inner({
  analysis,
  result,
  selected,
  onSelect,
  colorMode,
  active = true,
  ui,
  onUi,
}: Props) {
  const rf = useReactFlow();
  // Every open investment keeps its graph mounted, so each React Flow needs
  // its own id or their SVG marker and background pattern ids collide.
  const flowId = `graph-${useId().replace(/[^\w-]/g, "")}`;
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef<string | null>(null);
  // The graph stays fitted while its canvas resizes (the inspector opening,
  // a tab becoming visible) until the user pans or zooms it themselves.
  const autoFit = useRef(true);
  const moveStart = useRef<Viewport | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const { all, expanded, pathOnly, labels } = ui;
  const revealKey = `${selected}|${result?.shock.node_id}|${result?.shock.mode}`;
  const revealOn = ui.collapsedFor !== revealKey;
  const pathNodes = useMemo(
    () =>
      new Set(result?.paths.flatMap((p) => p.hops.map((h) => h.node_id)) ?? []),
    [result],
  );
  const reveal = revealOn
    ? [selected, result?.shock.node_id, ...pathNodes].filter(
        (id): id is string => !!id,
      )
    : [];
  const revealIds = reveal.join(",");
  const base = useMemo(
    () =>
      graphView(analysis, expanded, all, revealIds ? revealIds.split(",") : []),
    [analysis, expanded, all, revealIds],
  );
  // Members of a collapsed group are drawn as that group.
  const shown = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of base.nodes)
      for (const id of (n.attrs.members as string[] | undefined) ?? [])
        m.set(id, n.id);
    return (id: string) => m.get(id) ?? id;
  }, [base]);
  const pathView = useMemo(
    () => new Set([...pathNodes].map(shown)),
    [pathNodes, shown],
  );
  const pathEdges = useMemo(
    () =>
      new Set(
        result?.paths.flatMap((p) =>
          p.hops
            .slice(1)
            .map((h, i) => `${shown(p.hops[i].node_id)}>${shown(h.node_id)}`),
        ) ?? [],
      ),
    [result, shown],
  );
  const view = useMemo(
    () =>
      pathOnly && result
        ? {
            ...base,
            nodes: base.nodes.filter((n) => pathView.has(n.id)),
            edges: base.edges.filter(
              (e) => pathView.has(e.source) && pathView.has(e.target),
            ),
          }
        : base,
    [base, pathOnly, result, pathView],
  );
  // Re-layout only when the drawn graph changes, not on every selection.
  const structure = topologyKey(view);
  const positions = useMemo(() => layout(view), [structure]);
  const selectedVisible = selected ? shown(selected) : null;
  const neighbours = useMemo(() => {
    const ids = new Set(selectedVisible ? [selectedVisible] : []);
    view.edges.forEach((e) => {
      if (e.source === selectedVisible || e.target === selectedVisible) {
        ids.add(e.source);
        ids.add(e.target);
      }
    });
    return ids;
  }, [view, selectedVisible]);
  const lossOf = (n: GNode) => {
    if (!result) return null;
    const ids: string[] = n.type === "group" ? n.attrs.members : [n.id];
    return Math.max(0, ...ids.map((id) => result.node_losses[id] ?? 0));
  };
  const built: Node<DepData>[] = useMemo(
    () =>
      view.nodes.map((n) => {
        const loss = lossOf(n);
        return {
          id: n.id,
          type: "dep",
          position: positions[n.id],
          // Use the same box dimensions for React Flow and Dagre. Selection only
          // changes the highlight, so it cannot enlarge a card into its neighbour.
          style: { width: W, height: H },
          data: {
            n,
            colorMode,
            share: n.risk?.share ?? 0,
            loss: n.type === "group" ? null : loss,
            onPath: pathView.has(n.id),
            isShock: !!result && shown(result.shock.node_id) === n.id,
            selected: !!selected && shown(selected) === n.id,
            dim:
              (!!selected && !neighbours.has(n.id) && !pathView.has(n.id)) ||
              (!!result && !pathView.has(n.id) && (loss ?? 0) < 0.0001),
          },
        };
      }),
    [view, positions, colorMode, result, pathView, shown, selected, neighbours],
  );
  // React Flow keeps measured sizes and drag positions on the node objects it is given,
  // so carry them over when the data changes instead of handing it fresh nodes.
  const [nodes, setNodes] = useState<Node<DepData>[]>(built);
  const laidOut = useRef(positions);
  useEffect(() => {
    const relaid = laidOut.current !== positions;
    laidOut.current = positions;
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return built.map((n) => {
        const o = old.get(n.id);
        return o
          ? {
              ...n,
              measured: o.measured,
              position: relaid ? n.position : o.position,
            }
          : n;
      });
    });
  }, [built, positions]);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<DepData>>[]) =>
      setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const edges: Edge[] = view.edges.map((e) => {
    const hot = pathEdges.has(`${e.source}>${e.target}`);
    const connected =
      e.source === selectedVisible || e.target === selectedVisible;
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
  const fit = () => {
    autoFit.current = true;
    rf.fitView({ padding: 0.15, duration: 250 });
  };
  useEffect(() => {
    // Fit a newly loaded investment, an explicit reset, or a resized canvas
    // the user hasn't moved. Selecting nodes and expanding groups keep the
    // current zoom. fitView waits until React Flow has measured the nodes.
    if (!active || !width || !height) return;
    const key = `${analysis.position_id}:${fitRequest}`;
    if (fitted.current === key && !autoFit.current) return;
    fitted.current = key;
    fit();
  }, [analysis.position_id, fitRequest, active, width, height]);
  const set = (u: Partial<GraphUi>) => onUi({ ...ui, ...u });
  return (
    <>
      <div className="graph-tools">
        <div className="seg small">
          <button
            className={!all ? "on" : ""}
            aria-pressed={!all}
            onClick={() => set({ all: false })}
          >
            Simplified
          </button>
          <button
            className={all ? "on" : ""}
            aria-pressed={all}
            onClick={() => set({ all: true, pathOnly: false })}
          >
            All components
          </button>
        </div>
        {result && (
          <button
            className={`tool-button ${pathOnly ? "on" : ""}`}
            aria-pressed={pathOnly}
            onClick={() => set({ pathOnly: !pathOnly })}
          >
            Failure path
          </button>
        )}
        <button
          className={`tool-button ${labels ? "on" : ""}`}
          aria-pressed={labels}
          onClick={() => set({ labels: !labels })}
        >
          Connection labels
        </button>
        <button
          className="tool-button"
          onClick={() => {
            onUi({
              ...initialGraphUi,
              expanded: new Set(),
              collapsedFor: revealKey,
            });
            setFitRequest((request) => request + 1);
          }}
          title="Collapse groups"
        >
          <RotateCcw size={13} />
          Reset view
        </button>
        <button className="tool-button" onClick={fit} title="Fit graph">
          <Expand size={14} />
        </button>
      </div>
      <div className="graph-canvas">
        <ReactFlow
          id={flowId}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => {
            const group = view.groups[n.id];
            if (group) set({ expanded: new Set([...expanded, group]) });
            else onSelect(n.id);
          }}
          onPaneClick={() => onSelect(null)}
          onMoveStart={(_, viewport) => (moveStart.current = viewport)}
          onMoveEnd={(event, viewport) => {
            // Programmatic moves (fitView) have no source event, and a plain
            // click on the pane starts a move without changing the viewport.
            const start = moveStart.current;
            if (
              event &&
              (start?.x !== viewport.x ||
                start?.y !== viewport.y ||
                start?.zoom !== viewport.zoom)
            )
              autoFit.current = false;
          }}
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
          <Controls
            showInteractive={false}
            position="bottom-right"
            onZoomIn={() => (autoFit.current = false)}
            onZoomOut={() => (autoFit.current = false)}
            onFitView={() => (autoFit.current = true)}
          />
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
            {Object.values(view.groups).map((key) => (
              <button
                key={key}
                onClick={() => set({ expanded: new Set([...expanded, key]) })}
              >
                Expand {GROUPS[key].label.toLowerCase()}
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
  ui: GraphUi;
  onUi: (ui: GraphUi) => void;
};
export default function Graph(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
