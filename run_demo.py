"""Start the Python backend and React frontend together: python3 run_demo.py."""

import argparse
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", choices=["demo", "healthy", "stale", "latency", "downtime", "price_jump"], default="demo")
    args = parser.parse_args()
    node = shutil.which("node")
    if node is None:
        local = Path.home() / ".local/share/belem-tools/node/bin/node"
        if local.is_file():
            node = str(local)
    if node is None:
        parser.exit(1, "Install Node.js 22.18+ (or 24+) from nodejs.org, then run this command again.\n")
    env = dict(os.environ)
    env["PATH"] = str(Path(node).parent) + os.pathsep + env.get("PATH", "")
    for port in (8000, 5173):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                parser.exit(1, "Port %d is already in use. Stop the existing demo/server first.\n" % port)
    if not (WEB / "node_modules/vite/bin/vite.js").exists():
        npm = shutil.which("npm", path=env["PATH"])
        corepack = shutil.which("corepack", path=env["PATH"])
        if not npm and not corepack:
            parser.exit(1, "npm is needed to install frontend dependencies. Install Node.js with npm.\n")
        command = [npm, "ci"] if npm else [corepack, "npm", "ci"]
        subprocess.run(command, cwd=WEB, env=env, check=True)
    processes = []
    try:
        processes.append(subprocess.Popen(
            [sys.executable, "-m", "backend.snapshot_server", "--scenario", args.scenario],
            cwd=ROOT, start_new_session=True))
        processes.append(subprocess.Popen(
            [node, str(WEB / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
            cwd=WEB, env=env, start_new_session=True))
        print("\nOpen http://127.0.0.1:5173 and click 'Inspect monitored oracle'.", flush=True)
        print("Simulated data only. Ctrl+C stops both services.\n", flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(0.5)
        print("A demo service stopped; shutting down the other service.", file=sys.stderr)
    except KeyboardInterrupt:
        print("\nStopping demo.")
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
        for process in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    main()
