"""Simulated oracle monitor. Run: python3 -m backend.oracle_monitor --steps 24.

All feed data and exit availability are simulated. Actions are fixed-policy
recommendations, not trades, loss forecasts, or proof of an oracle outage.
"""

import argparse
import json
import math
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class Rules:
    stale_warning_seconds: float = 60
    stale_critical_seconds: float = 180
    slow_response_ms: float = 1000
    failed_reads_before_review: int = 3
    healthy_reads_to_recover: int = 3
    suspicious_price_change_percent: float = 10

    def __post_init__(self):
        values = (self.stale_warning_seconds, self.stale_critical_seconds,
                  self.slow_response_ms, self.suspicious_price_change_percent)
        if not all(math.isfinite(x) and x > 0 for x in values):
            raise ValueError("Thresholds must be finite and positive")
        if self.stale_critical_seconds <= self.stale_warning_seconds:
            raise ValueError("Critical age must exceed warning age")
        for count in (self.failed_reads_before_review, self.healthy_reads_to_recover):
            if type(count) is not int or count < 1:
                raise ValueError("Reading counts must be positive integers")


@dataclass(frozen=True)
class Observation:
    observed_at: float  # Unix seconds; simulation advances its own clock.
    read_ok: bool
    price: Optional[float]
    updated_at: Optional[float]
    response_ms: float  # RPC/request duration, NOT oracle publication latency.
    exit_route_available: bool = False  # Unknown/unchecked defaults to false.


def finite_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


class OracleMonitor:
    """Keep one instance per feed; evaluate observations in time order."""

    def __init__(self, rules=None, feed_id="SIMULATED-BTC-USD"):
        self.rules = rules or Rules()
        self.feed_id = feed_id
        self.failed_reads = 0
        self.healthy_reads = 0
        self.alert_active = False
        self.previous_time = None
        self.previous_valid_price = None
        self.previous_valid_time = None

    def evaluate(self, sample):
        if not finite_number(sample.observed_at) or sample.observed_at <= 0:
            raise ValueError("observed_at must be a positive Unix timestamp")
        if self.previous_time is not None and sample.observed_at <= self.previous_time:
            raise ValueError("Observations must have strictly increasing timestamps")
        self.previous_time = sample.observed_at
        reasons = []
        age = None
        price_change = None
        price_change_interval = None
        action, status = "STAY", "HEALTHY"

        valid_transport = (type(sample.read_ok) is bool
                           and finite_number(sample.response_ms)
                           and sample.response_ms >= 0)
        valid_answer = (finite_number(sample.price) and sample.price > 0
                        and finite_number(sample.updated_at)
                        and 0 < sample.updated_at <= sample.observed_at)

        if not valid_transport:
            self.failed_reads += 1
            action, status = "REVIEW", "INVALID_DATA"
            reasons.append("Invalid read status or response duration; investigate the adapter.")
        elif not sample.read_ok:
            self.failed_reads += 1
            action = ("REVIEW" if self.failed_reads >= self.rules.failed_reads_before_review
                      else "PAUSE")
            status = "UNREACHABLE"
            reasons.append("Read failed; oracle, RPC, network, or chain may be responsible.")
            reasons.append("Pause new exposure and check an independent RPC/source.")
        elif not valid_answer:
            self.failed_reads = 0
            action, status = "REVIEW", "INVALID_DATA"
            reasons.append("Price or publication timestamp is missing, invalid, or in the future.")
        else:
            self.failed_reads = 0
            age = sample.observed_at - sample.updated_at
            if age >= self.rules.stale_critical_seconds:
                status = "CRITICAL"
                action = "EXIT" if sample.exit_route_available is True else "REVIEW"
                reasons.append("Price age breaches the fixed critical-age policy.")
                if action == "EXIT":
                    reasons.append("Recommend exit under demo policy; simulated exit route is available.")
                else:
                    reasons.append("Exit is unavailable or unverified; pause exposure and review alternatives.")
            elif age >= self.rules.stale_warning_seconds:
                action, status = "PAUSE", "WARNING"
                reasons.append("Price is stale under the demo policy; pause new exposure.")
            if sample.response_ms >= self.rules.slow_response_ms:
                reasons.append("Read response is slow; this does not measure oracle publication latency.")
                if action == "STAY":
                    action, status = "PAUSE", "WARNING"
            if self.previous_valid_price is not None:
                price_change = ((sample.price - self.previous_valid_price)
                                / self.previous_valid_price * 100)
                price_change_interval = sample.observed_at - self.previous_valid_time
                threshold = self.rules.suspicious_price_change_percent
                if not math.isfinite(price_change):
                    price_change = None
                    reasons.append("Price change exceeds numeric limits; verify the feed.")
                    if status != "CRITICAL":
                        action, status = "REVIEW", "INVALID_DATA"
                elif (abs(price_change) >= threshold
                      or math.isclose(abs(price_change), threshold, rel_tol=1e-12)):
                    reasons.append(
                        "Price moved %+.2f%% over %.1f seconds since the previous valid reading "
                        "(threshold %.2f%%); pause new exposure and verify against another source."
                        % (price_change, price_change_interval, threshold))
                    # Preserve critical staleness/exit handling when both checks fire.
                    if status != "CRITICAL":
                        action, status = "REVIEW", "SUSPICIOUS"
            # Failed/invalid readings never replace the comparison baseline.
            self.previous_valid_price = sample.price
            self.previous_valid_time = sample.observed_at

        if action == "STAY":
            self.healthy_reads += 1
            if self.alert_active and self.healthy_reads < self.rules.healthy_reads_to_recover:
                action, status = "PAUSE", "RECOVERING"
                reasons.append("Wait for %d consecutive healthy readings before clearing the alert."
                               % self.rules.healthy_reads_to_recover)
            else:
                self.alert_active = False
                reasons.append("All monitored checks pass; continue monitoring any remaining position.")
        else:
            self.healthy_reads = 0
            self.alert_active = True

        return {
            "schema_version": 1,
            "mode": "simulation",
            "feed_id": self.feed_id,
            "observed_at": sample.observed_at,
            "status": status,
            "action": action,
            "reasons": reasons,
            "metrics": {
                "price": sample.price if sample.read_ok is True and valid_answer else None,
                "price_age_seconds": age,
                "price_change_percent": price_change,
                "price_change_interval_seconds": price_change_interval,
                "read_response_ms": sample.response_ms if valid_transport else None,
                "publication_latency_ms": None,
                "consecutive_failed_reads": self.failed_reads,
                "consecutive_healthy_reads": self.healthy_reads,
            },
            "exit_route_available": sample.exit_route_available is True,
            "policy": asdict(self.rules),
            "decision_basis": "Fixed demo thresholds; no economic loss or exit-cost model.",
            "trade_executed": False,
        }


class SimulatedOracle:
    """Replay healthy → slow RPC → stale feed → failed reads → price jump → recovery.

    Each tick advances 30 simulated seconds, regardless of CLI playback speed.
    The price-jump phase increases $100,000 to $110,000, then holds it steady.
    """

    def __init__(self, scenario="demo", exit_route_available=True, start_time=None):
        self.scenario = scenario
        self.exit_route_available = exit_route_available
        self.start = time.time() if start_time is None else start_time
        self.updated_at = self.start

    def read(self, tick):
        now = self.start + tick * 30
        phase = self.scenario
        if phase == "demo":
            phase = ("healthy" if tick < 3 else "latency" if tick < 5
                     else "healthy" if tick < 8 else "stale" if tick < 15
                     else "downtime" if tick < 18 else "healthy" if tick < 20
                     else "price_jump")
        if phase == "downtime":
            return Observation(now, False, None, None, 5000, self.exit_route_available)
        if phase != "stale":
            self.updated_at = now
        price = (110000.0 if phase == "price_jump" and (self.scenario == "demo" or tick >= 3)
                 else 100000.0)
        return Observation(now, True, price, self.updated_at,
                           1500 if phase == "latency" else 80,
                           self.exit_route_available)


def write_snapshot(path, result):
    """Atomic replacement so a reader never sees a partially written JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["demo", "healthy", "stale", "latency", "downtime", "price_jump"],
                        default="demo")
    parser.add_argument("--interval", type=float, default=1, help="Playback delay in real seconds")
    parser.add_argument("--steps", type=int, default=0, help="Number of polls; 0 runs until Ctrl+C")
    parser.add_argument("--repeat", action="store_true", help="Repeat the 24-tick demo")
    parser.add_argument("--json", action="store_true", help="Emit one JSON object per line")
    parser.add_argument("--output", type=Path, help="Atomically replace this latest-state JSON file")
    parser.add_argument("--exit-unavailable", action="store_true", help="Simulate a blocked exit route")
    args = parser.parse_args()
    if not math.isfinite(args.interval) or args.interval < 0 or args.steps < 0:
        parser.error("interval must be finite and nonnegative; steps must be nonnegative")
    if args.steps == 0 and args.interval == 0:
        parser.error("An unbounded run needs a positive interval")
    monitor = OracleMonitor()
    source = SimulatedOracle(args.scenario, not args.exit_unavailable)
    tick = 0
    try:
        while args.steps == 0 or tick < args.steps:
            # Keep simulated timestamps monotonic across repeated demo cycles.
            if args.repeat and args.scenario == "demo" and tick and tick % 24 == 0:
                source = SimulatedOracle("demo", not args.exit_unavailable,
                                         start_time=source.start + 24 * 30)
            source_tick = tick % 24 if args.repeat and args.scenario == "demo" else tick
            result = monitor.evaluate(source.read(source_tick))
            result["sequence"] = tick
            if args.output:
                write_snapshot(args.output, result)
            if args.json:
                print(json.dumps(result, allow_nan=False), flush=True)
            else:
                stamp = datetime.fromtimestamp(result["observed_at"], timezone.utc).isoformat()
                print("SIM %s | %-11s | %-6s | age=%s s | %s" % (
                    stamp, result["status"], result["action"],
                    result["metrics"]["price_age_seconds"], "; ".join(result["reasons"])), flush=True)
            tick += 1
            if args.steps == 0 or tick < args.steps:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Monitor stopped.", file=sys.stderr)


if __name__ == "__main__":
    main()
