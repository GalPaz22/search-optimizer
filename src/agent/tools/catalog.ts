import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb, tenantDb } from "../../core/db.js";
import { storeProfile } from "../../core/tenant.js";
import { RunContext, workspaceContext } from "../context.js";
import { asJson, fail, objectId } from "./shared.js";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Catalog inspection: what exists, how it is labelled, and each product's own source text. */
export function catalogTools(ctx: RunContext) {
  const { tenant } = ctx;
  return [
    tool("get_catalog_filter_coverage", "Category/soft-category coverage of the real catalog, the store's configured soft categories, a sample of visible products with no soft-category tag, and pending catalog work. Use before proposing a new filter or category repair.", { sampleLimit: z.number().int().min(1).max(50).default(20) }, async ({ sampleLimit }) => {
      try {
        const db = await tenantDb(tenant.dbName), products = db.collection("products");
        const [total, hidden, inStock, softCategories, categories, missing, profile, pending] = await Promise.all([
          products.countDocuments({}), products.countDocuments({ hidden: true }),
          products.countDocuments({ hidden: { $ne: true }, $or: [{ stockStatus: "instock" }, { stock_status: "instock" }] }),
          products.distinct("softCategory"), products.distinct("category"),
          products.find({ hidden: { $ne: true }, $or: [{ softCategory: { $exists: false } }, { softCategory: null }, { softCategory: "" }, { softCategory: { $size: 0 } }] }).project({ _id: 1, id: 1, name: 1, category: 1 }).limit(sampleLimit).toArray(),
          storeProfile(tenant.dbName),
          (await controlDb()).collection("optimization_actions").find({ dbName: tenant.dbName, kind: { $ne: "investigate" }, status: { $in: ["pending", "applying", "dispatch_pending", "reprocessing", "verifying"] } }).project({ query: 1, filter: 1, categories: 1, status: 1 }).limit(20).toArray(),
        ]);
        const flat = (values: unknown[]) => [...new Set(values.flat().filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
        return asJson({ totalProducts: total, visibleProducts: total - hidden, visibleInStock: inStock, configuredSoftCategories: profile?.softCategories.sample ?? [], catalogSoftCategories: flat(softCategories).slice(0, 300), categories: flat(categories).slice(0, 200), untaggedSample: missing, pendingCatalogWork: pending });
      } catch (e) { return fail(e); }
    }),
    tool("search_catalog", "Find concrete catalog products by text in name/description/category/softCategory/type/tags. Returns stable Mongo document ids (catalogDocumentId), stock and visibility. Hidden products are included only when includeHidden is true, marked hidden.", {
      query: z.string().min(2).max(200), limit: z.number().int().min(1).max(10).default(5), offset: z.number().int().min(0).default(0), includeHidden: z.boolean().default(false),
    }, async ({ query, limit, offset, includeHidden }) => {
      try {
        const db = await tenantDb(tenant.dbName), rx = new RegExp(escape(query), "i");
        const rows = await db.collection("products").find({
          ...(includeHidden ? {} : { hidden: { $ne: true } }),
          $or: [{ name: rx }, { description: rx }, { category: rx }, { softCategory: rx }, { type: rx }, { tags: rx }, { sku: rx }],
        }).project({ _id: 1, id: 1, name: 1, category: 1, softCategory: 1, type: 1, price: 1, description: 1, stockStatus: 1, stock_status: 1, hidden: 1 }).sort({ _id: 1 }).skip(offset).limit(limit + 1).toArray();
        return asJson({
          products: rows.slice(0, limit).map((p: any) => ({ ...p, stockStatus: p.stockStatus ?? p.stock_status ?? null, stock_status: undefined, hidden: p.hidden === true, description: String(p.description ?? "").slice(0, 1200), descriptionTruncated: String(p.description ?? "").length > 1200, catalogDocumentId: String(p._id) })),
          nextOffset: rows.length > limit ? offset + limit : null,
          note: "For truncated descriptions use get_product_source before relying on absent or contradictory source evidence.",
        });
      } catch (e) { return fail(e); }
    }),
    tool("get_product_source", "Original source description of one visible product in this store, in 4000-character pages. Read every page before concluding there is no conflicting source evidence.", { productId: objectId, offset: z.number().int().min(0).default(0) }, async ({ productId, offset }) => {
      try {
        const p = await (await tenantDb(tenant.dbName)).collection("products").findOne({ _id: new ObjectId(productId), hidden: { $ne: true } }, { projection: { name: 1, description: 1, category: 1, softCategory: 1, stockStatus: 1, stock_status: 1, price: 1 } });
        if (!p) return asJson({ error: "Visible product not found in this store" });
        const description = String(p.description ?? "");
        return asJson({ ...p, description: description.slice(offset, offset + 4000), nextOffset: description.length > offset + 4000 ? offset + 4000 : null });
      } catch (e) { return fail(e); }
    }),
    tool("get_current_config", "What shapes ranking right now: soft-category boost map, merchant pinned rules count, product boost distribution, and the permanent rules and experiments live in search.", {}, async () => {
      try {
        const db = await tenantDb(tenant.dbName);
        const [boostDist, profile, workspace] = await Promise.all([
          db.collection("products").aggregate([{ $group: { _id: "$boost", count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
          storeProfile(tenant.dbName), workspaceContext(tenant),
        ]);
        return asJson({ softCategoriesBoosted: profile?.softCategoriesBoosted ?? {}, merchantPinnedRules: profile?.pinnedResults ?? 0, boostDistribution: boostDist, liveInSearch: workspace.liveInSearch, showsOutOfStock: profile?.showsOutOfStock ?? null });
      } catch (e) { return fail(e); }
    }),
  ];
}
