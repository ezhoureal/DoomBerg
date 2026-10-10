import { useState } from "react";
import type { GraphNode, Incident, IncidentKind, RiskSnapshot, Severity, Warning } from "../protocol";
import type { PortfolioRisk, PositionRisk } from "../model/risk";
import { bps, pct, usd } from "../format";
import type { Selection } from "./GraphView";
import { ElVsExit } from "./Sidebar";

interface Props {
  snapshot: RiskSnapshot;
  risk: PortfolioRisk;
  warnings: Map<string, Warning[]>;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onAddIncident: (inc: Incident) => void;
}

export function DetailPanel(p: Props) {
  const { selection } = p;
  return (
    <aside className="detail">
      {!selection || selection.kind === "portfolio" ? (
        <PortfolioDetail {...p} />
      ) : selection.kind === "position" ? (
        <PositionDetail {...p} pr={p.risk.byId.get(selection.id)!} />
      ) : (
        <NodeDetail key={selection.id} {...p} node={p.snapshot.nodes.find((n) => n.id === selection.id)!} />
      )}
    </aside>
  );
}

function PortfolioDetail({ snapshot, risk, warnings, onSelect }: Props) {
  const top = [...risk.nodeExposure]
    .filter(([, e]) => e.elUsd > 0)
    .sort((a, b) => b[1].elUsd - a[1].elUsd)
    .slice(0, 8);
  const label = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const conc = [...risk.nodeExposure]
    .filter(([id]) => label.get(id)!.type !== "chain")
    .sort((a, b) => b[1].aumUsd - a[1].aumUsd)
    .slice(0, 6);
  const maxHist = Math.max(...risk.lossHistogram.map((b) => b.prob), 1e-9);
  const alerts = [...warnings].flatMap(([id, ws]) =>
    ws.filter((w) => w.severity === "high" || w.severity === "critical").map((w) => ({ id, w })),
  );
  return (
    <>
      <h2>{snapshot.portfolio.name}</h2>
      <p className="muted small">
        {snapshot.portfolio.manager} · as of {new Date(snapshot.asOf).toUTCString()} · horizon {snapshot.riskParams.horizonDays}d ·
        data: <b>{snapshot.source}</b>
      </p>

      {alerts.length > 0 && (
        <div className="card">
          <h4>Alerts</h4>
          {alerts.map(({ id, w }, i) => (
            <div key={i} className="warn-row clickable" onClick={() => onSelect({ kind: "node", id })}>
              <span className={`sev sev-bg-${w.severity}`}>{w.severity}</span>
              <span>
                <b>{label.get(id)!.label}</b>: {w.message}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h4>Where expected loss comes from</h4>
        <Bars
          rows={top.map(([id, e]) => ({ id, label: label.get(id)!.label, value: e.elUsd, text: usd(e.elUsd) }))}
          onClick={(id) => onSelect({ kind: "node", id })}
        />
      </div>

      <div className="card">
        <h4>Concentration: AUM depending on a node</h4>
        <Bars
          rows={conc.map(([id, e]) => ({
            id,
            label: label.get(id)!.label,
            value: e.aumUsd,
            text: pct(e.aumUsd / snapshot.portfolio.aumUsd, 0),
          }))}
          onClick={(id) => onSelect({ kind: "node", id })}
        />
      </div>

      <div className="card">
        <h4>
          Portfolio loss distribution ({snapshot.riskParams.monteCarloSamples.toLocaleString()} Monte Carlo draws, losses &gt; 0)
        </h4>
        <div className="hist">
          {risk.lossHistogram.map((b, i) => (
            <div
              key={i}
              title={`${usd(b.lossUsd)}: ${pct(b.prob, 2)}`}
              style={{ height: `${b.prob > 0 ? Math.max(3, Math.sqrt(b.prob / maxHist) * 100) : 0}%` }}
            />
          ))}
        </div>
        <div className="row small muted">
          <span>$0</span>
          <span>
            VaR {usd(risk.varUsd)} · CVaR {usd(risk.cvarUsd)}
          </span>
          <span>{usd(risk.lossHistogram.at(-1)?.lossUsd ?? 0)}</span>
        </div>
      </div>
      <p className="muted small">Click a position or node to see its dependency path, decision and warnings.</p>
    </>
  );
}

function PositionDetail({ snapshot, pr, onSelect }: Props & { pr: PositionRisk }) {
  const pos = pr.position;
  const label = new Map(snapshot.nodes.map((n) => [n.id, n.label]));
  const top = pr.contributions.slice(0, 8);
  return (
    <>
      <div className="row">
        <h2>{pos.label}</h2>
      </div>
      <p className="muted small">
        {pos.strategy} · <span className={`chain chain-${pos.chain}`}>{pos.chain}</span>
      </p>

      <div className={`verdict v-${pr.decision}`}>
        <div className="verdict-head">
          <span className={`decision big d-${pr.decision}`}>{pr.decision}</span>
          <span>
            {pr.decision === "EXIT" && pr.exitableFraction < 1
              ? `Exit ${pct(pr.exitableFraction, 0)} now (liquidity-limited), queue the rest`
              : pr.decision === "EXIT"
                ? "Unwind the position"
                : pr.decision === "WATCH"
                  ? "Hold, pre-stage exit, tighten monitoring"
                  : "Hold"}
          </span>
        </div>
        <ul>
          {pr.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h4>Stay vs exit ({snapshot.riskParams.horizonDays}d horizon)</h4>
        <div className="grid2">
          <Stat label="Position" value={usd(pos.valueUsd)} />
          <Stat label="Carry (yield)" value={usd(pr.carryUsd)} sub={`${pos.apr}% APR`} />
          <Stat label="Expected loss (total)" value={usd(pr.elUsd)} sub={bps(pr.elPct)} />
          <Stat label="of which baseline" value={usd(pr.baselineElUsd)} sub="underwritten at entry" />
          <Stat label="Incident-driven EL" value={usd(pr.excessElUsd)} sub="avoided by exiting" strong />
          <Stat label="Exit cost" value={usd(pr.exitCostUsd)} sub={bps(pr.exitCostPct)} strong />
          <Stat label="Stressed loss" value={usd(pr.stressedLossUsd)} sub={`${pct(pr.stressedLossPct)} if incidents hit`} />
          <Stat
            label="Break-even P(incident)"
            value={pr.breakEvenP === null ? "n/a" : pct(Math.min(1, pr.breakEvenP))}
            sub={pr.breakEvenP === null ? "no active incident" : `current ${pct(pr.incidentP)}`}
          />
        </div>
        <ElVsExit el={pr.excessElUsd} exit={pr.exitCostUsd} />
        <div className="row small muted">
          <span>■ incident EL</span>
          <span>■ exit cost</span>
        </div>
      </div>

      <div className="card">
        <h4>Exit route</h4>
        <p className="small">{pos.exit.route}</p>
        <div className="grid2">
          <Stat label="Slippage" value={`${pos.exit.slippageBps} bps`} />
          <Stat label="Fixed costs" value={usd(pos.exit.fixedCostUsd)} />
          <Stat label="Exitable now" value={usd(pos.exit.availableLiquidityUsd)} sub={pct(pr.exitableFraction, 0)} />
          <Stat label="Time to exit" value={`${pos.exit.timeToExitHours}h`} />
        </div>
      </div>

      <div className="card">
        <h4>Top risk contributors</h4>
        <table className="tbl">
          <thead>
            <tr>
              <th>Dependency</th>
              <th title="Share of position value reached (sum over paths of exposure × transmission)">Reach</th>
              <th title="Probability of failure over horizon">p</th>
              <th title="Loss to this position if the node fails">Loss|fail</th>
              <th>EL</th>
            </tr>
          </thead>
          <tbody>
            {top.map((c) => (
              <tr key={c.nodeId} className="clickable" onClick={() => onSelect({ kind: "node", id: c.nodeId })}>
                <td>{label.get(c.nodeId)}</td>
                <td>{c.reach.toFixed(2)}</td>
                <td>{pct(c.p, 2)}</td>
                <td>{pct(c.lossIfFails, 0)}</td>
                <td>{usd(c.elUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">{pr.reach.size} dependencies discovered.</p>
      </div>
    </>
  );
}

const INCIDENT_KINDS: IncidentKind[] = [
  "exploit",
  "oracle_deviation",
  "depeg",
  "liquidity_crunch",
  "outage",
  "governance",
  "market_dislocation",
];

function NodeDetail({ snapshot, risk, warnings, node, onSelect, onAddIncident }: Props & { node: GraphNode }) {
  const nr = risk.nodeRisk.get(node.id)!;
  const exp = risk.nodeExposure.get(node.id)!;
  const ws = warnings.get(node.id) ?? [];
  const deps = snapshot.edges.filter((e) => e.from === node.id);
  const dependents = snapshot.edges.filter((e) => e.to === node.id);
  const label = new Map(snapshot.nodes.map((n) => [n.id, n.label]));

  const [kind, setKind] = useState<IncidentKind>("exploit");
  const [pFail, setPFail] = useState(0.2);
  const [lgf, setLgf] = useState(node.baseline.lossGivenFailure);

  return (
    <>
      <h2>{node.label}</h2>
      <p className="muted small">
        {node.type} · <span className={`chain chain-${node.chain}`}>{node.chain}</span>
      </p>
      {node.description && <p className="small">{node.description}</p>}
      {snapshot.monitor?.nodeId === node.id && <p className="muted small">
        Monitor warnings do not assign failure probabilities. To explore financial impact,
        use the incident simulator below with explicit assumptions.
      </p>}

      {ws.length > 0 && (
        <div className="card">
          <h4>Warnings</h4>
          {ws.map((w, i) => (
            <div key={i} className="warn-row">
              <span className={`sev sev-bg-${w.severity}`}>{w.severity}</span>
              <span>{w.message}</span>
            </div>
          ))}
        </div>
      )}

      {nr.incidents.map((inc) => (
        <div key={inc.id} className={`card incident-card sev-border-${inc.severity}`}>
          <h4>
            {inc.title} <span className="muted small">({inc.kind})</span>
          </h4>
          <p className="small">{inc.description}</p>
          <p className="muted small">
            {inc.source} · {new Date(inc.detectedAt).toUTCString()}
          </p>
        </div>
      ))}

      <div className="card">
        <h4>Risk</h4>
        <div className="grid2">
          <Stat label="p(fail) baseline" value={pct(node.baseline.pFail, 2)} />
          <Stat label="p(fail) now" value={pct(nr.p, 2)} strong={nr.p > node.baseline.pFail} />
          <Stat label="LGF baseline" value={pct(node.baseline.lossGivenFailure, 0)} />
          <Stat label="LGF now" value={pct(nr.lgf, 0)} />
          <Stat label="AUM depending" value={usd(exp.aumUsd)} sub={pct(exp.aumUsd / snapshot.portfolio.aumUsd, 0)} />
          <Stat label="EL contributed" value={usd(exp.elUsd)} />
        </div>
      </div>

      {node.metrics && Object.keys(node.metrics).length > 0 && (
        <div className="card">
          <h4>Metrics</h4>
          <div className="grid2">
            {Object.entries(node.metrics).map(([k, v]) => (
              <Stat key={k} label={k} value={formatMetric(k, v)} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h4>Positions exposed</h4>
        {exp.positions.length === 0 && <p className="muted small">None</p>}
        {exp.positions.map((pid) => {
          const pr = risk.byId.get(pid)!;
          const r = pr.reach.get(node.id)!;
          return (
            <div key={pid} className="warn-row clickable" onClick={() => onSelect({ kind: "position", id: pid })}>
              <span className={`decision d-${pr.decision}`}>{pr.decision}</span>
              <span>
                {pr.position.label} <span className="muted">· reach {r.toFixed(2)}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h4>Edges</h4>
        {deps.map((e) => (
          <div key={e.to} className="edge-row clickable" onClick={() => onSelect({ kind: "node", id: e.to })}>
            → <b>{label.get(e.to)}</b> <span className="muted">{e.kind}</span> {edgeMult(e.exposure, e.transmission)}
            {e.note && <div className="muted small">{e.note}</div>}
          </div>
        ))}
        {dependents.map((e) => (
          <div key={e.from} className="edge-row clickable" onClick={() => onSelect({ kind: "node", id: e.from })}>
            ← <b>{label.get(e.from)}</b> <span className="muted">{e.kind}</span> {edgeMult(e.exposure, e.transmission)}
          </div>
        ))}
      </div>

      <div className="card sim">
        <h4>Simulate an incident here</h4>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as IncidentKind)}>
            {INCIDENT_KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          P(materialises within horizon): <b>{pct(pFail, 0)}</b>
          <input type="range" min={0} max={1} step={0.01} value={pFail} onChange={(e) => setPFail(+e.target.value)} />
        </label>
        <label>
          Loss given failure: <b>{pct(lgf, 0)}</b>
          <input type="range" min={0} max={1} step={0.01} value={lgf} onChange={(e) => setLgf(+e.target.value)} />
        </label>
        <button
          className="primary"
          onClick={() =>
            onAddIncident({
              id: `sim-${Date.now()}`,
              nodeId: node.id,
              kind,
              severity: severityFor(pFail * lgf),
              title: `Simulated ${kind.replace("_", " ")} on ${node.label}`,
              description: "User-injected scenario.",
              detectedAt: new Date().toISOString(),
              status: "active",
              pFail,
              lossGivenFailure: lgf,
              source: "simulated",
            })
          }
        >
          Inject incident
        </button>
      </div>
    </>
  );
}

function severityFor(x: number): Severity {
  if (x >= 0.2) return "critical";
  if (x >= 0.05) return "high";
  if (x >= 0.01) return "medium";
  return "low";
}

function edgeMult(exposure: number, transmission: number) {
  const parts = [];
  if (exposure !== 1) parts.push(`exp ${pct(exposure, 0)}`);
  if (transmission !== 1) parts.push(`×${transmission}`);
  return parts.length ? <span className="pill">{parts.join(" ")}</span> : null;
}

function formatMetric(k: string, v: number | undefined) {
  if (v === undefined) return "–";
  if (/Usd/.test(k)) return usd(v);
  if (k === "utilization" || k === "lltv" || k === "tvlShareOfChain") return pct(v, 1);
  if (/Pct|Apr/.test(k)) return `${v}%`;
  if (/Sec/.test(k)) return `${v}s`;
  if (/Ms$/.test(k)) return `${v}ms`;
  return String(v);
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`stat ${strong ? "strong" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Bars({
  rows,
  onClick,
}: {
  rows: { id: string; label: string; value: number; text: string }[];
  onClick: (id: string) => void;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <div className="bars">
      {rows.map((r) => (
        <div key={r.id} className="bar-row clickable" onClick={() => onClick(r.id)}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="bar-text">{r.text}</span>
        </div>
      ))}
    </div>
  );
}
