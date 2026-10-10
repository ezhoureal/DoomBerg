import ReactMarkdown from "react-markdown";
import { Bar, BarChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Sparkles, X } from "lucide-react";
import type { ShockResult } from "../types";
import { TYPE_META, lossColor, pct, usd } from "../format";

function Gauge({ p, ci, be }: { p: number; ci: [number, number]; be: number | null }) {
  const scale = (x: number) => `${Math.min(100, Math.max(0, x * 100))}%`;
  const anchor = (x: number) => ({ transform: `translateX(${x < 0.08 ? "0" : x > 0.92 ? "-100%" : "-50%"})` });
  return (
    <div className="gauge">
      <div className="gauge-track">
        <div className="gauge-ci" style={{ left: scale(ci[0]), width: `calc(${scale(ci[1])} - ${scale(ci[0])})` }} />
        {be !== null && be <= 1 && <div className="gauge-be" style={{ left: scale(be) }}><span style={anchor(be)}>break-even {pct(be)}</span></div>}
        <div className="gauge-p" style={{ left: scale(p) }}><span style={anchor(p)}>model {pct(p)}</span></div>
      </div>
      <div className="gauge-axis"><span>0%</span><span>50%</span><span>100% chance of failure</span></div>
    </div>
  );
}

export default function Answer({ r, onClose }: { r: ShockResult; onClose: () => void }) {
  const d = r.decision;
  const exit = d.verdict === "EXIT";
  const hist = r.loss.histogram.map((b) => ({ x: (b.x0 + b.x1) / 2, share: b.share }));
  const path = r.paths[0]?.hops ?? [];
  return (
    <div className="answer">
      <button className="close" onClick={onClose} title="Close"><X size={16} /></button>
      <div className="step"><span>3</span> Read the answer
        <small className="muted"> · {r.shock.node_label}: {r.shock.mode_label.toLowerCase()} · {r.shock.alert_label}
          {r.shock.incident ? ` · replay of ${r.shock.incident.name} (${r.shock.incident.date})` : ""}</small>
      </div>

      <div className="answer-grid">
        <div className={`verdict ${exit ? "exit" : "stay"}`}>
          <div className="v-label">Verdict</div>
          <div className="v-main">{d.verdict}</div>
          <div className="v-conf">{pct(d.confidence, 0)} of probability draws agree</div>
          <div className="v-rule">
            {pct(d.probability)} × {pct(d.loss_given_failure.mean)} = <b>{pct(d.expected_loss_pct, 2)}</b> {exit ? ">" : "≤"} {pct(d.exit_cost_pct, 2)} exit cost
          </div>
        </div>

        <div className="metrics">
          <div className="m"><small>Expected loss if you stay</small><b style={{ color: "#ff8c96" }}>{usd(d.expected_loss_usd)}</b><em>{pct(d.expected_loss_pct, 2)} of position</em></div>
          <div className="m"><small>Cost to exit now</small><b style={{ color: "#ffd166" }}>{usd(d.exit_cost_usd)}</b><em>{pct(d.exit_cost_pct, 2)}{r.exit.override !== undefined ? " (override)" : ""} · {pct(r.exit.instant_fraction, 0)} withdrawable now</em></div>
          <div className="m"><small>Break-even probability</small><b style={{ color: "#7c9cff" }}>{d.break_even_probability === null || d.break_even_probability > 1 ? "never" : pct(d.break_even_probability)}</b><em>exit if failure is more likely</em></div>
          <div className="m"><small>Loss if it fails</small><b style={{ color: lossColor(d.loss_given_failure.mean) }}>{pct(d.loss_given_failure.typical)} <span className="dim">typical</span></b><em>bad case (p95) {pct(d.loss_given_failure.bad_case)} = {usd(d.bad_case_usd)}</em></div>
          <div className="m"><small>Chance of failure ({r.probability.horizon_days}d)</small><b>{pct(d.probability)}</b><em>90% range {pct(r.probability.p_ci[0])} – {pct(r.probability.p_ci[1])}{d.probability_source === "override" ? " · overridden" : ""}</em></div>
          <div className="m"><small>Hit to the whole book</small><b>{pct(d.book_impact_pct, 3)}</b><em>position is {pct(d.position_share_of_book, 0)} of book</em></div>
        </div>
      </div>

      <Gauge p={d.probability} ci={r.probability.p_ci} be={d.break_even_probability} />

      <div className="answer-cols">
        <div className="card">
          <div className="card-h">Loss distribution if it fails ({(r.loss.histogram.length && "Monte Carlo") || ""})</div>
          <div style={{ height: 150 }}>
            <ResponsiveContainer>
              <BarChart data={hist} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <XAxis dataKey="x" tickFormatter={(v) => pct(v, 0)} stroke="#5b6888" fontSize={10} />
                <YAxis tickFormatter={(v) => pct(v, 0)} stroke="#5b6888" fontSize={10} />
                <Tooltip formatter={(v: number) => pct(v)} labelFormatter={(v: number) => `loss ≈ ${pct(v)}`}
                  contentStyle={{ background: "#0d1326", border: "1px solid #24305a", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="share" fill="#ff7a85" radius={[3, 3, 0, 0]} />
                <ReferenceLine x={hist.reduce((a, b) => (Math.abs(b.x - d.loss_given_failure.mean) < Math.abs(a.x - d.loss_given_failure.mean) ? b : a), hist[0])?.x}
                  stroke="#ffd166" strokeDasharray="4 3" label={{ value: "mean", fill: "#ffd166", fontSize: 10, position: "top" }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="card-h" style={{ marginTop: 10 }}>How the damage travels</div>
          <div className="path">
            {path.map((h, i) => (
              <div key={h.node_id} className="hop">
                {i > 0 && <div className="hop-edge">{h.edge_type?.replace("_", " ")}</div>}
                <div className="hop-node" style={{ borderColor: TYPE_META[h.type]?.color }}>
                  <span>{h.label}</span><b style={{ color: lossColor(h.mean_loss) }}>{h.mean_loss > 0.0001 ? `−${pct(h.mean_loss)}` : "0"}</b>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card explain">
          <div className="card-h"><Sparkles size={13} /> Why: {r.explanation?.provider === "template" ? "rule-based narrative (set an LLM key for AI narrative)" : `LLM narrative (${r.explanation?.model})`}</div>
          <div className="md"><ReactMarkdown>{r.explanation?.text ?? ""}</ReactMarkdown></div>
        </div>

        <div className="card">
          <div className="card-h">Exit plan priced at size</div>
          {r.exit.steps.map((s, i) => (
            <div key={i} className="exit-step"><b>{s.step}</b><span className={`src src-${s.source}`}>{s.source}</span><p>{s.detail}</p><em>{pct(s.cost_pct, 2)}</em></div>
          ))}
          <div className="card-h" style={{ marginTop: 10 }}>Break-even view</div>
          <table className="be">
            <thead><tr><th>If the loss would be</th><th>Exit when failure is above</th></tr></thead>
            <tbody>
              {d.break_even_table.map((b) => <tr key={b.loss_if_fails}><td>{pct(b.loss_if_fails, 0)}</td><td>{b.exit_above === null ? "never" : pct(b.exit_above)}</td></tr>)}
            </tbody>
          </table>
          <div className="card-h" style={{ marginTop: 10 }}>Reasons & assumptions</div>
          <ul className="assume">
            {d.reasons.map((x, i) => <li key={"r" + i}><b>{x}</b></li>)}
            {r.probability.reasons.map((x, i) => <li key={"p" + i}>{x}</li>)}
            {r.assumptions.map((x, i) => <li key={"a" + i} className="dim">{x}</li>)}
          </ul>
        </div>
      </div>
    </div>
  );
}
