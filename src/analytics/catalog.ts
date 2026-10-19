import { tenantDb } from "../core/db.js";

/**
 * Resolves the product a shopper event names to the store's catalog document.
 * Plugins identify products differently (Woo numeric id, "woo_product_<id>",
 * Shopify gid, slug, SKU, or only a URL/name), so several keys are indexed.
 */
export interface CatalogProduct {
  _id: string; id: string; name: string; price: number | null;
  stockStatus: string | null; hidden: boolean; available: boolean;
  category: string[]; softCategory: string[]; url: string;
}
export interface Catalog { size: number; visible: number; available: number; match(e: { pid?: string; name?: string; url?: string }): CatalogProduct | null }

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase().replace(/\s+/g, " ") : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.flat().filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? v.split(",").map(s => s.trim()).filter(Boolean) : []);
export const urlTail = (u: unknown) => {
  if (typeof u !== "string" || !u) return "";
  try {
    const url = new URL(u, "https://x.invalid");
    const p = url.searchParams.get("p") ?? url.searchParams.get("ItemID");
    if (p) return p.toLowerCase();
    return decodeURIComponent(url.pathname.replace(/\/$/, "").split("/").pop() ?? "").toLowerCase();
  } catch { return ""; }
};

export function buildCatalog(docs: any[]): Catalog {
  const keys = new Map<string, CatalogProduct>(), names = new Map<string, CatalogProduct>();
  let visible = 0, available = 0;
  for (const d of docs) {
    const stock = d.stockStatus ?? d.stock_status ?? null, hidden = d.hidden === true;
    const p: CatalogProduct = {
      _id: String(d._id), id: d.id == null ? "" : String(d.id), name: String(d.name ?? d.title ?? ""), price: typeof d.price === "number" ? d.price : Number(d.price) || null,
      stockStatus: stock, hidden, available: !hidden && stock === "instock", category: list(d.category), softCategory: list(d.softCategory), url: String(d.url ?? d.permalink ?? ""),
    };
    if (!hidden) visible++;
    if (p.available) available++;
    const id = p.id;
    const gid = /\/(\d+)$/.exec(id)?.[1];
    for (const k of [id, id && `woo_product_${id}`, gid, d.numericId, d.sku, d.slug, d.handle && decodeURIComponent(String(d.handle)), urlTail(d.url), urlTail(d.permalink), d.ItemID, d.Makat])
      if (k != null && String(k).trim()) keys.set(String(k).toLowerCase(), p);
    if (p.name) names.set(norm(p.name), p);
  }
  return {
    size: docs.length, visible, available,
    match: ({ pid, name, url }) => {
      const id = (pid ?? "").trim().toLowerCase(), gid = /\/(\d+)$/.exec(id)?.[1];
      return (id && id !== "---" ? keys.get(id) ?? (gid ? keys.get(gid) : undefined) ?? keys.get(id.replace(/^woo_product_/, "")) : undefined)
        ?? (url ? keys.get(urlTail(url)) : undefined) ?? (name ? names.get(norm(name)) : undefined) ?? null;
    },
  };
}

export async function loadCatalog(dbName: string): Promise<Catalog> {
  const db = await tenantDb(dbName);
  const docs = await db.collection("products").find({}, {
    projection: { _id: 1, id: 1, name: 1, title: 1, price: 1, stockStatus: 1, stock_status: 1, hidden: 1, category: 1, softCategory: 1, url: 1, permalink: 1, sku: 1, slug: 1, handle: 1, numericId: 1, ItemID: 1, Makat: 1 },
  }).limit(100_000).maxTimeMS(60_000).toArray();
  return buildCatalog(docs);
}
