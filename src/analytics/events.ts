import { ObjectId } from "mongodb";
import { tenantDb } from "../core/db.js";

/**
 * One normalized view of what a store's shoppers did, read from the tenant
 * collections dashboard-server and the storefront plugins write:
 *   queries          searches the server logged (query, session, deliveredProducts)
 *   product_clicks   product clicks (search_query when the click came from search)
 *   cart             add-to-cart events
 *   checkout_events  checkout_initiated / checkout_completed
 *
 * Tenants disagree on shapes, so everything is normalized here once:
 * timestamps arrive as BSON dates, ISO strings (with or without offset) and
 * unix seconds; sessions as session_id or sessionId; order totals as
 * order_total, cart_total, total_price or orderData.*; line items as items,
 * cart_items or products. Raw session ids never leave the analytics layer.
 */

export const DAY_MS = 86_400_000;
const BLANK_QUERIES = new Set(["", "direct", "unknown", "null", "undefined"]);

export const normalizeQuery = (v: unknown): string =>
  typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : "";

/** Milliseconds since epoch for every timestamp shape tenants log, or null. */
export function parseTime(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(+v) ? +v : null;
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    if (/^\d{9,13}$/.test(v.trim())) return parseTime(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const eventTime = (r: any) => parseTime(r.timestamp) ?? parseTime(r.created_at) ?? parseTime(r.received_at);
const sessionOf = (r: any): string | null => {
  const s = r.session_id ?? r.sessionId ?? r.orderData?.session_id;
  return typeof s === "string" && s.trim() ? s.trim() : typeof s === "number" ? String(s) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const searchQueryOf = (r: any) => {
  const q = normalizeQuery(r.search_query ?? r.normalized_query);
  return BLANK_QUERIES.has(q) ? "" : q;
};

/** A completed purchase, never a checkout that was only started. */
export function isPurchase(r: any): boolean {
  if (r.event_type) return r.event_type === "checkout_completed";
  // Legacy order webhooks without event_type: an order id with line items is an order.
  if (!r.order_id) return false;
  const status = r.shopify_data?.financial_status ?? r.financial_status ?? r.status;
  if (typeof status === "string" && !["paid", "completed", "processing", "partially_refunded"].includes(status)) return false;
  return Array.isArray(r.items) || Array.isArray(r.cart_items) || Array.isArray(r.line_items) || Array.isArray(r.products) || num(r.order_total ?? r.total_price) !== null;
}

/** Recorded order amount (gross, as logged), from whichever field the tenant's plugin writes. */
export function orderTotal(r: any): number | null {
  return num(r.order_total) ?? num(r.orderData?.total_price) ?? num(r.orderData?.total) ?? num(r.total_price) ?? num(r.total) ?? num(r.cart_total);
}
const currencyOf = (r: any): string | null => {
  const c = r.currency ?? r.orderData?.currency;
  return typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : null;
};

export interface QueryEvent { q: string; s: string | null; t: number; delivered: number | null; names: string[]; zero: boolean | null }
export interface ProductEvent { q: string; s: string | null; t: number; pid: string; name: string; url: string }
export interface PurchaseEvent { q: string; s: string | null; t: number; orderId: string | null; total: number | null; currency: string | null; items: { pid: string; name: string; qty: number }[] }
export interface CheckoutStart { q: string; s: string | null; t: number }
export interface SourceStatus { status: "ok" | "missing" | "unavailable"; rows: number; truncated: boolean }
export interface StoreEvents {
  dbName: string;
  from: number;
  to: number;
  queries: QueryEvent[];
  clicks: ProductEvent[];
  carts: ProductEvent[];
  checkouts: CheckoutStart[];
  purchases: PurchaseEvent[];
  sources: Record<string, SourceStatus>;
}

export function toQueryEvent(r: any): QueryEvent | null {
  const t = eventTime(r), q = normalizeQuery(r.query);
  if (t === null || !q) return null;
  const list = Array.isArray(r.deliveredProducts) ? r.deliveredProducts : null;
  const count = list ? list.length : num(r.native_result_count ?? r.resultCount ?? r.resultsCount ?? r.totalResults);
  const zero = r.zero_results === true ? true : r.zero_results === false ? false : count === null ? null : count === 0;
  return { q, s: sessionOf(r), t, delivered: count, zero, names: list ? list.slice(0, 10).map((x: unknown) => String(typeof x === "object" && x ? (x as any).name ?? "" : x)).filter(Boolean) : [] };
}
export function toProductEvent(r: any): ProductEvent | null {
  const t = eventTime(r);
  if (t === null) return null;
  return { q: searchQueryOf(r), s: sessionOf(r), t, pid: r.product_id == null ? "" : String(r.product_id), name: typeof r.product_name === "string" ? r.product_name : "", url: typeof r.product_url === "string" ? r.product_url : "" };
}
export function toPurchaseEvent(r: any): PurchaseEvent | null {
  const t = eventTime(r);
  if (t === null || !isPurchase(r)) return null;
  const raw = r.items ?? r.cart_items ?? r.line_items ?? r.products ?? [];
  const items = (Array.isArray(raw) ? raw : []).map((i: any) => ({ pid: String(i?.product_id ?? i?.id ?? ""), name: String(i?.product_name ?? i?.name ?? i?.title ?? ""), qty: num(i?.quantity) ?? 1 })).filter((i: any) => i.pid || i.name);
  return { q: searchQueryOf(r), s: sessionOf(r), t, orderId: r.order_id == null ? null : String(r.order_id), total: orderTotal(r), currency: currencyOf(r), items };
}

// Bounded so a 30-day read of the busiest store fits a small instance next to the agent process.
const MAX_ROWS = 120_000;
const PAD_MS = 2 * DAY_MS;

/**
 * Reads [from, to) from one collection. Documents are inserted when events
 * happen, so ObjectId time is a padded prefilter that uses the _id index; the
 * exact window is then applied on the parsed event time. A collection whose
 * _ids are not ObjectIds falls back to a bounded scan.
 */
async function read(db: any, name: string, from: number, to: number, projection: Record<string, 1>, extra: Record<string, unknown> = {}) {
  const names = new Set((await db.listCollections({ name }, { nameOnly: true }).toArray()).map((c: any) => c.name));
  if (!names.has(name)) return { rows: [] as any[], status: { status: "missing", rows: 0, truncated: false } as SourceStatus };
  try {
    const latest = await db.collection(name).findOne({}, { sort: { _id: -1 }, projection: { _id: 1 } });
    const byId = latest?._id instanceof ObjectId
      ? { _id: { $gte: ObjectId.createFromTime(Math.floor((from - PAD_MS) / 1000)), $lt: ObjectId.createFromTime(Math.floor(Math.min(to + PAD_MS, Date.now() + DAY_MS) / 1000)) } }
      : {};
    const rows = await db.collection(name).find({ ...byId, ...extra }, { projection: { ...projection, timestamp: 1, created_at: 1, received_at: 1, session_id: 1, sessionId: 1 } })
      .sort({ _id: -1 }).limit(MAX_ROWS + 1).maxTimeMS(90_000).toArray();
    return { rows: rows.slice(0, MAX_ROWS), status: { status: "ok", rows: Math.min(rows.length, MAX_ROWS), truncated: rows.length > MAX_ROWS } as SourceStatus };
  } catch {
    return { rows: [] as any[], status: { status: "unavailable", rows: 0, truncated: false } as SourceStatus };
  }
}

export async function loadStoreEvents(dbName: string, from: Date, to: Date): Promise<StoreEvents> {
  const db = await tenantDb(dbName), f = +from, t = +to;
  const inWindow = <T extends { t: number }>(e: T | null): e is T => !!e && e.t >= f && e.t < t;
  const [queries, clicks, carts, checkout] = await Promise.all([
    read(db, "queries", f, t, { query: 1, deliveredProducts: 1, zero_results: 1, native_result_count: 1, resultCount: 1, resultsCount: 1, totalResults: 1 }),
    read(db, "product_clicks", f, t, { search_query: 1, normalized_query: 1, product_id: 1, product_name: 1, product_url: 1 }),
    read(db, "cart", f, t, { event_type: 1, search_query: 1, normalized_query: 1, product_id: 1, product_name: 1, product_url: 1 }),
    read(db, "checkout_events", f, t, {
      event_type: 1, search_query: 1, normalized_query: 1, order_id: 1, order_total: 1, cart_total: 1, total_price: 1, total: 1, currency: 1, status: 1, financial_status: 1,
      "shopify_data.financial_status": 1, orderData: 1, "items.product_id": 1, "items.product_name": 1, "items.quantity": 1, "cart_items.product_id": 1, "cart_items.product_name": 1,
      "cart_items.quantity": 1, "line_items.product_id": 1, "line_items.name": 1, "line_items.quantity": 1, "products.product_id": 1, "products.product_name": 1, "products.quantity": 1,
    }),
  ]);
  return {
    dbName, from: f, to: t,
    queries: queries.rows.map(toQueryEvent).filter(inWindow),
    clicks: clicks.rows.map(toProductEvent).filter(inWindow),
    carts: carts.rows.filter((r: any) => !r.event_type || r.event_type === "add_to_cart").map(toProductEvent).filter(inWindow),
    checkouts: checkout.rows.filter((r: any) => r.event_type === "checkout_initiated").map((r: any) => ({ q: searchQueryOf(r), s: sessionOf(r), t: eventTime(r) ?? NaN })).filter(inWindow),
    purchases: checkout.rows.map(toPurchaseEvent).filter(inWindow),
    sources: { queries: queries.status, product_clicks: clicks.status, cart: carts.status, checkout_events: checkout.status },
  };
}
