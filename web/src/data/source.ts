import type { RiskSnapshot } from "../protocol";
import { SCHEMA_VERSION } from "../protocol";
import mock from "./mockSnapshot.json";

/**
 * Default: the Vite /api proxy to the Python backend. Static mock is opt-in;
 * never silently hide a backend outage by substituting bundled data.
 */
export const usesStaticMock = import.meta.env.VITE_USE_MOCK === "true";

export async function loadSnapshot(signal?: AbortSignal): Promise<RiskSnapshot> {
  const url = import.meta.env.VITE_SNAPSHOT_URL || "/api/snapshot";
  let snapshot: RiskSnapshot;
  if (usesStaticMock) snapshot = mock as RiskSnapshot;
  else {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}`);
    snapshot = await response.json();
  }
  if (!snapshot || typeof snapshot.schemaVersion !== "string" || snapshot.schemaVersion.split(".")[0] !== SCHEMA_VERSION.split(".")[0])
    throw new Error(`Unsupported snapshot schema; expected ${SCHEMA_VERSION}`);
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.positions)
    || !Array.isArray(snapshot.incidents) || !snapshot.portfolio || !snapshot.riskParams
    || !Number.isFinite(Date.parse(snapshot.asOf))) throw new Error("Incomplete risk snapshot");
  return snapshot;
}
