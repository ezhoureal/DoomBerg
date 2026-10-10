export function usd(v: number, digits = 1) {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(digits)}K`;
  return `$${v.toFixed(0)}`;
}
export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export const bps = (v: number) => `${(v * 1e4).toFixed(0)} bps`;
