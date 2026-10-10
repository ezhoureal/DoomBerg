import { useEffect, useState } from "react";
import { Activity, GitBranch, Layers, PanelLeftClose, PanelLeftOpen, ShieldCheck } from "lucide-react";
import { api } from "./api";
import type { Analysis, Catalog, ShockResult } from "./types";
import Graph, { type ColorMode } from "./components/Graph";
import PositionForm from "./components/PositionForm";
import TopRisks from "./components/TopRisks";
import Inspector from "./components/Inspector";
import Answer from "./components/Answer";
import { CHAINS, TYPE_META, pct, usd } from "./format";

export default function App() {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [result, setResult] = useState<ShockResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preMode, setPreMode] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [llm, setLlm] = useState("…");
  const [busy, setBusy] = useState<"analyze" | "shock" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("risk");
  const [leftOpen, setLeftOpen] = useState(true);

  useEffect(() => {
    api.catalog().then(setCatalog).catch(() => {});
    api.health().then((h) => setLlm(h.llm)).catch(() => setLlm("offline"));
  }, []);

  const analyze = async (req: Parameters<typeof api.analyze>[0]) => {
    setBusy("analyze"); setError(null); setResult(null); setSelected(null);
    try {
      setAnalysis(await api.analyze(req));
      if (window.innerWidth < 1400) setLeftOpen(false);
    }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const shock = async (r: { node_id: string; mode: string; alert: string; probability_override: number | null; exit_cost_override: number | null }) => {
    if (!analysis) return;
    setBusy("shock"); setError(null);
    try { setResult(await api.shock({ position_id: analysis.position_id, ...r })); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const replay = async (incident_id: string, exit_cost_override: number | null) => {
    if (!analysis) return;
    setBusy("shock"); setError(null);
    try {
      const r = await api.replay({ position_id: analysis.position_id, incident_id, exit_cost_override });
      setResult(r); setSelected(r.shock.node_id);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  };

  const pt = analysis?.graph.nodes.find((n) => n.type === "asset" && n.attrs.kind === "pt");
  const amm = analysis?.graph.nodes.find((n) => n.type === "amm");
  const market = analysis?.graph.nodes.find((n) => n.type === "market");

  return (
    <div className="app">
      <header>
        <div className="brand">
          <div className="logo"><ShieldCheck size={18} /></div>
          <div><b>Belem Capital</b><span>DeFi Dependency Risk Engine</span></div>
        </div>
        {analysis && (
          <div className="hstats">
            <div><GitBranch size={14} /> {analysis.stats.nodes} components · {analysis.stats.edges} links</div>
            <div><Layers size={14} /> {analysis.stats.evidence} evidence records</div>
            <div><Activity size={14} /> traced in {analysis.stats.discovery_seconds}s</div>
          </div>
        )}
        <div className="llm">Narrative: <b>{llm}</b></div>
      </header>

      <main className={leftOpen ? "" : "left-closed"}>
        <aside className="left">
          <PositionForm onAnalyze={analyze} busy={busy === "analyze"} />
          {analysis && <TopRisks analysis={analysis} onPick={(n, m) => { setSelected(n); setPreMode(m); }} />}
        </aside>

        <section className="center">
          {error && <div className="toast" onClick={() => setError(null)}>{error}</div>}
          {!analysis && (
            <div className="empty">
              <div className="empty-card">
                <h1>One position, a dozen silent dependencies.</h1>
                <p>Paste a Pendle PT token, or a Morpho market that takes a PT as collateral. The engine traces everything the position relies on
                  (oracle, underlying token, Pendle AMM, issuer, bridge, chain, who can mint), then lets you break any piece and prices <b>stay vs exit</b>.</p>
                <ol>
                  <li><b>Enter the position</b>: or start with the brief's PT-reUSD market on the left.</li>
                  <li><b>See the dependency graph</b>: every link carries the API / on-chain evidence behind it.</li>
                  <li><b>Pick what breaks</b>: a component and a failure type.</li>
                  <li><b>Read the answer</b>: expected loss, exit cost, break-even probability and the verdict with its reason.</li>
                </ol>
                {busy === "analyze" && <div className="tracing">Tracing dependencies on-chain…</div>}
              </div>
            </div>
          )}
          {analysis && (
            <>
              <div className="pos-bar">
                <button className="toggle" onClick={() => setLeftOpen((o) => !o)} title={leftOpen ? "Hide position panel" : "Show position panel & risk ranking"}>
                  {leftOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </button>
                <div className="pos-title">
                  <b>{analysis.graph.nodes.find((n) => n.id === analysis.graph.root)?.label}</b>
                  <span>{CHAINS[analysis.request.chain_id]} · {analysis.request.kind === "market" ? "Morpho market, PT collateral" : "Pendle PT"}
                    {market ? ` · LLTV ${pct(market.attrs.lltv)} · utilization ${pct(market.attrs.utilization, 0)} · instant liquidity ${usd(market.attrs.liquidity_usd)}` : ""}
                    {pt?.attrs.expiry ? ` · matures ${pt.attrs.expiry}` : ""}
                    {amm?.attrs.liquidity_usd !== undefined ? ` · AMM liquidity ${usd(amm.attrs.liquidity_usd)}` : ""}
                    {amm?.attrs.implied_apy ? ` · implied APY ${pct(amm.attrs.implied_apy)}` : ""}</span>
                </div>
                <div className="seg small">
                  <button className={colorMode === "risk" ? "on" : ""} onClick={() => setColorMode("risk")}>Color: risk share</button>
                  <button className={colorMode === "type" ? "on" : ""} onClick={() => setColorMode("type")}>Color: type</button>
                </div>
              </div>
              <div className={`graph-wrap ${result ? "with-answer" : ""}`}>
                <Graph analysis={analysis} result={result} selected={selected} onSelect={(id) => { setSelected(id); setPreMode(null); }} colorMode={colorMode}
                  fitKey={`${leftOpen}-${result ? result.shock.node_id + result.shock.mode : "none"}`} />
                <div className="legend">
                  {Object.entries(TYPE_META).filter(([k]) => analysis.graph.nodes.some((n) => n.type === k)).map(([k, m]) => (
                    <span key={k}><i style={{ background: m.color }} />{m.label}</span>
                  ))}
                </div>
                {busy === "shock" && <div className="overlay">Running Monte Carlo…</div>}
              </div>
              {result && <Answer r={result} onClose={() => setResult(null)} />}
            </>
          )}
        </section>

        <aside className="right">
          {analysis ? (
            <Inspector analysis={analysis} catalog={catalog} selected={selected} preMode={preMode} busy={busy === "shock"} onShock={shock} onReplay={replay} />
          ) : (
            <div className="panel-section hint">Trace a position to inspect its components.</div>
          )}
        </aside>
      </main>
    </div>
  );
}
