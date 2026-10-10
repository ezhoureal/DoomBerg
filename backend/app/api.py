from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from risk_engine import PositionRequest, RiskEngine
from risk_engine.engine import INCIDENTS, PRESETS
from risk_engine.failures import MODES
from risk_engine.probability import ALERT_LEVELS

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

app = FastAPI(title="DeFi Dependency Risk Engine", version="0.1.0",
              description="Belem Capital x EPFL Hackathon 2026 - discover, shock, price the exit, decide.")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
engine = RiskEngine()


class AnalyzeBody(BaseModel):
    kind: Literal["token", "market"] = "token"
    address: str
    chain_id: int = 1
    size_usd: float = Field(1_000_000, gt=0)
    book_usd: float = Field(10_000_000, gt=0)
    label: str | None = None
    horizon_days: float = Field(30, gt=0, le=365)


class ShockBody(BaseModel):
    position_id: str
    node_id: str
    mode: str
    alert: Literal["none", "watch", "alert", "corroborated", "confirmed"] = "alert"
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


def _llm_provider() -> str:
    if os.getenv("OPENAI_API_KEY"):
        return f"openai:{os.getenv('OPENAI_MODEL', 'gpt-4o-mini')}"
    if os.getenv("ANTHROPIC_API_KEY"):
        return f"anthropic:{os.getenv('ANTHROPIC_MODEL', 'claude-sonnet-4-5')}"
    return "template"


@app.get("/api/health")
def health():
    return {"ok": True, "llm": _llm_provider(), "positions_in_memory": len(engine.store)}


@app.get("/api/presets")
def presets():
    return PRESETS


@app.get("/api/catalog")
def catalog():
    return {
        "modes": [{"id": m.id, "label": m.label, "applies_to": m.applies_to, "description": m.description} for m in MODES.values()],
        "alerts": [{"id": k, **v} for k, v in ALERT_LEVELS.items()],
        "incidents": INCIDENTS,
    }


@app.post("/api/analyze")
def analyze(body: AnalyzeBody):
    req = PositionRequest(body.kind, body.address.strip(), body.chain_id, body.size_usd, body.book_usd, body.label)
    try:
        return engine.analyze(req, body.horizon_days)
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


DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
