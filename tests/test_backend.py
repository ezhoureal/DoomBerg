import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen

from backend.detect import detect_incidents
from backend.events import EVENTS
from backend.server import TEMPLATE, build_snapshot, make_handler

TEMPLATE_DATA = json.loads(TEMPLATE.read_text())
NOW = "2026-10-10T00:00:00Z"


def node(snapshot, node_id):
    return next(n for n in snapshot["nodes"] if n["id"] == node_id)


class DetectTests(unittest.TestCase):
    def detect(self, node_type, metrics):
        snap = {"riskParams": TEMPLATE_DATA["riskParams"],
                "nodes": [{"id": "n", "type": node_type, "label": "N", "metrics": metrics}]}
        return detect_incidents(snap, NOW)

    def test_quiet_metrics_raise_nothing(self):
        self.assertEqual(self.detect("oracle", {"deviationPct": 0.1, "stalenessSec": 10, "heartbeatSec": 60}), [])
        self.assertEqual(self.detect("asset", {"pegDeviationPct": -0.2}), [])
        self.assertEqual(self.detect("market", {"utilization": 0.95}), [])

    def test_staleness_is_relative_to_heartbeat(self):
        self.assertEqual(self.detect("oracle", {"stalenessSec": 3000, "heartbeatSec": 3600}), [])
        [inc] = self.detect("oracle", {"stalenessSec": 14400, "heartbeatSec": 3600})
        self.assertEqual((inc["kind"], inc["severity"]), ("oracle_deviation", "high"))

    def test_depeg_severity_and_probability_grow_with_deviation(self):
        small, = self.detect("asset", {"pegDeviationPct": -1})
        large, = self.detect("asset", {"pegDeviationPct": -6})
        self.assertEqual((small["severity"], large["severity"]), ("medium", "critical"))
        self.assertLess(small["pFail"], large["pFail"])
        self.assertLessEqual(large["pFail"], 0.95)

    def test_incident_ids_are_stable(self):
        a = self.detect("market", {"utilization": 0.99})
        b = self.detect("market", {"utilization": 0.999})
        self.assertEqual(a[0]["id"], b[0]["id"])


class SnapshotTests(unittest.TestCase):
    def test_template_is_not_mutated(self):
        before = json.dumps(TEMPLATE_DATA, sort_keys=True)
        build_snapshot(TEMPLATE_DATA, list(EVENTS), NOW)
        self.assertEqual(json.dumps(TEMPLATE_DATA, sort_keys=True), before)

    def test_every_event_adds_incidents(self):
        base = build_snapshot(TEMPLATE_DATA, [], NOW)
        self.assertEqual(base["source"], "simulation")
        base_ids = {i["id"] for i in base["incidents"]}
        for event_id in EVENTS:
            with self.subTest(event=event_id):
                snap = build_snapshot(TEMPLATE_DATA, [event_id], NOW)
                self.assertTrue({i["id"] for i in snap["incidents"]} - base_ids)
                json.dumps(snap, allow_nan=False)

    def test_event_patches_metrics_and_exits(self):
        snap = build_snapshot(TEMPLATE_DATA, ["kamino-usdc-run"], NOW)
        self.assertEqual(node(snap, "mkt-kamino-usdc")["metrics"]["utilization"], 0.997)
        pos = next(p for p in snap["positions"] if p["id"] == "pos-kamino-usdc")
        self.assertEqual(pos["exit"]["availableLiquidityUsd"], 3_000_000)

    def test_events_reference_existing_nodes_and_positions(self):
        nodes = {n["id"] for n in TEMPLATE_DATA["nodes"]}
        positions = {p["id"] for p in TEMPLATE_DATA["positions"]}
        for event_id, e in EVENTS.items():
            with self.subTest(event=event_id):
                self.assertLessEqual(set(e.get("metrics", {})), nodes)
                self.assertLessEqual({i["nodeId"] for i in e.get("incidents", [])}, nodes)
                self.assertLessEqual(set(e.get("exits", {})), positions)

    def test_unknown_event_rejected(self):
        with self.assertRaises(KeyError):
            build_snapshot(TEMPLATE_DATA, ["nope"], NOW)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(TEMPLATE_DATA))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        with urlopen(self.base + path, timeout=3) as r:
            return json.load(r)

    def status(self, path):
        with self.assertRaises(HTTPError) as e:
            urlopen(self.base + path, timeout=3)
        return e.exception.code

    def test_endpoints(self):
        self.assertEqual(self.get("/snapshot")["schemaVersion"], "1.0")
        self.assertEqual({e["id"] for e in self.get("/events")}, set(EVENTS))
        snap = self.get("/snapshot?events=drift-exploit,solana-outage")
        self.assertIn("evt-drift-exploit-0", {i["id"] for i in snap["incidents"]})
        self.assertEqual(self.status("/snapshot?events=nope"), 400)
        self.assertEqual(self.status("/snapshot?mode=live"), 501)
        self.assertEqual(self.status("/missing"), 404)


if __name__ == "__main__":
    unittest.main()
