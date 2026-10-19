import { ObjectId } from "mongodb";
import { controlDb, getRedis, tenantDb } from "../core/db.js";
import { Tenant } from "../core/tenant.js";

/**
 * Merchant product changes requested in chat, saved as pending proposals and
 * applied only on approval:
 * - productBoost: the product `boost` field (1–3) the search engine uses to rank products higher in every search;
 * - productVisibility: the `hidden` flag that removes products from search results.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function findProducts(dbName: string, term: string, { limit = 30, inStockOnly = true, includeHidden = false } = {}) {
  const words = term.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return [];
  const db = await tenantDb(dbName);
  const filter: Record<string, unknown> = { $and: words.map(w => ({ name: { $regex: escape(w), $options: "i" } })) };
  if (!includeHidden) filter.hidden = { $ne: true };
  if (inStockOnly) filter.$or = [{ stockStatus: "instock" }, { stock_status: "instock" }];
  const docs = await db.collection("products").find(filter).project({ name: 1, boost: 1, hidden: 1, stockStatus: 1, stock_status: 1, price: 1 }).limit(limit).maxTimeMS(20_000).toArray();
  return docs.map(d => ({ _id: String(d._id), name: String(d.name ?? ""), boost: typeof d.boost === "number" ? d.boost : null, hidden: d.hidden === true, stockStatus: d.stockStatus ?? d.stock_status ?? null, price: d.price ?? null }));
}

async function saveProposal(tenant: Tenant, kind: string, change: Record<string, unknown>, summary: string, hypothesis: string, agentRunId?: string) {
  const res = await (await controlDb()).collection("proposals").insertOne({
    kind, tenantApiKey: tenant.apiKey, dbName: tenant.dbName, status: "pending", agentRunId, hypothesis, evidence: { summary, term: change.term },
    [kind === "productBoost" ? "boostChange" : "visibilityChange"]: change, createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400_000),
  });
  return String(res.insertedId);
}

export async function proposeBoost(tenant: Tenant, input: { term: string; level: number; limit?: number; inStockOnly?: boolean; agentRunId?: string }) {
  const level = Math.max(0, Math.min(3, Math.round(input.level)));
  const products = await findProducts(tenant.dbName, input.term, { limit: input.limit ?? 30, inStockOnly: input.inStockOnly ?? true });
  if (!products.length) return { error: `לא נמצאו מוצרים${input.inStockOnly === false ? "" : " במלאי"} ששמם כולל "${input.term}"` };
  const changing = products.filter(p => (level === 0 ? p.boost != null : p.boost !== level));
  if (!changing.length) return { error: level === 0 ? "אף אחד מהמוצרים אינו מקודם כרגע" : `כל ${products.length} המוצרים כבר מקודמים ברמה ${level}`, products: products.slice(0, 10) };
  const summary = level === 0 ? `הסרת קידום מ-${changing.length} מוצרים של "${input.term}"` : `קידום ${changing.length} מוצרים של "${input.term}" ברמה ${level}`;
  const proposalId = await saveProposal(tenant, "productBoost", { term: input.term, level, products: changing.map(p => ({ _id: p._id, name: p.name, boostBefore: p.boost })) },
    summary, `${summary}. המוצרים יופיעו גבוה יותר בכל החיפושים שבהם הם רלוונטיים.`, input.agentRunId);
  return { proposalId, summary, count: changing.length, alreadyAtLevel: products.length - changing.length, sample: changing.slice(0, 8).map(p => p.name) };
}

export async function proposeVisibility(tenant: Tenant, input: { term: string; hidden: boolean; limit?: number; agentRunId?: string }) {
  const products = await findProducts(tenant.dbName, input.term, { limit: input.limit ?? 30, inStockOnly: false, includeHidden: true });
  const changing = products.filter(p => p.hidden !== input.hidden);
  if (!changing.length) return { error: products.length ? `כל ${products.length} המוצרים כבר ${input.hidden ? "מוסתרים" : "מוצגים"}` : `לא נמצאו מוצרים ששמם כולל "${input.term}"` };
  const summary = input.hidden ? `הסתרת ${changing.length} מוצרים של "${input.term}" מהחיפוש` : `החזרת ${changing.length} מוצרים של "${input.term}" לחיפוש`;
  const proposalId = await saveProposal(tenant, "productVisibility", { term: input.term, hidden: input.hidden, products: changing.map(p => ({ _id: p._id, name: p.name, hiddenBefore: p.hidden })) },
    summary, `${summary}. ${input.hidden ? "המוצרים לא יופיעו בתוצאות החיפוש עד שיוחזרו." : "המוצרים יופיעו שוב בתוצאות החיפוש."}`, input.agentRunId);
  return { proposalId, summary, count: changing.length, sample: changing.slice(0, 8).map(p => p.name) };
}

export async function clearSearchCache(dbName: string) {
  try {
    const redis = await getRedis();
    if (!redis) return false;
    const escapedDb = dbName.replace(/[\\*?\[\]]/g, "\\$&");
    for await (const key of redis.scanIterator({ MATCH: `simple-search:${escapedDb}:*`, COUNT: 100 })) await redis.del(key);
    return true;
  } catch { return false; }
}

export async function applyProductChange(proposal: any, by?: string) {
  const boost = proposal.kind === "productBoost", change = boost ? proposal.boostChange : proposal.visibilityChange;
  const db = await tenantDb(proposal.dbName), ids = change.products.map((p: any) => new ObjectId(p._id));
  const update = boost ? (change.level === 0 ? { $unset: { boost: "" } } : { $set: { boost: change.level } }) : { $set: { hidden: change.hidden, updatedAt: new Date() } };
  const result = await db.collection("products").updateMany(boost ? { _id: { $in: ids }, hidden: { $ne: true } } : { _id: { $in: ids } }, update);
  const cdb = await controlDb();
  await cdb.collection("catalog_change_audits").insertOne({ proposalId: String(proposal._id), dbName: proposal.dbName, tenantApiKey: proposal.tenantApiKey, kind: proposal.kind, productBefore: change.products, appliedAt: new Date(), appliedBy: by });
  await cdb.collection("proposals").updateOne({ _id: proposal._id }, { $set: { status: "approved", reviewedBy: by, reviewedAt: new Date(), appliedCount: result.modifiedCount } });
  return { ok: true, updated: result.modifiedCount, cacheCleared: await clearSearchCache(proposal.dbName) };
}
