import test from "node:test";
import assert from "node:assert/strict";
import { isPurchase, orderTotal, parseTime, StoreEvents, toProductEvent, toPurchaseEvent, toQueryEvent } from "../src/analytics/events.js";
import { classifyLeaks, queryFunnel, rankQueries, storeFunnel, suspectedSynthetic, uniquePurchases } from "../src/analytics/conversion.js";
import { dailyActivity } from "../src/analytics/activity.js";
import { buildCatalog, urlTail } from "../src/analytics/catalog.js";
import { buildBaseline } from "../src/analytics/baseline.js";
import { auditCandidates, queryEvidence } from "../src/analytics/evidence.js";
import { trackingIssues } from "../src/analytics/report.js";
import { guardSearchChange, matchesTargeting } from "../src/agent/guards.js";

const T0 = Date.parse("2026-09-10T10:00:00Z"), min = 60_000;
const at = (m: number) => new Date(T0 + m * min).toISOString();
const events = (raw: { queries?: any[]; clicks?: any[]; carts?: any[]; checkout?: any[] }): StoreEvents => {
  const checkout = raw.checkout ?? [];
  return {
    dbName: "t", from: T0 - 86400_000, to: T0 + 7 * 86400_000,
    queries: (raw.queries ?? []).map(toQueryEvent).filter((e): e is NonNullable<typeof e> => !!e),
    clicks: (raw.clicks ?? []).map(toProductEvent).filter((e): e is NonNullable<typeof e> => !!e),
    carts: (raw.carts ?? []).map(toProductEvent).filter((e): e is NonNullable<typeof e> => !!e),
    checkouts: checkout.filter(r => r.event_type === "checkout_initiated").map(r => ({ q: "", s: r.session_id ?? null, t: parseTime(r.timestamp)! })),
    purchases: checkout.map(toPurchaseEvent).filter((e): e is NonNullable<typeof e> => !!e),
    sources: { queries: { status: "ok", rows: 0, truncated: false }, product_clicks: { status: "ok", rows: 0, truncated: false }, cart: { status: "ok", rows: 0, truncated: false }, checkout_events: { status: checkout.length ? "ok" : "missing", rows: 0, truncated: false } },
  };
};

test("timestamps in every shape tenants log", () => {
  assert.equal(parseTime(new Date(T0)), T0);
  assert.equal(parseTime("2026-09-10T10:00:00Z"), T0);
  assert.equal(parseTime("2026-09-10T10:00:00+00:00"), T0);
  assert.equal(parseTime(T0 / 1000), T0, "unix seconds (wineRoute) are not milliseconds");
  assert.equal(parseTime(T0), T0);
  assert.equal(parseTime(String(T0 / 1000)), T0);
  assert.equal(parseTime("not a date"), null);
});

test("only checkout_completed is a purchase; totals come from whichever field the plugin writes", () => {
  assert.equal(isPurchase({ event_type: "checkout_initiated", cart_total: 100 }), false);
  assert.equal(isPurchase({ event_type: "checkout_completed", order_id: 1 }), true);
  assert.equal(isPurchase({ order_id: 7, line_items: [], financial_status: "refunded" }), false);
  assert.equal(isPurchase({ order_id: 7, line_items: [], financial_status: "paid" }), true);
  assert.equal(orderTotal({ order_total: 614 }), 614);
  assert.equal(orderTotal({ cart_total: "679.20" }), 679.2);
  assert.equal(orderTotal({ orderData: { total_price: "1,250.50" } }), 1250.5);
  const { list, duplicates } = uniquePurchases([toPurchaseEvent({ event_type: "checkout_completed", order_id: 9, order_total: 5, timestamp: at(0) })!, toPurchaseEvent({ event_type: "checkout_completed", order_id: 9, order_total: 5, timestamp: at(1) })!]);
  assert.equal(list.length, 1);
  assert.equal(duplicates, 1);
});

test("per-query conversion: explicit and inferred attribution, distinct sessions, started checkouts excluded", () => {
  const ev = events({
    queries: [
      { query: "Red Wine ", session_id: "a", timestamp: at(0), deliveredProducts: ["x"] },
      { query: "red wine", session_id: "a", timestamp: at(1), deliveredProducts: ["x"] }, // repeat in one session counts once
      { query: "red wine", session_id: "b", timestamp: at(0), deliveredProducts: ["x"] },
      { query: "gin", session_id: "c", timestamp: at(0), deliveredProducts: [] },
    ],
    clicks: [{ session_id: "a", product_id: "1", timestamp: at(3) }, { search_query: "red wine", session_id: "b", product_id: "1", timestamp: at(2) }],
    carts: [{ event_type: "add_to_cart", session_id: "a", product_id: "1", timestamp: at(10) }],
    checkout: [
      { event_type: "checkout_initiated", session_id: "b", cart_total: 90, timestamp: at(20) },
      { event_type: "checkout_completed", session_id: "a", order_id: "o1", order_total: 120, currency: "ILS", items: [{ product_id: "1", quantity: 1 }], timestamp: at(60) },
    ],
  });
  const rows = queryFunnel(ev), wine = rows.find(r => r.query === "red wine")!, gin = rows.find(r => r.query === "gin")!;
  assert.equal(wine.searches, 3);
  assert.equal(wine.searchSessions, 2);
  assert.equal(wine.clickSessions, 2, "session a inferred, session b explicit");
  assert.equal(wine.purchases, 1);
  assert.equal(wine.inferredPurchases, 1);
  assert.equal(wine.purchaseRate, 0.5, "b only started checkout");
  assert.deepEqual(wine.attributedRevenue, [{ currency: "ILS", amount: 120, orders: 1 }]);
  assert.equal(gin.zeroRate, 1);
  const f = storeFunnel(ev);
  assert.deepEqual(f.sessions, { all: 3, searched: 3, clicked: 2, carted: 1, checkout: 1, purchased: 1 });
  assert.equal(f.orders.searchAssisted, 1);
  assert.equal(f.coverage.purchaseTracking, true);
});

test("a click long after the search is not attributed to it; missing sessions add counts, never rates", () => {
  const ev = events({
    queries: [{ query: "kindle", session_id: "a", timestamp: at(0) }, { query: "kindle", timestamp: at(0) }],
    clicks: [{ session_id: "a", product_id: "1", timestamp: at(90) }],
  });
  const row = queryFunnel(ev).find(r => r.query === "kindle")!;
  assert.equal(row.clicks, 0);
  assert.equal(row.missingSession, 1);
  assert.equal(row.searchSessions, 1);
  assert.equal(row.purchaseRate, null, "no purchase tracking means unknown, not zero");
});

test("leak stages are judged against the store's own funnel; automated queries are detected", () => {
  const queries: any[] = [], clicks: any[] = [];
  for (let i = 0; i < 40; i++) {
    queries.push({ query: "good", session_id: `g${i}`, timestamp: at(0), deliveredProducts: ["p"] });
    if (i < 20) clicks.push({ search_query: "good", session_id: `g${i}`, product_id: "1", timestamp: at(1) });
    queries.push({ query: "ignored", session_id: `i${i}`, timestamp: at(0), deliveredProducts: ["p"] });
    if (i < 1) clicks.push({ search_query: "ignored", session_id: `i${i}`, product_id: "1", timestamp: at(1) });
  }
  for (let i = 0; i < 300; i++) queries.push({ query: "top it", session_id: `bot${i}`, timestamp: at(0), deliveredProducts: ["p"] });
  const ev = events({ queries, clicks });
  const raw = queryFunnel(ev);
  assert.deepEqual(suspectedSynthetic(raw, 380), ["top it"]);
  const rows = classifyLeaks(raw.filter(r => r.query !== "top it"), storeFunnel({ ...ev, queries: ev.queries.filter(q => q.q !== "top it") }));
  assert.equal(rows.find(r => r.query === "ignored")!.leakStage, "no_click");
  assert.equal(rows.find(r => r.query === "good")!.leakStage, "healthy");
  assert.equal(rankQueries(rows, { sort: "opportunity" }).rows[0].query, "ignored");
});

test("catalog matching understands woo, shopify and slug ids and URL tails", () => {
  const catalog = buildCatalog([
    { _id: "a1", id: 198917, name: "Top Coat", stockStatus: "instock", url: "https://s.co/?post_type=product&p=198917" },
    { _id: "a2", id: "gid://shopify/Product/42", name: "Ring", stockStatus: "outofstock", handle: "dainty-ring" },
    { _id: "a3", id: 5, name: "Hidden Watch", stockStatus: "instock", hidden: true, slug: "venu-4-bone" },
  ]);
  assert.equal(catalog.match({ pid: "woo_product_198917" })?._id, "a1");
  assert.equal(catalog.match({ pid: "gid://shopify/Product/42" })?._id, "a2");
  assert.equal(catalog.match({ pid: "venu-4-bone" })?.hidden, true);
  assert.equal(catalog.match({ pid: "---", name: "top coat" })?._id, "a1");
  assert.equal(urlTail("https://www.steimatzky.co.il/017410014"), "017410014");
  assert.equal(catalog.available, 1);
});

test("baseline: chosen products define working queries; unavailable choices are catalog gaps, and the audit says so", () => {
  const catalog = buildCatalog([{ _id: "d1", id: 1, name: "In stock", stockStatus: "instock" }, { _id: "d2", id: 2, name: "Sold out", stockStatus: "outofstock" }]);
  const queries: any[] = [], carts: any[] = [];
  for (let i = 0; i < 6; i++) {
    queries.push({ query: "works", session_id: `w${i}`, timestamp: at(0), deliveredProducts: ["In stock"] });
    carts.push({ search_query: "works", session_id: `w${i}`, product_id: "1", timestamp: at(2) });
    queries.push({ query: "gone", session_id: `g${i}`, timestamp: at(0), deliveredProducts: ["x"] });
    carts.push({ search_query: "gone", session_id: `g${i}`, product_id: "2", timestamp: at(2) });
    queries.push({ query: "nothing", session_id: `n${i}`, timestamp: at(0), deliveredProducts: [] });
  }
  const ev = events({ queries, carts }), rows = classifyLeaks(queryFunnel(ev), storeFunnel(ev));
  const b = buildBaseline(ev, rows, catalog), by = new Map(b.queries.map(q => [q.query, q]));
  assert.equal(b.catalogMatchRate, 1);
  assert.equal(by.get("works")!.status, "works");
  assert.equal(by.get("gone")!.status, "gap");
  assert.equal(by.get("nothing")!.status, "fails");
  const audit = auditCandidates(rows, b);
  assert.equal(audit.find(a => a.query === "gone")!.classification, "catalog_gap");
  assert.ok(audit.find(a => a.query === "gone")!.unavailableChosen[0].includes("אזל מהמלאי"));
  const e = queryEvidence(ev, rows, catalog, "Gone");
  assert.equal(e.catalogGapShare, 1);
  assert.equal(e.chosenProducts[0].catalogDocumentId, "d2");
});

test("unmatched product ids are unknown, not missing, when the catalog match rate is low", () => {
  const catalog = buildCatalog([{ _id: "d1", id: 1, name: "Known", stockStatus: "instock" }]);
  const queries: any[] = [], carts: any[] = [];
  for (let i = 0; i < 6; i++) {
    queries.push({ query: "books", session_id: `b${i}`, timestamp: at(0) });
    carts.push({ search_query: "books", session_id: `b${i}`, product_id: `unknown-${i % 2}`, timestamp: at(2) });
  }
  const ev = events({ queries, carts }), rows = queryFunnel(ev), b = buildBaseline(ev, rows, catalog);
  assert.equal(b.catalogMatchRate, 0);
  assert.equal(b.queries[0].status, "works");
  assert.equal(b.queries[0].unavailable.length, 0);
});

test("tracking issues name the blockers: missing session ids, no purchase tracking, logging gaps", () => {
  const queries: any[] = [], clicks: any[] = [];
  for (let i = 0; i < 40; i++) queries.push({ query: `q${i % 4}`, timestamp: at(i), ...(i < 2 ? { session_id: `s${i}` } : {}) });
  for (let i = 0; i < 10; i++) clicks.push({ session_id: `x${i}`, product_id: "1", timestamp: new Date(T0 + 3 * 86400_000 + i).toISOString() });
  const ev = events({ queries, clicks, carts: [{ session_id: "x1", product_id: "1", timestamp: at(5) }] });
  const f = storeFunnel(ev), codes = trackingIssues(ev, f, dailyActivity(ev), [{ id: "e", name: "Pin", targeting: "all", exposures: 1, startedAt: at(0) }]).map(i => i.code);
  assert.ok(codes.includes("queries_missing_session"));
  assert.ok(codes.includes("no_purchase_tracking"));
  assert.ok(codes.includes("search_log_gap"));
});

test("guards: targeting match, and a working query touched by a change is reported with what to keep", async () => {
  assert.equal(matchesTargeting({ mode: "queryMatch", patterns: ["משקל"], matchType: "contains" }, "משקל חכם"), true);
  assert.equal(matchesTargeting({ mode: "queryMatch", patterns: ["gin"], matchType: "exact" }, "gin tonic"), false);
  const baseline = { catalogMatchRate: 1, summary: {} as any, queries: [{ query: "red wine", searches: 50, status: "works", targets: [{ name: "Merlot" }], unavailable: [] }] } as any;
  const r = await guardSearchChange({ dbName: "unused", targeting: { mode: "queryMatch", patterns: ["wine"], matchType: "contains" }, patch: {}, catalog: null, baseline });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.protectedQueries, [{ query: "red wine", searches: 50, keep: ["Merlot"] }]);
});

test("the agent's report may only cite queries it actually saw in the store's data", async () => {
  const { ReportInput, validateReport } = await import("../src/agent/tools/report.js");
  const { createRunContext, rememberQueries } = await import("../src/agent/context.js");
  const ctx = createRunContext({ apiKey: "k", dbName: "t" }, "000000000000000000000000", null);
  rememberQueries(ctx, ["Red Wine"]);
  const proposal = { kind: "rule", title: "Pin merlot", evidence: "40 sessions, 0 clicks on red wine", change: "Pin two in-stock merlots", expectedImpact: "More clicks (hypothesis)", metric: "click rate", validation: "Compare 14 days; disable rule to roll back", risk: "Could hide other wines", priority: 1 };
  const base = { summary: "סיכום ".repeat(20), findings: [], limitations: [] };
  assert.deepEqual(await validateReport(ctx, ReportInput.parse({ ...base, proposals: [{ ...proposal, queries: ["red wine"] }] })), []);
  const problems = await validateReport(ctx, ReportInput.parse({ ...base, proposals: [{ ...proposal, queries: ["invented query"] }] }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never saw/);
});

test("purchase-stage leaks are not claimed when most orders carry no session id", () => {
  const queries: any[] = [], carts: any[] = [], checkout: any[] = [];
  for (let i = 0; i < 10; i++) {
    queries.push({ query: "hard base", session_id: `h${i}`, timestamp: at(0), deliveredProducts: ["p"] });
    carts.push({ search_query: "hard base", session_id: `h${i}`, product_id: "1", timestamp: at(2) });
    // Real purchases, tagged with the query but logged without the shopper's session.
    checkout.push({ event_type: "checkout_completed", order_id: `o${i}`, order_total: 100, search_query: "hard base", timestamp: at(30) });
  }
  const ev = events({ queries, carts, checkout }), f = storeFunnel(ev);
  const row = classifyLeaks(queryFunnel(ev), f).find(r => r.query === "hard base")!;
  assert.equal(row.purchases, 10);
  assert.equal(row.purchaseRate, 0, "no session-matched purchases");
  assert.notEqual(row.leakStage, "cart_no_purchase");
});

test('daily purchase counts and funnel order totals use the same deduplicated orders', () => {
  const ev = events({ checkout: [
    { event_type: 'checkout_completed', order_id: 'same', order_total: 100, timestamp: at(5) },
    { event_type: 'checkout_completed', order_id: 'same', order_total: 100, timestamp: at(6) },
    { event_type: 'checkout_completed', order_id: 'other', order_total: 20, timestamp: at(7) },
  ] });
  assert.equal(dailyActivity(ev).perDay.reduce((n, day) => n + day.purchases, 0), 2);
  assert.equal(storeFunnel(ev).orders.total, 2);
});

test('unavailable analytics sources are surfaced independently of event volume', () => {
  const ev = events({}); ev.sources.queries.status = 'unavailable';
  const issues = trackingIssues(ev, storeFunnel(ev), dailyActivity(ev));
  assert.ok(issues.some(issue => issue.code === 'source_queries' && issue.severity === 'critical'));
  assert.ok(issues.some(issue => issue.code === 'source_checkout_events'));
});

test('chat and reports suppress rates when search session coverage is incomplete', async () => {
  const { measuredConversion } = await import('../src/analytics/measurement.js');
  const ev = events({ queries: Array.from({length: 10}, (_, i) => ({ query: 'watch', timestamp: at(0), ...(i < 4 ? { session_id: `s${i}` } : {}) })), clicks: [{ session_id: 's0', search_query: 'watch', timestamp: at(1) }] });
  const raw = queryFunnel(ev), result = measuredConversion(ev, storeFunnel(ev), raw);
  assert.equal(raw[0].clickRate, 0.25); assert.equal(result.rows[0].clickRate, null);
  assert.equal(result.funnel.rates.click, null); assert.equal(result.rows[0].clicks, 1);
  assert.equal(result.funnel.cartSessionsPurchaseRate.withSearch, null);
  assert.equal(result.funnel.cartSessionsPurchaseRate.withoutSearch, null);
  assert.equal(classifyLeaks(result.rows, result.funnel)[0].leakStage, 'unmeasured');
});

test('per-query missing identifiers suppress only that query even with adequate store coverage', async () => {
  const { measuredConversion } = await import('../src/analytics/measurement.js');
  const ev = events({ queries: [
    ...Array.from({length: 20}, (_, i) => ({ query: 'good', timestamp: at(0), session_id: `s${i}` })),
    ...Array.from({length: 3}, () => ({ query: 'unknown', timestamp: at(0) })),
  ] });
  const result = measuredConversion(ev, storeFunnel(ev), queryFunnel(ev));
  assert.equal(result.rows.find(r => r.query === 'good')!.clickRate, 0);
  assert.equal(result.rows.find(r => r.query === 'unknown')!.clickRate, null);
  ev.sources.product_clicks.truncated = true;
  assert.equal(measuredConversion(ev, storeFunnel(ev), queryFunnel(ev)).funnel.rates.click, null);
});
