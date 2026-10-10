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
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  useNodesInitialized,
  useStore,
  useUpdateNodeInternals,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, Expand, Layers, RotateCcw } from "lucide-react";
import "@xyflow/react/dist/style.css";
import type { Analysis, GNode, ShockResult } from "../types";
import { TYPE_META, lossColor, pct, riskColor } from "../format";
import EvidenceBadge from "./EvidenceBadge";
import { relationLabel, topologyKey } from "../ui/workspace";
import {
  graphView,
  GROUPS,
  type GroupKey,
} from "../ui/graphView";
import { layoutGraph, NODE_WIDTH as W, NODE_HEIGHT as H, portId, routeLabel, routePath, type Port, type Point, type RoutedLayout } from "../ui/graphLayout";
export type ColorMode = "risk" | "type";
type DepData = {
  ports: Port[];
  n: GNode;
  colorMode: ColorMode;
  share: number;
  loss: number | null;
  onPath: boolean;
  isShock: boolean;
  selected: boolean;
  dim: boolean;
};
const DepNode = memo(({ id, data }: NodeProps<Node<DepData>>) => {
  const updateInternals = useUpdateNodeInternals();
  useEffect(() => { updateInternals(id); }, [id, data.ports, updateInternals]);
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
      {data.ports.map((p) => (
        <Handle key={p.id} id={p.id} type={p.side}
          position={p.side === "source" ? Position.Right : Position.Left}
          style={{ top: p.y }} className="h" isConnectable={false} />
      ))}
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
    </div>
  );
});
const nodeTypes = { dep: DepNode };
const RoutedEdge = memo((props: EdgeProps<Edge<{ points: Point[] }>>) => {
  const points = props.data?.points;
  if (!points?.length) return null;
  const path = routePath(points), label = routeLabel(points);
  return <>
    {/* The casing breaks the lower line at a crossing: crossing is not a junction. */}
    <path d={path} fill="none" stroke="#fdfcfb" strokeWidth={8}
      strokeLinejoin="round" style={{ pointerEvents: "none" }} />
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd}
      style={{ ...props.style, strokeLinejoin: "round" }} label={props.label}
      labelX={label.x} labelY={label.y} labelStyle={props.labelStyle}
      labelBgStyle={props.labelBgStyle} labelBgPadding={props.labelBgPadding} />
  </>;
});
const edgeTypes = { routed: RoutedEdge };
const emptyPositions: Record<string, Point> = {};
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
  const nodesInitialized = useNodesInitialized();
  // Every open investment keeps its graph mounted, so each React Flow needs
  // its own id or their SVG marker and background pattern ids collide.
  const flowId = `graph-${useId().replace(/[^\w-]/g, "")}`;
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const fitted = useRef<string | null>(null);
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
  const [layoutState, setLayoutState] = useState<{ key: string; graph: RoutedLayout } | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLayoutError(null);
    layoutGraph(view).then((graph) => {
      if (!cancelled) setLayoutState({ key: structure, graph });
    }).catch(() => {
      if (!cancelled) setLayoutError("Could not arrange connections. Refresh this investment to retry.");
    });
    return () => { cancelled = true; };
  }, [structure]);
  const ready = layoutState?.key === structure;
  const positions = layoutState?.graph.positions ?? emptyPositions;
  // Highlight connections only when the selection is drawn; "Failure path"
  // can hide it, and dimming everything around nothing helps no one.
  const selectedId = selected ? shown(selected) : null;
  const selectedVisible =
    selectedId && view.nodes.some((n) => n.id === selectedId)
      ? selectedId
      : null;
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
      (ready ? view.nodes : []).map((n) => {
        const loss = lossOf(n);
        return {
          id: n.id,
          type: "dep",
          draggable: false,
          className: "nopan",
          position: positions[n.id],
          // Use the same box dimensions for React Flow and Dagre. Selection only
          // changes the highlight, so it cannot enlarge a card into its neighbour.
          style: { width: W, height: H },
          data: {
            ports: layoutState?.graph.ports[n.id] ?? [],
            n,
            colorMode,
            share: n.risk?.share ?? 0,
            loss: n.type === "group" ? null : loss,
            onPath: pathView.has(n.id),
            isShock: !!result && shown(result.shock.node_id) === n.id,
            selected: !!selected && shown(selected) === n.id,
            dim:
              (!!selectedVisible &&
                !neighbours.has(n.id) &&
                !pathView.has(n.id)) ||
              (!!result && !pathView.has(n.id) && (loss ?? 0) < 0.0001),
          },
        };
      }),
    [
      view,
      ready,
      layoutState,
      positions,
      colorMode,
      result,
      pathView,
      shown,
      selected,
      selectedVisible,
      neighbours,
    ],
  );
  // Preserve React Flow's measurements; positions always come from the fixed layout.
  const [nodes, setNodes] = useState<Node<DepData>[]>(built);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return built.map((n) => {
        const o = old.get(n.id);
        return o
          ? {
              ...n,
              measured: o.measured,
              position: n.position,
            }
          : n;
      });
    });
  }, [built, positions]);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<DepData>>[]) =>
      setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "position" && c.type !== "remove"), ns)),
    [],
  );
  const edges: Edge[] = (ready ? view.edges : []).map((e) => {
    const hot = pathEdges.has(`${e.source}>${e.target}`);
    const connected =
      e.source === selectedVisible || e.target === selectedVisible;
    const color = hot ? "#b45345" : connected ? "#4e645d" : "#8b8780";
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: portId(e.id, "source"),
      targetHandle: portId(e.id, "target"),
      type: "routed",
      data: { points: layoutState!.graph.routes[e.id] },
      reconnectable: false,
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
        opacity: selectedVisible && !connected && !hot ? 0.3 : 1,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        markerUnits: "userSpaceOnUse",
        color,
      },
    };
  });
  const fit = () => {
    rf.fitView({ padding: 0.15, duration: 250 });
  };
  useEffect(() => {
    // Only a new investment or explicit reset fits automatically. Opening an
    // inspector, expanding groups and switching existing tabs preserve zoom.
    if (!active || !width || !height || !ready || !nodesInitialized || nodes.length !== view.nodes.length) return;
    const key = `${analysis.position_id}:${fitRequest}`;
    if (fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [analysis.position_id, fitRequest, active, width, height, ready, nodes.length, nodesInitialized]);
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
        {!ready && <div className="graph-layout-status" role="status">{layoutError ?? "Arranging connections…"}</div>}
        <ReactFlow
          id={flowId}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => {
            const group = view.groups[n.id];
            if (group) set({ expanded: new Set([...expanded, group]) });
            else onSelect(n.id);
          }}
          onPaneClick={() => onSelect(null)}
          minZoom={0.15}
          maxZoom={1.8}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
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
          />
        </ReactFlow>
      </div>
      <div className="graph-footer">
        <span>
          {view.nodes.length} visible / {analysis.stats.nodes} total · Arrows
          mean “depends on” · Select a component to highlight connections
          · Crossings are not connections
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
