import {
  memo,
  useCallback,
  useEffect,
  useReducer,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { api } from "./api";
import type { Analysis, Catalog } from "./types";
import PositionForm from "./components/PositionForm";
import InvestmentWorkspace from "./components/InvestmentWorkspace";
import InvestmentTabs from "./components/InvestmentTabs";
import InvestmentOverview from "./components/InvestmentOverview";
import {
  restoreWorkspace,
  serializeWorkspace,
  STORAGE_KEY,
} from "./ui/storage";
import {
  newWorkspaceId,
  type PositionRole,
  type ScenarioRecord,
} from "./ui/workspace";
import {
  emptyInvestments,
  investmentsReducer,
  type Investment,
  type InvestmentsAction,
} from "./ui/investments";

// Keep workspaces mounted when switching tabs, preserving graph controls,
// scenario inputs and results. Each workspace owns its own async requests.
// Only the active workspace gets the tab list, so its ids stay unique and
// memo skips re-rendering hidden workspaces when another tab changes.
const WorkspaceTab = memo(function WorkspaceTab({
  item,
  active,
  catalog,
  service,
  tabs,
  onAdd,
  dispatch,
  onOverview,
  now,
  saveError,
}: {
  item: Investment;
  active: boolean;
  catalog: Catalog | null;
  service: string;
  tabs: ReactNode;
  onAdd: () => void;
  dispatch: Dispatch<InvestmentsAction>;
  onOverview: () => void;
  now: number;
  saveError: string | null;
}) {
  const onAnalysis = useCallback(
    (analysis: Analysis, role: PositionRole, refreshedAt: string) =>
      dispatch({ type: "analysis", id: item.id, analysis, role, refreshedAt }),
    [dispatch, item.id],
  );
  const onScenario = useCallback(
    (record: ScenarioRecord) =>
      dispatch({ type: "scenario", id: item.id, record }),
    [dispatch, item.id],
  );
  const onInvalid = useCallback(
    () => dispatch({ type: "invalid", id: item.id }),
    [dispatch, item.id],
  );
  const onBusy = useCallback(
    (busy: boolean) => dispatch({ type: "busy", id: item.id, busy }),
    [dispatch, item.id],
  );
  return (
    <div
      role="tabpanel"
      id={`investment-panel-${item.id}`}
      aria-labelledby={`investment-tab-${item.id}`}
      hidden={!active}
    >
      <InvestmentWorkspace
        initialAnalysis={item.analysis}
        active={active}
        catalog={catalog}
        service={service}
        investmentTabs={tabs}
        onAdd={onAdd}
        onAnalysis={onAnalysis}
        onBusy={onBusy}
        role={item.role}
        refreshedAt={item.refreshedAt}
        needsRefresh={item.needsRefresh}
        history={item.history}
        onScenario={onScenario}
        onInvalid={onInvalid}
        onOverview={onOverview}
        now={now}
        saveError={saveError}
      />
    </div>
  );
});

const noop = () => {};
// crypto.randomUUID is unavailable over plain HTTP on a LAN address.

export default function App() {
  const [loaded] = useState(() => {
    try {
      return {
        state: restoreWorkspace(window.localStorage.getItem(STORAGE_KEY)),
        error: null,
      };
    } catch {
      return {
        state: emptyInvestments,
        error:
          "Saved workspace could not be restored. Add investments to create a new workspace.",
      };
    }
  });
  const [investments, dispatch] = useReducer(investmentsReducer, loaded.state);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [service, setService] = useState("Checking API");
  const [now, setNow] = useState(Date.now());
  const [saveError, setSaveError] = useState<string | null>(loaded.error);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [positionOpen, setPositionOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const addingRef = useRef(false);
  const onAdd = useCallback(() => {
    setError(null);
    setPositionOpen(true);
  }, []);
  const onOverview = useCallback(() => setOverviewOpen(true), []);
  const persisted = useMemo(
    () => serializeWorkspace(investments),
    [investments],
  );
  useEffect(() => {
    if (loaded.error && !investments.items.length) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, persisted);
      setSaveError(null);
    } catch {
      setSaveError(
        "Workspace changes could not be saved in this browser. Your open tabs still work; do not rely on reload restoring the latest runs.",
      );
    }
  }, [persisted, loaded.error, investments.items.length]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api
      .catalog()
      .then(setCatalog)
      .catch(() => {});
    let stopped = false;
    let controller: AbortController | null = null;
    const check = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      const timeout = setTimeout(() => requestController.abort(), 5000);
      try {
        const response = await api.health(requestController.signal);
        if (!stopped && controller === requestController)
          setService(response.ok ? "API online" : "API offline");
      } catch {
        if (!stopped && controller === requestController)
          setService("API offline");
      } finally {
        clearTimeout(timeout);
      }
    };
    void check();
    const timer = setInterval(check, 15_000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
      window.removeEventListener("focus", check);
    };
  }, []);
  useEffect(() => {
    if (positionOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [positionOpen]);

  const addInvestment = async (
    request: Parameters<typeof api.analyze>[0],
    role: PositionRole,
  ) => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setError(null);
    try {
      const analysis = await api.analyze(request);
      dispatch({ type: "open", id: newWorkspaceId(), analysis, role });
      setPositionOpen(false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to analyse this investment.",
      );
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };
  const tabs = (
    <InvestmentTabs
      items={investments.items}
      activeId={investments.activeId}
      onAdd={onAdd}
      onSelect={(id) => dispatch({ type: "select", id })}
      onClose={(id) => dispatch({ type: "close", id })}
    />
  );
  return (
    <>
      {!investments.items.length && (
        <InvestmentWorkspace
          initialAnalysis={null}
          active
          catalog={catalog}
          service={service}
          investmentTabs={null}
          onAdd={onAdd}
          onAnalysis={noop}
          onBusy={noop}
          role="entered"
          refreshedAt={new Date(now).toISOString()}
          needsRefresh={false}
          history={[]}
          onScenario={noop}
          onInvalid={noop}
          onOverview={onOverview}
          now={now}
          saveError={saveError}
        />
      )}
      {investments.items.map((item) => (
        <WorkspaceTab
          key={item.id}
          item={item}
          active={item.id === investments.activeId}
          catalog={catalog}
          service={service}
          tabs={item.id === investments.activeId ? tabs : null}
          onAdd={onAdd}
          dispatch={dispatch}
          onOverview={onOverview}
          now={now}
          saveError={saveError}
        />
      ))}
      <InvestmentOverview
        open={overviewOpen}
        items={investments.items}
        now={now}
        onClose={() => setOverviewOpen(false)}
        onSelect={(id) => {
          dispatch({ type: "select", id });
          setOverviewOpen(false);
        }}
      />
      <dialog
        ref={dialog}
        className="position-dialog"
        onCancel={(event) => {
          if (addingRef.current) event.preventDefault();
          else setPositionOpen(false);
        }}
        onClose={() => setPositionOpen(false)}
      >
        <div className="dialog-header">
          <div>
            <span className="eyebrow">Investment research</span>
            <h2>Add investment</h2>
          </div>
          <button
            aria-label="Close investment form"
            disabled={adding}
            onClick={() => setPositionOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError(null)}>
              <X size={15} />
            </button>
          </div>
        )}
        {positionOpen && (
          <PositionForm onAnalyze={addInvestment} busy={adding} />
        )}
      </dialog>
    </>
  );
}
