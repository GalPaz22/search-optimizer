import {
  useEffect,
  useState,
  useCallback,
  createContext,
  useContext,
  useRef,
} from "react";
import { Optimization } from "./Optimization";
import { api } from "./api";

type Tab = "optimization" | "overview" | "proposals" | "experiments" | "rules" | "agent";
const StoreContext = createContext("");
const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString();
const labels: Record<Tab, string> = {
  optimization: "Daily optimization",
  overview: "Overview",
  proposals: "Opportunities",
  experiments: "Experiments",
  agent: "Activity",
  rules: "Merchandising",
};
const captions: Record<Tab, string> = {
  optimization: "Turn search findings into verified catalog repairs.",
  overview: "A clear view of your next search improvements.",
  proposals: "Review the evidence. Decide what to test next.",
  experiments: "Understand what changes, and whether it works.",
  agent: "Run an analysis and explore the optimizer’s recent work.",
  rules: "Manage the rules that shape your search results.",
};

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [selected, setSelected] = useState<string | null>(null);
  const [store, setStore] = useState("");
  const tenants = useAsync<any[]>(() => api.tenants());
  const navigate = (next: Tab) => {
    setTab(next);
    setSelected(null);
  };
  return (
    <StoreContext.Provider value={store}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">↗</span>
            <div>
              Search Optimizer<small>SEARCH INTELLIGENCE</small>
            </div>
          </div>
          <div className="nav-caption">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {(
              [
                "overview",
                "optimization",
                "proposals",
                "experiments",
                "agent",
                "rules",
              ] as Tab[]
            ).map((t, i) => (
              <button
                key={t}
                aria-current={tab === t ? "page" : undefined}
                className={tab === t ? "active" : ""}
                onClick={() => navigate(t)}
              >
                <span aria-hidden="true">{["◫", "✓", "◇", "⚗", "↺", "≡"][i]}</span>
                {labels[t]}
              </button>
            ))}
          </nav>
          <div className="sidebar-note">
            <span className="status-dot" />
            Evidence-led optimization
            <p>Review repairs or enable daily agent execution.</p>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <span>
              Workspace <span className="muted">/ {labels[tab]}</span>
            </span>
            <div className="store-picker">
              <label htmlFor="store">Store</label>
              <select
                id="store"
                value={store}
                onChange={(e) => {
                  setStore(e.target.value);
                  setSelected(null);
                }}
              >
                <option value="">All stores</option>
                {tenants.data?.map((t) => (
                  <option key={t.apiKey} value={t.apiKey}>
                    {t.dbName}
                  </option>
                ))}
              </select>
            </div>
          </header>
          <main>
            <div className="page-heading">
              <div>
                <div className="eyebrow">SEARCH PERFORMANCE</div>
                <h1>{selected ? "Experiment review" : labels[tab]}</h1>
                <p>
                  {selected
                    ? "Review the treatment, evidence, and next decision."
                    : captions[tab]}
                </p>
              </div>
              <span className="badge">
                {store
                  ? (tenants.data?.find((t) => t.apiKey === store)?.dbName ??
                    "Selected store")
                  : "All stores"}
              </span>
            </div>
            {tenants.error && (
              <div className="error" role="alert">
                Could not load stores: {tenants.error}
              </div>
            )}
            <div key={store}>
              {selected ? (
                <ExperimentDetail
                  id={selected}
                  onBack={() => setSelected(null)}
                />
              ) : tab === "overview" ? (
                <Overview navigate={navigate} onOpen={setSelected} />
              ) : tab === "optimization" ? (
                <Optimization store={store} />
              ) : tab === "proposals" ? (
                <Proposals onOpenExperiment={setSelected} />
              ) : tab === "experiments" ? (
                <Experiments onOpen={setSelected} />
              ) : tab === "rules" ? (
                <Rules />
              ) : (
                <AgentPanel />
              )}
            </div>
          </main>
          <footer>
            Search Optimizer <span>Evidence first. Better search follows.</span>
          </footer>
        </div>
      </div>
    </StoreContext.Provider>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setError(null);
    fn()
      .then((value) => {
        if (generation.current === current) setData(value);
      })
      .catch((e) => {
        if (generation.current === current) setError(e.message);
      });
  }, deps);
  useEffect(() => {
    reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return { data, error, reload };
}

function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">◇</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Overview({
  navigate,
  onOpen,
}: {
  navigate: (t: Tab) => void;
  onOpen: (id: string) => void;
}) {
  const store = useContext(StoreContext);
  const result = useAsync(
    () =>
      Promise.all([
        api.proposals("pending", store),
        api.experiments(store ? `?tenant=${encodeURIComponent(store)}` : ""),
        api.agentRuns(store),
      ]),
    [store],
  );
  if (result.error)
    return (
      <div className="error" role="alert">
        {result.error}
        <button className="btn" onClick={result.reload}>
          Retry
        </button>
      </div>
    );
  if (!result.data)
    return (
      <Empty title="Loading your workspace">
        Gathering proposals, experiments, and recent analysis…
      </Empty>
    );
  const [proposals, experiments, runs] = result.data;
  const running = experiments.filter((e: any) => e.status === "running");
  return (
    <>
      <div className="overview-stats">
        {[
          [
            "Awaiting review",
            proposals.length,
            "Proposals ready for your decision",
            "proposals",
          ],
          [
            "Running experiments",
            running.length,
            "Changes currently being measured",
            "experiments",
          ],
          [
            "Promoted experiments",
            experiments.filter((e: any) => e.status === "promoted").length,
            "In the returned experiment history",
            "experiments",
          ],
        ].map(([label, value, note, target]) => (
          <button
            className="metric-card"
            key={label}
            onClick={() => navigate(target as Tab)}
          >
            <span>{label}</span>
            <strong>{value}</strong>
            <small>
              {note} <span>↗</span>
            </small>
          </button>
        ))}
      </div>
      <div className="section-heading">
        <h2>Your next decisions</h2>
        <button className="btn" onClick={() => navigate("proposals")}>
          View opportunities →
        </button>
      </div>
      {proposals.length ? (
        proposals.slice(0, 4).map((p: any) => (
          <button
            className="decision-row"
            key={p._id}
            onClick={() => navigate("proposals")}
          >
            <span className="opportunity-icon">◇</span>
            <div>
              <strong>
                {p.draftExperiment?.name ??
                  `Add filter: ${p.catalogChange?.filter}`}
              </strong>
              <p>{p.hypothesis}</p>
            </div>
            <span className="badge pending">Review</span>
          </button>
        ))
      ) : (
        <Empty title="Nothing awaiting review">
          New proposals appear here after an analysis finds an opportunity worth
          testing.
        </Empty>
      )}
      <div className="two-column">
        <section className="card">
          <div className="section-heading">
            <h2>In flight</h2>
            <span className="badge running">{running.length} running</span>
          </div>
          {running.length ? (
            running.slice(0, 5).map((e: any) => (
              <button
                className="list-link"
                key={e._id}
                onClick={() => onOpen(e._id)}
              >
                <strong>{e.name}</strong>
                <span>{e.trafficPct}% traffic →</span>
              </button>
            ))
          ) : (
            <p className="muted">
              Approved experiments will appear here when started.
            </p>
          )}
        </section>
        <section className="card">
          <h2>Latest analysis</h2>
          {runs[0] ? (
            <>
              <p className="muted">
                {new Date(runs[0].startedAt).toLocaleString()} ·{" "}
                {runs[0].status}
              </p>
              <p className="summary-text" dir="auto">
                {runs[0].summary ||
                  runs[0].error ||
                  "No summary available yet."}
              </p>
            </>
          ) : (
            <p className="muted">
              Start an analysis to inspect search performance and discover
              opportunities.
            </p>
          )}
          <button className="btn" onClick={() => navigate("agent")}>
            Open activity →
          </button>
        </section>
      </div>
      <p className="muted">
        Overview uses the latest returned records: up to 100 pending proposals,
        200 experiments, and 50 analysis runs. Search funnel and tracking health
        require additional analytics.
      </p>
    </>
  );
}

function Evidence({ value }: { value: unknown }) {
  if (value == null) return <span className="muted">Not provided</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value))
    return (
      <div className="evidence-list">
        {value.map((v, i) => (
          <div key={i}>
            <Evidence value={v} />
          </div>
        ))}
      </div>
    );
  return (
    <dl className="evidence-grid">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}</dt>
          <dd>
            <Evidence value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Proposals({
  onOpenExperiment,
}: {
  onOpenExperiment: (id: string) => void;
}) {
  const store = useContext(StoreContext);
  const { data, error, reload } = useAsync<any[]>(
    () => api.proposals("pending", store),
    [store],
  );
  const [review, setReview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (fn: () => Promise<any>, id: string) => {
    setBusy(id);
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  if (data.length === 0)
    return (
      <Empty title="You’re all caught up">
        No pending opportunities. Run an analysis from Activity to look for new
        improvements.
      </Empty>
    );

  return (
    <>
      {actionError && <div className="error">{actionError}</div>}
      {data.map((p) => (
        <div className="card proposal-card" key={p._id}>
          <div className="row spread">
            <h3>
              {p.kind === "catalogFilter"
                ? `Add catalog filter: ${p.catalogChange?.filter}`
                : (p.draftExperiment?.name ?? "Untitled")}
            </h3>
            <span className="badge pending">pending</span>
          </div>
          <div className="muted">
            {p.kind === "catalogFilter" ? (
              `${p.dbName ?? "Catalog"} · catalog enrichment · ${p.catalogChange?.productIds?.length ?? 0} products · requires approval`
            ) : (
              <>
                {p.draftExperiment?.dbName} · {p.draftExperiment?.type} ·{" "}
                {p.draftExperiment?.targeting?.mode === "all"
                  ? "all searches"
                  : `queries: ${p.draftExperiment?.targeting?.patterns?.join(", ")}`}{" "}
                · {p.draftExperiment?.trafficPct}% traffic
              </>
            )}
          </div>
          <p style={{ fontSize: 14 }}>{p.hypothesis}</p>
          <button
            className="btn"
            aria-expanded={review === p._id}
            onClick={() => {
              setReview(review === p._id ? null : p._id);
              setNote("");
            }}
          >
            {review === p._id ? "Close review ↑" : "Review evidence & change →"}
          </button>
          {review === p._id && (
            <div className="proposal-review">
              <h2>Evidence behind this proposal</h2>
              <Evidence value={p.evidence} />
              <h2>What will change</h2>
              {p.kind === "catalogFilter" ? (
                <>
                  <p>{p.catalogChange?.rationale}</p>
                  <Evidence value={p.catalogChange} />
                  <p className="muted">
                    Catalog enrichment applies globally after approval; it is
                    not an A/B test.
                  </p>
                </>
              ) : (
                <>
                  <div className="two-column">
                    {p.draftExperiment?.arms?.map((arm: any) => (
                      <div className="treatment" key={arm.key}>
                        <div className="eyebrow">
                          {arm.key === "control"
                            ? "CONTROL · CURRENT BEHAVIOR"
                            : `VARIANT · ${arm.key}`}
                        </div>
                        <p>
                          {arm.key === "control"
                            ? "Existing search configuration"
                            : describePatch(arm.patch)}
                        </p>
                        {arm.key !== "control" && (
                          <Evidence value={arm.patch} />
                        )}
                      </div>
                    ))}
                  </div>
                  <h2>Test plan</h2>
                  <div className="plan-grid">
                    <div>
                      <label>Targeting</label>
                      {describeCondition(p.draftExperiment?.targeting)}
                    </div>
                    <div>
                      <label>Enrolled traffic</label>
                      {p.draftExperiment?.trafficPct}%
                    </div>
                    <div>
                      <label>Minimum sessions per arm</label>
                      {num(p.draftExperiment?.guardrails?.minSessionsPerArm)}
                    </div>
                    <div>
                      <label>Maximum duration</label>
                      {p.draftExperiment?.guardrails?.maxDurationDays ??
                        "—"}{" "}
                      days
                    </div>
                  </div>
                  <p className="muted">
                    Configuration preview. Ranked product previews and duration
                    estimates are not yet available.
                  </p>
                </>
              )}
              <details>
                <summary>Technical details</summary>
                <pre className="evidence">{JSON.stringify(p, null, 2)}</pre>
              </details>
              <label htmlFor={`note-${p._id}`}>
                Rejection reason (optional)
              </label>
              <textarea
                id={`note-${p._id}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Explain what should be different next time…"
                rows={2}
              />
              <div className="row" style={{ marginTop: 10 }}>
                {p.kind === "catalogFilter" ? (
                  <button
                    className="btn primary"
                    disabled={busy === p._id}
                    onClick={() =>
                      act(() => api.approveProposal(p._id, false), p._id)
                    }
                  >
                    Approve & apply to catalog
                  </button>
                ) : (
                  <>
                    <button
                      className="btn primary"
                      disabled={busy === p._id}
                      onClick={() =>
                        act(async () => {
                          const exp = await api.approveProposal(p._id, true);
                          if (exp?._id) onOpenExperiment(exp._id);
                        }, p._id)
                      }
                    >
                      Approve & start
                    </button>
                    <button
                      className="btn"
                      disabled={busy === p._id}
                      onClick={() =>
                        act(() => api.approveProposal(p._id, false), p._id)
                      }
                    >
                      Approve only
                    </button>
                  </>
                )}
                <button
                  className="btn danger"
                  disabled={busy === p._id}
                  onClick={() =>
                    act(
                      () =>
                        api.rejectProposal(
                          p._id,
                          note.trim() || "rejected from ops UI",
                        ),
                      p._id,
                    )
                  }
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function Experiments({ onOpen }: { onOpen: (id: string) => void }) {
  const store = useContext(StoreContext);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const { data, error } = useAsync<any[]>(
    () => api.experiments(store ? `?tenant=${encodeURIComponent(store)}` : ""),
    [store],
  );
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  if (data.length === 0)
    return <div className="muted">No experiments yet.</div>;
  return (
    <>
      <div className="filter-bar">
        <input
          aria-label="Search experiments"
          placeholder="Search experiments…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Experiment status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {[
            "all",
            "running",
            "approved",
            "paused",
            "completed",
            "promoted",
            "killed",
            "rejected",
          ].map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s}
            </option>
          ))}
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tenant</th>
              <th>Type</th>
              <th>Targeting</th>
              <th>Traffic</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data
              .filter(
                (e) =>
                  (status === "all" || e.status === status) &&
                  `${e.name} ${e.dbName} ${e.targeting?.patterns?.join(" ")}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((e) => (
                <tr
                  key={e._id}
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(e._id)}
                >
                  <td>
                    <button
                      className="text-button"
                      onClick={() => onOpen(e._id)}
                    >
                      {e.name} →
                    </button>
                  </td>
                  <td className="muted">{e.dbName}</td>
                  <td>{e.type}</td>
                  <td className="muted">
                    {e.targeting?.mode === "all"
                      ? "all"
                      : e.targeting?.patterns?.join(", ")}
                  </td>
                  <td>{e.trafficPct}%</td>
                  <td>
                    <span className={`badge ${e.status}`}>{e.status}</span>
                  </td>
                  <td className="muted">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!data.some(
        (e) =>
          (status === "all" || e.status === status) &&
          `${e.name} ${e.dbName} ${e.targeting?.patterns?.join(" ")}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ) && (
        <Empty title="No matching experiments">
          Try another name or status.
        </Empty>
      )}
    </>
  );
}

function ExperimentDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const exp = useAsync<any>(() => api.experiment(id), [id]);
  const met = useAsync<any>(() => api.metrics(id), [id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (action: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.action(id, action, { by: "ops" });
      exp.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (exp.error) return <div className="error">{exp.error}</div>;
  if (!exp.data) return <div className="muted">Loading…</div>;
  const e = exp.data;
  const latest = met.data?.latest;
  const control = latest?.arms?.find((a: any) => a.arm === "control");
  const variant = latest?.arms?.find((a: any) => a.arm !== "control");

  const actionsFor: Record<string, string[]> = {
    proposed: ["approve", "reject"],
    approved: ["start", "reject"],
    running: ["pause", "complete", "kill", "promote"],
    paused: ["resume", "complete", "kill"],
    completed: ["promote"],
  };

  return (
    <div>
      <button className="btn" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Back
      </button>
      <div className="card">
        <div className="row spread">
          <h3>{e.name}</h3>
          <span className={`badge ${e.status}`}>{e.status}</span>
        </div>
        <div className="muted">
          {e.dbName} · {e.type} ·{" "}
          {e.targeting?.mode === "all"
            ? "all searches"
            : `queries: ${e.targeting?.patterns?.join(", ")}`}{" "}
          · {e.trafficPct}% traffic · source: {e.source}
        </div>
        <p style={{ fontSize: 14 }}>{e.hypothesis}</p>
        {err && <div className="error">{err}</div>}
        <div className="row">
          {(actionsFor[e.status] ?? []).map((a) => (
            <button
              key={a}
              className={`btn ${a === "promote" ? "primary" : a === "kill" ? "danger" : ""}`}
              disabled={busy}
              onClick={() => act(a)}
            >
              {a}
            </button>
          ))}
          <button className="btn" disabled={busy} onClick={() => met.reload()}>
            Reload metrics
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.refreshMetrics(id);
                met.reload();
              } catch (er) {
                setErr((er as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Recompute now
          </button>
        </div>
      </div>

      {met.error && (
        <div className="error" role="alert">
          Metrics could not be loaded: {met.error}
        </div>
      )}
      {latest && (
        <div className="card">
          <div className="section-heading">
            <h2>Sample progress</h2>
            <span className="badge">
              {e.arms.every(
                (arm: any) =>
                  (latest.arms.find((a: any) => a.arm === arm.key)?.sessions ??
                    0) >= (e.guardrails?.minSessionsPerArm ?? Infinity),
              )
                ? "Minimum sample reached"
                : "Collecting data"}
            </span>
          </div>
          <p className="muted">
            Reaching the sample threshold alone does not establish a winner.
            Review the outcome metrics before deciding.
          </p>
          <div className="two-column">
            {e.arms.map((a: any) => {
              const sessions =
                latest.arms.find((m: any) => m.arm === a.key)?.sessions ?? 0;
              const goal = e.guardrails?.minSessionsPerArm;
              return (
                <div key={a.key}>
                  <div className="row spread">
                    <strong>{a.key}</strong>
                    <span className="muted">
                      {num(sessions)} / {num(goal)} sessions
                    </span>
                  </div>
                  <progress
                    aria-label={`${a.key} sample progress`}
                    value={sessions}
                    max={goal || Math.max(1, sessions)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
      {control && variant && (
        <div className="comparison-grid">
          {[
            ["Click rate", "clickRate"],
            ["Conversion", "cvr"],
            ["Revenue / session", "revenuePerSession"],
          ].map(([label, key]) => {
            const lift =
              control[key] > 0 ? variant[key] / control[key] - 1 : null;
            return (
              <div className="card" key={key}>
                <span className="muted">{label}</span>
                <h2>
                  {lift == null ? "—" : `${lift > 0 ? "+" : ""}${pct(lift)}`}{" "}
                  <small>relative change</small>
                </h2>
                <p>
                  Control{" "}
                  {key === "revenuePerSession"
                    ? num(control[key])
                    : pct(control[key])}{" "}
                  → {variant.arm}{" "}
                  {key === "revenuePerSession"
                    ? num(variant[key])
                    : pct(variant[key])}
                </p>
                <span className="muted">
                  Absolute change:{" "}
                  {key === "revenuePerSession"
                    ? (variant[key] - control[key]).toFixed(2)
                    : `${((variant[key] - control[key]) * 100).toFixed(2)} percentage points`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {latest ? (
        <>
          <div className="card">
            <div className="row" style={{ gap: 12 }}>
              <div className="stat">
                <div className="v">{pct(latest.stats?.probBestClick)}</div>
                <div className="l">P(variant wins clicks)</div>
              </div>
              <div className="stat">
                <div className="v">{pct(latest.stats?.probBestConv)}</div>
                <div className="l">P(variant wins conv)</div>
              </div>
              <div className="stat">
                <div className="v">{pct(latest.stats?.probBestRps)}</div>
                <div className="l">P(variant wins rev/sess)</div>
              </div>
              <div className="stat">
                <div className="v">
                  {latest.stats?.pConv?.toFixed(3) ?? "—"}
                </div>
                <div className="l">p-value (conv)</div>
              </div>
              <div className="stat">
                <div className="v">{pct(latest.contaminationRate, 2)}</div>
                <div className="l">contamination</div>
              </div>
            </div>
            <div className="muted" style={{ marginTop: 8 }}>
              as of {new Date(latest.asOf).toLocaleString()}
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Arm</th>
                  <th>Sessions</th>
                  <th>Searches</th>
                  <th>Clicks</th>
                  <th>CTR</th>
                  <th>Click rate</th>
                  <th>ATC rate</th>
                  <th>Orders</th>
                  <th>CVR</th>
                  <th>Revenue</th>
                  <th>Rev/session</th>
                </tr>
              </thead>
              <tbody>
                {latest.arms.map((a: any) => (
                  <tr key={a.arm}>
                    <td>
                      {a.arm === "control" ? "control" : `${a.arm} (variant)`}
                    </td>
                    <td>{num(a.sessions)}</td>
                    <td>{num(a.searches)}</td>
                    <td>{num(a.clicks)}</td>
                    <td>{pct(a.ctr)}</td>
                    <td>{pct(a.clickRate)}</td>
                    <td>{pct(a.atcRate)}</td>
                    <td>{num(a.orders)}</td>
                    <td>{pct(a.cvr, 2)}</td>
                    <td>{a.revenue?.toFixed(0)}</td>
                    <td>{a.revenuePerSession?.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {control && variant && (
            <div className="muted" style={{ marginTop: 8 }}>
              Lift: click rate{" "}
              {pct(
                control.clickRate > 0
                  ? variant.clickRate / control.clickRate - 1
                  : null,
              )}{" "}
              · CVR{" "}
              {pct(control.cvr > 0 ? variant.cvr / control.cvr - 1 : null)} ·
              rev/session{" "}
              {pct(
                control.revenuePerSession > 0
                  ? variant.revenuePerSession / control.revenuePerSession - 1
                  : null,
              )}
            </div>
          )}
        </>
      ) : (
        <div className="muted">
          {!met.data && !met.error
            ? "Loading metrics…"
            : met.error
              ? "Metrics are unavailable. Try reloading metrics."
              : 'No metrics snapshot yet — use "Recompute now" once traffic flows.'}
        </div>
      )}

      <section className="card" style={{ marginTop: 20 }}>
        <h2>Experiment changes</h2>
        {e.arms.map((arm: any) => (
          <div className="treatment" key={arm.key}>
            <strong>{arm.key}</strong>
            <p>
              {arm.key === "control"
                ? "Existing search configuration"
                : describePatch(arm.patch)}
            </p>
          </div>
        ))}
        <h2>Decision history</h2>
        {e.statusHistory?.map((h: any, i: number) => (
          <div className="history-row" key={i}>
            <span className={`badge ${h.status}`}>{h.status}</span>
            <span>{new Date(h.at).toLocaleString()}</span>
            <span>{h.note || h.by || ""}</span>
          </div>
        ))}
      </section>
      <details style={{ marginTop: 16 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>
          Arms & patches / status history
        </summary>
        <pre className="evidence">
          {JSON.stringify({ arms: e.arms, history: e.statusHistory }, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function AgentPanel() {
  const tenants = useAsync<any[]>(() => api.tenants());
  const store = useContext(StoreContext);
  const runs = useAsync<any[]>(() => api.agentRuns(store), [store]);
  const [tenant, setTenant] = useState(store);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spend, setSpend] = useState<{
    spentUsd: number;
    budgetUsd: number;
    remainingUsd: number;
  } | null>(null);

  useEffect(() => {
    if (!tenant) {
      setSpend(null);
      return;
    }
    api
      .agentSpend(tenant)
      .then(setSpend)
      .catch(() => setSpend(null));
  }, [tenant]);

  const overBudget = spend != null && spend.remainingUsd <= 0;

  return (
    <div>
      <div className="card">
        <h3>Run search analysis</h3>
        {tenants.error && <div className="error">{tenants.error}</div>}
        <label>Tenant</label>
        <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
          <option value="">— choose tenant —</option>
          {(tenants.data ?? []).map((t) => (
            <option key={t.apiKey} value={t.apiKey}>
              {t.dbName}
            </option>
          ))}
        </select>
        {spend && (
          <div className="muted" style={{ marginTop: 8 }}>
            This month: ${spend.spentUsd.toFixed(2)} / $
            {spend.budgetUsd.toFixed(2)} spent
            {overBudget && " — budget exhausted, resumes next calendar month"}
          </div>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn primary"
            disabled={!tenant || running || overBudget}
            onClick={async () => {
              setRunning(true);
              setErr(null);
              setResult(null);
              try {
                const r = await api.runAgent(tenant);
                setResult(r.summary ?? "done");
                runs.reload();
                api
                  .agentSpend(tenant)
                  .then(setSpend)
                  .catch(() => {});
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setRunning(false);
              }
            }}
          >
            {running
              ? "Running… (may take a few minutes)"
              : overBudget
                ? "Monthly budget reached"
                : "Run agent"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {result && <pre className="evidence" dir="rtl" lang="he">{result}</pre>}
      </div>

      <h3 style={{ fontSize: 15 }}>Recent analyses</h3>
      {runs.error && (
        <div className="error" role="alert">
          {runs.error}
        </div>
      )}
      {!runs.data && !runs.error && (
        <p className="muted">Loading analysis history…</p>
      )}
      {runs.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Started</th>
              <th>Status</th>
              <th>Tool calls</th>
              <th>Proposals</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r._id}>
                <td>
                  {tenants.data?.find((t) => t.apiKey === r.tenantApiKey)
                    ?.dbName ?? "Unknown store"}
                  <details>
                    <summary>Read analysis</summary>
                    <p className="summary-text" dir="auto">
                      {r.summary || r.error || "No summary available yet."}
                    </p>
                  </details>
                </td>
                <td className="muted">
                  {new Date(r.startedAt).toLocaleString()}
                </td>
                <td>
                  <span
                    className={`badge ${
                      r.status === "completed"
                        ? "running"
                        : r.status === "skipped_budget"
                          ? "pending"
                          : "killed"
                    }`}
                  >
                    {r.status === "skipped_budget" ? "budget hit" : r.status}
                  </span>
                </td>
                <td>{r.toolCalls}</td>
                <td>{r.proposals}</td>
                <td className="muted">
                  {r.costUsd ? `$${r.costUsd.toFixed(3)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">No agent runs yet.</div>
      )}
    </div>
  );
}

function describeCondition(c: any): string {
  const parts: string[] = [];
  if (c?.mode === "queryMatch")
    parts.push(
      `query ${c.matchType === "exact" ? "=" : "contains"} "${c.patterns?.join('" / "')}"`,
    );
  else parts.push("every search");
  if (c?.timeWindow) {
    const { startHour, endHour, timezone } = c.timeWindow;
    parts.push(
      `${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00 (${timezone})`,
    );
  }
  return parts.join(" · ");
}

function describePatch(p: any): string {
  const parts: string[] = [];
  if (p?.categoryAssociation) {
    const a = p.categoryAssociation;
    parts.push(
      `also show [${[...(a.softCategories ?? []), ...(a.categories ?? [])].join(", ")}] (top ${a.limit})`,
    );
  }
  if (p?.softCategoriesBoost)
    parts.push(`boost ${JSON.stringify(p.softCategoriesBoost)}`);
  if (p?.pinnedResults)
    parts.push(
      `pin ${p.pinnedResults.reduce((n: number, r: any) => n + (r.productIds?.length ?? 0), 0)} product placements across ${p.pinnedResults.length} query rule(s)`,
    );
  if (p?.productBoosts)
    parts.push(`product boosts ${JSON.stringify(p.productBoosts)}`);
  if (p?.profileBoostMultiplier != null)
    parts.push(`personalization ×${p.profileBoostMultiplier}`);
  return parts.join(" · ") || "(no-op)";
}

function Rules() {
  const tenants = useAsync<any[]>(() => api.tenants());
  const store = useContext(StoreContext);
  const rules = useAsync<any[]>(() => api.rules(store), [store]);
  const [tenant, setTenant] = useState(store);
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [draft, setDraft] = useState<any | null>(null);
  const [mode, setMode] = useState<"permanent" | "experiment">("experiment");
  const [trafficPct, setTrafficPct] = useState(50);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const parse = async () => {
    setParsing(true);
    setErr(null);
    setDraft(null);
    setSavedMsg(null);
    try {
      const d = await api.parseRule(tenant, text);
      setDraft(d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setErr(null);
    try {
      const dbName = (tenants.data ?? []).find(
        (t) => t.apiKey === tenant,
      )?.dbName;
      const res = await api.createRule({
        tenantApiKey: tenant,
        dbName,
        name: draft.name,
        naturalLanguageText: text,
        condition: draft.condition,
        patch: draft.patch,
        mode,
        trafficPct,
      });
      setSavedMsg(
        mode === "permanent"
          ? "Saved and live immediately for all matching traffic."
          : "Sent to Proposals as a pending experiment — approve it there to start measuring.",
      );
      setDraft(null);
      setText("");
      rules.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>Describe a merchandising rule</h3>
        <label>Tenant</label>
        <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
          <option value="">— choose tenant —</option>
          {(tenants.data ?? []).map((t) => (
            <option key={t.apiKey} value={t.apiKey}>
              {t.dbName}
            </option>
          ))}
        </select>
        <label>Instruction</label>
        <textarea
          rows={3}
          placeholder='e.g. "boost all red wines between 10pm and 6am" or "always show whiskey when someone searches bourbon"'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            disabled={!tenant || !text || parsing}
            onClick={parse}
          >
            {parsing ? "Parsing…" : "Parse"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {savedMsg && (
          <div className="muted" style={{ marginTop: 8 }}>
            {savedMsg}
          </div>
        )}
      </div>

      {draft && (
        <div className="card">
          <h3>{draft.name}</h3>
          <div className="muted">
            When: {describeCondition(draft.condition)}
          </div>
          <div className="muted">Does: {describePatch(draft.patch)}</div>
          {draft.warnings?.length > 0 && (
            <div className="error" style={{ marginTop: 8 }}>
              {draft.warnings.map((w: string, i: number) => (
                <div key={i}>⚠ {w}</div>
              ))}
            </div>
          )}
          <details style={{ marginTop: 8 }}>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Raw condition & patch
            </summary>
            <pre className="evidence">
              {JSON.stringify(
                { condition: draft.condition, patch: draft.patch },
                null,
                2,
              )}
            </pre>
          </details>

          <label>Mode</label>
          <div className="row">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as any)}
              style={{ width: "auto" }}
            >
              <option value="experiment">
                Test as experiment first (recommended)
              </option>
              <option value="permanent">
                Apply now, permanently, to all traffic
              </option>
            </select>
            {mode === "experiment" && (
              <>
                <span className="muted">traffic %</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={trafficPct}
                  onChange={(e) => setTrafficPct(Number(e.target.value))}
                  style={{ width: 80 }}
                />
              </>
            )}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={saving} onClick={save}>
              {saving
                ? "Saving…"
                : mode === "permanent"
                  ? "Apply now"
                  : "Send to Proposals"}
            </button>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15 }}>Rules</h3>
      {rules.error && <div className="error">{rules.error}</div>}
      {rules.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tenant</th>
              <th>When</th>
              <th>Does</th>
              <th>Status</th>
              <th>Triggers (24h)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r._id}>
                <td>{r.name}</td>
                <td className="muted">{r.dbName}</td>
                <td className="muted">{describeCondition(r.condition)}</td>
                <td className="muted">{describePatch(r.patch)}</td>
                <td>
                  <span
                    className={`badge ${r.status === "active" ? "running" : "killed"}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td>{r.last24hTriggers ?? 0}</td>
                <td>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          setErr(null);
                          await api.ruleAction(
                            r._id,
                            r.status === "active" ? "disable" : "enable",
                          );
                          rules.reload();
                        } catch (e) {
                          setErr((e as Error).message);
                        }
                      }}
                    >
                      {r.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn danger"
                      onClick={async () => {
                        try {
                          setErr(null);
                          await api.deleteRule(r._id);
                          rules.reload();
                        } catch (e) {
                          setErr((e as Error).message);
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="muted">No permanent rules yet.</div>
      )}
    </div>
  );
}
