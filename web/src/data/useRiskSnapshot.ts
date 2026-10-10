import { useEffect, useState } from "react";
import type { RiskSnapshot } from "../protocol";
import { loadSnapshot, usesStaticMock } from "./source";
import { producerStale } from "./incidentEdits";

export function useRiskSnapshot() {
  const [snapshot, setSnapshot] = useState<RiskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    let producerKey: string | undefined;
    let lastAdvance = Date.now();
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const next = await loadSnapshot(controller.signal);
        if (disposed) return;
        const key = next.monitor ? `${next.monitor.runId}:${next.monitor.sequence}` : next.asOf;
        if (key !== producerKey) {
          producerKey = key;
          lastAdvance = Date.now();
        }
        const stale = !usesStaticMock && producerStale(lastAdvance, Date.now(), next.monitor?.intervalSeconds ?? 1);
        setSnapshot(next);
        setConnected(!stale);
        setError(stale ? "Backend readings have stopped advancing. Last snapshot is shown." : null);
      } catch (err) {
        if (disposed) return;
        setConnected(false);
        setError(`Backend unavailable. Start python3 -m backend.snapshot_server. ${String(err)}`);
      } finally {
        clearTimeout(timeout);
        if (!disposed && !usesStaticMock) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, []);
  return { snapshot, error, connected, staticMock: usesStaticMock };
}
