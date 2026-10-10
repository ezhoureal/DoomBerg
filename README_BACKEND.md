# Oracle risk monitor: first backend prototype

## Connected dashboard (start here)

Run from the repository root (`belem`):

```bash
python3 run_demo.py
```

Open **http://127.0.0.1:5173**, then click **Inspect monitored oracle**. The BTC oracle node shows Python-generated price, price age, response time, price changes and warnings. The default 24-second cycle repeats healthy readings, slow responses, stale prices, failed reads, a 10% price jump and recovery. Ctrl+C stops both services.

To isolate the price jump: `python3 run_demo.py --scenario price_jump`. It jumps after three readings, then demonstrates recovery; restart for another jump.

The launcher needs Python 3.9+ and Node.js (22.18+ or 24+ recommended). On this Mac, an official Node 22 runtime was installed under `~/.local/share/belem-tools/node`; the launcher finds it automatically without changing your shell configuration. It installs the pinned frontend dependencies on first use if needed. The Python backend still requires no third-party packages.

### What is connected

`SimulatedOracle → OracleMonitor → snapshot adapter → GET /snapshot → React dashboard`

- `backend/snapshot_server.py` publishes the frontend's `RiskSnapshot` schema (`schemaVersion: "1.0"`).
- It uses `web/src/data/mockSnapshot.json` as the demo graph/portfolio template and updates **only the BTC oracle's measurements and flags**, plus snapshot metadata and demo labels. The template file is never overwritten.
- The producer runs once per second independently of browser requests. Multiple clients see the same reading.
- The frontend requests `/api/snapshot` automatically; Vite proxies it to `http://127.0.0.1:8000/snapshot`. No manual URL setting or copying `latest.json` is needed.
- UI-added incidents, toggles and removals survive refreshes for the current browser session. **Reset incident edits** restores the backend's incident list. Reloading the page also discards those local edits.
- On request failure, timeout, or a frozen reading sequence, the UI shows disconnected/stale information and keeps the last snapshot clearly labeled. It retries automatically.
- All graph data, holdings, exit quotes and financial assumptions remain **mock**. An active Python connection does not mean live blockchain data.

### Warning versus investment decision

The Python adapter supplies evidence-based **node warnings**. It does not send its standalone `EXIT` verdict into the dashboard, invent `pFail`, or turn a 10% jump into a 10% failure probability. The frontend's existing financial model still derives STAY/WATCH/EXIT from its demo incidents, probabilities, losses and quotes.

For a visible price-jump alert, just watch the monitored node. To explore its financial consequences, use the existing incident simulator on that node and choose explicit hypothetical probability/loss assumptions. Warnings alone do not change expected loss or the portfolio verdict.

`priceChangePct` means movement since the previous valid reading. It is deliberately separate from `deviationPct` (oracle versus independent market price). Unknown readings are omitted from the graph's numeric metrics; the warning explains why. The synthetic node has no claimed source count, market-reference price or actual heartbeat.

### Start services separately, if preferred

Terminal 1, project root:

```bash
python3 -m backend.snapshot_server
```

Terminal 2:

```bash
cd web
npm ci
npm run dev -- --host 127.0.0.1
```

Endpoints: `http://127.0.0.1:8000/snapshot` and `/health`. `runtime/latest.json` is still useful for the standalone CLI below, but the connected dashboard does not read it.

The Vite proxy is for local development. Deployment needs a same-origin `/api/snapshot` reverse proxy or a configured `VITE_SNAPSHOT_URL` with appropriate CORS on the serving API. For a deliberately disconnected static UI demo, start Vite with `VITE_USE_MOCK=true`.

Tests: `python3 -m unittest discover -s tests -v`; frontend: `cd web && npm test && npm run build`. The frontend tests run Python snapshots through the actual TypeScript risk engine and verify manual incident-edit preservation.

## Standalone monitor (optional)

Python 3.9+, standard library only. All observations are simulated. No API keys, frontend, wallet, database or installation needed. This implements the requested first milestone: monitoring rules and incident playback. It does not yet discover dependencies or calculate economic losses.

## Run from this folder

```bash
python3 -m backend.oracle_monitor --steps 24
```

This plays healthy readings, slow responses, recovery, stale prices, failed reads, a 10% price jump and recovery. One real second advances 30 simulated seconds; the printed timestamp is simulated time and can move into the future. The price starts at $100,000 and jumps to $110,000 near the end. Freshness is determined by the publication timestamp, not whether the number changes.

Continuous repeated demonstration, until Ctrl+C:

```bash
python3 -m backend.oracle_monitor --repeat
```

One incident only:

```bash
python3 -m backend.oracle_monitor --scenario stale --steps 10
python3 -m backend.oracle_monitor --scenario downtime --steps 5
python3 -m backend.oracle_monitor --scenario latency --steps 5
python3 -m backend.oracle_monitor --scenario price_jump --steps 8
python3 -m backend.oracle_monitor --scenario stale --steps 10 --exit-unavailable
```

Without `--steps`, the script keeps monitoring until Ctrl+C. Without `--repeat`, the demo remains healthy after recovery. `--interval 0 --steps 24` runs a bounded demo immediately.

## Fixed rules

Edit the `Rules` dataclass defaults, or supply `Rules(...)` when importing the monitor.

| Observation | Recommendation |
|---|---|
| Valid price younger than 60 seconds; read faster than 1,000 ms; no suspicious movement | STAY |
| Price rises or falls at least 10% since the previous valid reading | REVIEW and verify against another source; critical staleness keeps priority |
| Price age at least 60 but less than 180 seconds | PAUSE new exposure |
| Price age at least 180 seconds, simulated exit route available | EXIT under fixed demo policy |
| Critical stale price but exit unavailable/unverified | REVIEW alternatives; pause new exposure |
| Read response at least 1,000 ms | At least PAUSE; does not override a stronger stale-price action |
| First or second consecutive failed read | PAUSE and investigate |
| Third or later consecutive failed read | REVIEW; source unavailable, cause unknown |
| Missing/invalid price or publication timestamp | REVIEW |
| Three consecutive fully healthy readings after an alert | Clear alert; STAY for any remaining position |

During recovery the action is PAUSE. A STAY result is not an instruction to re-enter a previously exited position. Recommendations are emitted on every poll; no trades occur, and no position holdings are changed or tracked. Exit availability is a simulated boolean, not a real withdrawal quote.

These thresholds are arbitrary demonstration choices. Real feeds have different update behavior and acceptable age limits. [Chainlink describes heartbeat/deviation-based updates and checking `updatedAt`](https://docs.chain.link/data-feeds/overview). Do not deploy the 60/180-second values as universal oracle limits.

## Suspicious price movement

Change `Rules.suspicious_price_change_percent` (default `10`) to adjust the boundary. The calculation is `(current_price - previous_valid_price) / previous_valid_price * 100`. Both positive and negative jumps are checked, including exactly 10%. The first valid reading establishes the baseline; failed or invalid readings do not replace it.

The JSON metrics include signed `price_change_percent` and `price_change_interval_seconds` (both null before a comparison is possible). The interval is between observations and may span failed reads. This is a change-between-readings check, not a time-window volatility model. A jump returns `status: SUSPICIOUS`, `action: REVIEW`, and an explanation. A large move can be real market activity, so it is not proof of manipulation.

Each valid reading becomes the next baseline, including a flagged reading. Three subsequent healthy readings clear the alert using the existing recovery rule. This detects sudden changes; it cannot establish whether a persistently incorrect price is accurate without an independent reference.

## Three different measurements

- **Price age:** observation time minus the oracle's publication timestamp. An unchanged price can still have a new timestamp and be fresh.
- **Read availability:** whether our request succeeded. A failed RPC request does not prove the oracle network is down. A stopped publisher may still return its last price successfully; that appears as growing price age.
- **Read response latency:** how long our request takes. This is not the time between a market event and oracle publication. Actual publication latency needs separately timestamped source/event data; `publication_latency_ms` is therefore null.

## Frontend handoff

Emit newline-delimited JSON, and optionally maintain a latest-state file:

```bash
python3 -m backend.oracle_monitor --repeat --json --output runtime/latest.json
```

Each stdout line is an independent JSON object. `latest.json` is replaced atomically on each poll (one writer per path). Your teammate can have their server read that file or forward the stdout stream. This prototype does not host an HTTP endpoint. Never treat the file as current merely because it exists: a real server should track arrival time/sequence and show disconnected if the producer stops. Simulation timestamps are not real freshness timestamps.

The response contains `schema_version`, `mode`, `feed_id`, `observed_at`, `sequence` (CLI only), `status`, `action`, `reasons`, `metrics`, `policy`, `exit_route_available`, `decision_basis`, and `trade_executed`. Every response says `mode: simulation` and `trade_executed: false`.

Or import the calculation directly in a Python server:

```python
from backend.oracle_monitor import Observation, OracleMonitor

monitor = OracleMonitor()  # Keep this instance between polls, one per feed.
result = monitor.evaluate(Observation(
    observed_at=1000,
    read_ok=True,
    price=100000,
    updated_at=800,  # 200 seconds old -> critical.
    response_ms=80,
    exit_route_available=True,
))
# result['action'] == 'EXIT'; JSON-compatible dictionary for the frontend.
```

## Verify

```bash
python3 -m unittest discover -s tests -v
```

Tests cover threshold boundaries, upward/downward price jumps, configurable jump limits, recovery, critical-staleness priority, invalid baselines, fresh unchanged prices, transport failures, blocked exits, malformed inputs, monotonic observation times, full scenarios and JSON snapshots.

## Next increments

1. Agree the JSON contract with the frontend owner.
2. Select one real feed, its supported chain and feed-specific age limits. Add a read-only adapter for price, decimals and publication timestamp; measure request duration with a monotonic clock, use timeouts, and cross-check failures against another RPC. Update the mode/provenance contract when introducing real data.
3. Link that feed to one verified position dependency.
4. Add position loss and feasible exit-cost calculations. Then an EXIT recommendation can be based on decision economics rather than the demo's fixed risk policy.

An AI model is unnecessary for these rules; explicit conditions make the first implementation easy to inspect and test.
