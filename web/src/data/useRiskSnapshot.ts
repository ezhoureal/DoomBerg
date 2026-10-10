import { useEffect, useState } from "react";
import type { RiskSnapshot } from "../protocol";
import { loadEvents, loadSnapshot, staticMock, type SimEvent } from "./source";

const RETRY_MS = 5000;

/**
 * Fetches the simulation snapshot for the selected events. If the backend is
 * unreachable, shows the bundled static mock (labelled offline) and retries.
 */
export function useRiskSnapshot(events: string[]) {
  const [snapshot, setSnapshot] = useState<RiskSnapshot | null>(null);
  const [catalogue, setCatalogue] = useState<SimEvent[]>([]);
  const [offline, setOffline] = useState(false);
  const key = events.join(",");

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const [snap, cat] = await Promise.all([loadSnapshot(events, controller.signal), loadEvents(controller.signal)]);
        setSnapshot(snap);
        setCatalogue(cat);
        setOffline(false);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn("Backend unavailable, using static mock:", err);
        setSnapshot((s) => (s && s.source !== "mock" ? s : staticMock));
        setOffline(true);
        timer = setTimeout(load, RETRY_MS);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);

  return { snapshot, catalogue, offline };
}
