import { ObjectId } from "mongodb";
import { CatalogFilterChange } from "../core/types.js";
import { getMongo, getRedis } from "../core/db.js";

const normalizedTags = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flat().filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
};

export async function applyCatalogFilterChange(input: {
  proposalId: string;
  tenantApiKey: string;
  dbName: string;
  change: CatalogFilterChange;
  by?: string;
}) {
  const change = CatalogFilterChange.parse(input.change);
  const mongo = await getMongo();
  const session = mongo.startSession();
  const credentialsBefore: Record<string, unknown[]> = {};
  const auditId = new ObjectId();
  let productCount = 0;
  try {
    await session.withTransaction(async () => {
      const products = mongo.db(input.dbName).collection("products");
      const objectIds = change.productIds.filter(ObjectId.isValid).map((id) => new ObjectId(id));
      const selected = await products.find({ _id: { $in: objectIds }, hidden: { $ne: true } }, { session }).toArray();
      if (selected.length !== new Set(change.productIds).size) {
        throw new Error(`Catalog changed since proposal: found ${selected.length} of ${new Set(change.productIds).size} selected visible products`);
      }
      productCount = selected.length;
      for (const coreDbName of ["users", "semantix"]) {
        const users = mongo.db(coreDbName).collection("users");
        const docs = await users.find({ $or: [{ dbName: input.dbName }, { apiKey: input.tenantApiKey }] }, { session }).project({ apiKey: 1, "credentials.softCategories": 1, "credentials.softCategoriesBoosted": 1 }).toArray();
        credentialsBefore[coreDbName] = docs.map((d: any) => ({ apiKey: d.apiKey, softCategories: d.credentials?.softCategories, softCategoriesBoosted: d.credentials?.softCategoriesBoosted }));
        for (const doc of docs as any[]) {
          const values = normalizedTags(doc.credentials?.softCategories);
          if (!values.some((v) => v.toLocaleLowerCase() === change.filter.toLocaleLowerCase())) values.push(change.filter);
          const set: Record<string, unknown> = { "credentials.softCategories": values.join(",") };
          if (doc.credentials?.softCategoriesBoosted && typeof doc.credentials.softCategoriesBoosted === "object") set["credentials.softCategoriesBoosted"] = { ...doc.credentials.softCategoriesBoosted, [change.filter]: doc.credentials.softCategoriesBoosted[change.filter] ?? 1 };
          await users.updateOne({ _id: doc._id }, { $set: set }, { session });
        }
      }
      for (const product of selected as any[]) {
        const tags = normalizedTags(product.softCategory);
        if (!tags.some((v) => v.toLocaleLowerCase() === change.filter.toLocaleLowerCase())) tags.push(change.filter);
        await products.updateOne({ _id: product._id }, { $set: { softCategory: tags } }, { session });
      }
      await mongo.db("control_plane").collection("catalog_change_audits").insertOne({
        _id: auditId, proposalId: input.proposalId, tenantApiKey: input.tenantApiKey, dbName: input.dbName,
        kind: "catalogFilter", filter: change.filter, productCount: selected.length,
        productBefore: selected.map((p: any) => ({ _id: p._id, softCategory: p.softCategory })),
        credentialsBefore, appliedBy: input.by, appliedAt: new Date(),
      }, { session });
      await mongo.db("control_plane").collection("proposals").updateOne(
        { _id: new ObjectId(input.proposalId), status: "applying" },
        { $set: { status: "approved", applyResult: { auditId: String(auditId), filter: change.filter, productsUpdated: selected.length } } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  const redis = await getRedis();
  if (redis) {
    const keys = new Set([input.tenantApiKey, ...Object.values(credentialsBefore).flat().map((d: any) => d.apiKey).filter(Boolean)]);
    await Promise.all([...keys].map((key) => redis.del(`store-config:${key}`)));
  }
  return { ok: true, auditId: String(auditId), filter: change.filter, productsUpdated: productCount };
}
