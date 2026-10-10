import type { Incident, RiskSnapshot } from "../protocol";
import type { PortfolioRisk } from "../model/risk";
import { pct, usd } from "../format";
import type { Selection } from "./GraphView";

interface Props {
  snapshot: RiskSnapshot;
  risk: PortfolioRisk;
  incidents: Incident[];
  selection: Selection;
  onSelect: (s: Selection) => void;
  focusPositionId: string | null;
  onFocus: (id: string | null) => void;
  chainFilter: string;
  onChainFilter: (c: string) => void;
  onToggleIncident: (id: string) => void;
  onRemoveIncident: (id: string) => void;
}

const DECISION_ORDER = { EXIT: 0, WATCH: 1, STAY: 2 } as const;

export function Sidebar(p: Props) {
  const { snapshot, risk } = p;
  const aum = snapshot.portfolio.aumUsd;
  const counts = { EXIT: 0, WATCH: 0, STAY: 0 };
  for (const pr of risk.positions) counts[pr.decision]++;
  const sorted = [...risk.positions].sort(
    (a, b) => DECISION_ORDER[a.decision] - DECISION_ORDER[b.decision] || b.avoidableElUsd - a.avoidableElUsd,
  );
  const nodeLabel = new Map(snapshot.nodes.map((n) => [n.id, n.label]));

  return (
    <aside className="sidebar">
      <section className="kpis" onClick={() => p.onSelect({ kind: "portfolio" })}>
        <Kpi label="AUM" value={usd(aum, 0)} />
        <Kpi label={`EL ${snapshot.riskParams.horizonDays}d`} value={usd(risk.totalElUsd)} sub={pct(risk.totalElUsd / aum, 2)} />
        <Kpi
          label={`VaR ${snapshot.riskParams.varConfidence * 100}%`}
          value={usd(risk.varUsd)}
          sub={`CVaR ${usd(risk.cvarUsd)}`}
        />
        <div className="kpi decisions">
          <span className="decision d-EXIT">{counts.EXIT} exit</span>
          <span className="decision d-WATCH">{counts.WATCH} watch</span>
          <span className="decision d-STAY">{counts.STAY} stay</span>
        </div>
      </section>

      <section>
        <div className="section-head">
          <h3>Positions</h3>
          <div className="seg">
            {["all", "ethereum", "solana"].map((c) => (
              <button key={c} className={p.chainFilter === c ? "on" : ""} onClick={() => p.onChainFilter(c)}>
                {c === "all" ? "All" : c === "ethereum" ? "Morpho/ETH" : "Solana"}
              </button>
            ))}
          </div>
        </div>
        <ul className="positions">
          {sorted
            .filter((pr) => p.chainFilter === "all" || pr.position.chain === p.chainFilter)
            .map((pr) => {
              const sel = p.selection?.kind === "position" && p.selection.id === pr.position.id;
              const focused = p.focusPositionId === pr.position.id;
              return (
                <li
                  key={pr.position.id}
                  className={sel ? "selected" : ""}
                  onClick={() => p.onSelect({ kind: "position", id: pr.position.id })}
                >
                  <div className="row">
                    <span className={`decision d-${pr.decision}`}>{pr.decision}</span>
                    <span className="pos-label">{pr.position.label}</span>
                  </div>
                  <div className="row small muted">
                    <span>{usd(pr.position.valueUsd, 0)}</span>
                    <span>
                      EL {usd(pr.avoidableElUsd)} vs exit {usd(pr.exitCostUsd)}
                    </span>
                  </div>
                  <ElVsExit el={pr.avoidableElUsd} exit={pr.exitCostUsd} />
                  <button
                    className={`focus ${focused ? "on" : ""}`}
                    title="Show only this position's dependency tree"
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onFocus(focused ? null : pr.position.id);
                    }}
                  >
                    {focused ? "◉ focused" : "◎ focus"}
                  </button>
                </li>
              );
            })}
        </ul>
      </section>

      <section>
        <h3>Incidents</h3>
        <ul className="incidents">
          {p.incidents.map((inc) => (
            <li key={inc.id} className={inc.status === "active" ? "" : "inactive"}>
              <div className="row">
                <span className={`sev sev-bg-${inc.severity}`}>{inc.severity}</span>
                <span className="inc-title" onClick={() => p.onSelect({ kind: "node", id: inc.nodeId })}>
                  {inc.title}
                </span>
              </div>
              <div className="row small muted">
                <span>
                  {nodeLabel.get(inc.nodeId)} · p={pct(inc.pFail, 0)} · LGF={pct(inc.lossGivenFailure, 0)}
                </span>
                <span className="inc-actions">
                  <label className="switch" title="Active incidents feed the model">
                    <input type="checkbox" checked={inc.status === "active"} onChange={() => p.onToggleIncident(inc.id)} />
                    <span />
                  </label>
                  {inc.source === "simulated" && (
                    <button className="link" onClick={() => p.onRemoveIncident(inc.id)}>
                      ✕
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** Two bars on a shared scale: incident-driven EL vs exit cost. */
export function ElVsExit({ el, exit }: { el: number; exit: number }) {
  const max = Math.max(el, exit, 1);
  return (
    <div className="elx">
      <div className="elx-row">
        <div className={`elx-bar el ${el >= exit ? "over" : ""}`} style={{ width: `${(el / max) * 100}%` }} />
      </div>
      <div className="elx-row">
        <div className="elx-bar exit" style={{ width: `${(exit / max) * 100}%` }} />
      </div>
    </div>
  );
}
