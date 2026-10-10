from __future__ import annotations

import json
import threading
import time
from typing import Any

import httpx

_client = httpx.Client(timeout=httpx.Timeout(25.0, connect=10.0), headers={"user-agent": "belem-risk-engine/0.1"})
_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def cached(key: str, ttl: float, fn):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fn()
    with _lock:
        _cache[key] = (now, value)
    return value


def get_json(url: str, params: dict | None = None, headers: dict | None = None, ttl: float = 300) -> Any:
    key = f"GET {url} {json.dumps(params, sort_keys=True)}"
    return cached(key, ttl, lambda: _raise(_client.get(url, params=params, headers=headers)).json())


def post_json(url: str, body: Any, headers: dict | None = None, ttl: float = 0) -> Any:
    if ttl <= 0:
        return _raise(_client.post(url, json=body, headers=headers)).json()
    key = f"POST {url} {json.dumps(body, sort_keys=True)}"
    return cached(key, ttl, lambda: _raise(_client.post(url, json=body, headers=headers)).json())


def _raise(r: httpx.Response) -> httpx.Response:
    if r.status_code == 400 and r.headers.get("content-type", "").startswith("application/json"):
        return r  # GraphQL validation errors come back as 400 with an "errors" body
    r.raise_for_status()
    return r
