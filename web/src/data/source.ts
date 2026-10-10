import type { RiskSnapshot } from "../protocol";
import { SCHEMA_VERSION } from "../protocol";
import mock from "./mockSnapshot.json";

/**
 * Snapshot loader. Set VITE_SNAPSHOT_URL to point at the backend (must return a
 * `RiskSnapshot`); otherwise the bundled mock is used.
 */
export async function loadSnapshot(): Promise<RiskSnapshot> {
  const url = import.meta.env.VITE_SNAPSHOT_URL as string | undefined;
  const snapshot: RiskSnapshot = url ? await fetch(url).then((r) => r.json()) : (mock as RiskSnapshot);
  if (snapshot.schemaVersion.split(".")[0] !== SCHEMA_VERSION.split(".")[0])
    throw new Error(`Unsupported snapshot schema ${snapshot.schemaVersion}, expected ${SCHEMA_VERSION}`);
  return snapshot;
}
