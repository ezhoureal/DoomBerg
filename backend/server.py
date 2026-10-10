"""Risk snapshot server. Run from the repo root: python3 -m backend.server

GET /snapshot?events=usde-depeg,solana-outage   simulation mode (default)
GET /snapshot?mode=live                          live data monitor (not built yet)
GET /events                                      simulated event catalogue
"""

import argparse
from copy import deepcopy
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from backend.detect import detect_incidents
from backend.events import EVENTS, apply_event, catalogue

TEMPLATE = Path(__file__).resolve().parents[1] / "web/src/data/mockSnapshot.json"


def build_snapshot(template, events=(), now=None):
    """Simulation mode: mock book + selected events, incidents re-derived from metrics.

    The template's hand-written incidents are dropped; every metric-driven incident
    comes from `detect.py`, so the same rules will apply to live readings.
    """
    unknown = [e for e in events if e not in EVENTS]
    if unknown:
        raise KeyError(", ".join(unknown))
    now = now or datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot = deepcopy(template)
    snapshot.update(source="simulation", asOf=now, incidents=[])
    for event_id in events:
        apply_event(snapshot, event_id, now)
    snapshot["incidents"] = detect_incidents(snapshot, now) + snapshot["incidents"]
    return snapshot


def make_handler(template):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlsplit(self.path)
            query = parse_qs(url.query)
            try:
                if url.path == "/snapshot":
                    if query.get("mode", ["simulation"])[0] == "live":
                        return self.send(501, {"error": "Live data monitor is not implemented yet"})
                    events = [e for e in query.get("events", [""])[0].split(",") if e]
                    return self.send(200, build_snapshot(template, events))
                if url.path == "/events":
                    return self.send(200, catalogue())
                if url.path == "/health":
                    return self.send(200, {"status": "ok"})
                self.send(404, {"error": "Not found"})
            except KeyError as e:
                self.send(400, {"error": "Unknown event: %s" % e.args[0]})
            except Exception as e:  # never leave a request hanging
                self.send(500, {"error": str(e)})

        def send(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    template = json.loads(TEMPLATE.read_text())
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(template))
    print("Risk snapshot server on http://127.0.0.1:%d/snapshot" % args.port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
