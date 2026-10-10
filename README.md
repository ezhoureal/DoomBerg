# Belem: DeFi dependency risk graph

Prototype for the Belem Capital DeFi Risk Dependency Challenge (`belemCapital.pdf`). It shows Morpho (Ethereum) and Solana positions as a dependency graph, propagates incidents through it, and gives each position a **STAY / WATCH / EXIT** signal by comparing the expected loss that exiting avoids with the cost of exiting.

```bash
python3 run_demo.py
```

Open http://127.0.0.1:5173. Or run `python3 -m backend.server` (repo root) and `npm ci && npm run dev` (in `web`) in separate terminals. The backend uses only the Python standard library.

**Modes**
* **Simulation** (default): toggle risk events in the top bar (USDe depeg, BTC oracle stale, Kamino bank run, Drift exploit, Solana halt). Each event changes node metrics or exit liquidity. The backend's detection rules turn those changes into incidents, and the model recomputes every verdict.
* **Live data monitor**: planned. Real metrics will go through the same detection rules.
* Backend offline: the UI shows the bundled static mock and retries.

**Code**
* Protocol and model: [docs/protocol.md](docs/protocol.md)
* Backend: `backend/events.py` (event catalogue), `backend/detect.py` (metrics → incidents), `backend/server.py` (HTTP)
* Model: `web/src/model/risk.ts` (reach, EL, Monte Carlo VaR, decision) and `web/src/model/warnings.ts` (rule-based warnings)

**UI**: click a position or node to highlight its dependency paths, and use **focus** to isolate one position's tree. You can toggle or remove incidents, or inject a custom one on any node from the right-hand panel. Manual edits persist when you toggle events.

**Tests**: `python3 -m unittest discover -s tests` and `cd web && npm test` (Node 22.18+).
