import { ObjectId } from "mongodb";
import { controlDb } from "../core/db.js";
import { Tenant } from "../core/tenant.js";
import { DAY_MS, loadStoreEvents, normalizeQuery, StoreEvents } from "../analytics/events.js";
import { queryFunnel, QueryRow } from "../analytics/conversion.js";

const BEFORE_DAYS = 14, MAX_DAYS = 60, CACHE_MS = 5 * 60_000;

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" });
const hourDay = new Map<number, string>();
/** Calendar day in the store's timezone (Israel offsets are whole hours, so an hour bucket has one day). */
export function dayOf(t: number): string {
  const h = Math.floor(t / 3_600_000);
  let d = hourDay.get(h);
  if (!d) { d = dayFmt.format(new Date(t)); hourDay.set(h, d); }
  return d;
}
const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = shiftDay(d, 1)) out.push(d);
  return out;
}

export interface DayFunnels { from: string; to: string; rows: Map<string, QueryRow[]>; purchaseTracking: boolean }

/** Query funnels per calendar day, so every plan's before/after is read from one pass over the events. */
export function funnelsByDay(ev: StoreEvents): DayFunnels {
  const buckets = new Map<string, StoreEvents>();
  const bucket = (t: number) => {
    const d = dayOf(t);
    let b = buckets.get(d);
    if (!b) { b = { ...ev, queries: [], clicks: [], carts: [], checkouts: [], purchases: [] }; buckets.set(d, b); }
    return b;
  };
  for (const e of ev.queries) bucket(e.t).queries.push(e);
  for (const e of ev.clicks) bucket(e.t).clicks.push(e);
  for (const e of ev.carts) bucket(e.t).carts.push(e);
  for (const e of ev.checkouts) bucket(e.t).checkouts.push(e);
  for (const e of ev.purchases) bucket(e.t).purchases.push(e);
  return { from: dayOf(ev.from), to: dayOf(ev.to), rows: new Map([...buckets].map(([d, b]) => [d, queryFunnel(b)])), purchaseTracking: ev.purchases.length > 0 };
}

export type Pattern = { text: string; exact: boolean };
const matches = (q: string, patterns: Pattern[]) => patterns.some(p => (p.exact ? q === p.text : q.includes(p.text)));
const rate = (n: number, d: number) => (d ? n / d : null);

function totals(days: { searches: number; sessions: number; clicks: number; carts: number; purchases: number }[], purchaseTracking: boolean) {
  const s = days.reduce((a, d) => ({ searches: a.searches + d.searches, sessions: a.sessions + d.sessions, clicks: a.clicks + d.clicks, carts: a.carts + d.carts, purchases: a.purchases + d.purchases }), { searches: 0, sessions: 0, clicks: 0, carts: 0, purchases: 0 });
  return { days: days.length, searches: s.searches, sessions: s.sessions, clickRate: rate(s.clicks, s.sessions), cartRate: rate(s.carts, s.sessions), purchaseRate: purchaseTracking ? rate(s.purchases, s.sessions) : null };
}

/** Daily search funnel of the targeted queries from two weeks before approval until today, with before/after totals. */
export function compareAround(f: DayFunnels, patterns: Pattern[], approvedAt: Date) {
  const approved = dayOf(+approvedAt), start = [shiftDay(approved, -BEFORE_DAYS), f.from].sort()[1];
  const series = dayRange(start, f.to).map(day => {
    const rows = (f.rows.get(day) ?? []).filter(r => matches(r.query, patterns));
    const sum = (k: "searches" | "searchSessions" | "clickSessions" | "cartSessions" | "purchaseSessions") => rows.reduce((a, r) => a + r[k], 0);
    const d = { day, searches: sum("searches"), sessions: sum("searchSessions"), clicks: sum("clickSessions"), carts: sum("cartSessions"), purchases: sum("purchaseSessions") };
    return { ...d, clickRate: rate(d.clicks, d.sessions), cartRate: rate(d.carts, d.sessions) };
  });
  return {
    approvedDay: approved,
    before: totals(series.filter(d => d.day < approved), f.purchaseTracking),
    after: totals(series.filter(d => d.day >= approved), f.purchaseTracking),
    series: series.map(({ day, searches, clickRate, cartRate }) => ({ day, searches, clickRate, cartRate })),
  };
}

const cache = new Map<string, { at: number; from: number; value: Promise<DayFunnels> }>();
function storeFunnels(dbName: string, from: number): Promise<DayFunnels> {
  const hit = cache.get(dbName);
  if (hit && Date.now() - hit.at < CACHE_MS && hit.from <= from) return hit.value;
  const value = loadStoreEvents(dbName, new Date(from), new Date()).then(funnelsByDay);
  cache.set(dbName, { at: Date.now(), from, value });
  value.catch(() => cache.delete(dbName));
  return value;
}

const PLAN_TYPE: Record<string, string> = { rule: "rule", experiment: "experiment", productBoost: "productBoost", productVisibility: "productVisibility", catalogFilter: "catalogFilter" };
const EXPERIMENT_EVENT: Record<string, string> = { approved: "הבדיקה אושרה", running: "הבדיקה התחילה", paused: "הבדיקה הושהתה", completed: "הבדיקה הסתיימה", promoted: "הגרסה המנצחת הופעלה לכל הגולשים", killed: "הבדיקה בוטלה", rejected: "הבדיקה נדחתה" };
const ACTION_EVENT: Record<string, string> = { dispatch_pending: "התיקון נשמר בקטלוג", reprocessing: "המוצרים בעיבוד מחדש", verifying: "מאמת את התוצאות", verified: "התיקון אומת בחיפוש", failed: "התיקון נכשל", completed: "התיקון הושלם" };
const ACTIVE_ACTION = new Set(["applying", "dispatch_pending", "reprocessing", "verifying"]);

function patternsOf(p: any, kind: string): Pattern[] {
  const seen = new Set<string>();
  return rawPatterns(p, kind).filter(x => { const k = `${x.exact}:${x.text}`; return !seen.has(k) && !!seen.add(k); });
}
function rawPatterns(p: any, kind: string): Pattern[] {
  const norm = (v: unknown, exact: boolean): Pattern[] => { const text = normalizeQuery(v); return text ? [{ text, exact }] : []; };
  if (kind === "rule" || kind === "experiment") {
    const target = kind === "rule" ? p.draftRule?.condition : p.draftExperiment?.targeting;
    const pins = (kind === "rule" ? p.draftRule?.patch?.pinnedResults : p.draftExperiment?.arms?.flatMap((a: any) => a.patch?.pinnedResults ?? [])) ?? [];
    return [
      ...(target?.mode === "queryMatch" ? (target.patterns ?? []).flatMap((x: unknown) => norm(x, target.matchType === "exact")) : []),
      ...pins.flatMap((x: any) => norm(x.query, true)),
    ];
  }
  if (kind === "productBoost" || kind === "productVisibility") return norm((p.boostChange ?? p.visibilityChange)?.term, false);
  const ev = p.evidence ?? {};
  const qs = [ev.query, ...(Array.isArray(ev.queries) ? ev.queries : [])].flatMap(x => norm(typeof x === "object" && x ? x.query : x, true));
  return qs.length ? qs : norm(p.catalogChange?.filter, false);
}

/**
 * Everything the optimizer proposed that was approved for this store: what it
 * changes, where it came from, its timeline, and how the searches it targets
 * did in the two weeks before approval against the time since.
 */
export async function listPlans(tenant: Tenant) {
  const db = await controlDb();
  const [proposals, actions] = await Promise.all([
    db.collection("proposals").find({ $or: [{ dbName: tenant.dbName }, { tenantApiKey: tenant.apiKey }, { "draftExperiment.dbName": tenant.dbName }], status: { $in: ["approved", "applying"] } })
      .sort({ reviewedAt: -1, createdAt: -1 }).limit(100).toArray(),
    db.collection("optimization_actions").find({ dbName: tenant.dbName, kind: { $ne: "investigate" }, status: { $nin: ["pending", "dismissed"] } })
      .sort({ createdAt: -1 }).limit(100).toArray(),
  ]);
  const runIds = [...new Set([...proposals, ...actions].map(x => x.agentRunId).filter((x): x is string => typeof x === "string" && ObjectId.isValid(x)))];
  const ruleIds = proposals.map(p => p.ruleId).filter((x): x is string => typeof x === "string" && ObjectId.isValid(x));
  const [runs, rules, experiments] = await Promise.all([
    runIds.length ? db.collection("agent_runs").find({ _id: { $in: runIds.map(id => new ObjectId(id)) } }).project({ request: 1, conversationId: 1, startedAt: 1 }).toArray() : [],
    ruleIds.length ? db.collection("rules").find({ _id: { $in: ruleIds.map(id => new ObjectId(id)) } }).project({ status: 1, createdAt: 1, history: 1 }).toArray() : [],
    proposals.some(p => !p.kind || p.kind === "experiment") ? db.collection("experiments").find({ proposalId: { $in: proposals.map(p => String(p._id)) } }).project({ proposalId: 1, status: 1, statusHistory: 1, name: 1 }).toArray() : [],
  ]);
  const metrics = experiments.length ? await db.collection("experiment_metrics").aggregate([
    { $match: { experimentId: { $in: experiments.map(e => String(e._id)) } } }, { $sort: { asOf: -1 } },
    { $group: { _id: "$experimentId", latest: { $first: "$$ROOT" } } },
  ]).toArray() : [];
  const runOf = new Map(runs.map(r => [String(r._id), r])), ruleOf = new Map(rules.map(r => [String(r._id), r]));
  const expOf = new Map(experiments.map(e => [e.proposalId, e])), metricOf = new Map(metrics.map(m => [m._id, m.latest]));

  const plans = [
    ...proposals.map(p => {
      const kind = PLAN_TYPE[p.kind ?? "experiment"] ?? p.kind, run = runOf.get(p.agentRunId), approvedAt: Date | undefined = p.reviewedAt ?? p.createdAt;
      const timeline: { at: Date; label: string; detail?: string }[] = [
        { at: p.createdAt, label: run ? "הסוכן הציע את השינוי" : "הסקירה השבועית הציעה את השינוי", detail: run?.request ?? undefined },
      ];
      let status = "active", control: Record<string, unknown> | null = null, experiment: any = null, measureAt = approvedAt;
      if (kind === "rule") {
        const rule = ruleOf.get(p.ruleId);
        if (p.reviewedAt) timeline.push({ at: p.reviewedAt, label: "אושר והופעל בחיפוש" });
        for (const h of rule?.history ?? []) timeline.push({ at: h.at, label: h.status === "active" ? "הכלל הופעל מחדש" : "הכלל הושבת" });
        status = !rule ? "ended" : rule.status === "active" ? "active" : "paused";
        if (rule) control = { type: "rule", id: String(rule._id), status: rule.status };
      } else if (kind === "experiment") {
        const exp = expOf.get(String(p._id));
        for (const h of exp?.statusHistory ?? []) timeline.push({ at: h.at, label: EXPERIMENT_EVENT[h.status] ?? h.status, detail: h.note });
        // A promoted winner is written into the store config, so it keeps acting on search.
        status = !exp ? "ended" : exp.status === "running" || exp.status === "promoted" ? "active" : exp.status === "paused" ? "paused" : exp.status === "approved" ? "scheduled" : "ended";
        if (exp) {
          control = { type: "experiment", id: String(exp._id), status: exp.status };
          // Before promotion only part of the traffic saw the variant.
          if (exp.status === "promoted") measureAt = exp.statusHistory?.find((h: any) => h.status === "promoted")?.at ?? measureAt;
          const m = metricOf.get(String(exp._id));
          if (m) {
            timeline.push({ at: m.asOf, label: "המדדים עודכנו" });
            experiment = { asOf: m.asOf, arms: (m.arms ?? []).map((a: any) => ({ arm: a.arm, sessions: a.sessions, clickRate: a.clickRate, atcRate: a.atcRate, cvr: a.cvr })), probBestClick: m.stats?.probBestClick ?? null, probBestConv: m.stats?.probBestConv ?? null };
          }
        }
      } else {
        status = p.status === "applying" ? "applying" : "active";
        if (p.reviewedAt) timeline.push({ at: p.reviewedAt, label: "אושר" });
        const count = p.appliedCount ?? p.applyResult?.productsUpdated;
        if (p.status === "approved" && p.reviewedAt) timeline.push({ at: p.reviewedAt, label: kind === "productBoost" ? ((p.boostChange?.level ?? 1) === 0 ? "הקידום הוסר" : "הקידום הופעל") : kind === "productVisibility" ? (p.visibilityChange?.hidden === false ? "המוצרים הוחזרו לחיפוש" : "המוצרים הוסתרו מהחיפוש") : "התגיות עודכנו בקטלוג", detail: count != null ? `${count} מוצרים` : undefined });
      }
      const change = p.boostChange ?? p.visibilityChange;
      return {
        id: String(p._id), source: "proposal", kind, status, approvedAt, measureAt, createdAt: p.createdAt,
        title: p.evidence?.summary ?? p.draftRule?.name ?? p.draftExperiment?.name ?? p.hypothesis,
        description: p.hypothesis, request: run?.request ?? null, conversationId: run?.conversationId ?? null,
        products: change?.products?.slice(0, 50).map((x: any) => ({ _id: String(x._id), name: x.name })) ?? [],
        level: p.boostChange?.level, filter: p.catalogChange?.filter,
        patterns: patternsOf(p, kind), timeline, control, experiment,
      };
    }),
    ...actions.map(a => {
      const run = runOf.get(a.agentRunId), approvedAt: Date | undefined = a.startedAt ?? a.appliedAt ?? a.createdAt;
      const timeline: { at: Date; label: string; detail?: string }[] = [
        { at: a.createdAt, label: run ? "הסוכן הציע את התיקון" : "המערכת הציעה את התיקון", detail: run?.request ?? undefined },
        ...(a.startedAt ? [{ at: a.startedAt, label: "אושר" }] : []),
        ...(a.history ?? []).filter((h: any) => ACTION_EVENT[h.status]).map((h: any) => ({ at: h.at, label: ACTION_EVENT[h.status] })),
      ];
      return {
        id: String(a._id), source: "action", kind: a.kind, status: a.status === "failed" ? "failed" : ACTIVE_ACTION.has(a.status) ? "applying" : "active",
        approvedAt, measureAt: approvedAt, createdAt: a.createdAt, title: a.title, description: a.rationale, request: run?.request ?? null, conversationId: run?.conversationId ?? null,
        products: (a.selectedProducts ?? []).slice(0, 50).map((x: any) => ({ _id: String(x._id), name: x.name })), filter: a.filter, categories: a.categories,
        patterns: normalizeQuery(a.query) ? [{ text: normalizeQuery(a.query), exact: true }] : [], timeline, control: null, experiment: null, error: a.error ?? a.lastError,
      };
    }),
  ].map(p => ({ ...p, timeline: p.timeline.filter(e => e.at).sort((x, y) => +new Date(x.at) - +new Date(y.at)) }))
    .sort((x, y) => +new Date(y.approvedAt ?? 0) - +new Date(x.approvedAt ?? 0));

  // One read of the events covers every plan's window.
  const measured = plans.filter(p => p.patterns.length && p.measureAt);
  const oldest = Math.min(...measured.map(p => +new Date(p.measureAt!)));
  const from = Math.max(oldest - BEFORE_DAYS * DAY_MS, Date.now() - MAX_DAYS * DAY_MS);
  const funnels = measured.length ? await storeFunnels(tenant.dbName, from).catch(() => null) : null;
  return {
    windowDays: BEFORE_DAYS, maxDays: MAX_DAYS, purchaseTracking: funnels?.purchaseTracking ?? false,
    plans: plans.map(p => ({ ...p, metrics: funnels && measured.includes(p) ? compareAround(funnels, p.patterns, new Date(p.measureAt!)) : null })),
  };
}
