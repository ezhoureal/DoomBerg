import type { Analysis } from "../types";
import { pct } from "../format";

const LEVEL_COLOR: Record<string, string> = {
  watch: "var(--gold)",
  alert: "var(--red)",
  corroborated: "var(--red)",
  confirmed: "var(--red)",
};

const ago = (ts: number) => {
  const h = (Date.now() / 1000 - ts) / 3600;
  return h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)} days ago`;
};

export default function LiveMonitor({
  analysis,
  onPick,
}: {
  analysis: Analysis;
  onPick: (node: string, mode: string) => void;
}) {
  const m = analysis.monitor;
  if (!m) return null;
  const prev = m.previous;
  return (
    <div className="live-monitor">
      <div className="sub-h" style={{ marginTop: 0 }}>
        Live signals
      </div>
      <div className="live-head">
        <b className={m.verdict === "EXIT" ? "verdict-exit" : "verdict-stay"}>{m.verdict}</b>
        <span>
          {m.alerts.length ? `${m.alerts.length} active alert${m.alerts.length > 1 ? "s" : ""}` : "No active alerts"} · {m.regime}
        </span>
      </div>
      <p className="live-note" title="Base rates are the risk accepted at entry; the verdict weighs only what today's signals and contagion add.">
        Signals add {pct(m.avoidable_loss_pct, 2)} avoidable loss vs {pct(m.exit_cost_pct, 2)} to exit
      </p>
      {m.alerts.map((a) => (
        <button key={a.node_id + a.mode} className="risk-row" onClick={() => onPick(a.node_id, a.mode)}
          title={a.signals.map((s) => `${s.rule_label}: ${s.detail}`).join("\n")}>
          <div className="risk-top">
            <span className="dot" style={{ background: LEVEL_COLOR[a.level] }} />
            <b>{a.label}</b>
            <span className="risk-share" style={{ color: LEVEL_COLOR[a.level] }}>{a.level}</span>
          </div>
          <div className="risk-meta">{a.signals[0]?.detail ?? a.mode_label}</div>
        </button>
      ))}
      {prev && (
        <p className="live-note">
          Last recorded run {ago(prev.ts)}: {prev.verdict}, expected loss {pct(prev.expected_loss_pct, 2)} → now {pct(m.expected_loss_pct, 2)}
        </p>
      )}
    </div>
  );
}
