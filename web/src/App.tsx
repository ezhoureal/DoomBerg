import { useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { Incident, RiskSnapshot, Warning } from "./protocol";
import { loadSnapshot } from "./data/source";
import { computePortfolioRisk } from "./model/risk";
import { nodeWarnings } from "./model/warnings";
import { GraphView, type Selection } from "./components/GraphView";
import { Sidebar } from "./components/Sidebar";
import { DetailPanel } from "./components/DetailPanel";

export function App() {
  const [snapshot, setSnapshot] = useState<RiskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [focusPositionId, setFocusPositionId] = useState<string | null>(null);
  const [chainFilter, setChainFilter] = useState("all");

  useEffect(() => {
    loadSnapshot()
      .then((s) => {
        setSnapshot(s);
        setIncidents(s.incidents);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const risk = useMemo(() => (snapshot ? computePortfolioRisk(snapshot, incidents) : null), [snapshot, incidents]);
  const warnings = useMemo(() => {
    const m = new Map<string, Warning[]>();
    if (snapshot && risk) for (const n of snapshot.nodes) m.set(n.id, nodeWarnings(n, snapshot, risk));
    return m;
  }, [snapshot, risk]);

  if (error) return <div className="splash error">{error}</div>;
  if (!snapshot || !risk) return <div className="splash">Loading snapshot…</div>;

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
          {snapshot.source === "mock" ? "MOCK DATA" : "LIVE"} · {new Date(snapshot.asOf).toISOString().slice(0, 16).replace("T", " ")} UTC
        </div>
      </header>
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
        onToggleIncident={(id) =>
          setIncidents((xs) =>
            xs.map((i) => (i.id === id ? { ...i, status: i.status === "active" ? "resolved" : "active" } : i)),
          )
        }
        onRemoveIncident={(id) => setIncidents((xs) => xs.filter((i) => i.id !== id))}
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
        onAddIncident={(inc) => setIncidents((xs) => [inc, ...xs])}
      />
    </div>
  );
}
