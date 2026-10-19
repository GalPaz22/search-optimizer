import { DAY_MS, normalizeQuery, ProductEvent, PurchaseEvent, StoreEvents } from "./events.js";

/**
 * Search → click → cart → checkout → purchase, per query and for the store.
 *
 * Attribution: an event carrying its own search_query is "explicit"; otherwise
 * it is "inferred" from the latest search in the same session before it, within
 * a stage-specific window (click 30 min, cart 2 h, checkout/purchase 24 h).
 * Inferred attribution is evidence, not proof. Rates are over DISTINCT search
 * sessions: a session counts as converted for a query only when it searched
 * that query before the event (repeat searches in one session count once).
 * Events whose session never logged a search add to counts, never to rates.
 */

export const WINDOWS = { click: 30 * 60_000, cart: 2 * 3_600_000, checkout: DAY_MS, purchase: DAY_MS } as const;
type Stage = keyof typeof WINDOWS;
type Search = { q: string; t: number };

export class SessionTimeline {
  private bySession = new Map<string, Search[]>();
  private bySessionQuery = new Map<string, Map<string, number[]>>();
  constructor(queries: { q: string; s: string | null; t: number }[]) {
    for (const e of queries) {
      if (!e.s) continue;
      if (!this.bySession.has(e.s)) this.bySession.set(e.s, []);
      this.bySession.get(e.s)!.push({ q: e.q, t: e.t });
    }
    for (const [s, list] of this.bySession) {
      list.sort((a, b) => a.t - b.t);
      const m = new Map<string, number[]>();
      for (const x of list) { if (!m.has(x.q)) m.set(x.q, []); m.get(x.q)!.push(x.t); }
      this.bySessionQuery.set(s, m);
    }
  }
  has(s: string | null) { return !!s && this.bySession.has(s); }
  get sessions() { return this.bySession.size; }
  /** Latest search in the session at or before t, within the window. */
  preceding(s: string | null, t: number, windowMs: number): Search | null {
    const list = s ? this.bySession.get(s) : undefined;
    if (!list) return null;
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].t <= t) lo = mid + 1; else hi = mid; }
    const hit = list[lo - 1];
    return hit && t - hit.t <= windowMs ? hit : null;
  }
  /** Did this session search q before t, within the window? */
  searched(s: string | null, q: string, t: number, windowMs: number): boolean {
    const times = s ? this.bySessionQuery.get(s)?.get(q) : undefined;
    if (!times) return false;
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo > 0 && t - times[lo - 1] <= windowMs;
  }
}

export type Money = { currency: string | null; amount: number; orders: number };
const addMoney = (m: Map<string, Money>, currency: string | null, amount: number | null) => {
  if (amount === null) return;
  const key = currency ?? "—", row = m.get(key) ?? { currency, amount: 0, orders: 0 };
  row.amount += amount; row.orders++; m.set(key, row);
};
const moneyList = (m: Map<string, Money>) => [...m.values()].map(r => ({ ...r, amount: Math.round(r.amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);

/** Orders deduplicated by order id (plugins retry webhooks). */
export function uniquePurchases(purchases: PurchaseEvent[]): { list: PurchaseEvent[]; duplicates: number } {
  const seen = new Set<string>(), list: PurchaseEvent[] = [];
  let duplicates = 0;
  for (const p of [...purchases].sort((a, b) => a.t - b.t)) {
    if (p.orderId) { if (seen.has(p.orderId)) { duplicates++; continue; } seen.add(p.orderId); }
    list.push(p);
  }
  return { list, duplicates };
}

export interface QueryRow {
  query: string; searches: number; searchSessions: number; missingSession: number;
  zeroSearches: number; measuredSearches: number; zeroRate: number | null;
  clicks: number; carts: number; checkouts: number; purchases: number; explicitPurchases: number; inferredPurchases: number;
  clickSessions: number; cartSessions: number; checkoutSessions: number; purchaseSessions: number;
  clickRate: number | null; cartRate: number | null; purchaseRate: number | null;
  attributedRevenue: Money[];
  delivered: string[];
  leakStage?: LeakStage; sessionsBelowAverage?: number;
}
export type LeakStage = "zero_results" | "no_click" | "click_no_cart" | "cart_no_purchase" | "healthy" | "unmeasured";

export interface Funnel {
  sessions: { all: number; searched: number; clicked: number; carted: number; checkout: number; purchased: number };
  rates: { click: number | null; cart: number | null; checkout: number | null; purchase: number | null };
  orders: { total: number; duplicates: number; searchAssisted: number; explicit: number; inferred: number; withSession: number };
  revenue: { total: Money[]; searchAssisted: Money[]; averageOrder: Money[] };
  cartSessionsPurchaseRate: { withSearch: number | null; withoutSearch: number | null; withSearchSessions: number; withoutSearchSessions: number };
  coverage: {
    queries: number; queriesWithSession: number; queriesWithResultCount: number;
    clicks: number; clicksTagged: number; carts: number; cartsTagged: number;
    purchases: number; purchasesTagged: number; purchasesWithSession: number; purchaseTracking: boolean; checkoutTracking: boolean;
    /** Share of purchasing sessions that also appear in click/cart events: low means the checkout uses another session id scheme. */
    purchaseSessionsSeenBefore: number | null;
  };
}

const rate = (n: number, d: number) => (d ? n / d : null);

/** Store-level search funnel over distinct sessions. */
export function storeFunnel(ev: StoreEvents): Funnel {
  const tl = new SessionTimeline(ev.queries), { list: orders, duplicates } = uniquePurchases(ev.purchases);
  const all = new Set<string>();
  for (const list of [ev.queries, ev.clicks, ev.carts, ev.checkouts, orders] as { s: string | null }[][]) for (const e of list) if (e.s) all.add(e.s);
  const reached = (list: { s: string | null; t: number }[], stage: Stage) => {
    const out = new Set<string>();
    for (const e of list) if (e.s && tl.preceding(e.s, e.t, WINDOWS[stage])) out.add(e.s);
    return out;
  };
  const clicked = reached(ev.clicks, "click"), carted = reached(ev.carts, "cart"), checkout = reached(ev.checkouts, "checkout"), purchased = reached(orders, "purchase");
  const total = new Map<string, Money>(), assisted = new Map<string, Money>();
  let searchAssisted = 0, explicit = 0, inferred = 0;
  for (const o of orders) {
    addMoney(total, o.currency, o.total);
    const viaSearch = o.q ? "explicit" : tl.preceding(o.s, o.t, WINDOWS.purchase) ? "inferred" : null;
    if (viaSearch) { searchAssisted++; viaSearch === "explicit" ? explicit++ : inferred++; addMoney(assisted, o.currency, o.total); }
  }
  // Among sessions that reached the cart: did those that searched buy more often?
  const cartSessions = new Set(ev.carts.map(c => c.s).filter((s): s is string => !!s)), buyers = new Set(orders.map(o => o.s).filter(Boolean));
  const withSearch = [...cartSessions].filter(s => tl.has(s)), withoutSearch = [...cartSessions].filter(s => !tl.has(s));
  const searched = tl.sessions;
  return {
    sessions: { all: all.size, searched, clicked: clicked.size, carted: carted.size, checkout: checkout.size, purchased: purchased.size },
    rates: { click: rate(clicked.size, searched), cart: rate(carted.size, searched), checkout: rate(checkout.size, searched), purchase: ev.purchases.length ? rate(purchased.size, searched) : null },
    orders: { total: orders.length, duplicates, searchAssisted, explicit, inferred, withSession: orders.filter(o => o.s).length },
    revenue: {
      total: moneyList(total), searchAssisted: moneyList(assisted),
      averageOrder: moneyList(total).map(m => ({ ...m, amount: m.orders ? Math.round((m.amount / m.orders) * 100) / 100 : 0 })),
    },
    cartSessionsPurchaseRate: {
      withSearch: ev.purchases.length ? rate(withSearch.filter(s => buyers.has(s)).length, withSearch.length) : null,
      withoutSearch: ev.purchases.length ? rate(withoutSearch.filter(s => buyers.has(s)).length, withoutSearch.length) : null,
      withSearchSessions: withSearch.length, withoutSearchSessions: withoutSearch.length,
    },
    coverage: {
      queries: ev.queries.length, queriesWithSession: ev.queries.filter(q => q.s).length, queriesWithResultCount: ev.queries.filter(q => q.zero !== null).length,
      clicks: ev.clicks.length, clicksTagged: ev.clicks.filter(c => c.q).length, carts: ev.carts.length, cartsTagged: ev.carts.filter(c => c.q).length,
      purchases: orders.length, purchasesTagged: orders.filter(o => o.q).length, purchasesWithSession: orders.filter(o => o.s).length,
      purchaseTracking: ev.sources.checkout_events?.status === "ok" && ev.purchases.length > 0,
      checkoutTracking: ev.checkouts.length > 0,
      purchaseSessionsSeenBefore: (() => {
        const earlier = new Set<string>([...ev.clicks, ...ev.carts].map(e => e.s).filter((s): s is string => !!s)), bought = [...new Set(orders.map(o => o.s).filter((s): s is string => !!s))];
        return bought.length ? bought.filter(s => earlier.has(s)).length / bought.length : null;
      })(),
    },
  };
}

type Group = QueryRow & { _sessions: Set<string>; _clicked: Set<string>; _carted: Set<string>; _checkout: Set<string>; _bought: Set<string>; _revenue: Map<string, Money> };

/** Per-query funnel with explicit/inferred attribution. */
export function queryFunnel(ev: StoreEvents): QueryRow[] {
  const tl = new SessionTimeline(ev.queries), groups = new Map<string, Group>();
  const get = (q: string): Group => {
    let g = groups.get(q);
    if (!g) {
      g = { query: q, searches: 0, searchSessions: 0, missingSession: 0, zeroSearches: 0, measuredSearches: 0, zeroRate: null, clicks: 0, carts: 0, checkouts: 0, purchases: 0, explicitPurchases: 0, inferredPurchases: 0,
        clickSessions: 0, cartSessions: 0, checkoutSessions: 0, purchaseSessions: 0, clickRate: null, cartRate: null, purchaseRate: null, attributedRevenue: [], delivered: [],
        _sessions: new Set(), _clicked: new Set(), _carted: new Set(), _checkout: new Set(), _bought: new Set(), _revenue: new Map() };
      groups.set(q, g);
    }
    return g;
  };
  const latest = new Map<string, number>();
  for (const e of ev.queries) {
    const g = get(e.q);
    g.searches++;
    if (e.s) g._sessions.add(e.s); else g.missingSession++;
    if (e.zero !== null) { g.measuredSearches++; if (e.zero) g.zeroSearches++; }
    if (e.names.length && e.t >= (latest.get(e.q) ?? 0)) { latest.set(e.q, e.t); g.delivered = e.names.slice(0, 6); }
  }
  const attribute = (e: { q: string; s: string | null; t: number }, stage: Stage) => {
    if (e.q) return { q: e.q, kind: "explicit" as const };
    const hit = tl.preceding(e.s, e.t, WINDOWS[stage]);
    return hit ? { q: hit.q, kind: "inferred" as const } : null;
  };
  const track = (list: { q: string; s: string | null; t: number }[], stage: Stage, count: "clicks" | "carts" | "checkouts", set: "_clicked" | "_carted" | "_checkout") => {
    for (const e of list) {
      const a = attribute(e, stage);
      if (!a) continue;
      const g = get(a.q);
      g[count]++;
      if (e.s && tl.searched(e.s, a.q, e.t, WINDOWS[stage])) g[set].add(e.s);
    }
  };
  track(ev.clicks, "click", "clicks", "_clicked");
  track(ev.carts, "cart", "carts", "_carted");
  track(ev.checkouts, "checkout", "checkouts", "_checkout");
  const purchaseTracking = ev.purchases.length > 0;
  for (const o of uniquePurchases(ev.purchases).list) {
    const a = attribute(o, "purchase");
    if (!a) continue;
    const g = get(a.q);
    g.purchases++;
    a.kind === "explicit" ? g.explicitPurchases++ : g.inferredPurchases++;
    addMoney(g._revenue, o.currency, o.total);
    if (o.s && tl.searched(o.s, a.q, o.t, WINDOWS.purchase)) g._bought.add(o.s);
  }
  return [...groups.values()].map(({ _sessions, _clicked, _carted, _checkout, _bought, _revenue, ...g }) => ({
    ...g,
    searchSessions: _sessions.size, clickSessions: _clicked.size, cartSessions: _carted.size, checkoutSessions: _checkout.size, purchaseSessions: _bought.size,
    zeroRate: rate(g.zeroSearches, g.measuredSearches),
    clickRate: rate(_clicked.size, _sessions.size), cartRate: rate(_carted.size, _sessions.size),
    purchaseRate: purchaseTracking ? rate(_bought.size, _sessions.size) : null,
    attributedRevenue: moneyList(_revenue),
  })).filter(r => r.searches > 0 || r.clicks > 0 || r.carts > 0 || r.purchases > 0);
}

/**
 * Where each query loses shoppers, against the store's own search funnel.
 * sessionsBelowAverage = search sessions × (store purchase rate − query rate):
 * a triage size, not a forecast of recoverable orders.
 */
export function classifyLeaks(rows: QueryRow[], funnel: Funnel, minSessions = 5): QueryRow[] {
  // When most orders arrive without a session id, per-query purchase rates miss real purchases:
  // the purchase stage then cannot flag leaks, and opportunity is measured at the cart instead.
  const c = funnel.coverage, purchasesMeasurable = c.purchaseTracking && c.purchases > 0 && c.purchasesWithSession / c.purchases >= 0.7;
  const f = { ...funnel.rates, purchase: purchasesMeasurable ? funnel.rates.purchase : null };
  const clickToCart = f.click && f.cart !== null ? f.cart / f.click : null, cartToBuy = f.cart && f.purchase !== null ? f.purchase / f.cart : null;
  return rows.map(r => {
    let leakStage: LeakStage;
    if ((r.zeroRate ?? 0) >= 0.5 && r.searches >= 3) leakStage = "zero_results";
    else if (r.searchSessions < minSessions || r.clickRate === null) leakStage = "unmeasured";
    else if (f.click !== null && r.clickRate < f.click * 0.5) leakStage = "no_click";
    else if (clickToCart !== null && r.clickRate > 0 && (r.cartRate ?? 0) / r.clickRate < clickToCart * 0.5) leakStage = "click_no_cart";
    else if (cartToBuy !== null && r.purchaseRate !== null && (r.cartRate ?? 0) > 0 && r.purchaseRate / (r.cartRate as number) < cartToBuy * 0.5) leakStage = "cart_no_purchase";
    else leakStage = "healthy";
    // Measured at the deepest stage this store actually tracks: purchase, else cart, else click.
    const [store, own] = f.purchase ? [f.purchase, r.purchaseRate] : f.cart ? [f.cart, r.cartRate] : [f.click, r.clickRate];
    const below = store !== null && own !== null ? Math.max(0, (store - own) * r.searchSessions) : 0;
    return { ...r, leakStage, sessionsBelowAverage: Math.round(below * 10) / 10 };
  });
}

/**
 * Queries that behave like automated calls rather than shoppers: one query
 * taking a large share of all search sessions with almost no clicks (a widget
 * prefetch, a health check, a default query). They are kept in the per-query
 * table but excluded from the store baselines so they cannot distort them.
 */
export function suspectedSynthetic(rows: QueryRow[], searchSessions: number): string[] {
  return rows.filter(r => searchSessions >= 200 && r.searchSessions >= searchSessions * 0.25 && (r.clickRate ?? 0) < 0.01 && (r.cartRate ?? 0) < 0.005).map(r => r.query);
}

export type Sort = "searches" | "low_conversion" | "high_conversion" | "purchases" | "carts" | "clicks" | "opportunity";
export function rankQueries(rows: QueryRow[], { sort = "searches", limit = 20, minSessions = 20, query }: { sort?: Sort; limit?: number; minSessions?: number; query?: string } = {}) {
  const q = query ? normalizeQuery(query) : "";
  let eligible = q ? rows.filter(r => r.query === q || r.query.includes(q)) : rows;
  if (!q && (sort === "low_conversion" || sort === "high_conversion")) eligible = eligible.filter(r => r.searchSessions >= minSessions && (r.purchaseRate ?? r.cartRate) !== null);
  const key = (r: QueryRow) => r.purchaseRate ?? r.cartRate ?? 0;
  const sorted = [...eligible].sort(
    sort === "low_conversion" ? (a, b) => key(a) - key(b) || b.searchSessions - a.searchSessions
      : sort === "high_conversion" ? (a, b) => key(b) - key(a) || b.searchSessions - a.searchSessions
      : sort === "opportunity" ? (a, b) => (b.sessionsBelowAverage ?? 0) - (a.sessionsBelowAverage ?? 0) || b.searches - a.searches
        : (a, b) => (b[sort] as number) - (a[sort] as number) || b.searches - a.searches,
  );
  return { rows: sorted.slice(0, limit), matching: eligible.length };
}

export const METHODOLOGY = {
  measurement: "Reports and chat suppress conversion rates when fewer than 70% of searches have session ids, the relevant source is missing or truncated, or purchase session coverage is below 70%. Per-query rates additionally require 70% query-session coverage. Null means unknown, never zero; recorded event counts remain available.",
  rates: "Distinct search sessions for the query that reached the stage after searching it, divided by distinct search sessions for the query.",
  attribution: `Event search_query first (explicit); otherwise the latest search in the same session within ${WINDOWS.click / 60000} min (click), ${WINDOWS.cart / 3600000} h (cart), 24 h (checkout/purchase) — inferred, not proof.`,
  orders: "checkout_completed only (checkout_initiated is a separate stage); deduplicated by order id. Revenue is the recorded gross order total per currency, not net or refund-adjusted.",
  scope: "A bounded window of recorded events. Sessions near the end of the window have less time to convert. Low conversion alone does not prove poor relevance.",
  privacy: "No customer identities, contact details or raw session ids are returned.",
};

export function productsOf(list: ProductEvent[]) {
  const m = new Map<string, { pid: string; name: string; url: string; events: number }>();
  for (const e of list) {
    const key = e.pid || e.name;
    if (!key) continue;
    const row = m.get(key) ?? { pid: e.pid, name: e.name, url: e.url, events: 0 };
    row.events++; if (!row.name && e.name) row.name = e.name; if (!row.url && e.url) row.url = e.url;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => b.events - a.events);
}
