# Risk snapshot protocol (v1)

Canonical types: [`web/src/protocol.ts`](../web/src/protocol.ts). Mock instance: [`web/src/data/mockSnapshot.json`](../web/src/data/mockSnapshot.json).

The backend returns one `RiskSnapshot` JSON document containing the graph, metrics, incidents, exit quotes and model inputs. Measurements must be distinguished from assumptions: `pFail`, `lossGivenFailure` and loss-transmission factors are modeled inputs, not directly observable facts. In this demo, portfolio data, quotes and these inputs are mocked. Portfolio risk numbers (reach, expected loss, VaR and decisions) are derived in the frontend model (`web/src/model/`). Node warnings merge backend flags with client-side rules.

## Backend modes

`python3 -m backend.server` serves the snapshot on port 8000. Vite proxies `/api/*` to it; override the base with `VITE_API_URL`. If the backend is unreachable, the UI falls back to the bundled mock (`source: "mock"`), labelled offline, and keeps retrying.

| endpoint | purpose |
|---|---|
| `GET /snapshot?events=a,b` | **Simulation mode** (`source: "simulation"`): the mock book plus the selected risk events |
| `GET /snapshot?mode=live` | **Live data monitor**: not built yet (`501`) |
| `GET /events` | simulated event catalogue `[{id, title, description}]` |

Both modes go through the same pipeline: **observations → detection rules → incidents → model**.

* An event (`backend/events.py`) is a set of observations: node metric changes (peg, oracle deviation or staleness, utilisation), exit-liquidity changes, and explicit incidents for signals no metric captures (exploit report, chain halt).
* `backend/detect.py` turns metrics into incidents with stable ids (`det-<rule>-<nodeId>`). This is the only place where an observation becomes a `pFail`/`lossGivenFailure`. The mapping is a documented prior, not a calibrated estimate. Staleness is measured against each feed's own `heartbeatSec`.
* The template's hand-written incidents are dropped, so every metric-driven incident in simulation mode comes from the rules. Live mode will feed real metrics into the same rules.

## Top level

| field | type | notes |
|---|---|---|
| `schemaVersion` | `"1.0"` | major version must match the frontend |
| `asOf` | ISO-8601 | snapshot time |
| `source` | `"mock" \| "simulation" \| "live"` | bundled file, backend simulation, real data |
| `portfolio` | `{id, name, manager, aumUsd, baseCurrency}` | |
| `positions[]` | `Position` | what we hold |
| `nodes[]` | `GraphNode` | dependencies (chains, protocols, markets, vaults, assets, issuers, oracles, bridges, curators, custodians) |
| `edges[]` | `GraphEdge` | `from` depends on `to` (DAG; cycles are rejected) |
| `incidents[]` | `Incident` | live signals that override node risk while `status: "active"` |
| `riskParams` | `RiskParams` | horizon, decision thresholds and warning thresholds |

## Position
```jsonc
{
  "id": "pos-pt-susde-loop",
  "label": "PT-sUSDe 27NOV26 loop (Morpho)",
  "chain": "ethereum",
  "entryNodeId": "strat-pt-susde-loop",  // the node we hold; its dependency tree is discovered from here
  "valueUsd": 40000000,
  "apr": 18.2,
  "strategy": "3x looped Pendle PT-sUSDe ...",
  "exit": {
    "slippageBps": 160,            // full-size unwind quote right now
    "fixedCostUsd": 2500,          // gas, bridge, withdrawal fees
    "availableLiquidityUsd": 4e7,  // exitable right now (utilisation / depth / queues)
    "timeToExitHours": 6,
    "route": "Flash-loan deleverage -> sell PT on Pendle AMM -> repay USDC"
  }
}
```

## GraphNode
```jsonc
{
  "id": "oracle-pt-susde",
  "type": "oracle",              // chain|bridge|protocol|market|vault|curator|strategy|asset|issuer|custodian|oracle
  "label": "PT-sUSDe oracle",
  "chain": "ethereum",           // ethereum|solana|base|arbitrum|offchain
  "baseline": { "pFail": 0.002, "lossGivenFailure": 0.3 },  // over riskParams.horizonDays
  "metrics": { "sourceCount": 1, "deviationPct": 3.2, "stalenessSec": 300, "heartbeatSec": 900 },
  "flags": []                    // optional backend-computed warnings, merged with client rules
}
```
Metric keys the warning rules use: `utilization`, `lltv`, `pegDeviationPct`, `sourceCount`, `deviationPct`, `stalenessSec`, `heartbeatSec`, `fundingRateApr`, `tvlShareOfChain`, `tvlUsd`, `depthUsd2pct`. Any other numeric key is shown in the node details.

## GraphEdge
```jsonc
{ "from": "vault-steakhouse-usdc", "to": "mkt-morpho-pt-susde-usdc",
  "kind": "allocates_to", "exposure": 0.35, "transmission": 1, "note": "35% allocation" }
```
* `exposure`: share of `from`'s value routed to or backed by `to` (vault allocation, collateral mix, pool weights).
* `transmission`: fraction of `to`'s loss that reaches `from`. Below 1 when a buffer absorbs part of it (a lender is protected by LTV headroom). Above 1 for leverage (a 3x loop has `transmission: 3`).
* `kind`: `settles_on, deployed_on, allocates_to, collateral, loan_asset, holds, underlying, issued_by, priced_by, oracle_source, bridged_via, hedged_on, managed_by, exit_liquidity`.

## Incident
```jsonc
{ "id": "inc-001", "nodeId": "oracle-pt-susde", "kind": "oracle_deviation", "severity": "high",
  "title": "...", "description": "...", "detectedAt": "...", "status": "active",
  "pFail": 0.18, "lossGivenFailure": 0.35, "source": "oracle-deviation monitor" }
```
While active: `p = 1 - (1 - p_baseline)(1 - p_incident)` and `LGF = max(LGF_baseline, LGF_incident)`.

## Model (summary; details in `web/src/model/risk.ts`)
1. **Reach** of node f from a position: `r = min(Σ_paths Π exposure·transmission, max_paths Π max(1, transmission))`. Summing over paths handles allocations. The cap stops shared sinks (every leg settles on Ethereum) from being counted twice.
2. **Expected loss**: `EL = 1 − Π_f (1 − p_f · min(1, LGF_f · r_f))`, plus per-node marginal attribution.
3. **Portfolio VaR/CVaR**: Monte Carlo over node failures. Shared nodes are drawn once per sample, so correlation between positions that share a dependency is kept.
4. **Decision**: exiting avoids only the *incident-driven* EL (`EL − EL_baseline`). Baseline risk was underwritten at entry, is paid for by the yield, and would follow the capital into any redeployment.
   * Only the **exitable fraction** `x = availableLiquidity / value` can escape. Exiting avoids `x · incident EL` and costs `x · value · slippage + fixed`.
   * **EXIT** if avoidable EL ≥ exit cost.
   * If nothing can be withdrawn (`x = 0`), exiting avoids nothing: an incident in the tree gives **WATCH**, never EXIT.
   * **WATCH** if incident EL ≥ `watchRatio` × exit cost, a high/critical incident is in the tree, stressed loss ≥ `stressLossWatchPct`, or total EL > carry over the horizon.
   * **STAY** otherwise.
   * **Break-even probability** `p* = exit cost / (x · (stressed loss − baseline EL))`. Exiting pays only if you believe the incident materialises with probability above p*.

Known simplifications: failures are independent apart from shared nodes, there is a single horizon, and exit cost is a static quote (it does not grow during a crisis).
