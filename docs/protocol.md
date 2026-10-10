# Risk snapshot protocol (v1)

Canonical types: [`web/src/protocol.ts`](../web/src/protocol.ts). Mock instance: [`web/src/data/mockSnapshot.json`](../web/src/data/mockSnapshot.json).

The backend returns one `RiskSnapshot` JSON document containing the graph, metrics, incidents, exit quotes and model inputs. Measurements must be distinguished from assumptions: `pFail`, `lossGivenFailure` and loss-transmission factors are modeled inputs, not directly observable facts. In this demo, portfolio data, quotes and these inputs are mocked. Portfolio risk numbers (reach, expected loss, VaR and decisions) are derived in the frontend model (`web/src/model/`). Node warnings merge backend flags with client-side rules.

The local default polls `/api/snapshot`, proxied by Vite to Python at `http://127.0.0.1:8000/snapshot`. Override with `VITE_SNAPSHOT_URL` or explicitly use the static mock with `VITE_USE_MOCK=true`. A connected backend may still serve simulated data and must keep `source: "mock"` in that case.

## Python monitor integration

The adapter overlays synthetic readings onto `oracle-chainlink-btc`. Numeric keys include `priceUsd`, `stalenessSec`, `readResponseMs`, `priceChangePct`, `priceChangeIntervalSec`, and consecutive read counters. Unknown values are omitted (not null or zero). `priceChangePct` is not `deviationPct`: the latter requires a separate market reference.

Backend warning codes use a `monitor.` prefix and carry `severity` and `message`. Active warnings disappear when their condition clears; the monitor reports recovery until enough healthy readings arrive. Flags are not incidents and do not directly modify expected loss or STAY/WATCH/EXIT. No failure probabilities are derived automatically from a warning.

Optional top-level `monitor` metadata contains `nodeId`, `runId`, `sequence`, `scenario`, `status`, `observedAt`, `receivedAt`, `intervalSeconds`, and `simulation`. `observedAt` is accelerated simulation time. `asOf` and `receivedAt` are wall-clock timestamps. Clients use advancing run/sequence identifiers and request success to track connection freshness. Local incident edits are a separate overlay and survive refreshes.

## Top level

| field | type | notes |
|---|---|---|
| `schemaVersion` | `"1.0"` | major version must match the frontend |
| `asOf` | ISO-8601 | snapshot time |
| `source` | `"mock" \| "live"` | |
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
   * **EXIT** if incident EL ≥ exit cost (slippage + fixed costs).
   * **WATCH** if incident EL ≥ `watchRatio` × exit cost, a high/critical incident is in the tree, stressed loss ≥ `stressLossWatchPct`, or total EL > carry over the horizon.
   * **STAY** otherwise.
   * **Break-even probability** `p* = exit cost / (stressed loss − baseline EL)`. Exiting pays only if you believe the incident materialises with probability above p*.

Known simplifications: failures are independent apart from shared nodes, there is a single horizon, and exit cost is a static quote (it does not grow during a crisis).
