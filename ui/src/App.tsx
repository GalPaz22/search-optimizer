import { useEffect, useState, useCallback } from "react";
import { api } from "./api";

type Tab = "proposals" | "experiments" | "rules" | "agent";

const pct = (v: number | null | undefined, digits = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(digits)}%`;
const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

export default function App() {
  const [tab, setTab] = useState<Tab>("proposals");
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="app">
      <header>
        <h1>Search Optimizer</h1>
        <span className="sub">agentic revenue experiments</span>
      </header>
      <nav>
        {(["proposals", "experiments", "rules", "agent"] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t && !selected ? "active" : ""}
            onClick={() => {
              setTab(t);
              setSelected(null);
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {selected ? (
        <ExperimentDetail id={selected} onBack={() => setSelected(null)} />
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
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    fn().then(setData).catch((e) => setError(e.message));
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function Proposals({ onOpenExperiment }: { onOpenExperiment: (id: string) => void }) {
  const { data, error, reload } = useAsync<any[]>(() => api.proposals("pending"));
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
    return <div className="muted">No pending proposals. Run the agent from the Agent tab.</div>;

  return (
    <>
      {actionError && <div className="error">{actionError}</div>}
      {data.map((p) => (
        <div className="card" key={p._id}>
          <div className="row spread">
            <h3>{p.kind === "catalogFilter" ? `Add catalog filter: ${p.catalogChange?.filter}` : p.draftExperiment?.name ?? "Untitled"}</h3>
            <span className="badge pending">pending</span>
          </div>
          <div className="muted">
            {p.kind === "catalogFilter"
              ? `${p.tenantApiKey} · catalog enrichment · ${p.catalogChange?.productIds?.length ?? 0} products · requires approval`
              : <>{p.tenantApiKey} · {p.draftExperiment?.type} · {p.draftExperiment?.targeting?.mode === "all" ? "all searches" : `queries: ${p.draftExperiment?.targeting?.patterns?.join(", ")}`} · {p.draftExperiment?.trafficPct}% traffic</>}
          </div>
          <p style={{ fontSize: 14 }}>{p.hypothesis}</p>
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              {p.kind === "catalogFilter" ? "Evidence & catalog change" : "Evidence & patch"}
            </summary>
            <pre className="evidence">
              {JSON.stringify(p.kind === "catalogFilter" ? { evidence: p.evidence, catalogChange: p.catalogChange } : { evidence: p.evidence, arms: p.draftExperiment?.arms }, null, 2)}
            </pre>
          </details>
          <div className="row" style={{ marginTop: 10 }}>
            {p.kind === "catalogFilter" ? (
              <button className="btn primary" disabled={busy === p._id} onClick={() => act(() => api.approveProposal(p._id, false), p._id)}>
                Approve & apply to catalog
              </button>
            ) : <>
              <button className="btn primary" disabled={busy === p._id} onClick={() => act(async () => { const exp = await api.approveProposal(p._id, true); if (exp?._id) onOpenExperiment(exp._id); }, p._id)}>Approve & start</button>
              <button className="btn" disabled={busy === p._id} onClick={() => act(() => api.approveProposal(p._id, false), p._id)}>Approve only</button>
            </>}
            <button
              className="btn danger"
              disabled={busy === p._id}
              onClick={() => act(() => api.rejectProposal(p._id, "rejected from ops UI"), p._id)}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function Experiments({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error } = useAsync<any[]>(() => api.experiments());
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  if (data.length === 0) return <div className="muted">No experiments yet.</div>;
  return (
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
        {data.map((e) => (
          <tr key={e._id} style={{ cursor: "pointer" }} onClick={() => onOpen(e._id)}>
            <td>{e.name}</td>
            <td className="muted">{e.dbName}</td>
            <td>{e.type}</td>
            <td className="muted">
              {e.targeting?.mode === "all" ? "all" : e.targeting?.patterns?.join(", ")}
            </td>
            <td>{e.trafficPct}%</td>
            <td>
              <span className={`badge ${e.status}`}>{e.status}</span>
            </td>
            <td className="muted">{new Date(e.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
          {e.targeting?.mode === "all" ? "all searches" : `queries: ${e.targeting?.patterns?.join(", ")}`} ·{" "}
          {e.trafficPct}% traffic · source: {e.source}
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
                <div className="v">{latest.stats?.pConv?.toFixed(3) ?? "—"}</div>
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
                  <td>{a.arm === "control" ? "control" : `${a.arm} (variant)`}</td>
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
          {control && variant && (
            <div className="muted" style={{ marginTop: 8 }}>
              Lift: click rate {pct(control.clickRate > 0 ? variant.clickRate / control.clickRate - 1 : null)} · CVR{" "}
              {pct(control.cvr > 0 ? variant.cvr / control.cvr - 1 : null)} · rev/session{" "}
              {pct(control.revenuePerSession > 0 ? variant.revenuePerSession / control.revenuePerSession - 1 : null)}
            </div>
          )}
        </>
      ) : (
        <div className="muted">No metrics snapshot yet — use "Recompute now" once traffic flows.</div>
      )}

      <details style={{ marginTop: 16 }}>
        <summary className="muted" style={{ cursor: "pointer" }}>
          Arms & patches / status history
        </summary>
        <pre className="evidence">{JSON.stringify({ arms: e.arms, history: e.statusHistory }, null, 2)}</pre>
      </details>
    </div>
  );
}

function AgentPanel() {
  const tenants = useAsync<any[]>(() => api.tenants());
  const runs = useAsync<any[]>(() => api.agentRuns());
  const [tenant, setTenant] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [spend, setSpend] = useState<{ spentUsd: number; budgetUsd: number; remainingUsd: number } | null>(null);

  useEffect(() => {
    if (!tenant) {
      setSpend(null);
      return;
    }
    api.agentSpend(tenant).then(setSpend).catch(() => setSpend(null));
  }, [tenant]);

  const overBudget = spend != null && spend.remainingUsd <= 0;

  return (
    <div>
      <div className="card">
        <h3>Run analysis agent</h3>
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
            This month: ${spend.spentUsd.toFixed(2)} / ${spend.budgetUsd.toFixed(2)} spent
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
                api.agentSpend(tenant).then(setSpend).catch(() => {});
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setRunning(false);
              }
            }}
          >
            {running ? "Running… (may take a few minutes)" : overBudget ? "Monthly budget reached" : "Run agent"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {result && <pre className="evidence">{result}</pre>}
      </div>

      <h3 style={{ fontSize: 15 }}>Recent runs</h3>
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
                <td>{r.tenantApiKey}</td>
                <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
                <td>
                  <span
                    className={`badge ${
                      r.status === "completed" ? "running" : r.status === "skipped_budget" ? "pending" : "killed"
                    }`}
                  >
                    {r.status === "skipped_budget" ? "budget hit" : r.status}
                  </span>
                </td>
                <td>{r.toolCalls}</td>
                <td>{r.proposals}</td>
                <td className="muted">{r.costUsd ? `$${r.costUsd.toFixed(3)}` : "—"}</td>
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
  if (c?.mode === "queryMatch") parts.push(`query ${c.matchType === "exact" ? "=" : "contains"} "${c.patterns?.join('" / "')}"`);
  else parts.push("every search");
  if (c?.timeWindow) {
    const { startHour, endHour, timezone } = c.timeWindow;
    parts.push(`${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00 (${timezone})`);
  }
  return parts.join(" · ");
}

function describePatch(p: any): string {
  const parts: string[] = [];
  if (p?.categoryAssociation) {
    const a = p.categoryAssociation;
    parts.push(`also show [${[...(a.softCategories ?? []), ...(a.categories ?? [])].join(", ")}] (top ${a.limit})`);
  }
  if (p?.softCategoriesBoost) parts.push(`boost ${JSON.stringify(p.softCategoriesBoost)}`);
  if (p?.pinnedResults) parts.push(`pin ${p.pinnedResults.length} product(s)`);
  if (p?.productBoosts) parts.push(`product boosts ${JSON.stringify(p.productBoosts)}`);
  if (p?.profileBoostMultiplier != null) parts.push(`personalization ×${p.profileBoostMultiplier}`);
  return parts.join(" · ") || "(no-op)";
}

function Rules() {
  const tenants = useAsync<any[]>(() => api.tenants());
  const rules = useAsync<any[]>(() => api.rules());
  const [tenant, setTenant] = useState("");
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
      const dbName = (tenants.data ?? []).find((t) => t.apiKey === tenant)?.dbName;
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
          : "Sent to Proposals as a pending experiment — approve it there to start measuring."
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
          <button className="btn primary" disabled={!tenant || !text || parsing} onClick={parse}>
            {parsing ? "Parsing…" : "Parse"}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
        {savedMsg && <div className="muted" style={{ marginTop: 8 }}>{savedMsg}</div>}
      </div>

      {draft && (
        <div className="card">
          <h3>{draft.name}</h3>
          <div className="muted">When: {describeCondition(draft.condition)}</div>
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
            <pre className="evidence">{JSON.stringify({ condition: draft.condition, patch: draft.patch }, null, 2)}</pre>
          </details>

          <label>Mode</label>
          <div className="row">
            <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ width: "auto" }}>
              <option value="experiment">Test as experiment first (recommended)</option>
              <option value="permanent">Apply now, permanently, to all traffic</option>
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
              {saving ? "Saving…" : mode === "permanent" ? "Apply now" : "Send to Proposals"}
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
                  <span className={`badge ${r.status === "active" ? "running" : "killed"}`}>{r.status}</span>
                </td>
                <td>{r.last24hTriggers ?? 0}</td>
                <td>
                  <div className="row">
                    <button
                      className="btn"
                      onClick={async () => {
                        await api.ruleAction(r._id, r.status === "active" ? "disable" : "enable");
                        rules.reload();
                      }}
                    >
                      {r.status === "active" ? "Disable" : "Enable"}
                    </button>
                    <button
                      className="btn danger"
                      onClick={async () => {
                        await api.deleteRule(r._id);
                        rules.reload();
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
