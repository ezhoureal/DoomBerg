import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position as HandlePos,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import type { GraphNode, RiskSnapshot, Severity, Warning } from "../protocol";
import type { Decision, PortfolioRisk } from "../model/risk";
import { maxSeverity } from "../model/warnings";
import { pct, usd } from "../format";

export type Selection = { kind: "node"; id: string } | { kind: "position"; id: string } | { kind: "portfolio" } | null;

const TYPE_GLYPH: Record<GraphNode["type"], string> = {
  chain: "⛓",
  bridge: "⇄",
  protocol: "▣",
  market: "◫",
  vault: "⬡",
  curator: "☺",
  strategy: "⟲",
  asset: "◉",
  issuer: "⌂",
  custodian: "⛁",
  oracle: "◎",
};

type RiskNodeData = {
  node: GraphNode;
  warnings: Warning[];
  severity: Severity | null;
  incident: boolean;
  contagion: boolean;
  aumShare: number;
  elUsd: number;
  dim: boolean;
  selected: boolean;
};

type PositionNodeData = {
  label: string;
  chain: string;
  valueUsd: number;
  decision: Decision;
  excessElUsd: number;
  exitCostUsd: number;
  contagion: boolean;
  dim: boolean;
  selected: boolean;
};

type PortfolioNodeData = { name: string; aumUsd: number; totalElUsd: number; dim: boolean; selected: boolean };

function RiskNode({ data }: NodeProps<Node<RiskNodeData>>) {
  const { node, severity, incident, contagion, aumShare, warnings, dim, selected } = data;
  return (
    <div
      className={[
        "rn",
        `rn-${node.type}`,
        severity ? `sev-${severity}` : "",
        incident ? "rn-incident" : "",
        contagion ? "rn-contagion" : "",
        dim ? "dim" : "",
        selected ? "selected" : "",
      ].join(" ")}
    >
      <Handle type="target" position={HandlePos.Left} />
      <div className="rn-glyph" title={node.type}>
        {TYPE_GLYPH[node.type]}
      </div>
      <div className="rn-body">
        <div className="rn-label">{node.label}</div>
        <div className="rn-sub">
          <span>{node.type}</span>
          <span className={`chain chain-${node.chain}`}>{node.chain}</span>
        </div>
        <div className="rn-bar" title={`${pct(aumShare, 0)} of AUM depends on this node`}>
          <div style={{ width: `${Math.min(100, aumShare * 100)}%` }} />
        </div>
      </div>
      {warnings.length > 0 && (
        <div className={`rn-badge sev-bg-${severity}`} title={warnings.map((w) => w.message).join("\n")}>
          {incident ? "!" : warnings.length}
        </div>
      )}
      <Handle type="source" position={HandlePos.Right} />
    </div>
  );
}

function PositionNode({ data }: NodeProps<Node<PositionNodeData>>) {
  return (
    <div
      className={["pn", `pn-${data.decision}`, data.contagion ? "rn-contagion" : "", data.dim ? "dim" : "", data.selected ? "selected" : ""].join(" ")}
    >
      <Handle type="target" position={HandlePos.Left} />
      <div className="pn-top">
        <span className={`decision d-${data.decision}`}>{data.decision}</span>
        <span className={`chain chain-${data.chain}`}>{data.chain}</span>
      </div>
      <div className="pn-label">{data.label}</div>
      <div className="pn-stats">
        <span>{usd(data.valueUsd, 0)}</span>
        <span title="Incident-driven expected loss vs exit cost">
          EL {usd(data.excessElUsd)} / exit {usd(data.exitCostUsd)}
        </span>
      </div>
      <Handle type="source" position={HandlePos.Right} />
    </div>
  );
}

function PortfolioNode({ data }: NodeProps<Node<PortfolioNodeData>>) {
  return (
    <div className={["pf", data.dim ? "dim" : "", data.selected ? "selected" : ""].join(" ")}>
      <div className="pf-label">{data.name}</div>
      <div className="pf-stats">
        AUM {usd(data.aumUsd, 0)} · EL {usd(data.totalElUsd)}
      </div>
      <Handle type="source" position={HandlePos.Right} />
    </div>
  );
}

const nodeTypes = { risk: RiskNode, position: PositionNode, portfolio: PortfolioNode };

const SIZE = {
  risk: { w: 210, h: 62 },
  position: { w: 240, h: 86 },
  portfolio: { w: 200, h: 70 },
} as const;

interface Props {
  snapshot: RiskSnapshot;
  risk: PortfolioRisk;
  warnings: Map<string, Warning[]>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  focusPositionId: string | null;
  chainFilter: string;
}

export function GraphView({ snapshot, risk, warnings, selection, onSelect, focusPositionId, chainFilter }: Props) {
  const { nodes, edges } = useMemo(() => {
    const positions = snapshot.positions.filter(
      (p) => (!focusPositionId || p.id === focusPositionId) && (chainFilter === "all" || p.chain === chainFilter),
    );
    const visible = new Set<string>();
    for (const p of positions) for (const id of risk.byId.get(p.id)!.reach.keys()) visible.add(id);

    // Contagion set: nodes from which an active incident node is reachable (incl. itself).
    const incidentNodes = new Set([...risk.nodeRisk].filter(([, r]) => r.incidents.length).map(([id]) => id));
    const contagion = new Set<string>();
    const parents = new Map<string, string[]>();
    for (const e of snapshot.edges) {
      if (!parents.has(e.to)) parents.set(e.to, []);
      parents.get(e.to)!.push(e.from);
    }
    const stack = [...incidentNodes];
    while (stack.length) {
      const id = stack.pop()!;
      if (contagion.has(id)) continue;
      contagion.add(id);
      stack.push(...(parents.get(id) ?? []));
    }

    // Highlight set for the current selection: everything upstream and downstream.
    let highlight: Set<string> | null = null;
    if (selection?.kind === "node" || selection?.kind === "position") {
      highlight = new Set();
      const children = new Map<string, string[]>();
      for (const e of snapshot.edges) {
        if (!children.has(e.from)) children.set(e.from, []);
        children.get(e.from)!.push(e.to);
      }
      const walk = (start: string, adj: Map<string, string[]>) => {
        const seen = new Set([start]);
        const st = [start];
        while (st.length) for (const n of adj.get(st.pop()!) ?? []) if (!seen.has(n)) (seen.add(n), st.push(n));
        for (const id of seen) highlight!.add(id);
      };
      if (selection.kind === "node") {
        walk(selection.id, children);
        walk(selection.id, parents);
        for (const p of positions) if (risk.byId.get(p.id)!.reach.has(selection.id)) highlight.add(p.id);
      } else {
        const p = snapshot.positions.find((x) => x.id === selection.id)!;
        highlight.add(p.id);
        walk(p.entryNodeId, children);
      }
      highlight.add("portfolio");
    }
    const dim = (id: string) => (highlight ? !highlight.has(id) : false);

    const rfNodes: Node[] = [
      {
        id: "portfolio",
        type: "portfolio",
        position: { x: 0, y: 0 },
        data: {
          name: snapshot.portfolio.name,
          aumUsd: snapshot.portfolio.aumUsd,
          totalElUsd: risk.totalElUsd,
          dim: false,
          selected: selection?.kind === "portfolio",
        },
      },
    ];
    const rfEdges: Edge[] = [];

    for (const p of positions) {
      const pr = risk.byId.get(p.id)!;
      const inContagion = contagion.has(p.entryNodeId);
      rfNodes.push({
        id: p.id,
        type: "position",
        position: { x: 0, y: 0 },
        data: {
          label: p.label,
          chain: p.chain,
          valueUsd: p.valueUsd,
          decision: pr.decision,
          excessElUsd: pr.excessElUsd,
          exitCostUsd: pr.exitCostUsd,
          contagion: inContagion,
          dim: dim(p.id),
          selected: selection?.kind === "position" && selection.id === p.id,
        },
      });
      rfEdges.push(edge("portfolio", p.id, `${pct(p.valueUsd / snapshot.portfolio.aumUsd, 0)}`, inContagion, dim(p.id)));
      rfEdges.push(edge(p.id, p.entryNodeId, undefined, inContagion, dim(p.id) || dim(p.entryNodeId)));
    }

    for (const n of snapshot.nodes) {
      if (!visible.has(n.id)) continue;
      const ws = warnings.get(n.id) ?? [];
      const exp = risk.nodeExposure.get(n.id)!;
      rfNodes.push({
        id: n.id,
        type: "risk",
        position: { x: 0, y: 0 },
        data: {
          node: n,
          warnings: ws,
          severity: maxSeverity(ws.filter((w) => w.severity !== "info")),
          incident: risk.nodeRisk.get(n.id)!.incidents.length > 0,
          contagion: contagion.has(n.id),
          aumShare: exp.aumUsd / snapshot.portfolio.aumUsd,
          elUsd: exp.elUsd,
          dim: dim(n.id),
          selected: selection?.kind === "node" && selection.id === n.id,
        } satisfies RiskNodeData,
      });
    }
    for (const e of snapshot.edges) {
      if (!visible.has(e.from) || !visible.has(e.to)) continue;
      const parts: string[] = [];
      if (e.exposure < 1) parts.push(pct(e.exposure, 0));
      if (e.transmission !== 1) parts.push(`×${e.transmission}`);
      rfEdges.push(edge(e.from, e.to, parts.join(" ") || undefined, contagion.has(e.to), dim(e.from) || dim(e.to), e.kind));
    }

    return { nodes: layout(rfNodes, rfEdges), edges: rfEdges };
  }, [snapshot, risk, warnings, selection, focusPositionId, chainFilter]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.1}
      fitView
      onNodeClick={(_, n) =>
        onSelect(n.type === "position" ? { kind: "position", id: n.id } : n.type === "portfolio" ? { kind: "portfolio" } : { kind: "node", id: n.id })
      }
      onPaneClick={() => onSelect(null)}
      proOptions={{ hideAttribution: true }}
    >
      <FitOnChange deps={`${focusPositionId}|${chainFilter}`} />
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable nodeStrokeWidth={3} nodeColor={miniColor} />
    </ReactFlow>
  );
}

function FitOnChange({ deps }: { deps: string }) {
  const rf = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ duration: 300, padding: 0.1 }), 30);
    return () => clearTimeout(t);
  }, [deps, rf]);
  return null;
}

function miniColor(n: Node) {
  if (n.type === "position") return "var(--accent)";
  const d = n.data as Partial<RiskNodeData>;
  if (d.incident) return "var(--sev-critical)";
  if (d.contagion) return "var(--sev-high)";
  return "var(--muted)";
}

function edge(from: string, to: string, label: string | undefined, contagion: boolean, dim: boolean, kind?: string): Edge {
  return {
    id: `${from}->${to}`,
    source: from,
    target: to,
    label,
    animated: contagion && !dim,
    className: [contagion ? "e-contagion" : "", dim ? "dim" : ""].join(" "),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    data: { kind },
    labelBgPadding: [4, 2],
    labelBgBorderRadius: 4,
  };
}

function layout(nodes: Node[], edges: Edge[]): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 14, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    const s = SIZE[n.type as keyof typeof SIZE];
    g.setNode(n.id, { width: s.w, height: s.h });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    const s = SIZE[n.type as keyof typeof SIZE];
    return { ...n, position: { x: p.x - s.w / 2, y: p.y - s.h / 2 } };
  });
}
