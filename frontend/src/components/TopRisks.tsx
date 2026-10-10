import type { Analysis } from "../types";
import { TYPE_META, pct, riskColor, usd } from "../format";

export default function TopRisks({ analysis, onPick }: { analysis: Analysis; onPick: (node: string, mode: string) => void }) {
  const s = analysis.screening;
  const size = analysis.request.size_usd;
  return (
    <div className="panel-section">
      <div className="sub-h" style={{ marginTop: 0 }}>Where the risk sits (base rates, no alert)</div>
      <div className="kpis">
        <div><small>Expected loss / {s.horizon_days}d</small><b>{pct(s.total_expected_loss_pct, 2)}</b><em>{usd(s.total_expected_loss_pct * size)}</em></div>
        <div><small>P(any loss event)</small><b>{pct(s.p_any_loss_event)}</b><em>within {s.horizon_days} days</em></div>
      </div>
      <div className="risk-list">
        {s.top.slice(0, 10).map((r) => (
          <button key={r.node_id + r.mode} className="risk-row" onClick={() => onPick(r.node_id, r.mode)}
            title={r.reasons.join("\n")}>
            <div className="risk-top">
              <span className="dot" style={{ background: TYPE_META[r.type]?.color }} />
              <b>{r.label}</b>
              <span className="risk-share" style={{ color: riskColor(r.share) }}>{pct(r.share, 0)}</span>
            </div>
            <div className="risk-meta">{r.mode_label} · p {pct(r.p, 2)} · loss if it fails {pct(r.loss_given_failure)}</div>
            <div className="bar"><i style={{ width: `${Math.min(100, r.share * 100)}%`, background: riskColor(r.share) }} /></div>
          </button>
        ))}
      </div>
    </div>
  );
}
