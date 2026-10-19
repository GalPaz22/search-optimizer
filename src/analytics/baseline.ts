import { Catalog, CatalogProduct } from "./catalog.js";
import { QueryRow, SessionTimeline, uniquePurchases, WINDOWS } from "./conversion.js";
import { StoreEvents } from "./events.js";

/**
 * Production baseline: what the CURRENT search does for real shoppers, from
 * their own behaviour. A query "works" when shoppers clearly chose products
 * from it (carted or bought, or clicked repeatedly with a real share of the
 * query's clicks) — those products are what any change must keep returning.
 * It "fails" when it mostly returns nothing or is never clicked. Chosen
 * products that are now missing or unavailable are catalog gaps (feed/stock),
 * not search failures: no ranking rule can surface a product that is not sold.
 */

export interface ChosenProduct { pid: string; name: string; clicks: number; carts: number; purchases: number; inCatalog: boolean; available: boolean; hidden: boolean; catalogId: string | null; stockStatus: string | null }
export interface BaselineQuery {
  query: string; searches: number; zeroRate: number | null; clicks: number; carts: number; purchases: number;
  production: "works" | "fails" | "unclear"; status: "works" | "gap" | "fails" | "unclear";
  targets: ChosenProduct[]; unavailable: ChosenProduct[]; delivered: string[];
}

type Tally = { pid: string; name: string; url: string; clicks: number; carts: number; purchases: number };

export function chosenProducts(ev: StoreEvents): Map<string, Map<string, Tally>> {
  const tl = new SessionTimeline(ev.queries), out = new Map<string, Map<string, Tally>>();
  const add = (q: string, e: { pid: string; name: string; url?: string }, kind: "clicks" | "carts" | "purchases") => {
    const key = e.pid || e.name;
    if (!q || !key) return;
    if (!out.has(q)) out.set(q, new Map());
    const m = out.get(q)!, row = m.get(key) ?? { pid: e.pid, name: e.name, url: e.url ?? "", clicks: 0, carts: 0, purchases: 0 };
    row[kind]++; if (!row.name && e.name) row.name = e.name;
    m.set(key, row);
  };
  for (const c of ev.clicks) add(c.q || tl.preceding(c.s, c.t, WINDOWS.click)?.q || "", c, "clicks");
  for (const c of ev.carts) add(c.q || tl.preceding(c.s, c.t, WINDOWS.cart)?.q || "", c, "carts");
  for (const o of uniquePurchases(ev.purchases).list) {
    const q = o.q || tl.preceding(o.s, o.t, WINDOWS.purchase)?.q || "";
    for (const i of o.items) add(q, i, "purchases");
  }
  return out;
}

const resolve = (t: Tally, catalog: Catalog | null): ChosenProduct => {
  const p: CatalogProduct | null = catalog?.match(t) ?? null;
  return { pid: t.pid, name: p?.name || t.name, clicks: t.clicks, carts: t.carts, purchases: t.purchases, inCatalog: !!p, available: !!p?.available, hidden: !!p?.hidden, catalogId: p?._id ?? null, stockStatus: p?.stockStatus ?? null };
};

/**
 * Share of chosen-product events whose product resolves to a catalog document.
 * When plugins log ids the catalog does not carry, an unmatched product is
 * "unknown", not "missing": gaps are then only claimed for products that are
 * in the catalog and unavailable.
 */
export function catalogMatchRate(chosen: Map<string, Map<string, Tally>>, catalog: Catalog | null) {
  if (!catalog) return null;
  let matched = 0, total = 0;
  for (const m of chosen.values()) for (const t of m.values()) { const w = t.clicks + t.carts + t.purchases; total += w; if (catalog.match(t)) matched += w; }
  return total ? matched / total : null;
}

export function buildBaseline(ev: StoreEvents, rows: QueryRow[], catalog: Catalog | null, { minSearches = 3, limit = 400 } = {}) {
  const chosen = chosenProducts(ev), out: BaselineQuery[] = [];
  const matchRate = catalogMatchRate(chosen, catalog), reliable = matchRate !== null && matchRate >= 0.9;
  const unavailable = (p: ChosenProduct) => (p.inCatalog ? !p.available : reliable);
  for (const r of rows) {
    const volume = Math.max(r.searches, r.clicks);
    if (volume < minSearches) continue;
    const tallies = [...(chosen.get(r.query)?.values() ?? [])];
    const totalClicks = tallies.reduce((s, t) => s + t.clicks, 0);
    const picked = tallies
      .filter(t => (t.carts > 0 || t.purchases > 0 || t.clicks >= 3) && (t.carts > 0 || t.purchases > 0 || !totalClicks || t.clicks / totalClicks >= 0.1))
      .sort((a, b) => b.purchases - a.purchases || b.carts - a.carts || b.clicks - a.clicks).slice(0, 8)
      .map(t => resolve(t, catalog));
    const production = picked.length ? "works" : (r.zeroRate ?? 0) >= 0.5 || (r.searches >= 5 && !totalClicks) ? "fails" : "unclear";
    const targets = catalog ? picked.filter(p => !unavailable(p)) : picked, gone = catalog ? picked.filter(unavailable) : [];
    out.push({
      query: r.query, searches: r.searches, zeroRate: r.zeroRate, clicks: r.clicks, carts: r.carts, purchases: r.purchases, production,
      status: production === "works" && !targets.length ? "gap" : production, targets, unavailable: gone, delivered: r.delivered,
    });
  }
  out.sort((a, b) => b.searches - a.searches || b.clicks - a.clicks);
  const weight = (f: (q: BaselineQuery) => boolean) => out.filter(f).reduce((s, q) => s + q.searches, 0);
  return {
    queries: out.slice(0, limit),
    catalogMatchRate: matchRate,
    summary: {
      queries: out.length, works: out.filter(q => q.status === "works").length, gaps: out.filter(q => q.status === "gap").length,
      fails: out.filter(q => q.status === "fails").length, unclear: out.filter(q => q.status === "unclear").length,
      searchesWorking: weight(q => q.status === "works"), searchesFailing: weight(q => q.status === "fails"), searchesInGaps: weight(q => q.status === "gap"),
      partialGaps: out.filter(q => q.status === "works" && q.unavailable.length).length,
    },
  };
}
export type Baseline = ReturnType<typeof buildBaseline>;
