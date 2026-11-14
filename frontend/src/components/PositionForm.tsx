import { useEffect, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { api } from "../api";
import type { BorrowFields, PositionKind, Preset } from "../types";
import { CHAINS } from "../format";
import { ROLE_LABELS, type PositionRole } from "../ui/workspace";

type Req = {
  kind: PositionKind;
  address: string;
  chain_id: number;
  size_usd: number;
  book_usd: number;
  horizon_days: number;
  label?: string;
} & BorrowFields;

export default function PositionForm({
  onAnalyze,
  busy,
  initial,
  initialRole = "entered",
}: {
  onAnalyze: (r: Req, role: PositionRole) => void;
  busy: boolean;
  initial?: Req;
  initialRole?: PositionRole;
}) {
  const [kind, setKind] = useState<PositionKind>(initial?.kind ?? "market");
  const [address, setAddress] = useState(
    initial?.address ??
      "0x1e9d614631a7df0ec07fb05b2c8cb2491575fd1a63a33bf187a6afb295a4fc64",
  );
  const [chain, setChain] = useState(initial?.chain_id ?? 1);
  const [size, setSize] = useState(initial?.size_usd ?? 1_000_000);
  const [book, setBook] = useState(initial?.book_usd ?? 10_000_000);
  const [horizon, setHorizon] = useState(initial?.horizon_days ?? 30);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [role, setRole] = useState<PositionRole>(initialRole);
  const [ltv, setLtv] = useState(initial?.ltv ?? 0.4);
  const [deploy, setDeploy] = useState(initial?.deploy_address ?? "");
  const [account, setAccount] = useState(initial?.account ?? "");
  const [statePath, setStatePath] = useState(initial?.state_path ?? "../basisd/data/trader-testnet");
  const borrow = kind === "borrow";
  const cexBasis = kind === "cex_basis";
  const borrowFields = (): BorrowFields =>
    borrow
      ? {
          ltv: account.trim() ? null : ltv,
          deploy_address: deploy.trim() || null,
          account: account.trim() || null,
        }
      : cexBasis
        ? { state_path: statePath.trim() || null }
        : {};
  const pickKind = (k: PositionKind) => {
    setKind(k);
    // A venue:symbol and a contract address are not interchangeable: reset the field when crossing over.
    if (k === "cex_basis" && address.startsWith("0x")) setAddress("binance:BTC/USDT:USDT");
    if (k !== "cex_basis" && !address.startsWith("0x")) setAddress("");
  };

  useEffect(() => {
    api
      .presets()
      .then(setPresets)
      .catch(() => {});
  }, []);

  return (
    <div className="panel-section">
      <p className="form-intro">
        Choose a reference position or enter a contract.
      </p>
      <div className="seg">
        {(
          [
            ["token", "PT token"],
            ["market", "Lending market"],
            ["borrow", "Borrow (leveraged)"],
            ["cex_basis", "CEX basis (basisd)"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={kind === k ? "on" : ""}
            onClick={() => pickKind(k)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="fld">
        <span>
          {kind === "market"
            ? "Morpho market id (PT collateral)"
            : borrow
              ? "Morpho market id you borrow from"
              : cexBasis
                ? "Venue and perp, as basisd names them"
                : "Pendle PT token address"}
        </span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          spellCheck={false}
          placeholder={cexBasis ? "binance:BTC/USDT:USDT" : "0x…"}
        />
      </label>
      {cexBasis && (
        <label className="fld">
          <span>basisd state: positions.json or its folder, on the API's machine</span>
          <input
            value={statePath}
            onChange={(e) => setStatePath(e.target.value)}
            spellCheck={false}
            placeholder="/opt/basisd/data/trader-testnet"
          />
        </label>
      )}
      {borrow && (
        <>
          <label className="fld">
            <span>Borrowed money deployed into PT (empty = PT loop)</span>
            <input
              value={deploy}
              onChange={(e) => setDeploy(e.target.value)}
              spellCheck={false}
              placeholder="0x… Pendle PT address"
            />
          </label>
          <div className="row2">
            <label className="fld">
              <span>LTV (debt / collateral)</span>
              <input
                type="number"
                value={ltv}
                min={0.01}
                max={0.99}
                step={0.05}
                disabled={!!account.trim()}
                onChange={(e) => setLtv(Number(e.target.value))}
              />
            </label>
            <label className="fld">
              <span>Or read a live borrower</span>
              <input
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                spellCheck={false}
                placeholder="0x… wallet (optional)"
              />
            </label>
          </div>
        </>
      )}
      <div className="row2">
        {!cexBasis && (
          <label className="fld">
            <span>Chain</span>
            <select
              value={chain}
              onChange={(e) => setChain(Number(e.target.value))}
            >
              {Object.entries(CHAINS)
                .filter(([id]) => id !== "0")
                .map(([id, n]) => (
                  <option key={id} value={id}>
                    {n}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="fld">
          <span>Horizon (days)</span>
          <input
            type="number"
            value={horizon}
            min={1}
            max={365}
            onChange={(e) => setHorizon(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="row2">
        {!cexBasis && (
          <label className="fld">
            <span>{borrow ? "Your capital / equity ($)" : "Entered position size ($)"}</span>
            <input
              type="number"
              value={size}
              step={100000}
              onChange={(e) => setSize(Number(e.target.value))}
            />
          </label>
        )}
        <label className="fld">
          <span>Portfolio value ($)</span>
          <input
            type="number"
            value={book}
            step={1000000}
            onChange={(e) => setBook(Number(e.target.value))}
          />
        </label>
      </div>
      <label className="fld">
        <span>Position classification</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as PositionRole)}
        >
          {Object.entries(ROLE_LABELS).map(([id, label]) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p className="form-intro">
        {cexBasis
          ? "Size, fills, leverage and liquidation price come from basisd's state; prices, funding and order books from the venue's mainnet API."
          : "Sizes are entered manually. Declared holdings are user-reported, not wallet-verified."}
      </p>
      <button
        className="btn primary"
        disabled={busy || !address || (cexBasis && !statePath.trim())}
        onClick={() =>
          onAnalyze(
            {
              kind,
              address,
              chain_id: cexBasis ? 0 : chain,
              size_usd: size,
              book_usd: book,
              horizon_days: horizon,
              ...borrowFields(),
            },
            role,
          )
        }
      >
        {busy ? <Loader2 className="spin" size={16} /> : <Search size={16} />}{" "}
        {busy ? "Tracing…" : "Analyse investment"}
      </button>

      <div className="sub-h">Reference positions</div>
      <div className="list">
        {presets.map((p) => (
          <button
            key={p.id}
            className="list-item"
            disabled={busy}
            title={p.note}
            onClick={() => {
              setKind(p.kind);
              setAddress(p.address);
              setChain(p.chain_id);
              setSize(p.size_usd);
              setLtv(p.ltv ?? 0.4);
              setDeploy(p.deploy_address ?? "");
              setAccount(p.account ?? "");
              setRole("example");
              onAnalyze(
                {
                  kind: p.kind,
                  address: p.address,
                  chain_id: p.chain_id,
                  size_usd: p.size_usd,
                  book_usd: book,
                  horizon_days: horizon,
                  ltv: p.ltv ?? null,
                  deploy_address: p.deploy_address ?? null,
                  account: p.account ?? null,
                },
                "example",
              );
            }}
          >
            <div>
              <b>{p.label}</b>
            </div>
            <span className="chip">{CHAINS[p.chain_id]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
