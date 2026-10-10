import { useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Incident, Warning } from "./protocol";
import { useRiskSnapshot } from "./data/useRiskSnapshot";
import { mergeIncidents } from "./data/incidentEdits";
import { computePortfolioRisk } from "./model/risk";
import { nodeWarnings } from "./model/warnings";
import { GraphView, type Selection } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { DetailPanel } from "./components/DetailPanel";

export function App() {
  const [events, setEvents] = useState<string[]>([]);
  const { snapshot, catalogue, offline } = useRiskSnapshot(events);
  const [localIncidents, setLocalIncidents] = useState<Incident[]>([]);
  const [statusOverrides, setStatusOverrides] = useState<Record<string, Incident["status"]>>({});
  const [hiddenIncidents, setHiddenIncidents] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [focusPositionId, setFocusPositionId] = useState<string | null>(null);
  const [chainFilter, setChainFilter] = useState("all");

  const incidents = useMemo(() => mergeIncidents(snapshot?.incidents ?? [], localIncidents,
    statusOverrides, hiddenIncidents), [snapshot, localIncidents, statusOverrides, hiddenIncidents]);

  const risk = useMemo(() => (snapshot ? computePortfolioRisk(snapshot, incidents) : null), [snapshot, incidents]);
  const warnings = useMemo(() => {
    const m = new Map<string, Warning[]>();
    if (snapshot && risk) for (const n of snapshot.nodes) m.set(n.id, nodeWarnings(n, snapshot, risk));
    return m;
  }, [snapshot, risk]);

  if (!snapshot || !risk) return <div className="splash">Loading snapshot…</div>;
  const edited = localIncidents.length > 0 || hiddenIncidents.length > 0 || Object.keys(statusOverrides).length > 0;

  return (
    <div className="app">
      <header>
        <div className="brand">
          <b>Belem</b> · DeFi dependency risk
        </div>
        <div className="legend">
          <span><i className="lg lg-incident" /> incident</span>
          <span><i className="lg lg-contagion" /> contagion path</span>
          <span><i className="lg lg-high" /> high warning</span>
          <span><i className="lg lg-medium" /> medium warning</span>
          <span className="muted">bar = share of AUM depending on node</span>
        </div>
        <div className="muted small">
          {snapshot.source.toUpperCase()} · {new Date(snapshot.asOf).toISOString().slice(0, 16).replace("T", " ")} UTC
        </div>
      </header>
      <div className={`sim-bar ${offline ? "offline" : ""}`} role="status">
        <span className="sim-mode">
          {offline ? "BACKEND OFFLINE · static mock, retrying" : "SIMULATION · toggle risk events"}
        </span>
        <div className="sim-events">
          {catalogue.map((e) => (
            <button
              key={e.id}
              className={events.includes(e.id) ? "on" : ""}
              title={e.description}
              disabled={offline}
              onClick={() => setEvents((xs) => (xs.includes(e.id) ? xs.filter((x) => x !== e.id) : [...xs, e.id]))}
            >
              {e.title}
            </button>
          ))}
          {edited && (
            <button className="reset" onClick={() => { setLocalIncidents([]); setHiddenIncidents([]); setStatusOverrides({}); }}>
              Reset incident edits
            </button>
          )}
        </div>
      </div>
      <Sidebar
        snapshot={snapshot}
        risk={risk}
        incidents={incidents}
        selection={selection}
        onSelect={setSelection}
        focusPositionId={focusPositionId}
        onFocus={setFocusPositionId}
        chainFilter={chainFilter}
        onChainFilter={setChainFilter}
        onToggleIncident={(id) => {
          const current = incidents.find((i) => i.id === id);
          if (current) setStatusOverrides((xs) => ({ ...xs, [id]: current.status === "active" ? "resolved" : "active" }));
        }}
        onRemoveIncident={(id) => setHiddenIncidents((xs) => [...xs, id])}
      />
      <main>
        <ReactFlowProvider>
          <GraphView
            snapshot={snapshot}
            risk={risk}
            warnings={warnings}
            selection={selection}
            onSelect={setSelection}
            focusPositionId={focusPositionId}
            chainFilter={chainFilter}
          />
        </ReactFlowProvider>
      </main>
      <DetailPanel
        snapshot={snapshot}
        risk={risk}
        warnings={warnings}
        selection={selection}
        onSelect={setSelection}
        onAddIncident={(inc) => setLocalIncidents((xs) => [inc, ...xs])}
      />
    </div>
  );
}
