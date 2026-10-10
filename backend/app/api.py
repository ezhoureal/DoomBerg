from __future__ import annotations

import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from risk_engine import PositionRequest, RiskEngine, calibration
from risk_engine.engine import INCIDENTS, PRESETS
from risk_engine.failures import MODES
from risk_engine.history import History
from risk_engine.probability import ALERT_LEVELS

BACKEND = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND / ".env")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("risk_api")

@asynccontextmanager
async def lifespan(_: FastAPI):
    _start_monitor()
    yield


app = FastAPI(title="DeFi Dependency Risk Engine", version="0.1.0", lifespan=lifespan,
              description="Belem Capital x EPFL Hackathon 2026 - discover, shock, price the exit, decide.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
history = History(os.getenv("HISTORY_DB") or BACKEND / "data" / "history.sqlite3")
engine = RiskEngine(history=history)


def load_watchlist() -> list[dict]:
    """Positions screened on schedule: the JSON list at WATCHLIST (shaped like the presets), else the presets."""
    path = os.getenv("WATCHLIST")
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else PRESETS


class AnalyzeBody(BaseModel):
    kind: Literal["token", "market"] = "token"
    address: str
    chain_id: int = 1
    size_usd: float = Field(1_000_000, gt=0)
    book_usd: float = Field(10_000_000, gt=0)
    label: str | None = None
    horizon_days: float = Field(30, gt=0, le=365)
    record: bool = False  # store in the run history and raise notifications (the scheduled monitor does this)


class ShockBody(BaseModel):
    position_id: str
    node_id: str
    mode: str
    alert: Literal["auto", "none", "watch", "alert", "corroborated", "confirmed"] = "auto"
    probability_override: float | None = Field(None, ge=0, le=1)
    exit_cost_override: float | None = Field(None, ge=0, le=1)
    horizon_days: float | None = Field(None, gt=0, le=365)
    use_llm: bool = True


class ReplayBody(BaseModel):
    position_id: str
    incident_id: str
    exit_cost_override: float | None = Field(None, ge=0, le=1)
    use_llm: bool = True


class ModesBody(BaseModel):
    position_id: str
    node_id: str


class OutcomeBody(BaseModel):
    node_id: str
    mode: str
    ts: float | None = None          # when it happened (unix seconds); default now
    node_class: str | None = None
    severity: float | None = Field(None, ge=0)
    note: str | None = None


class MonitorRunBody(BaseModel):
    horizon_days: float = Field(30, gt=0, le=365)


def _llm_provider() -> str:
    if os.getenv("OPENAI_API_KEY"):
        return f"openai:{os.getenv('OPENAI_MODEL', 'gpt-4o-mini')}"
    if os.getenv("ANTHROPIC_API_KEY"):
        return f"anthropic:{os.getenv('ANTHROPIC_MODEL', 'claude-sonnet-4-5')}"
    return "template"


@app.get("/api/health")
def health():
    return {"ok": True, "llm": _llm_provider(), "positions_in_memory": len(engine.store),
            "history_db": history.path, "monitor_interval_s": MONITOR_INTERVAL_S or None}


@app.get("/api/presets")
def presets():
    return PRESETS


@app.get("/api/catalog")
def catalog():
    return {
        "modes": [{"id": m.id, "label": m.label, "applies_to": m.applies_to, "description": m.description} for m in MODES.values()],
        "alerts": [{"id": "auto", "label": "Live signals (automatic)", "lr_scale": None}]
                  + [{"id": k, **v} for k, v in ALERT_LEVELS.items()],
        "incidents": INCIDENTS,
    }


@app.post("/api/analyze")
def analyze(body: AnalyzeBody):
    req = PositionRequest(body.kind, body.address.strip(), body.chain_id, body.size_usd, body.book_usd, body.label)
    try:
        return engine.analyze(req, body.horizon_days, record=body.record)
    except ValueError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(502, f"Discovery failed: {e}")


@app.post("/api/modes")
def modes(body: ModesBody):
    try:
        return engine.node_modes(body.position_id, body.node_id)
    except KeyError as e:
        raise HTTPException(404, str(e))


@app.post("/api/shock")
def shock(body: ShockBody):
    try:
        return engine.shock(body.position_id, body.node_id, body.mode, alert=body.alert,
                            probability_override=body.probability_override, exit_cost_override=body.exit_cost_override,
                            horizon_days=body.horizon_days, use_llm=body.use_llm)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/replay")
def replay(body: ReplayBody):
    try:
        return engine.replay(body.position_id, body.incident_id, exit_cost_override=body.exit_cost_override, use_llm=body.use_llm)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))


# ---------------------------------------------------------------------- monitoring
@app.get("/api/monitor/positions")
def monitor_positions():
    """Latest recorded run of every monitored position."""
    return history.positions()


@app.get("/api/monitor/history")
def monitor_history(position_key: str, limit: int = 365):
    return history.runs(position_key, limit)


@app.get("/api/monitor/events")
def monitor_events(limit: int = 100, position_key: str | None = None):
    return history.events(limit, position_key)


@app.get("/api/monitor/calibration")
def monitor_calibration():
    now = time.time()
    return calibration.report(history.forecasts(now), history.outcomes(), now)


@app.post("/api/monitor/outcomes")
def monitor_outcome(body: OutcomeBody):
    """Record a failure that actually happened: the label calibration and contagion learn from."""
    if body.mode not in MODES:
        raise HTTPException(422, f"Unknown failure mode {body.mode}")
    return {"id": history.add_outcome(body.node_id, body.mode, body.ts, body.node_class, body.severity, body.note)}


@app.post("/api/monitor/run")
def monitor_run(body: MonitorRunBody):
    """Screen and record the whole watchlist now."""
    with _monitor_lock:
        return engine.run_watchlist(load_watchlist(), body.horizon_days)


MONITOR_INTERVAL_S = float(os.getenv("MONITOR_INTERVAL_S") or 0)
_monitor_lock = threading.Lock()


def _monitor_loop():
    while True:
        with _monitor_lock:
            try:
                res = engine.run_watchlist(load_watchlist())
                log.info("monitor: screened %d positions, %d failed", len(res), sum(not r["ok"] for r in res))
            except Exception:  # noqa: BLE001 - the loop must survive a bad watchlist file
                log.exception("monitor run failed")
        time.sleep(MONITOR_INTERVAL_S)


def _start_monitor():
    if MONITOR_INTERVAL_S > 0:
        threading.Thread(target=_monitor_loop, name="monitor", daemon=True).start()
        log.info("monitor: screening the watchlist every %.0fs", MONITOR_INTERVAL_S)


DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
