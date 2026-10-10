# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hackathon entry for the Belem Capital "DeFi Risk Dependency Challenge" (EPFL 2026). The brief is `BelemCapital_EPFL-Hackathon_DeFi-Risk-Dependency-Challenge_EN_v1.pdf` and `problem_statement.txt`. Given a **Pendle PT** position, the system finds its dependency graph, simulates a component failure, prices the exit, and gives a STAY/EXIT verdict. There are two position kinds: `token` (hold a PT) and `market` (supply to a Morpho market whose collateral is a PT, the brief's example). Vault and wallet positions were removed on purpose. `Discovery.run()` raises `ValueError` for a non-PT token or a market without PT collateral. Judging weights: dependency discovery 30%, impact estimation 30%, decision usefulness 25%, demo on real data 15%. `README.md` holds the full background, the decision rule and the glossary.

## Commands

You need `uv` and Node 18+. Run everything from the repo root (the scripts work on Windows, macOS and Linux):

```bash
npm install          # root tools, then `npm run setup` (uv sync in backend/ + npm ci in frontend/)
npm run dev          # API on :8000 + Vite UI on :5173 (proxies /api → 127.0.0.1:8000)
npm run build        # tsc -b && vite build → frontend/dist
npm start            # build UI, then the backend serves it at :8000
npm test             # risk_engine tests (offline, synthetic graph)
```

To run a single test, use: `uv --directory risk_engine run --frozen --project ../backend pytest -q tests/test_engine.py::test_brief_examples`

Smoke scripts that hit live data: `uv --directory backend run python scripts/try_engine.py [preset_id]` and `scripts/try_discovery.py [pt_address_or_market_id] [chain_id]`.

There is no linter configured. The frontend type check runs as part of `npm run build`. The frontend graph tests run with `npm --prefix frontend test`; they load TypeScript through `--experimental-strip-types`, so they need Node 22.6+ (the rest of the toolchain works on Node 18+).

## Architecture

There are three packages. The backend's uv environment is the only Python environment: `backend/pyproject.toml` pulls in `risk_engine` as an editable path dependency, which is why tests run with `--project ../backend`.

- **`risk_engine/`**: pure Python, no web code. `engine.py` `RiskEngine` runs four stages:
  1. **Discover** (`discovery.py` + `sources/`: Pendle API for the PT's AMM and underlying, Morpho GraphQL for token metadata only, raw JSON-RPC, DefiLlama/KyberSwap pricing). It walks down from the position into a `DependencyGraph` (`graph.py`, networkx). The PT subgraph is `PT -traded_on-> Pendle AMM -runs_on-> Pendle V2 -settles_on-> chain`, plus `PT -backed_by-> underlying`, which recurses through `issued_by`, `mintable_by`, `bridged_via` and ERC-4626 `backed_by` hops. A `token` position `holds` the PT. A `market` position `deposits_in` the market, which has `collateral_in` (the PT), `priced_by` (oracle, then `reads_feed` to its feeds, whose tracking is classified from on-chain reads), `lends` and `runs_on` (Morpho Blue). Every node and edge stores its evidence.
  2. **Shock**. `failures.py` defines the failure modes and their hazard priors. `probability.py` gives a Gamma-Poisson probability with a Bayesian alert update. `propagation.py` runs a Monte Carlo of the shock, with propagation rules keyed on node and edge type. The loss arrays combine as independent losses. The lending-market model (`Simulator._market`) is the non-linear part: LLTV buffer, liquidation efficiency (zero when the oracle doesn't track the PT or is stale), and over-borrowing on oracle over-pricing. A chain halt is modelled as hours "frozen". The market handles this as a blind window. For a held PT it becomes a price drift, applied at the position so it isn't counted twice.
  3. **Exit cost** (`exit_cost.py`): for a held PT, the cost of selling it (a KyberSwap quote when the token has a USD price, otherwise a constant-product estimate on its Pendle AMM, widened under stress). For a market, the withdrawal is limited by instant liquidity, with a bank-run share under stress, and the loan asset is sold too if it is damaged.
  4. **Decide** (`decision.py`): exit if p × loss > exit cost. It also returns a break-even table. `explain.py` writes the narrative with an LLM (OpenAI or Anthropic, chosen by env key) and falls back to a template. The LLM never sets numbers or the verdict.
- `RiskEngine.analyze()` keeps analysed graphs **in memory** under a `position_id`. `shock`, `replay` and `node_modes` refer back to that id, so the backend is stateful per process. `PRESETS` (live Ethereum PT-collateral markets, starting with the brief's PT-reUSD market, and held PTs) and the `data/` files (`registry.json` with known tokens, chains and protocols; `incidents.json` with cited historical incidents used for replay) also live in the engine package.
- **`backend/`**: a thin FastAPI wrapper in `app/api.py` (`/api/analyze`, `/api/shock`, `/api/replay`, `/api/modes`, `/api/presets`, `/api/catalog`). It serves `frontend/dist` as a SPA if that folder exists. Settings live in `backend/.env` (see `.env.example`): LLM keys and `RPC_URL` / `RPC_URL_<chainId>`.
- **`frontend/`**: React + Vite + TS. `@xyflow/react` + dagre draw the graph and recharts draws the loss distribution. API types are in `src/types.ts` and must be kept in sync with the dicts the engine returns.
