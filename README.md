# Belem: DeFi dependency risk graph

Interactive React frontend for the Belem Capital DeFi Risk Dependency Challenge (`belemCapital.pdf`). It shows Morpho (Ethereum) and Solana positions as a dependency graph, propagates incidents through it, and gives each position a **STAY / WATCH / EXIT** signal by comparing incident-driven expected loss with exit cost.

From the repository root, start the integrated Python + React demo:

```bash
python3 run_demo.py
```

Open http://127.0.0.1:5173 and click **Inspect monitored oracle**. Ctrl+C stops both services. See [backend setup](README_BACKEND.md).

Or start `python3 -m backend.snapshot_server` from the repository root and `npm ci && npm run dev` from `web` in separate terminals.

* Data protocol and model: [docs/protocol.md](docs/protocol.md)
* Default data source: Python `/snapshot`, reached through Vite's `/api/snapshot` proxy. It retains the mock portfolio and risk assumptions, adding simulated oracle readings and warnings. `VITE_USE_MOCK=true` explicitly selects the bundled static mock; `VITE_SNAPSHOT_URL` overrides the endpoint.
* Model: `web/src/model/risk.ts` (reach, EL, Monte Carlo VaR, decision) and `web/src/model/warnings.ts` (rule-based warning signs).

UI: click a position or node to highlight its dependency paths. Use **focus** to isolate one position's tree. Toggle incidents on or off, or inject a simulated incident on any node from the right-hand panel; every number updates live.

Backend snapshots refresh automatically. Manual incident edits survive refreshes until reset or page reload. Monitor flags highlight suspicious observations; they do not invent financial probabilities or change the investment model. All results remain illustrative. Node.js 22.18+ or 24+ is recommended for the native TypeScript integration tests (`cd web && npm test`).
