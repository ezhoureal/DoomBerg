import type { Hedge } from "../types";
import { pct, usd } from "../format";

const price = (x: number) => `$${x.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
// Testnet positions are small: keep the cents that ``usd`` rounds away.
const cash = (x: number) => (Math.abs(x) < 100 ? `$${x.toFixed(2)}` : usd(x));

/** Hedge, margin and carry of a cash-and-carry on one exchange (``cex.health`` in the engine). */
export default function HedgeCard({ hedge: h, horizon }: { hedge: Hedge; horizon: number }) {
  const tone = h.rise_to_liquidation < 0.15 ? "bad" : h.rise_to_liquidation < 0.25 ? "warn" : "ok";
  const drift = h.hedge_drift ?? 0;
  const age = h.state_age_s;
  return (
    <section className="leverage-card" aria-label="Hedge and liquidation">
      <div className="leverage-head">
        <b>Hedge &amp; liquidation</b>
        <small>
          Long {h.spot_qty} {h.base} spot · short {h.perp_qty} {h.symbol} at {h.leverage}x on {h.venue} ({h.environment})
          {age != null ? ` · basisd state ${age < 120 ? `${Math.round(age)}s` : `${Math.round(age / 60)} min`} old` : ""}
        </small>
      </div>
      <div className="leverage-grid">
        <div>
          <small>Spot notional</small>
          <b>{usd(h.notional_usd)}</b>
        </div>
        <div>
          <small>Margin committed</small>
          <b>{usd(h.margin_usd)}</b>
        </div>
        <div>
          <small>Hedge drift</small>
          <b className={Math.abs(drift) > 0.02 ? "warn" : ""}>
            {pct(drift, 2)}
            <span>{cash(Math.abs(h.unhedged_usd))} {h.unhedged_usd >= 0 ? "net long" : "net short"}</span>
          </b>
        </div>
        <div>
          <small>Mark rise to liquidation</small>
          <b className={tone}>
            {pct(h.rise_to_liquidation)}
            <span>at {price(h.liquidation_price)} ({h.liquidation_source})</span>
          </b>
        </div>
        <div>
          <small>P(liquidated in {horizon}d)</small>
          <b>{pct(h.p_liquidation, 2)}</b>
        </div>
        <div>
          <small>Funding, 7 days</small>
          <b className={h.funding_apr_7d <= h.exit_apr ? "bad" : ""}>
            {pct(h.funding_apr_7d)}
            <span>now {pct(h.funding_apr_now)} · {pct(h.carry_apy)} on capital</span>
          </b>
        </div>
      </div>
      <p className="leverage-note">
        Received {cash(h.funding_received_usd)} funding over {h.settlements} settlements, paid {cash(h.fees_paid_usd)} fees.
        Basis at entry {pct(h.basis_entry, 2)}, now {pct(h.basis_now, 2)}. Exit and signals use mainnet prices
        {h.environment !== "mainnet" ? `, since ${h.environment} books are not representative` : ""}.
      </p>
    </section>
  );
}
