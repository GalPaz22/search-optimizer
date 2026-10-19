import test from "node:test";
import assert from "node:assert/strict";
import { longTail, rankWeeklyQueries, suggestForQuery } from "../src/optimization/weekly.js";
import { buildCatalog } from "../src/analytics/catalog.js";

const row = (query: string, sessions: number, clicked: number, carted: number, extra: Record<string, unknown> = {}): any => ({
  query, searches: sessions, searchSessions: sessions, clickSessions: clicked, cartSessions: carted, zeroSearches: 0, measuredSearches: sessions,
  clickRate: sessions ? clicked / sessions : null, cartRate: sessions ? carted / sessions : null, zeroRate: 0, delivered: ["a", "b", "c"], ...extra,
});
const product = (over: Record<string, unknown>): any => ({ pid: "1", name: "p", clicks: 0, carts: 0, purchases: 0, inCatalog: true, available: true, hidden: false, catalogId: "c1", stockStatus: "instock", ...over });
const bq = (over: Record<string, unknown>): any => ({ query: "q", searches: 10, zeroRate: 0, clicks: 0, carts: 0, purchases: 0, production: "works", status: "works", targets: [], unavailable: [], delivered: [], ...over });
const baseline = (queries: any[]): any => ({ queries, catalogMatchRate: 1, summary: {} });
const store = { click: 0.5, cart: 0.2 };

test("ranks by lost clicks and carts, not by volume; healthy demand is not listed", () => {
  const ranked = rankWeeklyQueries([row("healthy", 400, 220, 90), row("weak", 60, 6, 0), row("tiny", 4, 0, 0), row("once", 1, 0, 0)], store, null);
  assert.ok(!ranked.some(q => q.query === "once"), "single-session queries go to the long-tail summary");
  assert.equal(ranked[0].query, "weak");
  assert.ok(ranked[0].issues.includes("low_click"));
  assert.ok(!ranked.some(q => q.query === "healthy"));
  const tiny = ranked.find(q => q.query === "tiny")!;
  assert.ok(tiny.score < ranked[0].score / 5, "shrinkage keeps tiny samples low");
  assert.ok(tiny.issues.includes("small_sample"));
});

test("long tail counts one-off queries that returned nothing or got no engagement", () => {
  const tail = longTail([row("a", 1, 0, 0), row("b", 1, 1, 0), row("c", 1, 0, 0, { zeroSearches: 1, zeroRate: 1 }), row("big", 30, 3, 1)]);
  assert.equal(tail.queries, 3);
  assert.equal(tail.zeroResults, 1);
  assert.equal(tail.noEngagement, 1);
  assert.deepEqual(tail.noEngagementExamples, ["a"]);
});

test("clicks without carts surface as a separate problem", () => {
  const [q] = rankWeeklyQueries([row("browse", 50, 30, 1)], store, null);
  assert.ok(q.issues.includes("click_no_cart"));
});

test("zero-result searches count in full", () => {
  const [q] = rankWeeklyQueries([row("nothing", 20, 0, 0, { zeroSearches: 20, zeroRate: 1 })], store, null);
  assert.ok(q.issues.includes("zero_results"));
  assert.ok(q.score >= 20);
});

test("promotes products shoppers chose that sit below the top results", () => {
  const b = baseline([bq({ query: "watch", targets: [product({ name: "a", carts: 4 }), product({ name: "buried", carts: 3, catalogId: "c2" }), product({ name: "oos", carts: 5, available: false, catalogId: "c3" })] })]);
  const [q] = rankWeeklyQueries([row("watch", 30, 5, 1)], store, b);
  const s = suggestForQuery(q, b, null);
  const promote = s.find(x => x.kind === "promote_chosen")!;
  assert.deepEqual(promote.products.map(p => p.catalogId), ["c2"]);
  assert.equal(promote.mode, "experiment");
});

test("a failing query borrows choices from a related working query", () => {
  const b = baseline([bq({ query: "fenix", status: "fails", production: "fails" }), bq({ query: "fenix 8", carts: 9, targets: [product({ name: "Fenix 8 47mm", carts: 6, catalogId: "f8" })] })]);
  const [q] = rankWeeklyQueries([row("fenix", 12, 0, 0, { zeroSearches: 8, zeroRate: 0.67 })], store, b);
  const s = suggestForQuery(q, b, null);
  const borrow = s.find(x => x.kind === "borrow_related")!;
  assert.equal(borrow.relatedQuery, "fenix 8");
  assert.equal(borrow.mode, "rule");
  assert.deepEqual(borrow.products.map(p => p.catalogId), ["f8"]);
});

test("borrowed products must name the failing query", () => {
  const b = baseline([bq({ query: "sauvignon", status: "fails" }), bq({ query: "villa maria sauvignon", carts: 5, targets: [product({ name: "Rose Grenache", carts: 2, catalogId: "r" })] })]);
  const [q] = rankWeeklyQueries([row("sauvignon", 10, 0, 0, { zeroSearches: 6, zeroRate: 0.6 })], store, b);
  assert.ok(!suggestForQuery(q, b, null).some(x => x.kind === "borrow_related"));
});

test("related choices sharing a soft category become a category association", () => {
  const catalog = buildCatalog(["1", "2", "3"].map(id => ({ _id: `m${id}`, id, name: `wine ${id}`, stockStatus: "instock", softCategory: ["red wine"] })));
  const targets = ["1", "2", "3"].map(id => product({ pid: id, name: `wine ${id}`, carts: 2, catalogId: `m${id}` }));
  const b = baseline([bq({ query: "red", status: "fails" }), bq({ query: "red wine", carts: 6, targets })]);
  const [q] = rankWeeklyQueries([row("red", 15, 0, 0, { zeroSearches: 10, zeroRate: 0.67 })], store, b);
  const assoc = suggestForQuery(q, b, catalog).find(x => x.kind === "category_association")!;
  assert.equal(assoc.softCategory, "red wine");
});

test("chosen products that are out of stock produce a restock action", () => {
  const b = baseline([bq({ query: "strap", unavailable: [product({ name: "strap x", carts: 3, available: false, stockStatus: "outofstock" })] })]);
  const [q] = rankWeeklyQueries([row("strap", 20, 2, 0)], store, b);
  assert.ok(q.issues.includes("catalog_gap"));
  assert.ok(suggestForQuery(q, b, null).some(x => x.kind === "restock" && x.mode === "action"));
});
