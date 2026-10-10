export const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined || Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.001 ? 3 : d)}%`;

export const usd = (x: number | null | undefined) => {
  if (x === null || x === undefined) return "n/a";
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(x / 1e3).toFixed(1)}k`;
  return `$${x.toFixed(0)}`;
};

export const short = (a?: string | null) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "");

export const CHAINS: Record<number, string> = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon", 143: "Monad" };

export const TYPE_META: Record<string, { color: string; label: string; glyph: string }> = {
  position: { color: "#e8c468", label: "Position", glyph: "◆" },
  vault: { color: "#7c9cff", label: "Vault", glyph: "▣" },
  curator: { color: "#b18cff", label: "Curator", glyph: "☺" },
  market: { color: "#4fd1c5", label: "Lending market", glyph: "⇄" },
  oracle: { color: "#f6ad55", label: "Oracle", glyph: "◉" },
  feed: { color: "#fbd38d", label: "Price feed", glyph: "∿" },
  asset: { color: "#68d391", label: "Token", glyph: "●" },
  amm: { color: "#f687b3", label: "AMM / PT market", glyph: "≋" },
  issuer: { color: "#90cdf4", label: "Issuer / custodian", glyph: "⌂" },
  mint_authority: { color: "#fc8181", label: "Who can mint", glyph: "✎" },
  bridge: { color: "#d6bcfa", label: "Bridge", glyph: "⇆" },
  protocol: { color: "#a0aec0", label: "Protocol code", glyph: "{}" },
  chain: { color: "#cbd5e0", label: "Chain", glyph: "⛓" },
};

export const riskColor = (share: number) => {
  if (share >= 0.15) return "#ff5d6c";
  if (share >= 0.06) return "#ff9f43";
  if (share >= 0.02) return "#ffd166";
  return "#4fd1a5";
};

export const lossColor = (l: number) => {
  if (l >= 0.2) return "#ff5d6c";
  if (l >= 0.05) return "#ff9f43";
  if (l >= 0.005) return "#ffd166";
  return "#4fd1a5";
};
