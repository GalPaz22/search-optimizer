import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

const pct = (v: number | null | undefined, digits = 1) => (v == null ? "—" : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("he-IL"));
const money = (list: { currency: string | null; amount: number; orders: number }[] | undefined) =>
  list?.length ? list.map(m => `${Math.round(m.amount).toLocaleString("he-IL")} ${m.currency ?? "(מטבע לא מדווח)"}`).join(" · ") : "—";
const when = (v: string | undefined) => (v ? new Date(v).toLocaleString("he-IL") : "—");

const STAGE: Record<string, string> = {
  zero_results: "אין תוצאות", no_click: "מוצג ולא נלחץ", click_no_cart: "נלחץ ולא נוסף לסל", cart_no_purchase: "בסל ולא נקנה",
  healthy: "תקין", unmeasured: "לא נמדד", catalog_gap: "פער קטלוג", ranking: "דירוג", vocabulary: "אוצר מילים", tracking: "מדידה", other: "אחר",
};
const KIND: Record<string, string> = { catalog: "קטלוג", experiment: "ניסוי", rule: "כלל קבוע", tracking: "מדידה", merchandising: "מרצ'נדייזינג", content: "תוכן", investigation: "בדיקה" };
const REASON: Record<string, string> = { zero_results: "אין תוצאות", no_click: "בלי קליקים", click_no_cart: "קליק בלי סל", cart_no_purchase: "סל בלי רכישה", production_fails: "נכשל היום", catalog_gap: "פער קטלוג", top: "מהמובילים" };
const RUN_STATUS: Record<string, string> = { queued: "ממתין", running: "רץ", completed: "הושלם", failed: "נכשל", stopped: "נעצר", skipped_budget: "דילוג (תקציב)" };
const running = (s?: string) => s === "queued" || s === "running";

export function Conversion({ store }: { store: string }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [days, setDays] = useState(30);
  const [request, setRequest] = useState("");
  const [run, setRun] = useState<any>(null);
  const [spend, setSpend] = useState<any>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    if (!store) return;
    const [d, s] = await Promise.all([api.conversion(store), api.agentSpend(store).catch(() => null)]);
    setData(d); setSpend(s);
    if (d.run) setRun((prev: any) => (prev && prev._id === d.run._id && prev.steps ? prev : d.run));
  }, [store]);
  useEffect(() => { reload().catch(e => setError(e.message)); }, [reload]);

  // Follow a running analysis step by step; reload the reports when it ends.
  useEffect(() => {
    if (!run?._id || !running(run.status)) return;
    poll.current = setInterval(async () => {
      try {
        const next = await api.agentRun(run._id);
        setRun(next);
        if (!running(next.status)) { clearInterval(poll.current!); await reload(); }
      } catch (e: any) { setError(e.message); }
    }, 3000);
    return () => clearInterval(poll.current!);
  }, [run?._id, run?.status, reload]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError("");
    try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };

  if (!store) return <div className="empty"><h3>בחרו חנות</h3><p>דוח ההמרה והסוכן עובדים על חנות אחת.</p></div>;
  const r = data?.data, a = data?.agent, f = r?.funnel;
  const overBudget = spend && spend.remainingUsd <= 0;

  return (
    <div className="conversion" dir="rtl" lang="he">
      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <h2>שיפור ההמרה מהחיפוש</h2>
        <p className="muted">הדוח נבנה מנתוני הקונים של החנות (חיפושים, קליקים, סל, הזמנות). הסוכן מאבחן היכן החיפוש מאבד קונים ומכין פעולות: תיקוני קטלוג, כללים, ניסויים והשלמות מדידה — שינויים בחיפוש החי ממתינים לאישור.</p>
        <div className="conversion-controls">
          <label>טווח
            <select value={days} onChange={e => setDays(Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map(d => <option key={d} value={d}>{d} ימים</option>)}
            </select>
          </label>
          <button className="btn" disabled={!!busy} onClick={() => act("בונה דוח…", async () => { await api.conversionRefresh(store, days); await reload(); })}>רענון נתונים</button>
          {busy && <span role="status">{busy}</span>}
        </div>
        <label className="request-label" htmlFor="agent-request">בקשה לסוכן (אופציונלי)</label>
        <textarea id="agent-request" rows={2} maxLength={2000} value={request} onChange={e => setRequest(e.target.value)} placeholder="למשל: תתמקד בחיפושים שמגיעים לסל ולא נקנים, או: בדוק למה ״יין ללא אלכוהול״ לא ממיר" />
        <div className="conversion-controls">
          <button className="btn primary" disabled={!!busy || running(run?.status) || overBudget}
            onClick={() => act("מפעיל סוכן…", async () => { const { runId } = await api.runAgent(store, request); setRequest(""); setRun(await api.agentRun(runId)); })}>
            {running(run?.status) ? "הסוכן עובד…" : overBudget ? "התקציב החודשי נוצל" : "הפעלת סוכן ההמרה"}
          </button>
          {spend && <span className="muted">החודש: ${spend.spentUsd.toFixed(2)} מתוך ${spend.budgetUsd.toFixed(2)}</span>}
        </div>
      </section>

      {run && <RunPanel run={run} onStop={() => act("עוצר…", async () => { await api.stopAgentRun(run._id); setRun(await api.agentRun(run._id)); })} />}

      {!r && data && <div className="empty"><h3>אין עדיין דוח לחנות הזו</h3><p>לחצו ״רענון נתונים״ או הפעילו את הסוכן.</p></div>}

      {r && <>
        {!!r.tracking?.length && <section className="card">
          <h2>מה מגביל את המדידה</h2>
          <p className="muted">בעיות מדידה חוסמות או מטות את ניתוח ההמרה. תיקון שלהן הוא לרוב הצעד הראשון.</p>
          {r.tracking.map((t: any) => <div key={t.code} className={`issue ${t.severity}`}>
            <strong>{t.title}</strong><p>{t.detail}</p><p><b>מה לעשות: </b>{t.fix}</p>
          </div>)}
        </section>}

        <section className="card">
          <div className="row spread"><h2>משפך החיפוש</h2><span className="muted">{when(r.window.from)} – {when(r.window.to)} · נבנה {when(r.generatedAt)}</span></div>
          <div className="funnel">
            {[["חיפשו", f.sessions.searched, 1], ["לחצו על מוצר", f.sessions.clicked, f.rates.click], ["הוסיפו לסל", f.sessions.carted, f.rates.cart], ["התחילו תשלום", f.sessions.checkout, f.rates.checkout], ["קנו", f.sessions.purchased, f.rates.purchase]].map(([label, n, rate]) =>
              <div key={label as string} className="funnel-step">
                <div className="funnel-bar"><span style={{ width: `${Math.max(2, Math.min(100, ((rate as number) ?? 0) * 100))}%` }} /></div>
                <div><strong>{num(n as number)}</strong> {label} <span className="muted">({rate === 1 ? "100%" : pct(rate as number)})</span></div>
              </div>)}
          </div>
          <p className="muted">סשנים ייחודיים שחיפשו ואז הגיעו לשלב (קליק עד 30 דק׳, סל עד שעתיים, תשלום/רכישה עד 24 שעות).{r.excludedQueries?.length ? ` חיפושים אוטומטיים שהוצאו: ${r.excludedQueries.join(", ")}.` : ""}</p>
          <div className="stats-grid">
            <div className="stat"><div className="v">{num(f.orders.total)}</div><div className="l">הזמנות בטווח</div></div>
            <div className="stat"><div className="v">{num(f.orders.searchAssisted)}</div><div className="l">הזמנות אחרי חיפוש ({pct(f.orders.total ? f.orders.searchAssisted / f.orders.total : null)})</div></div>
            <div className="stat"><div className="v small">{money(f.revenue.total)}</div><div className="l">הכנסות רשומות</div></div>
            <div className="stat"><div className="v small">{money(f.revenue.searchAssisted)}</div><div className="l">הכנסות אחרי חיפוש</div></div>
            <div className="stat"><div className="v">{pct(f.cartSessionsPurchaseRate.withSearch)}</div><div className="l">קונים מתוך מוסיפי סל שחיפשו ({num(f.cartSessionsPurchaseRate.withSearchSessions)})</div></div>
            <div className="stat"><div className="v">{pct(f.cartSessionsPurchaseRate.withoutSearch)}</div><div className="l">קונים מתוך מוסיפי סל שלא חיפשו ({num(f.cartSessionsPurchaseRate.withoutSearchSessions)})</div></div>
          </div>
        </section>

        {a && <AgentReport report={a} linked={data.linked} />}

        {!!r.queries.opportunity.length && <section className="card">
          <h2>איפה החיפוש מאבד הכי הרבה קונים</h2>
          <p className="muted">״מתחת לממוצע״ = סשני חיפוש × (שיעור ההמרה של החנות − של החיפוש) בשלב העמוק ביותר שנמדד. זה גודל לתעדוף, לא תחזית של הזמנות.</p>
          <QueryTable rows={r.queries.opportunity} withBelow />
        </section>}

        {!!r.audit?.length && <section className="card">
          <h2>חיפושים לבדיקה ראשונה</h2>
          <div className="table-wrap"><table><thead><tr><th>חיפוש</th><th>סיבות</th><th>חיפושים</th><th>סיווג</th><th>מה הוצג</th><th>מוצרים שנבחרו ואינם זמינים</th></tr></thead><tbody>
            {r.audit.map((c: any) => <tr key={c.query}>
              <td dir="auto"><strong>{c.query}</strong></td><td>{c.reasons.map((x: string) => REASON[x] ?? x).join(" · ")}</td><td>{num(c.searches)}</td>
              <td>{c.classification === "catalog_gap" ? "פער קטלוג" : c.classification === "unmeasured" ? "מדגם קטן" : "בעיית חיפוש"}</td>
              <td dir="auto" className="muted">{c.delivered.slice(0, 3).join(" · ") || "—"}</td><td dir="auto" className="muted">{c.unavailableChosen.join(" · ") || "—"}</td>
            </tr>)}
          </tbody></table></div>
        </section>}

        <section className="card">
          <h2>מה עובד היום ומה חסר בקטלוג</h2>
          <div className="stats-grid">
            <div className="stat"><div className="v">{num(r.baseline.summary.works)}</div><div className="l">חיפושים שעובדים ({num(r.baseline.summary.searchesWorking)} חיפושים)</div></div>
            <div className="stat"><div className="v">{num(r.baseline.summary.fails)}</div><div className="l">חיפושים שנכשלים ({num(r.baseline.summary.searchesFailing)})</div></div>
            <div className="stat"><div className="v">{num(r.baseline.summary.gaps)}</div><div className="l">פערי קטלוג ({num(r.baseline.summary.searchesInGaps)} חיפושים)</div></div>
            {r.catalog && <div className="stat"><div className="v">{num(r.catalog.available)}</div><div className="l">מוצרים זמינים מתוך {num(r.catalog.products)}</div></div>}
          </div>
          {!!r.baseline.gaps.length && <details open><summary>קונים בוחרים במוצרים שלא ניתן להציג</summary><ul>
            {r.baseline.gaps.slice(0, 12).map((g: any) => <li key={g.query} dir="auto"><strong>{g.query}</strong> ({num(g.searches)} חיפושים): {g.unavailable.map((u: any) => `${u.name} — ${!u.inCatalog ? "לא בקטלוג" : u.hidden ? "מוסתר מהחיפוש" : u.stockStatus === "outofstock" ? "אזל" : "לא זמין"}`).join(" · ")}</li>)}
          </ul></details>}
          {!!r.queries.zeroResults.length && <details><summary>חיפושים בלי תוצאות</summary><QueryTable rows={r.queries.zeroResults} /></details>}
          <details><summary>החיפושים המובילים</summary><QueryTable rows={r.queries.top} /></details>
        </section>

        <details className="card methodology"><summary>איך זה מחושב</summary>
          <ul>{Object.entries(r.methodology ?? {}).map(([k, v]) => <li key={k} dir="ltr"><b>{k}:</b> {String(v)}</li>)}</ul>
          <p className="muted" dir="ltr">Sources: {Object.entries(r.sources).map(([k, s]: any) => `${k} ${s.status}${s.truncated ? " (truncated)" : ""} · ${s.rows}`).join(" | ")}</p>
        </details>
      </>}
    </div>
  );
}

function QueryTable({ rows, withBelow }: { rows: any[]; withBelow?: boolean }) {
  return <div className="table-wrap"><table><thead><tr><th>חיפוש</th><th>חיפושים</th><th>סשנים</th><th>ללא תוצאות</th><th>קליק</th><th>סל</th><th>רכישה</th><th>שלב הדליפה</th>{withBelow && <th>מתחת לממוצע</th>}</tr></thead><tbody>
    {rows.map(q => <tr key={q.query}>
      <td dir="auto"><strong>{q.query}</strong>{!!q.delivered?.length && <div className="muted small-text" title={q.delivered.join(" · ")}>{q.delivered.slice(0, 2).join(" · ")}</div>}</td>
      <td>{num(q.searches)}</td><td>{num(q.searchSessions)}</td><td>{pct(q.zeroRate, 0)}</td><td>{pct(q.clickRate)}</td><td>{pct(q.cartRate)}</td><td>{pct(q.purchaseRate)}</td>
      <td>{STAGE[q.leakStage] ?? q.leakStage}</td>{withBelow && <td>{q.sessionsBelowAverage}</td>}
    </tr>)}
  </tbody></table></div>;
}

function AgentReport({ report, linked }: { report: any; linked: { actions: any[]; proposals: any[] } }) {
  const actionById = new Map(linked.actions.map(x => [String(x._id), x])), proposalById = new Map(linked.proposals.map(x => [String(x._id), x]));
  return <section className="card agent-report">
    <div className="row spread"><h2>דוח הסוכן</h2><span className="muted">{when(report.generatedAt)}</span></div>
    <div className="summary-text">{report.summary}</div>
    {!!report.proposals?.length && <>
      <h3>הצעות לשיפור</h3>
      {[...report.proposals].sort((x: any, y: any) => x.priority - y.priority).map((p: any) => <div key={p.id} className="proposal">
        <div className="row"><span className={`badge p${p.priority}`}>עדיפות {p.priority}</span><span className="badge">{KIND[p.kind] ?? p.kind}</span><strong>{p.title}</strong></div>
        {!!p.queries.length && <div className="chips">{p.queries.map((q: string) => <span key={q} className="chip" dir="auto">{q}</span>)}</div>}
        <dl>
          <dt>ראיות</dt><dd>{p.evidence}</dd><dt>השינוי</dt><dd>{p.change}</dd><dt>השפעה צפויה (השערה)</dt><dd>{p.expectedImpact}</dd>
          <dt>מדד הצלחה</dt><dd>{p.metric}</dd><dt>אימות וחזרה לאחור</dt><dd>{p.validation}</dd><dt>סיכון</dt><dd>{p.risk}</dd>
        </dl>
        {(p.actionIds.length > 0 || p.proposalIds.length > 0) && <p className="muted">
          {p.actionIds.map((id: string) => { const x = actionById.get(id); return <span key={id} className="link-chip">פעולה: {x?.title ?? id} · {x?.status ?? "?"}</span>; })}
          {p.proposalIds.map((id: string) => { const x = proposalById.get(id); return <span key={id} className="link-chip">הצעה לאישור: {x?.draftExperiment?.name ?? x?.draftRule?.name ?? x?.catalogChange?.filter ?? id} · {x?.status ?? "?"}</span>; })}
        </p>}
      </div>)}
      <p className="muted">ניסויים וכללים ממתינים במסך Opportunities; תיקוני קטלוג במסך Daily optimization. יצירת פעולה אינה ביצוע, וביצוע אינו הוכחה לשיפור.</p>
    </>}
    {!!report.findings?.length && <details><summary>ממצאים ({report.findings.length})</summary>
      <div className="table-wrap"><table><thead><tr><th>חומרה</th><th>שלב</th><th>ממצא</th><th>ראיות</th><th>ביטחון</th></tr></thead><tbody>
        {report.findings.map((x: any, i: number) => <tr key={i}><td>{x.severity}</td><td>{STAGE[x.stage] ?? x.stage}</td><td dir="auto"><strong>{x.title}</strong>{x.query && <div className="muted">״{x.query}״</div>}</td><td dir="auto">{x.evidence}</td><td>{{ high: "גבוה", medium: "בינוני", low: "נמוך" }[x.confidence as string]}</td></tr>)}
      </tbody></table></div>
    </details>}
    {!!report.limitations?.length && <details><summary>מגבלות הניתוח</summary><ul>{report.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></details>}
  </section>;
}

function RunPanel({ run, onStop }: { run: any; onStop: () => void }) {
  const steps: any[] = run.steps ?? [];
  return <section className="card run-panel">
    <div className="row spread">
      <h2>ריצת הסוכן <span className={`badge ${run.status}`}>{RUN_STATUS[run.status] ?? run.status}</span></h2>
      <div className="row">
        <span className="muted">{when(run.startedAt)} · {run.toolCalls ?? 0} קריאות כלים{run.costUsd ? ` · $${run.costUsd.toFixed(3)}` : ""}</span>
        {running(run.status) && <button className="btn danger" onClick={onStop}>עצור</button>}
      </div>
    </div>
    {run.request && <p><b>בקשה:</b> {run.request}</p>}
    {run.error && <div className="error">{run.error}</div>}
    {!!steps.length && <ol className="steps">
      {steps.slice(-40).map((s: any) => <li key={s.id} className={s.ok === false ? "failed" : ""}>
        {s.type === "tool" ? <><code dir="ltr">{s.name}</code>{s.ok === undefined ? " …" : s.ok ? " ✓" : " ✗"}{s.output && s.ok === false && <div className="muted small-text" dir="auto">{s.output}</div>}</> : <span dir="auto">{s.text}</span>}
      </li>)}
    </ol>}
    {!running(run.status) && run.summary && <details><summary>הסקירה המלאה</summary><div className="summary-text">{run.summary}</div></details>}
    {run.status === "completed" && run.reportMissing && <p className="muted">הסוכן לא שמר דוח מובנה בריצה הזו; הסקירה המלאה זמינה למעלה.</p>}
  </section>;
}
