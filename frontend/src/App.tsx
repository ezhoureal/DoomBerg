import {
  useCallback,
  useEffect,
  useReducer,
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
import {
  emptyInvestments,
  investmentsReducer,
  type Investment,
  type InvestmentsAction,
} from "./ui/investments";

// Keep workspaces mounted when switching tabs, preserving graph controls,
// scenario inputs and results. Each workspace owns its own async requests.
function WorkspaceTab({
  item,
  active,
  catalog,
  service,
  tabs,
  onAdd,
  dispatch,
}: {
  item: Investment;
  active: boolean;
  catalog: Catalog | null;
  service: string;
  tabs: ReactNode;
  onAdd: () => void;
  dispatch: Dispatch<InvestmentsAction>;
}) {
  const onAnalysis = useCallback(
    (analysis: Analysis) =>
      dispatch({ type: "analysis", id: item.id, analysis }),
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
      />
    </div>
  );
}

const noop = () => {};
export default function App() {
  const [investments, dispatch] = useReducer(
    investmentsReducer,
    emptyInvestments,
  );
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [service, setService] = useState("Connecting");
  const [positionOpen, setPositionOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const addingRef = useRef(false);
  const onAdd = useCallback(() => {
    setError(null);
    setPositionOpen(true);
  }, []);

  useEffect(() => {
    api
      .catalog()
      .then(setCatalog)
      .catch(() => {});
    api
      .health()
      .then(() => setService("Connected"))
      .catch(() => setService("Offline"));
  }, []);
  useEffect(() => {
    if (positionOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [positionOpen]);

  const addInvestment = async (request: Parameters<typeof api.analyze>[0]) => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    setError(null);
    try {
      const analysis = await api.analyze(request);
      dispatch({ type: "open", id: crypto.randomUUID(), analysis });
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
        />
      )}
      {investments.items.map((item) => (
        <WorkspaceTab
          key={item.id}
          item={item}
          active={item.id === investments.activeId}
          catalog={catalog}
          service={service}
          tabs={tabs}
          onAdd={onAdd}
          dispatch={dispatch}
        />
      ))}
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
