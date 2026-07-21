import { getMongo, getRedis, tenantDb } from "../core/db.js";
import { getExperiment, transition } from "./experiments.js";
import { ExperimentDoc } from "../core/types.js";

/**
 * Materializes the winning arm's patch into permanent tenant config, then
 * marks the experiment promoted and busts caches.
 *
 * NOTE: dashboard-server reads store config from db "users" but its order
 * webhooks read db "semantix" for the same collection — we write BOTH.
 */
export async function promoteExperiment(id: string, by?: string, armKey = "v1") {
  const exp = (await getExperiment(id)) as ExperimentDoc | null;
  if (!exp) throw new Error("Experiment not found");
  if (!["running", "completed", "paused"].includes(exp.status)) {
    throw new Error(`Cannot promote from status '${exp.status}'`);
  }
  const arm = exp.arms.find((a) => a.key === armKey) ?? exp.arms.find((a) => a.key !== "control");
  if (!arm) throw new Error("No variant arm to promote");
  const patch = { ...(arm.patch ?? {}) } as typeof arm.patch & { pinnedResults?: any[] };

  // categoryAssociation is resolved dynamically per request at experiment time
  // (no permanent "always associate category X with query Y" config field
  // exists yet). Promotion freezes the current match into a static pin so the
  // winning behavior survives — revisit if this rule type needs to keep
  // tracking new products added to the category after promotion.
  if (patch.categoryAssociation) {
    const assoc = patch.categoryAssociation;
    const orClauses: Record<string, unknown>[] = [];
    if (assoc.softCategories?.length) orClauses.push({ softCategory: { $in: assoc.softCategories } });
    if (assoc.categories?.length) orClauses.push({ category: { $in: assoc.categories } });
    if (orClauses.length > 0) {
      const products = (await tenantDb(exp.dbName)).collection("products");
      const docs = await products
        .find({ $or: orClauses, hidden: { $ne: true } })
        .project({ _id: 1 })
        .sort({ boost: -1 })
        .limit(assoc.limit || 5)
        .toArray();
      const triggerQueries = exp.targeting.mode === "queryMatch" ? exp.targeting.patterns : [];
      for (const trigger of triggerQueries) {
        patch.pinnedResults = [
          ...(patch.pinnedResults ?? []),
          { query: trigger, productIds: docs.map((d: any) => d._id.toString()), enabled: true },
        ];
      }
    }
  }

  const client = await getMongo();

  for (const coreDbName of ["users", "semantix"]) {
    const users = client.db(coreDbName).collection("users");
    const doc: any = await users.findOne({ apiKey: exp.tenantApiKey });
    if (!doc) continue;

    const set: Record<string, unknown> = {};
    if (patch.softCategoriesBoost) {
      set["credentials.softCategoriesBoosted"] = {
        ...(doc.credentials?.softCategoriesBoosted ?? {}),
        ...patch.softCategoriesBoost,
      };
    }
    if (patch.pinnedResults) {
      const existing: any[] = doc.credentials?.pinnedResults ?? [];
      const newRules = patch.pinnedResults.filter(
        (r) => !existing.some((e) => (e.query ?? "").toLowerCase() === r.query.toLowerCase())
      );
      set["credentials.pinnedResults"] = [...newRules, ...existing];
    }
    if (Object.keys(set).length > 0) await users.updateOne({ apiKey: exp.tenantApiKey }, { $set: set });
  }

  if (patch.productBoosts) {
    const products = (await tenantDb(exp.dbName)).collection("products");
    for (const [productId, boost] of Object.entries(patch.productBoosts)) {
      await products.updateMany(
        { $or: [{ id: productId }, { id: Number(productId) || productId }] },
        { $set: { boost } }
      );
    }
  }
  // personalizationWeight has no permanent config field today — promotion for
  // that type is recorded on the experiment only (future: credentials field).

  const redis = await getRedis();
  if (redis) await redis.del(`store-config:${exp.tenantApiKey}`);

  return transition(id, "promoted", by, `promoted arm '${arm.key}'`);
}
