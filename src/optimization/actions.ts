import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb, getMongo, getRedis, tenantDb } from "../core/db.js";
import { getTenantByApiKey, siblingApiKeys, Tenant } from "../core/tenant.js";

const strings = (x: unknown): string[] => Array.isArray(x) ? x.filter(v => typeof v === "string") : typeof x === "string" ? x.split(",").map(v => v.trim()).filter(Boolean) : [];
export const ActionInput = z.object({
  title: z.string().min(5).max(200), query: z.string().min(1).max(200),
  rationale: z.string().min(20).max(6000), evidence: z.record(z.string(), z.unknown()),
  kind: z.enum(["catalogRepair", "reprocess", "investigate"]),
  filter: z.string().trim().min(2).max(80).optional(),
  productIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).default([]),
  removeTagProductIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(100).default([]),
  categories: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
  reprocess: z.object({ softCategories: z.boolean().default(false), embeddings: z.boolean().default(false) }).default({ softCategories: false, embeddings: false }),
}).strict().superRefine((v, ctx) => {
  if (v.kind !== "investigate" && !v.productIds.length && !v.removeTagProductIds.length) ctx.addIssue({ code: "custom", message: "Executable actions need explicit product ids" });
  if (v.kind === "catalogRepair" && !v.filter && !v.categories) ctx.addIssue({ code: "custom", message: "Catalog repair requires a filter or categories" });
  if (v.removeTagProductIds.length && !v.filter) ctx.addIssue({ code: "custom", message: "Tag removal requires filter" });
  if (v.productIds.some(id => v.removeTagProductIds.includes(id))) ctx.addIssue({ code: "custom", message: "A product cannot be both added and removed" });
  if (v.kind === "reprocess" && (!v.productIds.length || !(v.reprocess.softCategories || v.reprocess.embeddings))) ctx.addIssue({ code: "custom", message: "Choose products and reprocess fields" });
  if ((v.reprocess.softCategories || v.reprocess.embeddings) && !v.productIds.length) ctx.addIssue({ code: "custom", message: "Reprocess requires target products" });
});
export type RepairInput = z.infer<typeof ActionInput>;

/** Explicit source facts only. A generic wine category does not turn a soda into wine. */
export function alcoholFreeEvidence(product: any, wineOnly: boolean): { ok: boolean; reason: string } {
  const text = `${product.name ?? ""}\n${product.description ?? ""}`;
  const amounts = [...text.matchAll(/(?:אחוז\s*אלכוהול|alcohol(?:\s*(?:content|percentage))?|abv)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/gi)].map(m => Number(m[1].replace(",", ".")));
  const explicitlyFree = /ללא\s+אלכוהול|alcohol[- ]free|non[- ]alcoholic/i.test(text) || amounts.includes(0);
  if (amounts.some(n => n > 0)) return { ok: false, reason: "Source declares alcohol above zero" };
  if (!explicitlyFree) return { ok: false, reason: "No explicit alcohol-free evidence" };
  if (wineOnly && (!/(?:יין|wine)/i.test(text) || /(?:סודה|תמצית|סירופ|בירה|beer|soda)/i.test(text))) return { ok: false, reason: "No unambiguous evidence this is wine rather than another alcohol-free drink" };
  return { ok: true, reason: "Explicit source evidence" };
}
function validateProducts(input: RepairInput, products: any[]) {
  if (input.filter && /ללא\s+אלכוהול|alcohol[- ]free|non[- ]alcoholic/i.test(input.filter)) {
    for (const p of products.filter(p => input.productIds.includes(String(p._id)))) {
      const verdict = alcoholFreeEvidence(p, /יין|wine/i.test(input.filter));
      if (!verdict.ok) throw new Error(`${p.name}: ${verdict.reason}`);
    }
  }
}
const productFields = { name: 1, description: 1, category: 1, softCategory: 1, stockStatus: 1, stock_status: 1, hidden: 1, id: 1 };
const fingerprint = (p: any) => createHash("sha256").update(JSON.stringify(p)).digest("hex");
export async function previewAction(tenant: Tenant, raw: unknown) {
  const input = ActionInput.parse(raw), ids = [...new Set([...input.productIds, ...input.removeTagProductIds])];
  const db = await tenantDb(tenant.dbName);
  const products = await db.collection("products").find({ _id: { $in: ids.map(id => new ObjectId(id)) }, hidden: { $ne: true } }).project(productFields).toArray();
  if (products.length !== ids.length) throw new Error("Some products are missing or hidden in this store");
  validateProducts(input, products);
  if (input.reprocess.softCategories || input.reprocess.embeddings) for (const p of products.filter(p => input.productIds.includes(String(p._id)))) {
    if (p.stockStatus !== "instock" && p.stock_status !== "instock") throw new Error(`Reprocess targets must be in stock: ${p.name}`);
  }
  return { input, products, fingerprints: Object.fromEntries(products.map(p => [String(p._id), fingerprint(p)])) };
}
export async function createAction(tenant: Tenant, raw: unknown, agentRunId?: string) {
  const preview = await previewAction(tenant, raw), db = await controlDb();
  const key = createHash("sha256").update(JSON.stringify({ db: tenant.dbName, ...preview.input, evidence: undefined, rationale: undefined, title: undefined, productIds: [...preview.input.productIds].sort(), removeTagProductIds: [...preview.input.removeTagProductIds].sort() })).digest("hex");
  // One open action per exact intervention. Completed actions may be proposed again if it regresses.
  const old = await db.collection("optimization_actions").findOne({ dbName: tenant.dbName, dedupeKey: key, status: { $nin: ["verified", "dismissed", "failed"] } });
  if (old) {
    if (preview.input.kind === "investigate") {
      const preserveOperatorNote = String(old.evidence?.source ?? "").startsWith("operator") && !String(preview.input.evidence.source ?? "").startsWith("operator");
      await db.collection("optimization_actions").updateOne({ _id: old._id }, { $set: {
        ...(preserveOperatorNote ? { latestFailure: preview.input.evidence } : { evidence: preview.input.evidence, rationale: preview.input.rationale }),
        lastSeenAt: new Date(),
      } });
    }
    return { actionId: String(old._id), duplicate: true };
  }
  let result;
  try { result = await db.collection("optimization_actions").insertOne({ tenantApiKey: tenant.apiKey, dbName: tenant.dbName, ...preview.input, fingerprints: preview.fingerprints, selectedProducts: preview.products, dedupeKey: key, agentRunId, status: "pending", createdAt: new Date(), history: [{ status: "pending", at: new Date() }] });
  } catch (e: any) {
    if (e.code !== 11000) throw e;
    const existing = await db.collection("optimization_actions").findOne({ dbName: tenant.dbName, dedupeKey: key, status: { $in: ["pending", "applying", "dispatch_pending", "reprocessing", "verifying"] } });
    if (!existing) throw e;
    return { actionId: String(existing._id), duplicate: true };
  }
  return { actionId: String(result.insertedId), productCount: preview.products.length };
}

async function reprocessRequest(method: "GET" | "POST", body: unknown) {
  const base = process.env.REPROCESS_SERVICE_URL;
  const payload: any = body;
  const mongo = await getMongo();
  const users = mongo.db('users').collection('users');
  if (!payload.dbName) throw new Error('Reprocess request requires a resolved store');
  const user = await users.findOne({ dbName: payload.dbName, apiKey: payload.tenantApiKey }, { projection: { apiKey: 1 } })
    ?? await users.findOne({ dbName: payload.dbName, apiKey: { $type: 'string', $ne: '' } }, { projection: { apiKey: 1 }, sort: { _id: 1 } });
  const token = user?.apiKey;
  if (!base) throw new Error("Configure REPROCESS_SERVICE_URL to run the targeted reprocess service");
  if (!token) throw new Error("Tenant API key is missing; resolve the store from users.users before dispatch");
  const url = new URL(method === "GET" ? "/api/reprocess/logs" : "/api/reprocess", base);
  if (method === "GET") url.searchParams.set("jobId", String((body as any).jobId));
  const headers = { 'x-api-key': token, 'content-type': 'application/json' };
  if (method === 'POST') {
    const capability = await fetch(new URL('/api/reprocess/capabilities', base), { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!capability.ok) throw new Error('Onboarding capabilities are unavailable');
    const supported = await capability.json();
    if (supported.version < 2 || (payload.softCategoryScope && !supported.softCategoryScope)) throw new Error('Onboarding needs scoped soft-category reprocess support before dispatch');
  }
  const response = await fetch(url, { method, redirect: "error", headers, ...(method === "POST" ? { body: JSON.stringify({ optimizerJobId: payload.jobId, productIds: payload.productIds, softCategoryScope: payload.softCategoryScope, reprocessSoftCategories: payload.options.softCategories, reprocessEmbeddings: payload.options.embeddings, reprocessHardCategories: false, reprocessTypes: false, reprocessVariants: false, reprocessDescriptions: false, reprocessAll: false }) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Reprocess service returned ${response.status}`);
  const result: any = await response.json();
  if (method === "GET") return { ...result, status: result.status ?? (result.state === "done" ? "completed" : result.state === "error" ? "failed" : result.state) };
  return result;
}
export async function executeAction(id: string, apiKey: string, by = "ops") {
  const tenant = await getTenantByApiKey(apiKey); if (!tenant) throw new Error("Unknown store");
  const db = await controlDb(), actions = db.collection("optimization_actions");
  const a: any = await actions.findOne({ _id: new ObjectId(id), dbName: tenant.dbName });
  if (!a || a.status !== "pending") throw new Error("Pending action not found");
  if (a.kind === "investigate") throw new Error("Investigation requires an evidence-backed executable action; it cannot be marked fixed automatically");
  const input = actionPayload(a);
  if ((input.reprocess.softCategories || input.reprocess.embeddings) && !process.env.REPROCESS_SERVICE_URL) throw new Error("Reprocess service is not configured; action is still pending");
  const lock = await actions.updateOne({ _id: a._id, status: "pending" }, { $set: { status: "applying", startedAt: new Date(), executedBy: by } });
  if (!lock.modifiedCount) throw new Error("Action already claimed");
  const mongo = await getMongo(), session = mongo.startSession();
  try {
    await session.withTransaction(async () => {
      const products = mongo.db(tenant.dbName).collection("products");
      const ids = [...new Set([...input.productIds, ...input.removeTagProductIds])];
      const before = await products.find({ _id: { $in: ids.map(id => new ObjectId(id)) } }, { session }).project(productFields).toArray();
      if (before.length !== ids.length || before.some(p => fingerprint(p) !== a.fingerprints[String(p._id)])) throw new Error("Catalog changed since preview; create a fresh action");
      validateProducts(input, before);
      const credentialsBefore: any[] = [];
      if (input.filter) for (const core of ["users", "semantix"]) {
        const users = mongo.db(core).collection("users");
        const docs = await users.find({ dbName: tenant.dbName }, { session }).project({ "credentials.softCategories": 1 }).toArray();
        for (const user of docs) {
          credentialsBefore.push({ core, _id: user._id, softCategories: user.credentials?.softCategories });
          const tags = strings(user.credentials?.softCategories);
          if (!tags.includes(input.filter)) tags.push(input.filter);
          await users.updateOne({ _id: user._id }, { $set: { "credentials.softCategories": tags.join(",") } }, { session });
        }
      }
      for (const p of before) {
        const add = input.productIds.includes(String(p._id)), set: any = {};
        if (input.filter) { const tags = strings(p.softCategory).filter(t => t !== input.filter); if (add) tags.push(input.filter); set.softCategory = tags; }
        if (add && input.categories) set.category = input.categories;
        if (Object.keys(set).length) await products.updateOne({ _id: p._id }, { $set: set }, { session });
      }
      await mongo.db("control_plane").collection("catalog_change_audits").insertOne({ actionId: id, dbName: tenant.dbName, tenantApiKey: apiKey, productBefore: before, credentialsBefore, appliedAt: new Date(), appliedBy: by }, { session });
      const status = input.reprocess.softCategories || input.reprocess.embeddings ? "dispatch_pending" : "verifying";
      await actions.updateOne({ _id: a._id, status: "applying" }, { $set: { status, appliedAt: new Date() }, $push: { history: { status, at: new Date() } } } as any, { session });
    });
  } catch (error) {
    await actions.updateOne({ _id: a._id, status: "applying" }, { $set: { status: "failed", error: (error as Error).message } });
    throw error;
  } finally { await session.endSession(); }
  return reconcileAction(id, tenant.dbName);
}

export function actionPayload(a: any): RepairInput {
  return ActionInput.parse(Object.fromEntries(["title", "query", "rationale", "evidence", "kind", "filter", "productIds", "removeTagProductIds", "categories", "reprocess"].filter(k => a[k] !== undefined).map(k => [k, a[k]])));
}
export async function reconcileAction(id: string, dbName: string) {
  const db = await controlDb(), actions = db.collection("optimization_actions"), a: any = await actions.findOne({ _id: new ObjectId(id), dbName });
  if (!a) throw new Error("Action not found");
  if (!["dispatch_pending", "reprocessing", "verifying"].includes(a.status)) return a;
  const input = actionPayload(a);
  try {
    if (a.status === "dispatch_pending") {
      await reprocessRequest("POST", { jobId: id, tenantApiKey: a.tenantApiKey, dbName, productIds: input.productIds, options: input.reprocess, softCategoryScope: input.filter && input.reprocess.softCategories ? [input.filter] : undefined });
      await actions.updateOne({ _id: a._id, status: "dispatch_pending" }, { $set: { status: "reprocessing", dispatchedAt: new Date() }, $unset: { lastError: "" } });
      return { actionId: id, status: "reprocessing" };
    }
    if (a.status === "reprocessing") {
      const job = await reprocessRequest("GET", { jobId: id, tenantApiKey: a.tenantApiKey, dbName });
      if (["failed", "interrupted"].includes(job.status)) {
        await actions.updateOne({ _id: a._id }, { $set: { status: "failed", lastError: "Targeted reprocess failed or interrupted; inspect service job before creating a new action" } });
        return { actionId: id, status: "failed", job };
      }
      if (job.status !== "completed") return { actionId: id, status: "reprocessing", job };
    }
    const products = (await tenantDb(dbName)).collection("products");
    const ids = [...new Set([...input.productIds, ...input.removeTagProductIds])];
    const after = await products.find({ _id: { $in: ids.map(id => new ObjectId(id)) } }).project({ ...productFields, optimizerReprocessJobId: 1, embedding: { $slice: 1 } }).toArray();
    const problems: string[] = [];
    if (after.length !== ids.length) problems.push("Some target products disappeared");
    for (const p of after) {
      const add = input.productIds.includes(String(p._id));
      if (input.filter && strings(p.softCategory).includes(input.filter) !== add) problems.push(`${p.name}: tag verification failed`);
      if (add && input.categories && JSON.stringify(p.category) !== JSON.stringify(input.categories)) problems.push(`${p.name}: category verification failed`);
      if (add && (input.reprocess.softCategories || input.reprocess.embeddings) && p.optimizerReprocessJobId !== id) problems.push(`${p.name}: reprocess checkpoint missing`);
      if (add && input.reprocess.embeddings && !p.embedding?.length) problems.push(`${p.name}: embedding missing`);
    }
    try { validateProducts(input, after); } catch (error) { problems.push((error as Error).message); }
    if (input.filter && /ללא\s+אלכוהול|alcohol[- ]free|non[- ]alcoholic/i.test(input.filter)) {
      const tagged = await products.find({ softCategory: input.filter, hidden: { $ne: true } }).project(productFields).limit(1001).toArray();
      if (tagged.length > 1000) problems.push("Tag verification exceeds 1,000 products; manual audit required");
      for (const p of tagged) if (!alcoholFreeEvidence(p, /יין|wine/i.test(input.filter)).ok) problems.push(`${p.name}: incompatible product still carries filter`);
    }
    if (!problems.length) {
      const redis = await getRedis();
      if (!redis) { await actions.updateOne({ _id: a._id }, { $set: { status: "verifying", lastError: "Waiting for Redis to invalidate search caches" } }); return { actionId: id, status: "verifying" }; }
      for (const key of await siblingApiKeys(a.tenantApiKey)) await redis.del(`store-config:${key}`);
      const escapedDb = dbName.replace(/[\\*?\[\]]/g, "\\$&");
      for await (const key of redis.scanIterator({ MATCH: `simple-search:${escapedDb}:*`, COUNT: 100 })) await redis.del(key);
    }
    const status = problems.length ? "failed" : "verified";
    const verification = { at: new Date(), productCount: after.length, problems, scope: "catalog fields and reprocess checkpoints; not live ranking or revenue impact" };
    await actions.updateOne({ _id: a._id }, { $set: { status, verification }, $unset: { lastError: "" }, $push: { history: { status, at: new Date() } } } as any);
    return { actionId: id, status, verification };
  } catch (error) {
    // Dispatch may have succeeded despite timeout. Keep its idempotency key; never submit a second job.
    const status = a.status;
    await actions.updateOne({ _id: a._id }, { $set: { status, lastError: (error as Error).message } });
    return { actionId: id, status, error: (error as Error).message };
  }
}
export async function reconcileActions() {
  const db = await controlDb();
  // A crash before transaction commit cannot leave catalog edits; an applying action is not auto-replayed.
  await db.collection("optimization_actions").updateMany({ status: "applying", startedAt: { $lt: new Date(Date.now() - 3600000) } }, { $set: { status: "failed", error: "Execution interrupted before commit; inspect audit and create a fresh preview" } });
  const rows = await db.collection("optimization_actions").find({ status: { $in: ["dispatch_pending", "reprocessing", "verifying"] } }).limit(50).toArray();
  for (const a of rows) await reconcileAction(String(a._id), a.dbName);
}
