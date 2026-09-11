import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

const rate = (v: number | null) => v == null ? "—" : `${(v * 100).toFixed(1)}%`;
export function Optimization({ store }: { store: string }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [query, setQuery] = useState(""), [note, setNote] = useState("");
  const [policy, setPolicy] = useState({ enabled: false, agentEnabled: false, autoExecuteCatalog: false });
  const reload = useCallback(async () => {
    if (!store) return;
    const result = await api.optimization(store); setData(result);
    if (result.policy) setPolicy({ enabled: result.policy.enabled, agentEnabled: result.policy.agentEnabled, autoExecuteCatalog: result.policy.autoExecuteCatalog });
  }, [store]);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);
  useEffect(() => {
    if (!data?.actions?.some((a: any) => ["applying", "dispatch_pending", "reprocessing", "verifying"].includes(a.status))) return;
    const id = setInterval(() => reload().catch(e => setError(e.message)), 15000); return () => clearInterval(id);
  }, [data, reload]);
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); setError(""); try { await fn(); await reload(); } catch (e: any) { setError(e.message); } finally { setBusy(""); } };
  if (!store) return <div className="empty"><h3>Select a store</h3><p>Daily reports and repair actions are scoped to one store.</p></div>;
  const report = data?.report, current = report?.current, previous = report?.previous;
  return <div className="optimization">
    {error && <div className="error" role="alert">{error}</div>}
    <section className="card">
      <h2>Daily search improvements</h2><p>Prioritize failing searches, diagnose the cause, execute a scoped repair and measure search-to-cart performance afterward.</p>
      <div className="optimization-controls">
        <button className="btn primary" disabled={!!busy} onClick={() => run("Building report…", () => api.optimizationReport(store))}>Refresh 7-day report</button>
        <button className="btn" disabled={!!busy} onClick={() => run("מנתח דליפות ומכין פעולות…", () => api.runAgent(store))}>סקירת דליפות והכנת פעולות</button>
        {busy && <span role="status">{busy}</span>}
      </div>
      <fieldset disabled={!!busy}><legend>Daily operation</legend>
        <label><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })} /> Generate a report every day</label>
        <label><input type="checkbox" checked={policy.agentEnabled} onChange={e => setPolicy({ ...policy, agentEnabled: e.target.checked })} /> Have the agent investigate and prepare repairs</label>
        <label><input type="checkbox" checked={policy.autoExecuteCatalog} onChange={e => setPolicy({ ...policy, autoExecuteCatalog: e.target.checked })} /> Let the agent execute scoped catalog repairs</label>
        <button className="btn" onClick={() => run("Saving schedule…", () => api.optimizationPolicy(store, policy))}>Save daily settings</button>
      </fieldset>
      <p className="muted">The server checks hourly and runs once every 24 hours. Agent analysis uses the existing monthly budget. Ranking experiments keep their review flow.</p>
      {data && !data.reprocessConfigured && <p>Reprocess service address is not configured yet. Actions can be prepared; execution remains pending.</p>}
      {data?.policy?.lastError && <div className="error">Last scheduled run: {data.policy.lastError}</div>}
      {data?.policy?.nextRunAt && <p className="muted">Next due: {new Date(data.policy.nextRunAt).toLocaleString()}</p>}
    </section>
    {data?.review && <section className="card" dir="rtl" lang="he">
      <h2>סקירת דליפות בחיפוש</h2>
      <p className="muted">{new Date(data.review.startedAt).toLocaleString("he-IL")} · הסקירה נשמרה ותשמש הקשר לסקירה הבאה.</p>
      <div className="summary-text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{data.review.summary}</div>
      <h3>פעולות לאחר הסקירה</h3>
      {data.actions.filter((a: any) => a.agentRunId === data.review._id || a.diagnosis?.agentRunId === data.review._id).map((a: any) => <p key={a._id}><a href={`#action-${a._id}`}>{a.title}</a> · {a.kind === "investigate" ? "אבחון / המשך חקירה" : "פעולת תיקון"} · {a.status}</p>)}
      {!data.actions.some((a: any) => a.agentRunId === data.review._id || a.diagnosis?.agentRunId === data.review._id) && <p>לא נמצאו פעולות מהסקירה הזו בתור המוצג. יש לבדוק בסקירה את החסמים ואת הצעד הבא.</p>}
      <a href="#repair-queue">לפרטי הפעולות, הראיות וכפתורי הביצוע ↓</a>
      <p className="muted">הצעות לניסויים מופיעות במסך Proposals. יצירת פעולה אינה מעידה שבוצעה או שהחיפוש השתפר.</p>
    </section>}
    {current && <section className="card">
      <h2>Search → cart, last seven days</h2>
      <p>{new Date(current.start).toLocaleString()} – {new Date(current.end).toLocaleString()}</p>
      <div className="table-wrap"><table><thead><tr><th>Measure</th><th>Current</th><th>Previous</th></tr></thead><tbody>
        {[["Search events", "searches"], ["Search identifiers", "identities"], ["All cart events", "carts"], ["Cart events carrying a search", "searchTaggedCarts"], ["Identifiers with attributed cart", "cartIdentities"]].map(([label, key]) => <tr key={key}><td>{label}</td><td>{current[key]}</td><td>{previous[key]}</td></tr>)}
        <tr><td>Attributed click rate</td><td>{rate(current.clickRate)}</td><td>{rate(previous.clickRate)}</td></tr>
        <tr><td>Attributed cart rate</td><td>{rate(current.cartRate)}</td><td>{rate(previous.cartRate)}</td></tr>
        <tr><td>Searches missing identifier</td><td>{rate(current.missingSessionRate)}</td><td>{rate(previous.missingSessionRate)}</td></tr>
      </tbody></table></div>
      {!report.quality.comparable && <p className="error">Tracking gaps or changing identifier coverage limit week-over-week comparison.</p>}
      {report.quality.notes.map((n: string) => <p className="muted" key={n}>{n}</p>)}
      <details><summary>Queries and evidence</summary><div className="table-wrap"><table><thead><tr><th>Query</th><th>Searches</th><th>Tagged clicks</th><th>Tagged carts</th><th>Attributed cart identifiers</th></tr></thead><tbody>{current.terms.slice(0, 100).map((t: any) => <tr key={t.query}><td dir="auto">{t.query || "(empty)"}</td><td>{t.searches}</td><td>{t.clicks}</td><td>{t.carts}</td><td>{t.cartIdentities} / {t.identities}</td></tr>)}</tbody></table></div></details>
    </section>}
    {!!report?.failures?.length && <section className="card"><h2>Failures to investigate first</h2>
      <p className="muted">Priority combines zero results and attributed cart shortfall, adjusted for sample size. It is not an estimate of lost orders. Rates use search identifiers, not visits or purchases.</p>
      <div className="table-wrap"><table><thead><tr><th>Query / next step</th><th>Priority</th><th>Searches</th><th>Attributed carts</th><th>Cart rate</th><th>Reason</th></tr></thead><tbody>
        {report.failures.slice(0, 20).map((f: any) => <tr key={f.query}><td dir="auto"><strong>{f.query}</strong><p className="muted">{f.nextStep}</p></td><td>{f.score}</td><td>{f.metrics.searches}</td><td>{f.metrics.cartIdentities} / {f.metrics.identities}</td><td>{rate(f.metrics.cartRate)}</td><td>{f.reasons.join(", ")}{!f.measurementReliable && <p>Validate measurement / sample first</p>}</td></tr>)}
      </tbody></table></div>
    </section>}
    <section className="card"><h2>Add a search issue for the agent</h2>
      <form onSubmit={e => { e.preventDefault(); void run("Saving issue…", async () => { await api.optimizationCreate(store, { kind: "investigate", query, title: `בדיקת חיפוש: ${query}`, rationale: note, evidence: { source: "operator" } }); setQuery(""); setNote(""); }); }}>
        <label>Search query<input required minLength={1} maxLength={150} value={query} onChange={e => setQuery(e.target.value)} dir="auto" placeholder="יין ללא אלכוהול" /></label>
        <label>What should be corrected?<textarea required minLength={20} maxLength={6000} value={note} onChange={e => setNote(e.target.value)} dir="auto" placeholder="Describe the wrong result and the expected behavior…" /></label>
        <button className="btn" disabled={!!busy}>Save issue</button>
      </form>
    </section>
    <h2 id="repair-queue" dir="rtl">פעולות לשיפור החיפוש</h2>
    {data?.actions?.length === 0 && <p>Refresh the report or add an issue to start.</p>}
    {data?.actions?.map((a: any) => <section className="card" key={a._id} id={`action-${a._id}`}>
      <div className="optimization-controls"><h3 dir="auto">{a.title}</h3><span className="badge">{a.status === "verified" ? "Catalog verified" : a.status}</span><span className="muted">{a.kind}</span></div>
      <p dir="auto">{a.rationale}</p>
      {a.diagnosis && <div><h4>Diagnosis: {a.diagnosis.cause} · {a.diagnosis.status}</h4><p dir="auto">{a.diagnosis.evidence}</p><p dir="auto"><strong>Next step: </strong>{a.diagnosis.nextStep}</p>
        {a.diagnosis.actionIds.map((id: string) => <p key={id}><a href={`#action-${id}`}>Linked repair: {id}</a></p>)}
        {a.diagnosis.proposalIds.map((id: string) => <p key={id}>Experiment proposal: {id} — review in Proposals</p>)}
      </div>}
      {a.outcome && <div><h4>Post-repair measurement: {a.outcome.status}</h4>
        {a.outcome.dueAt && <p>Seven-day follow-up due: {new Date(a.outcome.dueAt).toLocaleString()}</p>}
        {a.outcome.baseline && <p>Attributed cart rate: {rate(a.outcome.baseline.cartRate)} → {rate(a.outcome.followup.cartRate)} ({a.outcome.baseline.identities} / {a.outcome.followup.identities} identifiers before / after)</p>}
        {!!a.outcome.reasons?.length && <p>{a.outcome.reasons.join("; ")}</p>}
        {!!a.outcome.overlappingRepairs && <p>Other repairs overlap this window; isolate changes in an experiment.</p>}
        <p>{a.outcome.nextStep}</p><p className="muted">{a.outcome.interpretation}</p>
      </div>}
      {a.filter && <p dir="auto">softCategory: <strong>{a.filter}</strong></p>}
      {a.categories && <p>Categories: {a.categories.join(", ")}</p>}
      {(a.reprocess?.softCategories || a.reprocess?.embeddings) && <p>Reprocess: {[a.reprocess.softCategories && "soft categories", a.reprocess.embeddings && "embeddings"].filter(Boolean).join(", ")}</p>}
      {!!a.selectedProducts?.length && <details><summary>Review {a.selectedProducts.length} exact products</summary><ul>{a.selectedProducts.map((p: any) => <li key={p._id} dir="auto">{p.name} — {a.removeTagProductIds.includes(p._id) ? "remove tag" : "target"}<p className="muted">{p.description}</p></li>)}</ul></details>}
      <details><summary>Evidence</summary><pre dir="auto">{JSON.stringify(a.evidence, null, 2)}</pre></details>
      {a.verification && <p>{a.verification.scope} · {a.verification.productCount} products checked</p>}
      {(a.error || a.lastError || a.verification?.problems?.length > 0) && <div className="error">{a.error || a.lastError || a.verification.problems.join("; ")}</div>}
      <div className="optimization-controls">
        {a.status === "pending" && a.kind !== "investigate" && <button className="btn primary" disabled={!!busy} onClick={() => run("Executing scoped repair…", () => api.optimizationAction(store, a._id, "execute"))}>ביצוע התיקון</button>}
        {["dispatch_pending", "reprocessing", "verifying"].includes(a.status) && <button className="btn" disabled={!!busy} onClick={() => run("Checking repair…", () => api.optimizationAction(store, a._id, "verify"))}>בדיקת התקדמות</button>}
        {a.status === "pending" && <button className="btn" disabled={!!busy} onClick={() => run("Dismissing issue…", () => api.optimizationAction(store, a._id, "dismiss"))}>Dismiss</button>}
      </div>
    </section>)}
  </div>;
}
