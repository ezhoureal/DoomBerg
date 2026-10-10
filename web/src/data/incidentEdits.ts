import type { Incident } from "../protocol";

/** User edits are an overlay; background refresh must not discard them. */
export function mergeIncidents(
  remote: Incident[], local: Incident[],
  overrides: Record<string, Incident["status"]>, hidden: string[],
): Incident[] {
  const localIds = new Set(local.map((i) => i.id));
  return [...local, ...remote.filter((i) => !localIds.has(i.id))]
    .filter((i) => !hidden.includes(i.id))
    .map((i) => overrides[i.id] ? { ...i, status: overrides[i.id] } : i);
}

/** A responsive endpoint with a frozen producer is still stale. */
export function producerStale(lastAdvance: number, now: number, intervalSeconds: number): boolean {
  return now - lastAdvance >= Math.max(5000, intervalSeconds * 3000);
}
