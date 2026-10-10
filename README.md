# Belem: DeFi dependency risk graph

Interactive React frontend for the Belem Capital DeFi Risk Dependency Challenge (`belemCapital.pdf`). It shows Morpho (Ethereum) and Solana positions as a dependency graph, propagates incidents through it, and gives each position a **STAY / WATCH / EXIT** signal by comparing incident-driven expected loss with exit cost.

```bash
cd web && npm install && npm run dev
```

* Data protocol and model: [docs/protocol.md](docs/protocol.md)
* Mock data (replace with backend): `web/src/data/mockSnapshot.json`. Point `VITE_SNAPSHOT_URL` at a live endpoint to switch.
* Model: `web/src/model/risk.ts` (reach, EL, Monte Carlo VaR, decision) and `web/src/model/warnings.ts` (rule-based warning signs).

UI: click a position or node to highlight its dependency paths. Use **focus** to isolate one position's tree. Toggle incidents on or off, or inject a simulated incident on any node from the right-hand panel; every number updates live.
