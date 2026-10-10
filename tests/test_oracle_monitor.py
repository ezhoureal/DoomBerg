import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from backend.oracle_monitor import Observation, OracleMonitor, Rules, SimulatedOracle, write_snapshot


class MonitorTests(unittest.TestCase):
    def sample(self, age=0, now=1000, **changes):
        return replace(Observation(now, True, 100000, now - age, 80, True), **changes)

    def test_exact_staleness_boundaries(self):
        for age, action in [(59.9, "STAY"), (60, "PAUSE"), (179.9, "PAUSE"), (180, "EXIT")]:
            with self.subTest(age=age):
                self.assertEqual(OracleMonitor().evaluate(self.sample(age))["action"], action)

    def test_unchanged_price_with_new_timestamp_is_healthy(self):
        monitor = OracleMonitor()
        for now in [1000, 2000, 3000]:
            self.assertEqual(monitor.evaluate(self.sample(now=now))["action"], "STAY")

    def test_slow_rpc_is_not_publication_latency(self):
        result = OracleMonitor().evaluate(self.sample(response_ms=1000))
        self.assertEqual(result["action"], "PAUSE")
        self.assertEqual(result["metrics"]["price_age_seconds"], 0)
        self.assertIsNone(result["metrics"]["publication_latency_ms"])

    def test_failures_escalate_and_reset_after_success(self):
        monitor = OracleMonitor()
        for i, action in enumerate(["PAUSE", "PAUSE", "REVIEW"]):
            result = monitor.evaluate(self.sample(now=1000 + i, read_ok=False, price=None, updated_at=None))
            self.assertEqual(result["action"], action)
            self.assertEqual(result["status"], "UNREACHABLE")
            self.assertIsNone(result["metrics"]["price"])
        result = monitor.evaluate(self.sample(now=1003))
        self.assertEqual(result["metrics"]["consecutive_failed_reads"], 0)

    def test_recovery_requires_consecutive_healthy_samples(self):
        monitor = OracleMonitor()
        self.assertEqual(monitor.evaluate(self.sample(180))["action"], "EXIT")
        self.assertEqual(monitor.evaluate(self.sample(now=1001))["status"], "RECOVERING")
        monitor.evaluate(self.sample(60, now=1002))  # Interrupt recovery.
        for now, action in [(1003, "PAUSE"), (1004, "PAUSE"), (1005, "STAY")]:
            self.assertEqual(monitor.evaluate(self.sample(now=now))["action"], action)

    def test_blocked_or_unknown_exit_cannot_recommend_exit(self):
        for availability in [False, None, "true"]:
            result = OracleMonitor().evaluate(self.sample(180, exit_route_available=availability))
            self.assertEqual(result["action"], "REVIEW")

    def test_invalid_values_fail_closed_and_are_json_serializable(self):
        for changes in [{"price": 0}, {"price": float("nan")}, {"price": float("inf")},
                        {"updated_at": 1001}, {"updated_at": None}, {"updated_at": 0},
                        {"response_ms": -1}, {"response_ms": float("nan")}, {"read_ok": "yes"}]:
            with self.subTest(changes=changes):
                result = OracleMonitor().evaluate(self.sample(**changes))
                self.assertEqual(result["action"], "REVIEW")
                json.dumps(result, allow_nan=False)

    def test_out_of_order_observations_rejected(self):
        monitor = OracleMonitor()
        monitor.evaluate(self.sample())
        with self.assertRaises(ValueError):
            monitor.evaluate(self.sample(now=999))

    def test_full_demo_and_json_snapshot(self):
        monitor, source = OracleMonitor(), SimulatedOracle(start_time=1000)
        results = [monitor.evaluate(source.read(i)) for i in range(24)]
        self.assertEqual({r["action"] for r in results}, {"STAY", "PAUSE", "EXIT", "REVIEW"})
        self.assertEqual(results[-1]["action"], "STAY")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "latest.json"
            write_snapshot(path, results[0])
            write_snapshot(path, results[-1])
            self.assertEqual(json.loads(path.read_text()), results[-1])

    def test_invalid_configuration(self):
        for settings in [{"stale_warning_seconds": 180}, {"slow_response_ms": 0},
                         {"healthy_reads_to_recover": 0}, {"failed_reads_before_review": 1.5},
                         {"suspicious_price_change_percent": 0},
                         {"suspicious_price_change_percent": float("nan")}]:
            with self.assertRaises(ValueError):
                Rules(**settings)

    def test_price_change_boundaries_in_both_directions(self):
        for price, action in [(109999, "STAY"), (110000, "REVIEW"), (120000, "REVIEW"),
                              (90001, "STAY"), (90000, "REVIEW"), (80000, "REVIEW")]:
            with self.subTest(price=price):
                monitor = OracleMonitor()
                first = monitor.evaluate(self.sample())
                self.assertIsNone(first["metrics"]["price_change_percent"])
                result = monitor.evaluate(self.sample(now=1030, price=price))
                self.assertEqual(result["action"], action)
                self.assertAlmostEqual(result["metrics"]["price_change_percent"],
                                       (price - 100000) / 100000 * 100)
                self.assertEqual(result["metrics"]["price_change_interval_seconds"], 30)
                if action == "REVIEW":
                    self.assertEqual(result["status"], "SUSPICIOUS")

    def test_price_change_threshold_handles_decimal_prices(self):
        monitor = OracleMonitor()
        monitor.evaluate(self.sample(price=1.0))
        self.assertEqual(monitor.evaluate(self.sample(now=1030, price=0.9))["action"], "REVIEW")

    def test_custom_price_change_threshold(self):
        monitor = OracleMonitor(Rules(suspicious_price_change_percent=5))
        monitor.evaluate(self.sample())
        self.assertEqual(monitor.evaluate(self.sample(now=1030, price=105000))["action"], "REVIEW")

    def test_failed_or_invalid_read_does_not_replace_price_baseline(self):
        for changes in [{"read_ok": False, "price": 500000}, {"price": -1},
                        {"price": 500000, "response_ms": -1}]:
            with self.subTest(changes=changes):
                monitor = OracleMonitor()
                monitor.evaluate(self.sample())
                monitor.evaluate(self.sample(now=1030, **changes))
                result = monitor.evaluate(self.sample(now=1060, price=110000))
                self.assertEqual(result["status"], "SUSPICIOUS")
                self.assertEqual(result["metrics"]["price_change_percent"], 10)
                self.assertEqual(result["metrics"]["price_change_interval_seconds"], 60)

    def test_price_jump_does_not_override_critical_staleness(self):
        for available, action in [(True, "EXIT"), (False, "REVIEW")]:
            monitor = OracleMonitor()
            monitor.evaluate(self.sample())
            result = monitor.evaluate(self.sample(age=180, now=1300, price=110000,
                                                  exit_route_available=available))
            self.assertEqual(result["action"], action)
            self.assertEqual(result["status"], "CRITICAL")
            self.assertTrue(any("Price moved" in reason for reason in result["reasons"]))

    def test_price_jump_scenario_and_recovery(self):
        monitor, source = OracleMonitor(), SimulatedOracle("price_jump", start_time=1000)
        results = [monitor.evaluate(source.read(i)) for i in range(7)]
        self.assertEqual([r["action"] for r in results],
                         ["STAY", "STAY", "STAY", "REVIEW", "PAUSE", "PAUSE", "STAY"])
        self.assertEqual(results[3]["metrics"]["price_change_percent"], 10)
        self.assertEqual(results[4]["metrics"]["price_change_percent"], 0)

    def test_extreme_price_change_keeps_json_valid(self):
        monitor = OracleMonitor()
        monitor.evaluate(self.sample(price=1e-300))
        result = monitor.evaluate(self.sample(now=1030, price=1e300))
        self.assertEqual(result["action"], "REVIEW")
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
