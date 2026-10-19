import { FastifyInstance } from "fastify";
import { buildConversionReport } from "../../analytics/report.js";
import { liveSearch } from "../../analytics/live-search.js";
import { getTenantByApiKey, storeProfile } from "../../core/tenant.js";
import { tenantDb } from "../../core/db.js";
import { controlDb, getRedis } from "../../core/db.js";
import { publishActiveRules, ACTIVE_RULES_KEY } from "../../rules/publisher.js";
import { RuleInput } from "../../core/types.js";
import { clearSearchCache } from "../../optimization/boosts.js";

// Share expensive reports across dashboard tabs; concurrent requests build once.
const cache = new Map<string, { expires: number; result: Promise<unknown> }>();
export function invalidateDashboardReports(dbName: string) {
  for (const key of cache.keys()) if (key.startsWith(`${dbName}:`)) cache.delete(key);
}
export async function dashboardRoutes(app: FastifyInstance) {
  app.post("/dashboard/merchandising/publish", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    const t = tenant ? await getTenantByApiKey(tenant) : null;
    if (!t) return reply.code(400).send({ error: "Select a valid store" });
    await publishActiveRules(t.apiKey);
    invalidateDashboardReports(t.dbName);
    return { published: !!(await getRedis()), cacheCleared: await clearSearchCache(t.dbName) };
  });
  app.post("/dashboard/search", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    const t = tenant ? await getTenantByApiKey(tenant) : null;
    if (!t) return reply.code(400).send({ error: "Select a valid store" });
    const { query } = (req.body ?? {}) as { query?: string };
    if (typeof query !== "string" || !query.trim() || query.length > 200) return reply.code(400).send({ error: "Invalid query" });
    try {
      const term = query.trim().replace(/\s+/g, " ").toLowerCase();
      const [products, rule] = await Promise.all([
        liveSearch(t, query),
        (await controlDb()).collection("rules").findOne({ dbName: t.dbName, merchantQuery: term }),
      ]);
      const pins: string[] = (rule?.patch?.pinnedResults?.[0]?.productIds ?? []).map(String);
      const pinnedProducts = pins.length ? await (await tenantDb(t.dbName)).collection("products").find({
        id: { $in: pins.flatMap(id => Number.isFinite(Number(id)) ? [id, Number(id)] : [id]) },
      }).project({ id: 1, name: 1, price: 1, image: 1, images: 1, category: 1, hidden: 1 }).toArray() : [];
      return { products, query: query.trim(), pins, pinnedProducts, pinStatus: rule?.status ?? null, pinRevision: rule?.updatedAt?.toISOString?.() ?? null };
    } catch (e) {
      const status = /returned \d+/.exec((e as Error).message);
      return reply.code(502).send({ error: status ? (e as Error).message : "מנוע החיפוש אינו זמין כרגע" });
    }
  });

  // One merchant-managed pin rule per exact query; agent-authored rules stay independent.
  app.put("/dashboard/pins", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    const t = tenant ? await getTenantByApiKey(tenant) : null;
    if (!t) return reply.code(400).send({ error: "Select a valid store" });
    const { query, productIds, revision } = (req.body ?? {}) as { query?: string; productIds?: string[]; revision?: string | null };
    if (typeof query !== "string" || !query.trim() || query.length > 200 || !Array.isArray(productIds) || productIds.length > 20 || productIds.some(id => typeof id !== "string" || !id)) return reply.code(400).send({ error: "Invalid pinned results" });
    const term = query.trim().replace(/\s+/g, " ").toLowerCase(), ids = [...new Set(productIds)];
    const products = await (await tenantDb(t.dbName)).collection("products").find({ hidden: { $ne: true }, id: { $in: ids.flatMap(id => Number.isFinite(Number(id)) ? [id, Number(id)] : [id]) } }).project({ id: 1 }).toArray();
    if (new Set(products.map(p => String(p.id))).size !== ids.length) return reply.code(400).send({ error: "Some products do not belong to this store" });
    const db = await controlDb(), identity = { dbName: t.dbName, merchantQuery: term };
    const previous = await db.collection("rules").findOne(identity);
    const checkedRevision = Object.prototype.hasOwnProperty.call(req.body ?? {}, "revision");
    if (checkedRevision && revision !== (previous?.updatedAt?.toISOString?.() ?? null)) return reply.code(409).send({ error: "הנעיצות עודכנו מאז פתיחת החיפוש. רענן את החיפוש לפני שמירה כדי לא לדרוס שינוי אחר." });
    const input = ids.length ? RuleInput.parse({ tenantApiKey: t.apiKey, dbName: t.dbName, name: `נעיצות: ${term}`,
      naturalLanguageText: `סדר תוצאות שנבחר בדאשבורד עבור ${term}`, condition: { mode: "queryMatch", patterns: [term], matchType: "exact" },
      patch: { pinnedResults: [{ query: term, productIds: ids, enabled: true }] },
    }) : null;
    const updatedAt = new Date();
    const selector = checkedRevision && previous ? { ...identity, _id: previous._id, updatedAt: previous.updatedAt } : identity;
    if (!ids.length) {
      if (previous) {
        const result = await db.collection("rules").deleteOne(selector);
        if (!result.deletedCount) return reply.code(409).send({ error: "הנעיצות השתנו; רענן את החיפוש ונסה שוב" });
      }
    } else if (checkedRevision && !previous) {
      try { await db.collection("rules").insertOne({ ...identity, ...input, status: "active", createdAt: updatedAt, updatedAt }); }
      catch (error) { if ((error as { code?: number }).code === 11000) return reply.code(409).send({ error: "נשמרו נעיצות במקביל. רענן את החיפוש לפני שמירה." }); throw error; }
    } else {
      const result = await db.collection("rules").updateOne(selector, { $set: { ...input, status: "active", updatedAt }, $setOnInsert: { createdAt: updatedAt } }, { upsert: !checkedRevision });
      if (checkedRevision && !result.matchedCount) return reply.code(409).send({ error: "הנעיצות השתנו; רענן את החיפוש ונסה שוב" });
    }
    let published = false;
    try {
      await publishActiveRules(t.apiKey);
      const redis = await getRedis(), payload = redis ? await redis.get(ACTIVE_RULES_KEY(t.apiKey)) : null;
      const wire = payload ? JSON.parse(payload) : [];
      published = !!redis && (ids.length ? wire.some((rule: any) => rule.patch?.pinnedResults?.some((p: any) => p.query === term && JSON.stringify(p.productIds) === JSON.stringify(ids))) : !wire.some((rule: any) => rule.patch?.pinnedResults?.some((p: any) => p.query === term)));
    } catch { /* Pins are saved; the UI must distinguish persistence from publishing. */ }
    return { saved: true, published, revision: ids.length ? updatedAt.toISOString() : null };
  });
  app.get("/dashboard", async (req, reply) => {
    const { tenant, days = "30" } = req.query as { tenant?: string; days?: string };
    const t = tenant ? await getTenantByApiKey(tenant) : null;
    if (!t) return reply.code(400).send({ error: "Select a valid store" });
    const count = Number(days);
    if (![7, 30, 90].includes(count)) return reply.code(400).send({ error: "Invalid date range" });
    const key = `${t.dbName}:${count}`;
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
      const result = Promise.all([storeProfile(t.dbName), buildConversionReport(t, { days: count, persist: false })])
        .then(([store, report]) => ({ store, report }))
        .catch(error => { cache.delete(key); throw error; });
      entry = { expires: Date.now() + 60_000, result };
      cache.set(key, entry);
    }
    return entry.result;
  });

  app.get("/dashboard/catalog", async (req, reply) => {
    const { tenant, query = "" } = req.query as { tenant?: string; query?: string };
    const t = tenant ? await getTenantByApiKey(tenant) : null;
    if (!t) return reply.code(400).send({ error: "Select a valid store" });
    if (typeof query !== "string" || query.length > 200) return reply.code(400).send({ error: "Invalid query" });
    const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const products = await (await tenantDb(t.dbName)).collection("products").find({ hidden: { $ne: true },
      ...(query ? { $or: [{ name: rx }, { category: rx }, { softCategory: rx }, { sku: rx }] } : {}),
    }).project({ _id: 1, id: 1, name: 1, price: 1, image: 1, images: 1, category: 1, stockStatus: 1, stock_status: 1 }).sort({ _id: 1 }).limit(50).toArray();
    return { products };
  });
}
