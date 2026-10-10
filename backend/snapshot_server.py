"""Serve the frontend RiskSnapshot with simulated Python oracle observations.

Run from the project root: python3 -m backend.snapshot_server
"""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
from uuid import uuid4

from backend.oracle_monitor import OracleMonitor, SimulatedOracle


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "web/src/data/mockSnapshot.json"
ORACLE_NODE_ID = "oracle-chainlink-btc"
SCENARIOS = ("demo", "healthy", "stale", "latency", "downtime", "price_jump")


def iso_time(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def monitor_flags(result):
    """Translate evidence to graph warnings, not to financial probabilities."""
    flags = []
    metrics, policy = result["metrics"], result["policy"]

    def add(code, severity, message):
        flags.append({"code": "monitor." + code, "severity": severity,
                      "message": "SIMULATED: " + message})

    age = metrics["price_age_seconds"]
    if age is not None and age >= policy["stale_warning_seconds"]:
        critical = age >= policy["stale_critical_seconds"]
        add("stale", "critical" if critical else "high",
            "Price is %.0fs old; demo warning/critical limits are %.0fs/%.0fs."
            % (age, policy["stale_warning_seconds"], policy["stale_critical_seconds"]))
    latency = metrics["read_response_ms"]
    if result["status"] not in ("UNREACHABLE", "INVALID_DATA") and latency is not None and latency >= policy["slow_response_ms"]:
        add("slow_response", "medium", "Read took %.0fms. This measures RPC response time, not publication latency." % latency)
    change = metrics["price_change_percent"]
    threshold = policy["suspicious_price_change_percent"]
    if change is not None and (abs(change) >= threshold or math.isclose(abs(change), threshold, rel_tol=1e-12)):
        add("price_jump", "high", "Price moved %+.2f%% over %.0fs. Verify against another source; this is not proof of manipulation."
            % (change, metrics["price_change_interval_seconds"]))
    if result["status"] == "UNREACHABLE":
        add("unreachable", "high" if result["action"] == "REVIEW" else "medium",
            "%d consecutive failed reads. Oracle, RPC, network or chain may be responsible."
            % metrics["consecutive_failed_reads"])
    if result["status"] == "INVALID_DATA":
        add("invalid_data", "high", "Invalid oracle reading; measurements are unavailable.")
    if result["status"] == "RECOVERING":
        add("recovering", "medium", "%d/%d healthy readings; keep new exposure paused during recovery."
            % (metrics["consecutive_healthy_reads"], policy["healthy_reads_to_recover"]))
    return flags


def build_snapshot(template, result, sequence, run_id, scenario, interval, received_at):
    """Return a new snapshot; never modify the frontend's mock file or template."""
    snapshot = deepcopy(template)
    node = next((n for n in snapshot["nodes"] if n["id"] == ORACLE_NODE_ID), None)
    if node is None or node["type"] != "oracle":
        raise ValueError("Snapshot template is missing the BTC oracle node")
    snapshot["source"] = "mock"  # Graph, holdings, quotes and risk assumptions remain mocked.
    snapshot["asOf"] = iso_time(received_at)  # Wall time, not the accelerated simulation clock.
    snapshot["portfolio"]["name"] = "Demo portfolio - simulated oracle monitoring"
    snapshot["portfolio"]["manager"] = "Hackathon demo (hypothetical holdings)"
    node["label"] = "BTC/USD oracle (Python simulation)"
    node["description"] = (
        "Synthetic observations attached to this demo dependency. No Chainlink connection. "
        "Warnings are measurements/policy checks; portfolio decisions still use the frontend's "
        "mock risk assumptions. No incident probabilities are inferred from these readings."
    )
    # Drop template oracle metrics: we have no independent market reference,
    # verified source count or actual heartbeat for a synthetic feed.
    mapping = {
        "price": "priceUsd", "price_age_seconds": "stalenessSec",
        "read_response_ms": "readResponseMs", "price_change_percent": "priceChangePct",
        "price_change_interval_seconds": "priceChangeIntervalSec",
        "consecutive_failed_reads": "consecutiveFailedReads",
        "consecutive_healthy_reads": "consecutiveHealthyReads",
    }
    node["metrics"] = {target: result["metrics"][source] for source, target in mapping.items()
                       if result["metrics"][source] is not None}
    node["metrics"].update({
        "staleWarningSec": result["policy"]["stale_warning_seconds"],
        "staleCriticalSec": result["policy"]["stale_critical_seconds"],
        "priceChangeWarnPct": result["policy"]["suspicious_price_change_percent"],
    })
    node["flags"] = monitor_flags(result)
    snapshot["monitor"] = {
        "nodeId": ORACLE_NODE_ID, "runId": run_id, "sequence": sequence,
        "scenario": scenario, "status": result["status"],
        "observedAt": iso_time(result["observed_at"]),
        "receivedAt": iso_time(received_at), "intervalSeconds": interval,
        "simulation": True,
    }
    # Explicitly keep baseline probabilities, edge transmission factors, exit
    # quotes and incidents unchanged. A price jump is not a failure probability.
    return snapshot


class SnapshotService:
    """One background producer shared by all dashboard clients."""

    def __init__(self, scenario="demo", interval=1.0, template=None):
        if scenario not in SCENARIOS or not math.isfinite(interval) or interval <= 0:
            raise ValueError("Choose a supported scenario and a positive finite interval")
        self.template = json.loads(TEMPLATE.read_text()) if template is None else template
        self.scenario, self.interval = scenario, interval
        self.run_id = str(uuid4())
        self.start_time = time.time()
        self.source = SimulatedOracle(scenario, start_time=self.start_time)
        self.monitor = OracleMonitor()
        self.sequence = 0
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.error = None
        self.thread = None
        self.latest = None
        self.advance()

    def advance(self):
        tick = self.sequence
        if self.scenario == "demo" and tick and tick % 24 == 0:
            self.source = SimulatedOracle("demo", start_time=self.start_time + tick * 30)
        result = self.monitor.evaluate(self.source.read(tick % 24 if self.scenario == "demo" else tick))
        snapshot = build_snapshot(self.template, result, tick, self.run_id,
                                  self.scenario, self.interval, time.time())
        # Validate serialization before publishing to readers.
        json.dumps(snapshot, allow_nan=False)
        with self.lock:
            self.latest = snapshot
        self.sequence += 1

    def get_snapshot(self):
        with self.lock:
            if self.error:
                raise RuntimeError("Monitor stopped updating")
            return deepcopy(self.latest)

    def start(self):
        def produce():
            while not self.stop_event.wait(self.interval):
                try:
                    self.advance()
                except Exception as exc:
                    with self.lock:
                        self.error = str(exc)
                    break
        self.thread = threading.Thread(target=produce, name="oracle-monitor", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=2)


def make_handler(service):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlsplit(self.path).path
            try:
                if path == "/snapshot":
                    body, status = service.get_snapshot(), 200
                elif path == "/health":
                    snapshot = service.get_snapshot()
                    body, status = {"status": "ok", "source": "mock", "monitor": snapshot["monitor"]}, 200
                else:
                    body, status = {"error": "Not found"}, 404
            except RuntimeError:
                body, status = {"error": "Monitor stopped updating; restart the backend."}, 503
            encoded = json.dumps(body, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format, *args):
            pass  # Polls are frequent; keep terminal output readable.
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--scenario", choices=SCENARIOS, default="demo")
    parser.add_argument("--interval", type=float, default=1.0)
    args = parser.parse_args()
    if not math.isfinite(args.interval) or args.interval <= 0 or not 1 <= args.port <= 65535:
        parser.error("Use a positive finite interval and a port between 1 and 65535")
    service = SnapshotService(args.scenario, args.interval)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(service))
    except OSError as exc:
        parser.exit(1, "Cannot start backend: %s\n" % exc)
    service.start()
    print("Simulated snapshot: http://127.0.0.1:%d/snapshot" % args.port, flush=True)
    print("Start the frontend in a second terminal. Ctrl+C stops the backend.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        server.server_close()


if __name__ == "__main__":
    main()
