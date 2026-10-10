import type { Analysis, Catalog, Preset, ShockResult } from "./types";

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const j = await r.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return r.json();
}

export const api = {
  health: () => call<{ ok: boolean; llm: string }>("/health"),
  presets: () => call<Preset[]>("/presets"),
  catalog: () => call<Catalog>("/catalog"),
  rockawayx: () => call<{ address: string; name: string; chain_id: number; network: string; asset: string; tvl_usd: number; liquidity_usd: number; net_apy: number }[]>("/vaults/rockawayx"),
  wallet: (address: string, chainId: number) =>
    call<{ positions: { kind: string; address: string; label: string; size_usd: number; asset: string }[] }>(`/wallet/${address}?chain_id=${chainId}`),
  analyze: (body: { kind: string; address: string; chain_id: number; size_usd: number; book_usd: number; horizon_days: number; label?: string }) =>
    call<Analysis>("/analyze", body),
  shock: (body: { position_id: string; node_id: string; mode: string; alert: string; probability_override?: number | null; exit_cost_override?: number | null; horizon_days?: number }) =>
    call<ShockResult>("/shock", body),
  replay: (body: { position_id: string; incident_id: string; exit_cost_override?: number | null }) => call<ShockResult>("/replay", body),
};
