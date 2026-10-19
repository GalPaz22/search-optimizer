import { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { getTenantByApiKey } from "../../core/tenant.js";
import { getRedis, tenantDb } from "../../core/db.js";
import { invalidateDashboardReports } from "./dashboard.js";
import { clearSearchCache } from "../../optimization/boosts.js";
import { controlDb } from "../../core/db.js";

export const ProductVisibilityInput = z.object({
  productId: z.string().regex(/^[a-f\d]{24}$/i),
  hidden: z.boolean(),
}).strict();

export const ProductBoostInput = z.object({
  productIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(100)
    .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, "Duplicate products"),
  level: z.number().int().min(0).max(3),
}).strict();

const productServices = { getTenantByApiKey, tenantDb, controlDb, invalidateDashboardReports, clearSearchCache };
export async function productRoutes(app: FastifyInstance, options: { services?: typeof productServices } = {}) {
  const services = options.services ?? productServices;
  app.get("/dashboard/products", async (req, reply) => {
    const { tenant, query = "", visibility = "all", promotion = "all", page = "1" } = req.query as Record<string, string>;
    const store = tenant ? await getTenantByApiKey(tenant) : null;
    if (!store) return reply.code(400).send({ error: "Select a valid store" });
    const pageNumber = Number(page), limit = 25;
    if (typeof query !== "string" || query.length > 200 || !["all", "visible", "hidden"].includes(visibility) || !["all", "boosted"].includes(promotion) || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000000) return reply.code(400).send({ error: "Invalid product filters" });
    const rx = new RegExp(query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const search = query.trim() ? { $or: [{ name: rx }, { sku: rx }, { category: rx }, { id: rx }, ...(Number.isFinite(Number(query.trim())) ? [{ id: Number(query.trim()) }] : [])] } : {};
    const filter = { ...search, ...(promotion === "boosted" ? { boost: { $gt: 0 } } : {}), ...(visibility === "hidden" ? { hidden: true } : visibility === "visible" ? { hidden: { $ne: true } } : {}) };
    const products = (await tenantDb(store.dbName)).collection("products");
    const [rows, total, totalAll, totalHidden] = await Promise.all([
      products.find(filter).project({ _id: 1, id: 1, name: 1, sku: 1, price: 1, category: 1, image: 1, images: 1, hidden: 1, boost: 1, stockStatus: 1, stock_status: 1 }).sort({ _id: 1 }).skip((pageNumber - 1) * limit).limit(limit).maxTimeMS(15000).toArray(),
      products.countDocuments(filter, { maxTimeMS: 15000 }),
      products.countDocuments({}, { maxTimeMS: 15000 }),
      products.countDocuments({ hidden: true }, { maxTimeMS: 15000 }),
    ]);
    return { products: rows, total, page: pageNumber, limit, totalPages: Math.ceil(total / limit), stats: { total: totalAll, hidden: totalHidden, visible: totalAll - totalHidden } };
  });

  app.put("/dashboard/products/boost", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    const store = tenant ? await services.getTenantByApiKey(tenant) : null;
    if (!store) return reply.code(400).send({ error: "Select a valid store" });
    const input = ProductBoostInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: "יש לבחור עד 100 מוצרים ורמת קידום בין 0 ל־3" });
    const { productIds, level } = input.data;
    const products = (await services.tenantDb(store.dbName)).collection("products");
    const ids = productIds.map(id => new ObjectId(id));
    const before = await products.find({ _id: { $in: ids } }).project({ name: 1, boost: 1, hidden: 1 }).toArray();
    if (before.length !== ids.length) return reply.code(404).send({ error: "אחד המוצרים לא נמצא בחנות שלך; לא בוצע שינוי" });
    if (level > 0 && before.some(p => p.hidden === true)) return reply.code(409).send({ error: "יש להחזיר מוצרים מוסתרים לחיפוש לפני שמקדמים אותם" });
    const result = await products.updateMany(
      { _id: { $in: ids }, ...(level > 0 ? { hidden: { $ne: true } } : {}) },
      level === 0 ? { $unset: { boost: "" }, $set: { updatedAt: new Date() } } : { $set: { boost: level, updatedAt: new Date() } },
    );
    await (await services.controlDb()).collection("catalog_change_audits").insertOne({
      dbName: store.dbName, kind: "manualProductBoost", productBefore: before, level, appliedAt: new Date(),
    });
    services.invalidateDashboardReports(store.dbName);
    return { saved: true, level, updated: result.matchedCount, cacheCleared: await services.clearSearchCache(store.dbName) };
  });

  app.put("/dashboard/products/visibility", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    const store = tenant ? await getTenantByApiKey(tenant) : null;
    if (!store) return reply.code(400).send({ error: "Select a valid store" });
    const input = ProductVisibilityInput.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: "Invalid product visibility update" });
    // Resolve by Mongo document identity inside the authenticated store, never by a browser-supplied database.
    const result = await (await tenantDb(store.dbName)).collection("products").updateOne(
      { _id: new ObjectId(input.data.productId) },
      { $set: { hidden: input.data.hidden, updatedAt: new Date() } },
    );
    if (!result.matchedCount) return reply.code(404).send({ error: "המוצר לא נמצא בחנות שלך" });
    invalidateDashboardReports(store.dbName);
    let cacheCleared = false;
    try {
      const redis = await getRedis();
      if (redis) {
        const escapedDb = store.dbName.replace(/[\\*?\[\]]/g, "\\$&");
        for await (const key of redis.scanIterator({ MATCH: `simple-search:${escapedDb}:*`, COUNT: 100 })) await redis.del(key);
        cacheCleared = true;
      }
    } catch { /* The database update succeeded; communicate cache refresh separately. */ }
    return { saved: true, productId: input.data.productId, hidden: input.data.hidden, cacheCleared };
  });
}
