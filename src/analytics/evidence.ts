import { Baseline, chosenProducts } from "./baseline.js";
import { Catalog } from "./catalog.js";
import { QueryRow } from "./conversion.js";
import { normalizeQuery, StoreEvents } from "./events.js";

/** Why a product shoppers chose cannot be shown, in the merchant's language. */
export const availabilityLabel = (p: { inCatalog: boolean; hidden: boolean; stockStatus: string | null }) =>
  !p.inCatalog ? "לא בקטלוג" : p.hidden ? "מוסתר מהחיפוש" : p.stockStatus === "outofstock" ? "אזל מהמלאי" : `לא זמין (${p.stockStatus ?? "ללא סטטוס מלאי"})`;

export type AuditReason = "zero_results" | "no_click" | "click_no_cart" | "cart_no_purchase" | "production_fails" | "catalog_gap" | "top";
export interface AuditCandidate {
  query: string; reasons: AuditReason[]; searches: number; searchSessions: number;
  zeroRate: number | null; clickRate: number | null; cartRate: number | null; purchaseRate: number | null;
  sessionsBelowAverage: number; classification: "search_problem" | "catalog_gap" | "unmeasured";
  delivered: string[]; unavailableChosen: string[];
}

/**
 * The queries worth a diagnosis first, interleaved so one failure mode cannot
 * crowd out the others: zero results, searched-but-never-clicked, funnel leaks
 * sized by sessions below the store average, production failures, catalog gaps,
 * then the most searched. A query whose shoppers mostly want unavailable
 * products is classified a catalog gap: fix the feed or stock, not the ranking.
 */
export function auditCandidates(rows: QueryRow[], baseline: Baseline | null, { limit = 12 } = {}): AuditCandidate[] {
  const byQuery = new Map((baseline?.queries ?? []).map(b => [b.query, b]));
  const bySearches = (a: QueryRow, b: QueryRow) => b.searches - a.searches;
  const lists: [AuditReason, QueryRow[]][] = [
    ["zero_results", rows.filter(r => r.leakStage === "zero_results").sort(bySearches)],
    ["no_click", rows.filter(r => r.leakStage === "no_click" || (r.searchSessions >= 5 && r.clicks === 0 && (r.zeroRate ?? 0) < 0.5)).sort((a, b) => b.searchSessions - a.searchSessions)],
    ["click_no_cart", rows.filter(r => r.leakStage === "click_no_cart").sort((a, b) => (b.sessionsBelowAverage ?? 0) - (a.sessionsBelowAverage ?? 0))],
    ["cart_no_purchase", rows.filter(r => r.leakStage === "cart_no_purchase").sort((a, b) => (b.sessionsBelowAverage ?? 0) - (a.sessionsBelowAverage ?? 0))],
    ["production_fails", rows.filter(r => byQuery.get(r.query)?.status === "fails").sort(bySearches)],
    ["catalog_gap", rows.filter(r => byQuery.get(r.query)?.status === "gap" || !!byQuery.get(r.query)?.unavailable.length).sort(bySearches)],
    ["top", [...rows].sort(bySearches)],
  ];
  const picked = new Map<string, AuditCandidate>();
  for (let i = 0; picked.size < limit && lists.some(([, l]) => i < l.length); i++) {
    for (const [reason, list] of lists) {
      const r = list[i];
      if (!r) continue;
      const existing = picked.get(r.query);
      if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); continue; }
      if (picked.size >= limit) continue;
      const b = byQuery.get(r.query);
      const unavailableClicks = (b?.unavailable ?? []).reduce((s, p) => s + p.clicks + p.carts, 0), chosenClicks = unavailableClicks + (b?.targets ?? []).reduce((s, p) => s + p.clicks + p.carts, 0);
      picked.set(r.query, {
        query: r.query, reasons: [reason], searches: r.searches, searchSessions: r.searchSessions, zeroRate: r.zeroRate, clickRate: r.clickRate, cartRate: r.cartRate, purchaseRate: r.purchaseRate,
        sessionsBelowAverage: r.sessionsBelowAverage ?? 0,
        classification: b?.status === "gap" || (chosenClicks > 0 && unavailableClicks / chosenClicks >= 0.6) ? "catalog_gap" : r.searchSessions < 5 && reason !== "zero_results" ? "unmeasured" : "search_problem",
        delivered: r.delivered.slice(0, 5), unavailableChosen: (b?.unavailable ?? []).slice(0, 5).map(p => `${p.name} (${availabilityLabel(p)})`),
      });
    }
  }
  return [...picked.values()];
}

/** Everything known about one query: funnel, what the search showed, what shoppers chose, availability. */
export function queryEvidence(ev: StoreEvents, rows: QueryRow[], catalog: Catalog | null, query: string) {
  const q = normalizeQuery(query), row = rows.find(r => r.query === q) ?? null;
  const shown = new Map<string, { list: string[]; searches: number }>();
  const perDay = new Map<string, number>();
  for (const e of ev.queries) {
    if (e.q !== q) continue;
    const day = new Date(e.t).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (!e.names.length) continue;
    const key = JSON.stringify(e.names.slice(0, 5));
    shown.set(key, { list: e.names.slice(0, 8), searches: (shown.get(key)?.searches ?? 0) + 1 });
  }
  const chosen = [...(chosenProducts(ev).get(q)?.values() ?? [])].sort((a, b) => b.purchases - a.purchases || b.carts - a.carts || b.clicks - a.clicks).slice(0, 15).map(t => {
    const p = catalog?.match(t) ?? null;
    return { name: p?.name || t.name, pid: t.pid, clicks: t.clicks, carts: t.carts, purchases: t.purchases, inCatalog: !!p, available: !!p?.available, hidden: !!p?.hidden, stockStatus: p?.stockStatus ?? null, catalogDocumentId: p?._id ?? null, category: p?.category.slice(0, 4) ?? [], softCategory: p?.softCategory.slice(0, 6) ?? [] };
  });
  const related = rows.filter(r => r.query !== q && (r.query.includes(q) || q.includes(r.query))).sort((a, b) => b.searches - a.searches).slice(0, 8)
    .map(r => ({ query: r.query, searches: r.searches, clickRate: r.clickRate, purchaseRate: r.purchaseRate, zeroRate: r.zeroRate }));
  const unavailable = chosen.filter(c => !c.available).reduce((s, c) => s + c.clicks + c.carts, 0), total = chosen.reduce((s, c) => s + c.clicks + c.carts, 0);
  return {
    query: q, funnel: row, searchesPerDay: Object.fromEntries([...perDay].sort()),
    resultsShown: [...shown.values()].sort((a, b) => b.searches - a.searches).slice(0, 3),
    chosenProducts: chosen, relatedQueries: related,
    catalogGapShare: total ? Math.round((unavailable / total) * 100) / 100 : null,
    note: "resultsShown comes from the names dashboard-server logged in queries.deliveredProducts (at most 20 per search); chosenProducts are clicks/carts/purchases attributed to this query.",
  };
}
