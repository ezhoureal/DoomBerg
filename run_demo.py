"""Start the Python backend and the React frontend together: python3 run_demo.py"""

from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent


def main():
    npm = shutil.which("npm")
    if npm is None:
        sys.exit("npm not found. Install Node.js 22.18+ and try again.")
    if not (ROOT / "web/node_modules").exists():
        subprocess.run([npm, "ci"], cwd=ROOT / "web", check=True)
    procs = [
        subprocess.Popen([sys.executable, "-m", "backend.server"], cwd=ROOT),
        subprocess.Popen([npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
                         cwd=ROOT / "web"),
    ]
    print("\nOpen http://127.0.0.1:5173. Ctrl+C stops both services.\n", flush=True)
    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait()


if __name__ == "__main__":
    main()
