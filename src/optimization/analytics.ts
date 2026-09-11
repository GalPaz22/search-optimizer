import { tenantDb } from "../core/db.js";

export const normalizeQuery = (v: unknown) => typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : "";
const identity = (r: any): string | null => r.session_id || r.sessionId || null;
const time = (r: any) => new Date(r.timestamp).getTime();
export const dateRange = (start: Date, end: Date) => ({ $or: [
  { timestamp: { $gte: start, $lt: end } },
  { timestamp: { $gte: start.toISOString(), $lt: end.toISOString() } },
] });

/** Same-query attribution requires a preceding search, never a click-selected denominator. */
export function analyzeWindow(queries: any[], clicks: any[], carts: any[], start: Date, end: Date) {
  const inWindow = (r: any) => time(r) >= +start && time(r) < +end;
  queries = queries.filter(inWindow); clicks = clicks.filter(inWindow); carts = carts.filter(inWindow);
  const bySession = new Map<string, any[]>();
  const terms = new Map<string, { query: string; searches: number; missingSession: number; zeroResults: number; clicks: number; carts: number; identities: Set<string>; clickIdentities: Set<string>; cartIdentities: Set<string>; examples: string[][] }>();
  for (const r of queries) {
    const q = normalizeQuery(r.query), id = identity(r);
    if (!terms.has(q)) terms.set(q, { query: q, searches: 0, missingSession: 0, zeroResults: 0, clicks: 0, carts: 0, identities: new Set(), clickIdentities: new Set(), cartIdentities: new Set(), examples: [] });
    const row = terms.get(q)!; row.searches++;
    if (id) { row.identities.add(id); if (!bySession.has(id)) bySession.set(id, []); bySession.get(id)!.push(r); }
    else row.missingSession++;
    if (r.zero_results === true || (r.zero_results !== false && Array.isArray(r.deliveredProducts) && !r.deliveredProducts.length)) row.zeroResults++;
    if (Array.isArray(r.deliveredProducts) && row.examples.length < 3) {
      const names = r.deliveredProducts.slice(0, 5).filter((x: unknown) => typeof x === "string");
      if (!row.examples.some(x => JSON.stringify(x) === JSON.stringify(names))) row.examples.push(names);
    }
  }
  const clicked = new Set<string>(), carted = new Set<string>();
  let attributedCartEvents = 0;
  for (const [rows, kind] of [[clicks, "clicks"], [carts, "carts"]] as const) for (const r of rows) {
    const q = normalizeQuery(r.search_query), id = identity(r), term = terms.get(q);
    if (!q || ["direct", "unknown", "null"].includes(q)) continue;
    if (term) term[kind]++;
    if (id && term && (bySession.get(id) ?? []).some(s => normalizeQuery(s.query) === q && time(r) >= time(s) && time(r) - time(s) <= 30 * 60_000)) {
      (kind === "clicks" ? clicked : carted).add(id);
      (kind === "clicks" ? term.clickIdentities : term.cartIdentities).add(id);
      if (kind === "carts") attributedCartEvents++;
    }
  }
  const daily: Record<string, { searches: number; clicks: number; carts: number }> = {};
  for (const [rows, field] of [[queries, "searches"], [clicks, "clicks"], [carts, "carts"]] as const) for (const r of rows) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(r.timestamp));
    daily[day] ??= { searches: 0, clicks: 0, carts: 0 }; daily[day][field]++;
  }
  const missingSession = queries.filter(r => !identity(r)).length;
  return {
    start, end, searches: queries.length, identities: bySession.size, missingSession,
    missingSessionRate: queries.length ? missingSession / queries.length : null,
    clicks: clicks.length, carts: carts.length,
    searchTaggedCarts: carts.filter(r => { const q = normalizeQuery(r.search_query); return q && !["direct", "unknown", "null"].includes(q); }).length,
    clickIdentities: clicked.size, cartIdentities: carted.size, attributedCartEvents,
    clickRate: bySession.size ? clicked.size / bySession.size : null,
    cartRate: bySession.size ? carted.size / bySession.size : null,
    daily,
    trackingGapDays: Object.entries(daily).filter(([, d]) => d.searches >= 10 && !d.clicks && !d.carts).map(([day]) => day),
    terms: [...terms.values()].map(r => ({ ...r, identities: r.identities.size, clickIdentities: r.clickIdentities.size, cartIdentities: r.cartIdentities.size })).sort((a, b) => b.searches - a.searches),
  };
}

export async function searchReport(dbName: string, days = 7, end = new Date()) {
  const db = await tenantDb(dbName), start = new Date(+end - days * 86400_000), previousStart = new Date(+start - days * 86400_000);
  const limit = 100_000;
  const [queries, clicks, carts, checkoutEvents] = await Promise.all([
    db.collection("queries").find(dateRange(previousStart, end)).project({ query: 1, timestamp: 1, session_id: 1, sessionId: 1, deliveredProducts: 1, zero_results: 1 }).limit(limit + 1).maxTimeMS(60000).toArray(),
    db.collection("product_clicks").find(dateRange(previousStart, end)).project({ search_query: 1, timestamp: 1, session_id: 1, sessionId: 1 }).limit(limit + 1).maxTimeMS(60000).toArray(),
    db.collection("cart").find(dateRange(previousStart, end)).project({ search_query: 1, timestamp: 1, session_id: 1, sessionId: 1 }).limit(limit + 1).maxTimeMS(60000).toArray(),
    db.collection("checkout_events").countDocuments(dateRange(start, end), { maxTimeMS: 60000 }),
  ]);
  if ([queries, clicks, carts].some(rows => rows.length > limit)) throw new Error("Window exceeds 100,000 events per collection; use a shorter window. No partial report saved.");
  const current = analyzeWindow(queries, clicks, carts, start, end), previous = analyzeWindow(queries, clicks, carts, previousStart, start);
  return { dbName, generatedAt: end, days, current, previous, quality: {
    comparable: !current.trackingGapDays.length && !previous.trackingGapDays.length && Math.abs((current.missingSessionRate ?? 0) - (previous.missingSessionRate ?? 0)) < 0.05,
    checkoutEvents, revenue: null,
    notes: ["Rates use persistent identifiers and same-query actions within 30 minutes, not purchases or distinct visits.", "Tagged event counts are not conversion rates. Results record at most 20 names.", "No bot exclusion; end-of-window searches have incomplete follow-up.", ...(checkoutEvents ? ["Checkout events are not confirmed orders; revenue is unavailable in this report."] : ["No checkout tracking observed; this does not mean no sales."])],
  } };
}
