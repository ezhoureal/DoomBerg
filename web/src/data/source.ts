import type { RiskSnapshot } from "../protocol";
import { SCHEMA_VERSION } from "../protocol";
import mock from "./mockSnapshot.json";

/** Backend base URL. Defaults to the Vite /api proxy (see vite.config.ts). */
const API = (import.meta.env.VITE_API_URL as string | undefined) || "/api";

export interface SimEvent {
  id: string;
  title: string;
  description: string;
}

export const staticMock = mock as RiskSnapshot;

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(API + path, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function loadSnapshot(events: string[], signal?: AbortSignal): Promise<RiskSnapshot> {
  const qs = events.length ? `?events=${events.map(encodeURIComponent).join(",")}` : "";
  const snapshot = await get<RiskSnapshot>(`/snapshot${qs}`, signal);
  if (snapshot?.schemaVersion?.split(".")[0] !== SCHEMA_VERSION.split(".")[0])
    throw new Error(`Unsupported snapshot schema ${snapshot?.schemaVersion}, expected ${SCHEMA_VERSION}`);
  return snapshot;
}

export const loadEvents = (signal?: AbortSignal) => get<SimEvent[]>("/events", signal);
