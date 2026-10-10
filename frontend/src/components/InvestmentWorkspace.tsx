import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  GitBranch,
  Plus,
  Shield,
  X,
  FlaskConical,
  FileText,
} from "lucide-react";
import { api } from "../api";
import type { Analysis, Catalog, ShockResult } from "../types";
import Graph, {
  initialGraphUi,
  type ColorMode,
  type GraphUi,
} from "./Graph";
import PositionForm from "./PositionForm";
import TopRisks from "./TopRisks";
import Inspector from "./Inspector";
import Answer from "./Answer";
import { CHAINS, pct, usd } from "../format";

type View = "dependencies" | "scenarios" | "results";
export default function InvestmentWorkspace({
  initialAnalysis,
  catalog,
  service,
  active,
  investmentTabs,
  onAdd,
  onAnalysis,
  onBusy,
}: {
  initialAnalysis: Analysis | null;
  catalog: Catalog | null;
  service: string;
  active: boolean;
  investmentTabs: ReactNode;
  onAdd: () => void;
  onAnalysis: (analysis: Analysis) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [analysis, setAnalysis] = useState<Analysis | null>(initialAnalysis);
  const [result, setResult] = useState<ShockResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preMode, setPreMode] = useState<string | null>(null);
  const [busy, setBusy] = useState<"analyze" | "shock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("type");
  const [view, setView] = useState<View>("dependencies");
  const [positionOpen, setPositionOpen] = useState(false);
  const [tracedAt, setTracedAt] = useState<string | null>(() =>
    initialAnalysis ? traceTime() : null,
  );
  const [graphUi, setGraphUi] = useState<GraphUi>(initialGraphUi);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    onBusy(!!busy);
  }, [busy, onBusy]);
  useEffect(() => {
    if (!active) setPositionOpen(false);
  }, [active]);
  useEffect(() => {
    if (positionOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [positionOpen]);
  const analyze = async (req: Parameters<typeof api.analyze>[0]) => {
    setBusy("analyze");
    setError(null);
    try {
      const next = await api.analyze(req);
      setAnalysis(next);
      onAnalysis(next);
      setResult(null);
      setSelected(null);
      setPreMode(null);
      setView("dependencies");
      setGraphUi(initialGraphUi);
      setTracedAt(traceTime());
      setPositionOpen(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const shock = async (r: {
    node_id: string;
    mode: string;
    alert: string;
    probability_override: number | null;
    exit_cost_override: number | null;
  }) => {
    if (!analysis) return;
    setBusy("shock");
    setError(null);
    try {
      setResult(await api.shock({ position_id: analysis.position_id, ...r }));
      setView("results");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const replay = async (
    incident_id: string,
    exit_cost_override: number | null,
  ) => {
    if (!analysis) return;
    setBusy("shock");
    setError(null);
    try {
      const r = await api.replay({
        position_id: analysis.position_id,
        incident_id,
        exit_cost_override,
      });
      setResult(r);
      setSelected(r.shock.node_id);
      setView("results");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const pt = analysis?.graph.nodes.find(
    (n) => n.type === "asset" && n.attrs.kind === "pt",
  );
  const market = analysis?.graph.nodes.find((n) => n.type === "market");
  const choose = (id: string | null) => {
    setSelected(id);
    setPreMode(null);
  };
  const tabs: { id: View; label: string; icon: typeof GitBranch }[] = [
    { id: "dependencies", label: "Dependencies", icon: GitBranch },
    { id: "scenarios", label: "Scenarios", icon: FlaskConical },
    { id: "results", label: "Results", icon: FileText },
  ];
  return (
    <div className="app">
      <aside className="workspace-nav">
        <div className="workspace-brand">
          <span className="brand-mark">D.</span>
          <div>
            <b>Doomberg Terminal</b>
            <small>Belem Capital</small>
          </div>
        </div>
        <span className="nav-caption">Risk workspace</span>
        <nav aria-label="Workspace">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${view === t.id ? "active" : ""}`}
              disabled={t.id === "results" && !result}
              onClick={() => setView(t.id)}
            >
              <t.icon size={16} />
              {t.label}
              {t.id === "results" && result && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        {!analysis && (
          <button className="new-position" onClick={onAdd}>
            <Plus size={15} /> Add investment
          </button>
        )}
        {analysis && (
          <div className="nav-risk">
            <TopRisks
              analysis={analysis}
              onPick={(n, m) => {
                setSelected(n);
                setPreMode(m);
                setView("scenarios");
              }}
            />
          </div>
        )}
        {investmentTabs}
        <div className="nav-footer">
          <Shield size={15} />
          <span>
            Belem Capital<small>Investment risk research</small>
          </span>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span>
            Belem Capital <ChevronRight size={13} /> Risk workspace{" "}
            <ChevronRight size={13} />{" "}
            <b>{tabs.find((t) => t.id === view)?.label}</b>
          </span>
          <span className={`service-state ${service.toLowerCase()}`}>
            <i />
            {service}
          </span>
        </header>
        {error && !positionOpen && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {!analysis ? (
          <div className="welcome">
            <div className="welcome-icon">
              <GitBranch size={30} strokeWidth={1.5} />
            </div>
            <span className="eyebrow">Belem Capital / Investment research</span>
            <h1>
              Understand what your
              <br />
              investment depends on.
            </h1>
            <p>
              Trace a Pendle PT position. Explore its risks. Compare staying
              with exiting.
            </p>
            <button className="btn primary welcome-button" onClick={onAdd}>
              <Plus size={16} /> Add investment <ArrowRight size={15} />
            </button>
            <div className="welcome-steps">
              <span>
                <GitBranch size={17} />
                Trace dependencies
              </span>
              <span>
                <FlaskConical size={17} />
                Test a scenario
              </span>
              <span>
                <Check size={17} />
                Review the result
              </span>
            </div>
            <span className="welcome-note">
              Live discovery · Modeled scenarios · No trades executed
            </span>
          </div>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {analysis.request.kind === "market"
                    ? "Morpho lending position"
                    : "Pendle PT position"}{" "}
                  / {CHAINS[analysis.request.chain_id]}
                </span>
                <h1>{market?.label || pt?.label || "Investment analysis"}</h1>
                <span className="heading-meta">
                  {analysis.screening.horizon_days}-day horizon
                  {pt?.attrs.expiry ? ` · Matures ${pt.attrs.expiry}` : ""} ·
                  Traced {tracedAt}
                </span>
              </div>
              <button
                className="btn subtle"
                onClick={() => setPositionOpen(true)}
                disabled={!!busy}
              >
                Change investment
              </button>
            </div>
            <section className="summary-strip" aria-label="Investment summary">
              <div>
                <small>Position value</small>
                <b>{usd(analysis.request.size_usd)}</b>
              </div>
              <div>
                <small>Withdrawable now</small>
                <b>{pct(analysis.exit_now.instant_fraction, 0)}</b>
              </div>
              <div>
                <small>Baseline modeled loss</small>
                <b>
                  {usd(
                    analysis.screening.total_expected_loss_pct *
                      analysis.request.size_usd,
                  )}
                </b>
              </div>
              <div>
                <small>Dependencies</small>
                <b>
                  {analysis.stats.nodes - 1}
                  <span> / {analysis.stats.edges} links</span>
                </b>
              </div>
            </section>
            <details className="mobile-contributors">
              <summary>Modeled risk contributors</summary>
              <TopRisks
                analysis={analysis}
                onPick={(n, m) => {
                  setSelected(n);
                  setPreMode(m);
                  setView("scenarios");
                }}
              />
            </details>
            <div
              className="workspace-tabs"
              role="tablist"
              aria-label="Analysis views"
            >
              {tabs.map((t) => (
                <button
                  role="tab"
                  aria-selected={view === t.id}
                  key={t.id}
                  disabled={t.id === "results" && !result}
                  className={view === t.id ? "active" : ""}
                  onClick={() => setView(t.id)}
                >
                  <t.icon size={15} />
                  {t.label}
                </button>
              ))}
            </div>
            {view === "results" && result ? (
              <Answer
                r={result}
                onClose={() => {
                  setResult(null);
                  setView("dependencies");
                }}
                onInspectPath={() => setView("scenarios")}
              />
            ) : (
              <div
                className={`research-area ${selected || view === "scenarios" ? "with-inspector" : ""}`}
              >
                <section className="graph-panel" aria-label="Dependency graph">
                  <div className="graph-heading">
                    <div>
                      <b>
                        {view === "scenarios"
                          ? "Scenario workspace"
                          : "Dependency map"}
                      </b>
                      <small>
                        {view === "scenarios"
                          ? "Select a component to test a failure."
                          : "Select a component. Expand groups for more detail."}
                      </small>
                    </div>
                    <select
                      aria-label="Graph colour"
                      value={colorMode}
                      onChange={(e) =>
                        setColorMode(e.target.value as ColorMode)
                      }
                    >
                      <option value="type">Category colours</option>
                      <option value="risk">Modeled risk contribution</option>
                    </select>
                  </div>
                  <Graph
                    analysis={analysis}
                    result={result}
                    selected={selected}
                    onSelect={choose}
                    colorMode={colorMode}
                    active={active}
                    ui={graphUi}
                    onUi={setGraphUi}
                  />
                  {busy === "shock" && (
                    <div className="overlay" role="status">
                      Calculating scenario…
                    </div>
                  )}
                </section>
                <aside
                  className="right"
                  hidden={!selected && view !== "scenarios"}
                >
                  <div className="inspector-toolbar">
                    <b>
                      {view === "scenarios"
                        ? "Run scenario"
                        : "Component details"}
                    </b>
                    {selected && (
                      <button
                        aria-label="Close component"
                        onClick={() => choose(null)}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                  <Inspector
                    analysis={analysis}
                    catalog={catalog}
                    selected={selected}
                    preMode={preMode}
                    busy={busy === "shock"}
                    onShock={shock}
                    onReplay={replay}
                    scenarioView={view === "scenarios"}
                    onScenario={() => setView("scenarios")}
                  />
                </aside>
              </div>
            )}
            <details className="analysis-details">
              <summary>
                <CircleHelp size={14} /> Analysis details & discovery notes
              </summary>
              <div>
                {analysis.stats.evidence} evidence records · Discovery took{" "}
                {analysis.stats.discovery_seconds}s · Model probabilities are
                assumptions, not observed incidents.
                {analysis.stats.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
                <p>
                  Unavailable or inferred dependencies require verification.
                  This workspace evaluates scenarios; it does not continuously
                  monitor or execute trades.
                </p>
              </div>
            </details>
          </>
        )}
      </main>
      <dialog
        ref={dialog}
        className="position-dialog"
        onCancel={(event) => {
          if (busy === "analyze") event.preventDefault();
          else setPositionOpen(false);
        }}
        onClose={() => setPositionOpen(false)}
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Investment research</span>
            <h2>{analysis ? "Change investment" : "Add investment"}</h2>
          </div>
          <button
            aria-label="Close investment form"
            disabled={busy === "analyze"}
            onClick={() => setPositionOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {positionOpen && (
          <PositionForm
            onAnalyze={analyze}
            busy={busy === "analyze"}
            initial={
              analysis
                ? {
                    ...analysis.request,
                    label: analysis.request.label ?? undefined,
                    horizon_days: analysis.screening.horizon_days,
                  }
                : undefined
            }
          />
        )}
      </dialog>
    </div>
  );
}

function traceTime() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
