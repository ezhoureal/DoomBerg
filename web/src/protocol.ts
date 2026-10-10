/**
 * Belem risk-graph wire protocol (v1).
 *
 * A `RiskSnapshot` is everything the frontend needs to render the dependency
 * graph and compute stay/exit signals. The backend supplies graph data,
 * measurements, incidents, quotes and explicitly modeled risk inputs.
 * Portfolio calculations are client-side in `model/risk.ts`; warnings combine
 * backend flags and frontend rules. See docs/protocol.md for semantics.
 */

export const SCHEMA_VERSION = "1.0";

export type ChainId = "ethereum" | "solana" | "base" | "arbitrum" | "offchain";

export type NodeType =
  | "chain" // settlement layer
  | "bridge" // cross-chain messaging / wrapped-asset bridge
  | "protocol" // smart-contract system (Morpho Blue, Kamino Lend, Drift...)
  | "market" // a single market inside a protocol (lending market, AMM pool, perp market)
  | "vault" // capital allocator that routes deposits into markets/venues
  | "curator" // off-chain party with allocation / admin powers
  | "strategy" // multi-leg position we construct ourselves (e.g. a loop)
  | "asset" // token
  | "issuer" // entity backing / minting an asset
  | "custodian" // off-exchange custody / CEX venue
  | "oracle"; // price feed

export type EdgeKind =
  | "settles_on" // dependency runs on this chain
  | "deployed_on" // contract system lives on this protocol
  | "allocates_to" // vault -> market allocation (exposure = allocation share)
  | "collateral" // market accepts this asset as collateral
  | "loan_asset" // market lends this asset
  | "holds" // directly holds this asset
  | "underlying" // asset wraps / derives from another asset
  | "issued_by" // asset is minted / redeemable through this issuer
  | "priced_by" // relies on this oracle for pricing / liquidations
  | "oracle_source" // oracle reads from this upstream source
  | "bridged_via" // asset exists on this chain through a bridge
  | "hedged_on" // hedge leg sits on this venue
  | "managed_by" // admin / curator powers
  | "exit_liquidity"; // exit relies on this market's depth

export interface RiskBaseline {
  /** Probability the node fails (exploit, depeg, halt...) within the horizon. 0..1 */
  pFail: number;
  /** Fraction of value lost at this node if it fails. 0..1 */
  lossGivenFailure: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  chain: ChainId;
  description?: string;
  /** Free-form observable metrics. Well-known keys are interpreted by warning rules (see model/warnings.ts). */
  metrics?: NodeMetrics;
  baseline: RiskBaseline;
  /** Pre-computed flags from the backend, merged with client-side warning rules. */
  flags?: Warning[];
  /** Explorer / docs link. */
  url?: string;
}

export interface NodeMetrics {
  tvlUsd?: number;
  /** Share of the host chain's DeFi TVL held by this protocol. 0..1 */
  tvlShareOfChain?: number;
  /** Lending market utilization. 0..1 */
  utilization?: number;
  /** Liquidation LTV for lending markets. 0..1 */
  lltv?: number;
  /** Current price vs peg / reference, percent (negative = below peg). */
  pegDeviationPct?: number;
  /** Oracle: number of independent upstream sources. */
  sourceCount?: number;
  /** Oracle: deviation between oracle price and best market price, percent. */
  deviationPct?: number;
  /** Oracle: seconds since last update vs configured heartbeat. */
  stalenessSec?: number;
  heartbeatSec?: number;
  /** Perp markets: annualised funding rate, percent. */
  fundingRateApr?: number;
  /** Market depth available for exit within 2% price impact, USD. */
  depthUsd2pct?: number;
  /** Chain: outages in the trailing 12 months. */
  outages12m?: number;
  /** Audits count / days since last audit. */
  audits?: number;
  [key: string]: number | undefined;
}

export interface GraphEdge {
  /** The dependent (closer to the position). */
  from: string;
  /** The dependency (closer to the settlement layer). */
  to: string;
  kind: EdgeKind;
  /** Share of `from`'s value that is routed to / backed by `to`. 0..1 */
  exposure: number;
  /**
   * Fraction of `to`'s loss that passes through to `from`, given exposure.
   * <1 when buffers absorb part of it (e.g. LTV headroom), >1 for leverage.
   */
  transmission: number;
  note?: string;
}

export interface ExitQuote {
  /** Price impact + fees to unwind the full position now, basis points. */
  slippageBps: number;
  /** Fixed costs: gas, bridge fees, withdrawal fees. USD */
  fixedCostUsd: number;
  /** Size that can be exited right now (withdrawable liquidity / depth). USD */
  availableLiquidityUsd: number;
  /** Expected wall-clock time to fully unwind. */
  timeToExitHours: number;
  /** Route summary shown to the PM, e.g. "Withdraw from vault -> USDC". */
  route: string;
}

export interface Position {
  id: string;
  label: string;
  chain: ChainId;
  /** The node we actually hold (vault share, LP token, strategy...). */
  entryNodeId: string;
  valueUsd: number;
  /** Current yield, percent APR — staying earns this, exiting forfeits it over the horizon. */
  apr: number;
  strategy: string;
  exit: ExitQuote;
}

export type IncidentKind =
  | "exploit"
  | "oracle_deviation"
  | "depeg"
  | "liquidity_crunch"
  | "outage"
  | "governance"
  | "market_dislocation";

export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Incident {
  id: string;
  nodeId: string;
  kind: IncidentKind;
  severity: Severity;
  title: string;
  description: string;
  detectedAt: string; // ISO-8601
  status: "active" | "resolved";
  /** Updated failure probability over the horizon while the incident is active. */
  pFail: number;
  /** Updated loss-given-failure while the incident is active. */
  lossGivenFailure: number;
  source: string; // where the signal came from (monitor, feed, manual, simulated)
}

export interface Warning {
  code: string;
  severity: Severity;
  message: string;
}

export interface RiskParams {
  horizonDays: number;
  /** Stay/exit thresholds (see model/risk.ts#decide). */
  watchRatio: number; // WATCH when expected loss >= watchRatio * exit cost
  stressLossWatchPct: number; // WATCH when stressed loss >= this % of position value
  /** Warning rule thresholds. */
  concentrationPct: number; // node reaches >= this % of AUM
  utilizationWarn: number;
  oracleDeviationWarnPct: number;
  oracleDeviationCritPct: number;
  pegDeviationWarnPct: number;
  tvlShareWarn: number;
  monteCarloSamples: number;
  varConfidence: number; // e.g. 0.99
}

export interface Portfolio {
  id: string;
  name: string;
  manager: string;
  aumUsd: number;
  baseCurrency: "USD";
}

export interface RiskSnapshot {
  schemaVersion: string;
  asOf: string; // ISO-8601
  source: "mock" | "live";
  portfolio: Portfolio;
  positions: Position[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  incidents: Incident[];
  riskParams: RiskParams;
  /** Optional backend producer metadata. observedAt is accelerated demo time;
   * receivedAt and asOf use wall time. Financial inputs remain mock assumptions. */
  monitor?: {
    nodeId: string;
    runId: string;
    sequence: number;
    scenario: string;
    status: string;
    observedAt: string;
    receivedAt: string;
    intervalSeconds: number;
    simulation: boolean;
  };
}
