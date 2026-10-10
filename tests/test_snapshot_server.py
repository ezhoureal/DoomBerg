from copy import deepcopy
from http.server import ThreadingHTTPServer
import json
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

from backend.snapshot_server import ORACLE_NODE_ID, SnapshotService, make_handler


def oracle(snapshot):
    return next(n for n in snapshot["nodes"] if n["id"] == ORACLE_NODE_ID)


class SnapshotTests(unittest.TestCase):
    def test_graph_and_financial_assumptions_are_preserved(self):
        service = SnapshotService()
        template = deepcopy(service.template)
        snapshot = service.get_snapshot()
        for key in ("positions", "edges", "incidents", "riskParams"):
            self.assertEqual(snapshot[key], template[key])
        for before, after in zip(template["nodes"], snapshot["nodes"]):
            self.assertEqual(before["baseline"], after["baseline"])
            if before["id"] != ORACLE_NODE_ID:
                self.assertEqual(before, after)
        self.assertEqual(service.template, template)
        self.assertEqual(snapshot["source"], "mock")
        self.assertNotIn("action", snapshot)
        self.assertNotIn("deviationPct", oracle(snapshot)["metrics"])

    def test_price_jump_becomes_flag_not_market_deviation_or_incident(self):
        service = SnapshotService("price_jump")
        for _ in range(3):
            service.advance()
        snapshot = service.get_snapshot()
        node = oracle(snapshot)
        self.assertEqual(node["metrics"]["priceChangePct"], 10)
        self.assertTrue(any(f["code"] == "monitor.price_jump" and f["severity"] == "high"
                            for f in node["flags"]))
        self.assertEqual(snapshot["incidents"], service.template["incidents"])
        self.assertEqual(snapshot["monitor"]["status"], "SUSPICIOUS")
        for _ in range(3):
            service.advance()
        self.assertEqual(oracle(service.get_snapshot())["flags"], [])

    def test_failed_reads_omit_unknown_metrics(self):
        service = SnapshotService("downtime")
        node = oracle(service.get_snapshot())
        self.assertNotIn("priceUsd", node["metrics"])
        self.assertNotIn("stalenessSec", node["metrics"])
        self.assertEqual(node["flags"][0]["code"], "monitor.unreachable")
        self.assertIn("RPC", node["flags"][0]["message"])
        self.assertTrue(all(isinstance(v, (int, float)) for v in node["metrics"].values()))

    def test_repeating_demo_monotonic_and_recovery(self):
        service = SnapshotService()
        results = [service.get_snapshot()]
        for _ in range(47):
            service.advance()
            results.append(service.get_snapshot())
        for a, b in zip(results, results[1:]):
            self.assertGreater(b["monitor"]["sequence"], a["monitor"]["sequence"])
            self.assertGreater(b["monitor"]["observedAt"], a["monitor"]["observedAt"])
        for tick in [13, 37]:
            self.assertTrue(any(f["severity"] == "critical" for f in oracle(results[tick])["flags"]))
        self.assertEqual(results[20]["monitor"]["status"], "SUSPICIOUS")
        self.assertEqual(results[-1]["monitor"]["status"], "HEALTHY")

    def test_reads_do_not_advance_simulation_or_mutate_state(self):
        service = SnapshotService()
        first = service.get_snapshot()
        first["nodes"].clear()
        self.assertGreater(len(service.get_snapshot()["nodes"]), 0)
        self.assertEqual(service.get_snapshot()["monitor"]["sequence"], 0)

    def test_http_contract_and_monitor_failure(self):
        service = SnapshotService()
        server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = "http://127.0.0.1:%d" % server.server_port
        try:
            with urlopen(base + "/snapshot", timeout=3) as response:
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                snapshot = json.load(response)
                self.assertEqual(snapshot["schemaVersion"], "1.0")
                self.assertEqual(snapshot["source"], "mock")
            with urlopen(base + "/health", timeout=3) as response:
                self.assertEqual(json.load(response)["status"], "ok")
            with self.assertRaises(HTTPError) as missing:
                urlopen(base + "/missing", timeout=3)
            self.assertEqual(missing.exception.code, 404)
            service.error = "test failure"
            with self.assertRaises(HTTPError) as stopped:
                urlopen(base + "/snapshot", timeout=3)
            self.assertEqual(stopped.exception.code, 503)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
