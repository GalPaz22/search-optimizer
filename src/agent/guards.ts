import { ObjectId } from "mongodb";
import { tenantDb } from "../core/db.js";
import { ArmPatch, Targeting } from "../core/types.js";
import { Baseline } from "../analytics/baseline.js";
import { Catalog } from "../analytics/catalog.js";
import { normalizeQuery } from "../analytics/events.js";

/**
 * Checks a search change must pass before it reaches a reviewer.
 * errors block the proposal; warnings travel with it into the review.
 */
export interface GuardResult { errors: string[]; warnings: string[]; protectedQueries: { query: string; searches: number; keep: string[] }[] }

export const matchesTargeting = (targeting: Pick<Targeting, "mode" | "patterns" | "matchType">, query: string) => {
  if (targeting.mode === "all") return true;
  const q = normalizeQuery(query);
  return targeting.patterns.some(p => { const pat = normalizeQuery(p); return pat && (targeting.matchType === "exact" ? q === pat : q.includes(pat)); });
};

/** Every pinned product must be a visible, in-stock catalog product (by Mongo _id or the store's own id). */
async function checkPins(dbName: string, patch: ArmPatch, catalog: Catalog | null, errors: string[]) {
  for (const pin of patch.pinnedResults ?? []) {
    const db = await tenantDb(dbName);
    for (const raw of pin.productIds) {
      const id = String(raw);
      const doc: any = ObjectId.isValid(id) && id.length === 24
        ? await db.collection("products").findOne({ _id: new ObjectId(id) }, { projection: { name: 1, hidden: 1, stockStatus: 1, stock_status: 1 } })
        : null;
      const product = doc ? { name: doc.name, available: doc.hidden !== true && (doc.stockStatus ?? doc.stock_status) === "instock" } : catalog?.match({ pid: id }) ?? null;
      if (!product) errors.push(`Pinned product "${id}" (query "${pin.query}") is not in this store's catalog`);
      else if (!product.available) errors.push(`Pinned product "${product.name}" (${id}) is hidden or out of stock — shoppers cannot buy it`);
    }
  }
}

export async function guardSearchChange(input: { dbName: string; targeting: Pick<Targeting, "mode" | "patterns" | "matchType">; patch: ArmPatch; catalog: Catalog | null; baseline: Baseline | null }): Promise<GuardResult> {
  const errors: string[] = [], warnings: string[] = [];
  await checkPins(input.dbName, input.patch, input.catalog, errors);
  for (const pin of input.patch.pinnedResults ?? []) {
    if (!matchesTargeting(input.targeting, pin.query)) warnings.push(`Pin query "${pin.query}" is outside the change's targeting; the pin only fires when both match`);
  }
  if (input.patch.categoryAssociation && input.targeting.mode === "all") errors.push("categoryAssociation must target specific queries, never all searches");
  const soft = input.patch.softCategoriesBoost ? Object.keys(input.patch.softCategoriesBoost) : [];
  if (soft.length) {
    // Unknown labels boost nothing; catch typos before a reviewer approves a no-op.
    const known = new Set<string>();
    const db = await tenantDb(input.dbName);
    for (const v of await db.collection("products").distinct("softCategory").catch(() => [])) for (const x of [v].flat()) if (typeof x === "string") known.add(x);
    const missing = soft.filter(s => !known.has(s));
    if (missing.length) errors.push(`softCategoriesBoost labels not used by any product: ${missing.join(", ")}`);
  }
  // Queries that work today: shoppers already find and choose these products — the change must keep them.
  const protectedQueries = (input.baseline?.queries ?? [])
    .filter(q => q.status === "works" && matchesTargeting(input.targeting, q.query))
    .slice(0, 15).map(q => ({ query: q.query, searches: q.searches, keep: q.targets.slice(0, 4).map(t => t.name) }));
  if (protectedQueries.length) warnings.push(`Affects ${protectedQueries.length} queries that already work (e.g. ${protectedQueries.slice(0, 3).map(q => `"${q.query}"`).join(", ")}); the products shoppers choose there must stay visible`);
  return { errors, warnings, protectedQueries };
}
