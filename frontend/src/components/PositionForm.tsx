import { useEffect, useState } from "react";
import { Search, Wallet, Loader2 } from "lucide-react";
import { api } from "../api";
import type { Preset } from "../types";
import { CHAINS, pct, short, usd } from "../format";

type Req = { kind: string; address: string; chain_id: number; size_usd: number; book_usd: number; horizon_days: number; label?: string };

export default function PositionForm({ onAnalyze, busy }: { onAnalyze: (r: Req) => void; busy: boolean }) {
  const [kind, setKind] = useState<"vault" | "market" | "token" | "wallet">("vault");
  const [address, setAddress] = useState("0xD6d4b804014EF27836dBe9f8f6Bf6c71251548Ec");
  const [chain, setChain] = useState(1);
  const [size, setSize] = useState(1_000_000);
  const [book, setBook] = useState(10_000_000);
  const [horizon, setHorizon] = useState(30);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [rx, setRx] = useState<Awaited<ReturnType<typeof api.rockawayx>>>([]);
  const [walletPos, setWalletPos] = useState<{ kind: string; address: string; label: string; size_usd: number; asset: string }[] | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => {});
    api.rockawayx().then(setRx).catch(() => {});
  }, []);

  const submit = (over?: Partial<Req>) =>
    onAnalyze({ kind: kind === "wallet" ? "vault" : kind, address, chain_id: chain, size_usd: size, book_usd: book, horizon_days: horizon, ...over });

  const lookupWallet = async () => {
    setWalletBusy(true); setWalletErr(null); setWalletPos(null);
    try { setWalletPos((await api.wallet(address, chain)).positions); }
    catch (e: any) { setWalletErr(e.message); }
    finally { setWalletBusy(false); }
  };

  return (
    <div className="panel-section">
      <div className="step"><span>1</span> Enter the position</div>
      <div className="seg">
        {(["vault", "market", "token", "wallet"] as const).map((k) => (
          <button key={k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{k}</button>
        ))}
      </div>
      <label className="fld">
        <span>{kind === "market" ? "Morpho market id" : kind === "wallet" ? "Wallet address" : kind === "token" ? "Token address" : "Vault address"}</span>
        <input value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} placeholder="0x…" />
      </label>
      <div className="row2">
        <label className="fld">
          <span>Chain</span>
          <select value={chain} onChange={(e) => setChain(Number(e.target.value))}>
            {Object.entries(CHAINS).map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select>
        </label>
        <label className="fld">
          <span>Horizon (days)</span>
          <input type="number" value={horizon} min={1} max={365} onChange={(e) => setHorizon(Number(e.target.value))} />
        </label>
      </div>
      {kind !== "wallet" && (
        <div className="row2">
          <label className="fld">
            <span>Position size ($)</span>
            <input type="number" value={size} step={100000} onChange={(e) => setSize(Number(e.target.value))} />
          </label>
          <label className="fld">
            <span>Whole book ($)</span>
            <input type="number" value={book} step={1000000} onChange={(e) => setBook(Number(e.target.value))} />
          </label>
        </div>
      )}
      {kind === "wallet" ? (
        <button className="btn primary" disabled={walletBusy || !address} onClick={lookupWallet}>
          {walletBusy ? <Loader2 className="spin" size={16} /> : <Wallet size={16} />} Find Morpho positions
        </button>
      ) : (
        <button className="btn primary" disabled={busy || !address} onClick={() => submit()}>
          {busy ? <Loader2 className="spin" size={16} /> : <Search size={16} />} {busy ? "Tracing dependencies…" : "Trace dependencies"}
        </button>
      )}
      {walletErr && <div className="err">{walletErr}</div>}
      {walletPos && (
        <div className="list">
          {walletPos.length === 0 && <div className="muted">No positions.</div>}
          {walletPos.map((p) => (
            <button key={p.address} className="list-item" onClick={() => { setSize(p.size_usd); submit({ kind: p.kind, address: p.address, size_usd: p.size_usd, label: undefined }); }}>
              <div><b>{p.label}</b><small>{p.kind} · {p.asset}</small></div><span>{usd(p.size_usd)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="sub-h">Reference positions (live data)</div>
      <div className="list">
        {presets.map((p) => (
          <button key={p.id} className="list-item" disabled={busy} title={p.note}
            onClick={() => { setKind(p.kind as any); setAddress(p.address); setChain(p.chain_id); setSize(p.size_usd);
              onAnalyze({ kind: p.kind, address: p.address, chain_id: p.chain_id, size_usd: p.size_usd, book_usd: book, horizon_days: horizon }); }}>
            <div><b>{p.label}</b><small>{p.note}</small></div>
            <span className="chip">{CHAINS[p.chain_id]}</span>
          </button>
        ))}
      </div>

      {rx.length > 0 && (
        <>
          <div className="sub-h">All RockawayX-curated vaults (Morpho API)</div>
          <div className="list compact">
            {rx.map((v) => (
              <button key={v.address + v.chain_id} className="list-item" disabled={busy}
                onClick={() => { setKind("vault"); setAddress(v.address); setChain(v.chain_id);
                  onAnalyze({ kind: "vault", address: v.address, chain_id: v.chain_id, size_usd: size, book_usd: book, horizon_days: horizon }); }}>
                <div><b>{v.name}</b><small>{v.network} · {v.asset} · {short(v.address)} · APY {pct(v.net_apy)}</small></div>
                <span>{usd(v.tvl_usd)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
