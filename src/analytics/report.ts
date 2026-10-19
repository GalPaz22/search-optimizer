import { ObjectId } from "mongodb";
import { controlDb, tenantDb } from "../core/db.js";
import { Tenant } from "../core/tenant.js";
import { dailyActivity } from "./activity.js";
import { buildBaseline } from "./baseline.js";
import { loadCatalog } from "./catalog.js";
import { classifyLeaks, Funnel, METHODOLOGY, queryFunnel, QueryRow, rankQueries, storeFunnel, suspectedSynthetic } from "./conversion.js";
import { auditCandidates } from "./evidence.js";
import { DAY_MS, loadStoreEvents, StoreEvents } from "./events.js";
import { measuredConversion } from "./measurement.js";

export interface TrackingIssue { code: string; severity: "critical" | "warning" | "info"; title: string; detail: string; fix: string }
export interface ExperimentExposure { id: string; name: string; targeting: string; exposures: number; startedAt: string | null }

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

/** Measurement problems that block or bias conversion analysis, in the merchant's language. */
export function trackingIssues(ev: StoreEvents, f: Funnel, activity: ReturnType<typeof dailyActivity>, experiments: ExperimentExposure[] = [], synthetic: { query: string; searchSessions: number }[] = [], catalogMatchRate: number | null = null): TrackingIssue[] {
  const c = f.coverage, out: TrackingIssue[] = [];
  for (const [name, source] of Object.entries(ev.sources)) if (source.status !== "ok") out.push({
    code: `source_${name}`, severity: source.status === "unavailable" ? "critical" : "warning",
    title: `מקור הנתונים ${name} ${source.status === "missing" ? "חסר" : "אינו זמין"}`,
    detail: "נתונים חסרים אינם מעידים על אפס פעילות. מדדים שתלויים במקור הזה אינם מלאים.",
    fix: source.status === "missing" ? "לוודא שהמעקב בחנות שולח את האירועים למקור הזה." : "לבדוק את החיבור למסד הנתונים ולנסות לרענן את הדוח.",
  });
  if (catalogMatchRate !== null && catalogMatchRate < 0.9 && c.clicks + c.carts >= 100) out.push({ code: "catalog_id_mismatch", severity: "warning", title: "מזהי המוצרים באירועים לא תואמים לקטלוג",
    detail: `רק ${Math.round(catalogMatchRate * 100)}% מהקליקים/הוספות לסל שהגיעו מחיפוש מזוהים מול מוצר בקטלוג (לפי product_id, SKU, slug או כתובת). לכן מוצרים שלא זוהו מסומנים "לא ידוע" ולא "חסר", ופערי קטלוג נספרים רק למוצרים שקיימים ואזלו.`,
    fix: "לשלוח באירועי הקליק/סל את מזהה המוצר כפי שהוא שמור בקטלוג (id או sku) ואת product_url." });
  for (const s of synthetic) out.push({ code: "synthetic_query", severity: "warning", title: `החיפוש "${s.query}" נראה אוטומטי`,
    detail: `${s.searchSessions} סשנים חיפשו "${s.query}" כמעט בלי אף קליק או הוספה לסל — דפוס של קריאה אוטומטית (טעינה מוקדמת של הווידג'ט, שאילתת ברירת מחדל או בדיקה), לא של קונים. הוא הוצא מחישובי הבסיס של החנות.`,
    fix: "לבדוק בקוד הווידג'ט/האתר מה שולח את החיפוש הזה ולהפסיק לרשום אותו כחיפוש של קונה." });
  const activeStorefront = c.clicks + c.carts > 0;
  if (!c.queries && activeStorefront) out.push({ code: "no_search_logging", severity: "critical", title: "חיפושים לא נרשמים",
    detail: `בטווח נקלטו ${c.clicks} קליקים ו־${c.carts} הוספות לסל, אבל אף חיפוש לא נרשם באוסף queries.`,
    fix: "לוודא שהווידג'ט/האתר קורא לנקודות החיפוש של dashboard-server (שהן אלה שרושמות queries) ולא לחיפוש המקומי של הפלטפורמה." });
  if (c.queries >= 20 && c.queriesWithSession / c.queries < 0.5) out.push({ code: "queries_missing_session", severity: "critical", title: "חיפושים נרשמים בלי מזהה סשן",
    detail: `${100 - pct(c.queriesWithSession, c.queries)}% מהחיפושים (${c.queries - c.queriesWithSession} מתוך ${c.queries}) הגיעו בלי session_id. בלי מזהה אי אפשר לקשר חיפוש לקליק, לסל או לרכישה, וניסויי A/B לא משייכים את הקונים האלה לקבוצה (ה־hook מדלג על בקשה בלי session_id).`,
    fix: "לשלוח session_id (או sessionId) בגוף כל בקשת חיפוש מהאתר — אותו מזהה שכבר נשלח באירועי הקליק והסל. ב־dashboard-server הנתיב /simple-search קורא רק session_id ולא sessionId." });
  if (activeStorefront && !c.purchaseTracking) out.push({ code: "no_purchase_tracking", severity: c.carts ? "critical" : "warning", title: "רכישות לא נמדדות",
    detail: ev.sources.checkout_events?.status === "missing" ? "אין אוסף checkout_events — המדידה נעצרת בהוספה לסל." : `לא נקלטו אירועי checkout_completed בטווח${f.coverage.checkoutTracking ? " (יש רק checkout_initiated)" : ""} — אי אפשר לחשב המרה לרכישה או הכנסות מחיפוש.`,
    fix: "להפעיל בפלאגין את שליחת אירוע השלמת ההזמנה (checkout_completed עם order_id, order_total, currency ו־session_id)." });
  if (c.purchases >= 10 && c.purchasesWithSession / c.purchases < 0.7) out.push({ code: "purchases_missing_session", severity: "warning", title: "רכישות בלי מזהה סשן",
    detail: `${100 - pct(c.purchasesWithSession, c.purchases)}% מההזמנות נקלטו בלי session_id ולכן לא ניתן לשייך אותן לחיפוש שקדם להן.`, fix: "לצרף session_id לאירוע checkout_completed." });
  if (c.purchases >= 20 && c.purchaseSessionsSeenBefore !== null && c.purchaseSessionsSeenBefore < 0.3) out.push({ code: "session_mismatch", severity: "warning", title: "מזהי הסשן של ההזמנות לא תואמים לאירועי הגלישה",
    detail: `רק ${Math.round(c.purchaseSessionsSeenBefore * 100)}% מהסשנים שביצעו הזמנה מופיעים גם באירועי קליק/סל. כנראה שאירוע ההזמנה נשלח עם מזהה אחר (למשל מזהה עגלה או הזמנה), ולכן הייחוס של רכישות לחיפוש מוערך בחסר.`,
    fix: "לשלוח באירוע checkout_completed את אותו session_id שנשלח בחיפוש ובאירועי הקליק והסל." });
  if (c.purchases >= 10 && f.revenue.total.some(m => m.currency === null)) out.push({ code: "purchases_missing_currency", severity: "info", title: "הזמנות בלי מטבע",
    detail: "חלק מההזמנות נקלטו בלי currency; ההכנסות שלהן מוצגות תחת מטבע לא מדווח.", fix: "לשלוח currency (למשל ILS) באירוע ההזמנה." });
  if (c.queries >= 50 && c.queriesWithResultCount / c.queries < 0.5) out.push({ code: "no_result_counts", severity: "warning", title: "אין מידע על מספר תוצאות",
    detail: `רק ${pct(c.queriesWithResultCount, c.queries)}% מהחיפושים כוללים את רשימת התוצאות, כך שחיפושים ללא תוצאות לא נמדדים במלואם.`, fix: "לוודא ש־deliveredProducts/zero_results נרשמים בכל נתיבי החיפוש." });
  if (c.clicks >= 200 && c.clicksTagged / c.clicks < 0.3) out.push({ code: "clicks_untagged", severity: "info", title: "רוב הקליקים בלי search_query",
    detail: `רק ${pct(c.clicksTagged, c.clicks)}% מהקליקים מסומנים בחיפוש שממנו הגיעו; השיוך לחיפוש נשען על היסק לפי סשן וזמן.`, fix: "לשלוח search_query באירוע הקליק כשהוא מתוצאות חיפוש." });
  if (activity.searchLogging && activity.searchLogGapDays.length) out.push({ code: "search_log_gap", severity: "warning", title: "ימים בלי רישום חיפושים",
    detail: `בימים ${activity.searchLogGapDays.slice(0, 8).join(", ")} היו קליקים/הוספות לסל אך לא נרשם אף חיפוש.`, fix: "לבדוק את רישום queries בימים האלה (פריסה, שגיאות שרת) לפני השוואה בין תקופות." });
  if (activity.trackingGapDays.length) out.push({ code: "tracking_gap", severity: "warning", title: "ימים בלי קליקים ובלי סל",
    detail: `בימים ${activity.trackingGapDays.slice(0, 8).join(", ")} נרשמו חיפושים אבל אף קליק או הוספה לסל.`, fix: "לבדוק שסקריפט המעקב באתר נטען בימים האלה." });
  for (const [name, s] of Object.entries(ev.sources)) if (s.truncated) out.push({ code: `truncated_${name}`, severity: "warning", title: `המקור ${name} נחתך`,
    detail: `נקראו ${s.rows} אירועים אחרונים בלבד; הטווח ארוך מדי למקור הזה.`, fix: "להריץ דוח על טווח קצר יותר." });
  const starved = experiments.filter(x => x.startedAt && c.queries >= 100 && x.exposures < Math.max(10, c.queries * 0.01));
  if (starved.length) out.push({ code: "experiment_starved", severity: "warning", title: starved.length === 1 ? `הניסוי "${starved[0].name}" כמעט לא נחשף` : `${starved.length} ניסויים רצים כמעט לא נחשפים`,
    detail: `${starved.map(x => `"${x.name}": ${x.exposures} חשיפות (${x.targeting})`).join("; ")} — מול ${c.queries} חיפושים בטווח. ניסוי מקבל קונים רק כשבקשת החיפוש כוללת session_id ותואמת את הטירגוט.`,
    fix: "להשלים session_id בבקשות החיפוש, להרחיב טירגוט צר מדי, או לעצור ניסויים שלא יגיעו למובהקות." });
  if (f.orders.duplicates) out.push({ code: "duplicate_orders", severity: "info", title: "הזמנות כפולות", detail: `${f.orders.duplicates} אירועי הזמנה חוזרים (אותו order_id) סוננו.`, fix: "אין צורך בפעולה; ייתכן שהפלאגין שולח את ה־webhook פעמיים." });
  const order = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

async function experimentExposures(dbName: string, from: Date): Promise<ExperimentExposure[]> {
  const cdb = await controlDb(), running = await cdb.collection("experiments").find({ dbName, status: "running" }).project({ name: 1, targeting: 1, statusHistory: 1 }).toArray();
  if (!running.length) return [];
  const db = await tenantDb(dbName), counts = new Map<string, number>();
  const ids = running.map(e => String(e._id));
  for (const r of await db.collection("experiment_exposures").aggregate([{ $match: { experiment_id: { $in: ids }, timestamp: { $gte: from } } }, { $group: { _id: "$experiment_id", n: { $sum: 1 } } }]).toArray().catch(() => []))
    counts.set(String(r._id), r.n);
  return running.map((e: any) => ({
    id: String(e._id), name: e.name, exposures: counts.get(String(e._id)) ?? 0,
    targeting: e.targeting?.mode === "all" ? "כל החיפושים" : `חיפושים שמכילים ${(e.targeting?.patterns ?? []).join(" / ")}`,
    startedAt: e.statusHistory?.find((h: any) => h.status === "running")?.at?.toISOString?.() ?? null,
  }));
}

async function topZeroSearches(dbName: string, from: Date) {
  const db = await tenantDb(dbName);
  return db.collection("zero_searches").find({ $or: [{ last_seen: { $gte: from } }, { last_seen: { $gte: from.toISOString() } }] })
    .sort({ hits: -1 }).limit(15).project({ _id: 0, query: 1, hits: 1, recovered_count: 1 }).toArray().catch(() => []);
}

const slim = (r: QueryRow) => ({
  query: r.query, searches: r.searches, searchSessions: r.searchSessions, zeroRate: r.zeroRate, clickRate: r.clickRate, cartRate: r.cartRate, purchaseRate: r.purchaseRate,
  clicks: r.clicks, carts: r.carts, purchases: r.purchases, attributedRevenue: r.attributedRevenue, leakStage: r.leakStage, sessionsBelowAverage: r.sessionsBelowAverage, delivered: r.delivered.slice(0, 4),
});

/** Deterministic conversion report for one store: no model calls, read-only on the tenant database. */
export async function buildConversionReport(tenant: Tenant, { days = 30, persist = true, now = new Date() } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error("days must be 1–90");
  const from = new Date(+now - days * DAY_MS);
  const [ev, catalog, experiments, zeroSearches] = await Promise.all([
    loadStoreEvents(tenant.dbName, from, now), loadCatalog(tenant.dbName).catch(() => null),
    experimentExposures(tenant.dbName, from).catch(() => []), topZeroSearches(tenant.dbName, from),
  ]);
  // Automated queries are detected on the raw data, then excluded from the store baselines.
  const raw = queryFunnel(ev), searchSessions = new Set(ev.queries.map(q => q.s).filter(Boolean)).size;
  const synthetic = suspectedSynthetic(raw, searchSessions), skip = new Set(synthetic);
  const clean: StoreEvents = skip.size ? { ...ev, queries: ev.queries.filter(q => !skip.has(q.q)) } : ev;
  const measured = measuredConversion(clean, storeFunnel(clean), skip.size ? queryFunnel(clean) : raw);
  const funnel = measured.funnel, activity = dailyActivity(clean);
  const rows = classifyLeaks(measured.rows, funnel);
  const baseline = buildBaseline(ev, rows, catalog), audit = auditCandidates(rows, baseline);
  const report = {
    source: "data" as const, dbName: tenant.dbName, generatedAt: now, days, window: { from, to: now },
    sources: ev.sources, funnel, zeroResultSearches: rows.reduce((sum, row) => sum + row.zeroSearches, 0), tracking: trackingIssues(ev, funnel, activity, experiments, raw.filter(r => skip.has(r.query)).map(r => ({ query: r.query, searchSessions: r.searchSessions })), baseline.catalogMatchRate), activity,
    excludedQueries: synthetic,
    catalog: catalog ? { products: catalog.size, visible: catalog.visible, available: catalog.available, eventMatchRate: baseline.catalogMatchRate } : null,
    queries: {
      distinct: rows.length,
      top: rankQueries(rows, { sort: "searches", limit: 40 }).rows.map(slim),
      opportunity: rankQueries(rows, { sort: "opportunity", limit: 20 }).rows.filter(r => (r.sessionsBelowAverage ?? 0) > 0).map(slim),
      lowConversion: rankQueries(rows, { sort: "low_conversion", limit: 15, minSessions: 10 }).rows.map(slim),
      zeroResults: rows.filter(r => r.leakStage === "zero_results").sort((a, b) => b.searches - a.searches).slice(0, 20).map(slim),
    },
    baseline: {
      summary: baseline.summary,
      gaps: baseline.queries.filter(q => q.status === "gap" || q.unavailable.length).slice(0, 20).map(q => ({ query: q.query, searches: q.searches, status: q.status, unavailable: q.unavailable.slice(0, 5), targets: q.targets.slice(0, 3) })),
      works: baseline.queries.filter(q => q.status === "works").slice(0, 25).map(q => ({ query: q.query, searches: q.searches, targets: q.targets.slice(0, 4).map(t => ({ name: t.name, catalogId: t.catalogId, clicks: t.clicks, carts: t.carts, purchases: t.purchases })) })),
      fails: baseline.queries.filter(q => q.status === "fails").slice(0, 20).map(q => ({ query: q.query, searches: q.searches, zeroRate: q.zeroRate, delivered: q.delivered.slice(0, 4) })),
    },
    audit, zeroSearches, experiments, methodology: METHODOLOGY,
  };
  if (!persist) return { ...report, reportId: null as string | null };
  const _id = new ObjectId();
  await (await controlDb()).collection("conversion_reports").insertOne({ _id, ...report, tenantApiKey: tenant.apiKey });
  return { ...report, reportId: String(_id) };
}
export type ConversionReport = Awaited<ReturnType<typeof buildConversionReport>>;

export async function latestConversionReports(dbName: string) {
  const cdb = await controlDb();
  const [data, agent] = await Promise.all([
    cdb.collection("conversion_reports").find({ dbName, source: "data" }).sort({ generatedAt: -1 }).limit(1).next(),
    cdb.collection("conversion_reports").find({ dbName, source: "agent" }).sort({ generatedAt: -1 }).limit(5).toArray(),
  ]);
  return { data, agent: agent[0] ?? null, agentHistory: agent.slice(1).map(a => ({ _id: a._id, generatedAt: a.generatedAt, summary: String(a.summary ?? "").slice(0, 400) })) };
}

/** Compact view for the agent's opening context (bounded size, no ids of shoppers). */
export function reportDigest(r: Pick<ConversionReport, "days" | "excludedQueries" | "window" | "funnel" | "tracking" | "catalog" | "queries" | "baseline" | "audit" | "experiments" | "sources" | "zeroSearches"> & { reportId?: string | null }) {
  const q = (x: ReturnType<typeof slim>) => ({ q: x.query, s: x.searches, ss: x.searchSessions, zero: x.zeroRate, click: x.clickRate, cart: x.cartRate, buy: x.purchaseRate, stage: x.leakStage, below: x.sessionsBelowAverage });
  return {
    reportId: r.reportId ?? null, days: r.days, window: r.window, sources: r.sources, catalog: r.catalog, excludedQueries: r.excludedQueries,
    funnel: { sessions: r.funnel.sessions, rates: r.funnel.rates, orders: r.funnel.orders, revenue: r.funnel.revenue, cartSessionsPurchaseRate: r.funnel.cartSessionsPurchaseRate, coverage: r.funnel.coverage },
    tracking: r.tracking.map(t => ({ code: t.code, severity: t.severity, detail: t.detail })),
    topQueries: r.queries.top.slice(0, 20).map(q),
    biggestLeaks: r.queries.opportunity.slice(0, 12).map(q),
    zeroResults: r.queries.zeroResults.slice(0, 10).map(q),
    zeroSearchesCollection: r.zeroSearches.slice(0, 8),
    baseline: { summary: r.baseline.summary, gaps: r.baseline.gaps.slice(0, 8).map(g => ({ q: g.query, s: g.searches, unavailable: g.unavailable.map(u => u.name).slice(0, 3) })), fails: r.baseline.fails.slice(0, 8).map(f => ({ q: f.query, s: f.searches, zero: f.zeroRate })) },
    auditCandidates: r.audit.map(a => ({ q: a.query, reasons: a.reasons, s: a.searches, class: a.classification, below: a.sessionsBelowAverage, delivered: a.delivered.slice(0, 3), unavailableChosen: a.unavailableChosen.slice(0, 3) })),
    runningExperiments: r.experiments,
  };
}
