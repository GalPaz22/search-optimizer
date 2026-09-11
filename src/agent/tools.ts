import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ObjectId } from "mongodb";
import { controlDb, tenantDb } from "../core/db.js";
import { ExperimentInput } from "../core/types.js";
import { assertNoConflict } from "../engine/experiments.js";
import { Tenant } from "../core/tenant.js";

import { searchReport } from "../optimization/analytics.js";
import { ActionInput, createAction, executeAction, reconcileAction } from "../optimization/actions.js";
import { collectDailyReport } from "../optimization/service.js";
import { prioritizeFailures } from "../optimization/failures.js";
import { DiagnosisInput, recordDiagnosis } from "../optimization/diagnosis.js";

const asJson = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, (key, value) => ["apiKey", "tenantApiKey"].includes(key) ? undefined : value) }],
});

const actionSummary = (a: any) => ({ actionId: String(a._id), query: a.query, kind: a.kind, status: a.status,
  title: a.title, rationale: a.rationale?.slice(0, 250), filter: a.filter,
  productCount: (a.productIds?.length ?? 0) + (a.removeTagProductIds?.length ?? 0),
  diagnosis: a.diagnosis && { status: a.diagnosis.status, cause: a.diagnosis.cause, nextStep: a.diagnosis.nextStep?.slice(0, 200), actionIds: a.diagnosis.actionIds, proposalIds: a.diagnosis.proposalIds },
  outcome: a.outcome && { status: a.outcome.status, dueAt: a.outcome.dueAt, cartRateDelta: a.outcome.cartRateDelta },
  lastError: a.lastError?.slice(0, 250),
});

export function buildAnalyticsServer(tenant: Tenant, agentRunId: string) {
  const days = (d: number) => new Date(Date.now() - d * 86400_000);

  return createSdkMcpServer({
    name: "tenant-analytics",
    version: "1.0.0",
    tools: [
      tool("get_failure_priorities", "Refresh and persist the seven-day failure queue ranked by zero results and attributed search-to-cart shortfall. Score is a triage heuristic, not lost revenue. Return stable investigation IDs for recording diagnoses. Work on the top three actionable failures and operator notes.", {}, async () => {
        const report = await collectDailyReport(tenant), db = await controlDb();
        const issues = await db.collection("optimization_actions").find({ dbName: tenant.dbName, kind: "investigate", status: "pending" }).sort({ lastSeenAt: -1, createdAt: -1 }).limit(100).toArray();
        const top = report.failures.slice(0, 12);
        return asJson({ reportId: report.reportId, priorities: top.map(f => ({ ...f, examples: f.examples.slice(0, 1) })), quality: report.quality,
          issues: issues.filter(a => top.some(f => f.query === a.query) || String(a.evidence?.source ?? "").startsWith("operator") || a.query === "__tracking__").slice(0, 20)
            .map(a => ({ issueId: String(a._id), ...actionSummary(a), operatorNote: String(a.evidence?.source ?? "").startsWith("operator") })),
          more: "Use list_optimization_actions to page remaining work and get_optimization_action for detailed evidence." });
      }),
      tool("record_failure_diagnosis", "Persist the investigated cause, specific evidence, next step and links to saved repairs/proposals. Every investigated priority needs a diagnosis, even if blocked. Action-ready requires real linked actions. Never label an issue resolved just because a repair was queued.", DiagnosisInput.shape, async input => {
        try { return asJson(await recordDiagnosis(tenant, input, agentRunId)); } catch (e) { return asJson({ error: (e as Error).message }); }
      }),
      tool("get_daily_search_report", "Seven-day report against prior seven days with same-query 30-minute attribution, query examples and tracking quality. Use this as the primary diagnostic report.", {}, async () => {
        const report = await searchReport(tenant.dbName);
        return asJson({ ...report, current: { ...report.current, terms: report.current.terms.slice(0, 20).map(t => ({ ...t, examples: t.examples.slice(0, 1) })) }, previous: { ...report.previous, terms: report.previous.terms.slice(0, 10).map(t => ({ ...t, examples: [] })) } });
      }),
      tool("list_optimization_actions", "Page compact summaries of existing issues, repairs, failures and daily policy. Fetch detailed evidence with get_optimization_action. Check all pages for duplicate work.", { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(15) }, async ({ offset, limit }) => {
        const db = await controlDb();
        const rows = await db.collection("optimization_actions").find({ dbName: tenant.dbName }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1).toArray();
        return asJson({ actions: rows.slice(0, limit).map(actionSummary), nextOffset: rows.length > limit ? offset + limit : null, policy: await db.collection("optimization_policies").findOne({ dbName: tenant.dbName }) });
      }),
      tool("get_optimization_action", "Read one store-scoped action, exact product scope, diagnosis and verification. Product evidence is paginated in groups of five; evidenceText may be explicitly truncated. Never infer omitted evidence.", { actionId: z.string().regex(/^[a-f\d]{24}$/i), productOffset: z.number().int().min(0).default(0) }, async ({ actionId, productOffset }) => {
        const a = await (await controlDb()).collection("optimization_actions").findOne({ _id: new ObjectId(actionId), dbName: tenant.dbName });
        if (!a) return asJson({ error: "Action not found in this store" });
        const evidenceText = JSON.stringify(a.evidence);
        return asJson({ ...actionSummary(a), rationale: a.rationale, productIds: a.productIds, removeTagProductIds: a.removeTagProductIds,
          categories: a.categories, reprocess: a.reprocess, diagnosis: a.diagnosis, verification: a.verification, outcome: a.outcome,
          evidenceText: evidenceText?.slice(0, 3000), evidenceTruncated: (evidenceText?.length ?? 0) > 3000,
          products: a.selectedProducts?.slice(productOffset, productOffset + 5).map((p: any) => ({ ...p, description: String(p.description ?? "").slice(0, 1000), descriptionTruncated: String(p.description ?? "").length > 1000 })),
          nextProductOffset: a.selectedProducts?.length > productOffset + 5 ? productOffset + 5 : null });
      }),
      tool("create_optimization_action", "Create a previewable catalog repair, targeted reprocess or investigation. Include original-source evidence, explicit Mongo document ids, exact tags/categories and only needed reprocess fields. Alcohol-free wine needs evidence of BOTH wine and no alcohol. Empty product sets are investigation only. No live mutation occurs here.", ActionInput.shape, async input => {
        try { return asJson(await createAction(tenant, input, agentRunId)); } catch (e) { return asJson({ error: (e as Error).message }); }
      }),
      tool("execute_optimization_action", "Execute a pending catalog/reprocess action only when this store's autoExecuteCatalog policy permits it. Scoped products, before-state audit and post-reprocess verification are enforced. Otherwise leave it ready for the operator.", { actionId: z.string().regex(/^[a-f\d]{24}$/i) }, async ({ actionId }) => {
        const db = await controlDb(), policy = await db.collection("optimization_policies").findOne({ dbName: tenant.dbName });
        if (!policy?.autoExecuteCatalog) return asJson({ error: "Automatic catalog execution is off; action is ready for operator execution in Daily optimization" });
        try { return asJson(actionSummary(await executeAction(actionId, tenant.apiKey, `agent:${agentRunId}`))); } catch (e) { return asJson({ error: (e as Error).message }); }
      }),
      tool("verify_optimization_action", "Check a submitted reprocess job and verify exact catalog postconditions. Queued is not completed; catalog verification is not live ranking or revenue proof.", { actionId: z.string().regex(/^[a-f\d]{24}$/i) }, async ({ actionId }) => {
        try { return asJson(actionSummary(await reconcileAction(actionId, tenant.dbName))); } catch (e) { return asJson({ error: (e as Error).message }); }
      }),
      tool(
        "get_search_overview",
        "Search volume, top queries, and zero-result rate for the last N days.",
        { days: z.number().int().min(1).max(90).default(30) },
        async ({ days: d }) => {
          const db = await tenantDb(tenant.dbName);
          const since = days(d);
          const [total, topQueries, zeroTotal] = await Promise.all([
            db.collection("queries").countDocuments({ timestamp: { $gte: since } }),
            db
              .collection("queries")
              .aggregate([
                { $match: { timestamp: { $gte: since } } },
                { $group: { _id: { $toLower: "$query" }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
                { $limit: 30 },
              ])
              .toArray(),
            db.collection("zero_searches").countDocuments({ last_seen: { $gte: since } }),
          ]);
          return asJson({ totalSearches: total, topQueries, zeroResultQueries: zeroTotal });
        }
      ),

      tool(
        "get_zero_result_queries",
        "Queries that returned zero results, sorted by frequency.",
        { days: z.number().int().min(1).max(90).default(30), limit: z.number().int().max(50).default(25) },
        async ({ days: d, limit }) => {
          const db = await tenantDb(tenant.dbName);
          const rows = await db
            .collection("zero_searches")
            .find({ last_seen: { $gte: days(d) } })
            .sort({ hits: -1 })
            .limit(limit)
            .project({ query: 1, hits: 1, recovered_count: 1, last_seen: 1 })
            .toArray();
          return asJson(rows);
        }
      ),

      tool(
        "get_low_engagement_queries",
        "High-volume queries that DID return results but got suspiciously low or zero click-through — the 'wrong results' failure mode, distinct from zero-result queries (which have their own tool). Surfaces queries worth investigating with get_product_performance to see what's actually being shown.",
        {
          days: z.number().int().min(1).max(90).default(30),
          minSearches: z.number().int().min(1).default(15),
          limit: z.number().int().max(50).default(25),
        },
        async ({ days: d, minSearches, limit }) => {
          const report = await searchReport(tenant.dbName, d);
          return asJson({ quality: report.quality, queries: prioritizeFailures(report.current, report.previous, report.quality.comparable)
            .filter(t => t.metrics.searches >= minSearches && t.metrics.zeroRate !== 1).slice(0, limit) });
        }
      ),

      tool(
        "get_query_funnel",
        "Per-query searches, tagged events and attributed identifier rates for queries containing a pattern; same-query 30-minute attribution, no assumed purchases or revenue.",
        { pattern: z.string().min(1), days: z.number().int().min(1).max(90).default(30) },
        async ({ pattern, days: d }) => {
          const report = await searchReport(tenant.dbName, d);
          return asJson({ pattern, attribution: "Same exact normalized query, same identifier, subsequent event within 30 minutes", queries: report.current.terms.filter(t => t.query.includes(pattern.trim().toLowerCase())), quality: report.quality });
        }
      ),

      tool(
        "get_product_performance",
        "Per-product delivered-vs-clicked performance for a given query string.",
        { query: z.string().min(1), days: z.number().int().min(1).max(90).default(30) },
        async ({ query, days: d }) => {
          const db = await tenantDb(tenant.dbName);
          const since = days(d);
          const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const [delivered, clicked] = await Promise.all([
            db
              .collection("queries")
              .aggregate([
                { $match: { query: rx, timestamp: { $gte: since } } },
                { $unwind: { path: "$deliveredProducts", includeArrayIndex: "position" } },
                {
                  $group: {
                    _id: "$deliveredProducts",
                    impressions: { $sum: 1 },
                    avgPosition: { $avg: "$position" },
                  },
                },
                { $sort: { impressions: -1 } },
                { $limit: 40 },
              ])
              .toArray(),
            db
              .collection("product_clicks")
              .aggregate([
                { $match: { search_query: rx, timestamp: { $gte: since } } },
                { $group: { _id: "$product_name", clicks: { $sum: 1 }, product_id: { $first: "$product_id" } } },
                { $sort: { clicks: -1 } },
                { $limit: 40 },
              ])
              .toArray(),
          ]);
          return asJson({ delivered, clicked });
        }
      ),

      tool(
        "get_catalog_filter_coverage",
        "Inspect the real product catalog's category/filter coverage and find products with missing soft-category tags. Use this before proposing a new catalog filter.",
        { sampleLimit: z.number().int().min(1).max(50).default(20) },
        async ({ sampleLimit }) => {
          const db = await tenantDb(tenant.dbName);
          const products = db.collection("products");
          const [total, hidden, softCategories, categories, missing, pending] = await Promise.all([
            products.countDocuments({}),
            products.countDocuments({ hidden: true }),
            products.distinct("softCategory"),
            products.distinct("category"),
            products.find({ hidden: { $ne: true }, $or: [{ softCategory: { $exists: false } }, { softCategory: null }, { softCategory: "" }, { softCategory: { $size: 0 } }] })
              .project({ _id: 1, id: 1, name: 1, category: 1, softCategory: 1 }).limit(sampleLimit).toArray(),
            (await controlDb()).collection("proposals").find({ tenantApiKey: tenant.apiKey, kind: "catalogFilter", status: "pending" })
              .project({ "catalogChange.filter": 1, "catalogChange.productIds": 1 }).toArray(),
          ]);
          const flat = (values: unknown[]) => [...new Set(values.flat().filter((v): v is string => typeof v === "string" && v.trim().length > 0))];
          return asJson({ totalProducts: total, visibleProducts: total - hidden, configuredSoftCategories: tenant.softCategories ?? [], catalogSoftCategories: flat(softCategories), categories: flat(categories), untaggedSample: missing, pendingCatalogFilters: pending });
        }
      ),

      tool(
        "search_catalog_for_filter",
        "Preview concrete visible catalog products that might receive a proposed filter. Returns stable Mongo document ids; only select products clearly supported by their catalog data.",
        { query: z.string().min(2).max(200), limit: z.number().int().min(1).max(10).default(5), offset: z.number().int().min(0).default(0) },
        async ({ query: q, limit, offset }) => {
          const db = await tenantDb(tenant.dbName);
          const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const rows = await db.collection("products").find({
            hidden: { $ne: true },
            $or: [{ name: rx }, { description: rx }, { category: rx }, { softCategory: rx }, { type: rx }, { tags: rx }],
          }).project({ _id: 1, id: 1, name: 1, category: 1, softCategory: 1, type: 1, price: 1, description: 1, stockStatus: 1, stock_status: 1 }).sort({ _id: 1 }).skip(offset).limit(limit + 1).toArray();
          return asJson({ products: rows.slice(0, limit).map((p: any) => ({ ...p, description: String(p.description ?? "").slice(0, 1200), descriptionTruncated: String(p.description ?? "").length > 1200, catalogDocumentId: String(p._id) })), nextOffset: rows.length > limit ? offset + limit : null,
            note: "For truncated descriptions use get_product_source before relying on absent or contradictory source evidence." });
        }
      ),
      tool("get_product_source", "Read original source description of one visible product in this store, in 4000-character pages. Read every page before concluding there is no conflicting source evidence.", { productId: z.string().regex(/^[a-f\d]{24}$/i), offset: z.number().int().min(0).default(0) }, async ({ productId, offset }) => {
        const p = await (await tenantDb(tenant.dbName)).collection("products").findOne({ _id: new ObjectId(productId), hidden: { $ne: true } }, { projection: { name: 1, description: 1, category: 1, softCategory: 1, stockStatus: 1, stock_status: 1 } });
        if (!p) return asJson({ error: "Visible product not found in this store" });
        const description = String(p.description ?? "");
        return asJson({ ...p, description: description.slice(offset, offset + 4000), nextOffset: description.length > offset + 4000 ? offset + 4000 : null });
      }),

      tool(
        "propose_catalog_filter",
        "Submit a human-reviewed catalog enrichment proposal. This does not change the catalog. Use only Mongo catalogDocumentId values returned by search_catalog_for_filter, and include evidence of customer demand and why every selected product belongs.",
        {
          filter: z.string().trim().min(2).max(80),
          productIds: z.array(z.string().min(1)).min(1).max(500),
          rationale: z.string().min(20),
          hypothesis: z.string().min(20),
          evidence: z.record(z.string(), z.unknown()),
        },
        async (input) => {
          const db = await tenantDb(tenant.dbName);
          const uniqueIds = [...new Set(input.productIds)];
          const objectIds = uniqueIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
          const matches = await db.collection("products").find({ _id: { $in: objectIds }, hidden: { $ne: true } }).project({ _id: 1, name: 1 }).toArray();
          if (matches.length !== uniqueIds.length) return asJson({ error: `Only ${matches.length} of ${uniqueIds.length} product ids are valid visible catalog documents` });
          const cdb = await controlDb();
          const duplicate = await cdb.collection("proposals").findOne({ tenantApiKey: tenant.apiKey, kind: "catalogFilter", status: "pending", "catalogChange.filter": { $regex: `^${input.filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } });
          if (duplicate) return asJson({ error: "a pending proposal already exists for this filter" });
          const result = await cdb.collection("proposals").insertOne({
            kind: "catalogFilter", tenantApiKey: tenant.apiKey, dbName: tenant.dbName,
            hypothesis: input.hypothesis, evidence: { ...input.evidence, selectedProducts: matches },
            catalogChange: { filter: input.filter.trim(), productIds: uniqueIds, rationale: input.rationale },
            agentRunId, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400_000),
          });
          return asJson({ ok: true, proposalId: String(result.insertedId), productCount: matches.length });
        }
      ),

      tool(
        "get_current_config",
        "Current ranking config for this tenant: soft-category boost map, pinned rules, boost distribution.",
        {},
        async () => {
          const db = await tenantDb(tenant.dbName);
          const boostDist = await db
            .collection("products")
            .aggregate([{ $group: { _id: "$boost", count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
            .toArray();
          return asJson({
            softCategoriesBoosted: tenant.softCategoriesBoosted ?? {},
            pinnedResults: tenant.pinnedResults ?? [],
            boostDistribution: boostDist,
          });
        }
      ),

      tool(
        "list_experiments",
        "All experiments for this tenant with status and hypotheses (learn from past outcomes).",
        {},
        async () => {
          const db = await controlDb();
          const rows = await db
            .collection("experiments")
            .find({ dbName: tenant.dbName })
            .project({ name: 1, hypothesis: 1, type: 1, status: 1, targeting: 1, createdAt: 1 })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
          return asJson(rows);
        }
      ),

      tool(
        "read_experiment_results",
        "Latest metrics snapshot for an experiment id.",
        { experimentId: z.string() },
        async ({ experimentId }) => {
          const db = await controlDb();
          if (!ObjectId.isValid(experimentId) || !(await db.collection("experiments").findOne({ _id: new ObjectId(experimentId), dbName: tenant.dbName })))
            return asJson({ error: "Experiment not found in this store" });
          const snap = await db
            .collection("experiment_metrics")
            .find({ experimentId })
            .sort({ asOf: -1 })
            .limit(1)
            .toArray();
          return asJson(snap[0] ?? { error: "no metrics yet" });
        }
      ),

      tool(
        "propose_experiment",
        "Submit an experiment proposal for human review. hypothesis must cite numbers you obtained from other tools. arms must include a 'control' arm with empty patch. " +
          "For 'categoryRule' type, the variant arm's patch should be {\"categoryAssociation\": {\"softCategories\": [...], \"categories\": [...], \"limit\": 5}} — " +
          "e.g. to test surfacing cognac products on the query 'brandy', target that query and set categoryAssociation.softCategories to the cognac soft-category label(s) from get_current_config. " +
          "This is resolved dynamically per request (not a fixed product list) and reuses the tenant's own pinned-results mechanism.",
        {
          name: z.string().min(3),
          hypothesis: z.string().min(20),
          evidence: z.record(z.string(), z.unknown()),
          type: z.enum(["boost", "pin", "softCategoryBoost", "personalizationWeight", "filterTag", "categoryRule"]),
          targeting: z.object({
            mode: z.enum(["all", "queryMatch"]),
            patterns: z.array(z.string()).default([]),
            matchType: z.enum(["exact", "contains"]).default("contains"),
          }),
          arms: z.array(
            z.object({ key: z.string(), weight: z.number().positive(), patch: z.record(z.string(), z.unknown()) })
          ),
          trafficPct: z.number().min(1).max(100).default(50),
        },
        async (input) => {
          const draft = ExperimentInput.safeParse({
            tenantApiKey: tenant.apiKey,
            dbName: tenant.dbName,
            name: input.name,
            hypothesis: input.hypothesis,
            source: "agent",
            type: input.type,
            targeting: input.targeting,
            arms: input.arms,
            trafficPct: input.trafficPct,
          });
          if (!draft.success) return asJson({ error: "invalid experiment", details: draft.error.flatten() });
          if (!draft.data.arms.some((a) => a.key === "control" && Object.keys(a.patch).length === 0)) {
            return asJson({ error: "a 'control' arm with empty patch is required" });
          }
          try {
            await assertNoConflict(draft.data);
          } catch (e) {
            return asJson({ error: (e as Error).message });
          }
          const db = await controlDb();
          const res = await db.collection("proposals").insertOne({
            tenantApiKey: tenant.apiKey,
            hypothesis: input.hypothesis,
            evidence: input.evidence,
            draftExperiment: draft.data,
            agentRunId,
            status: "pending",
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 7 * 86400_000),
          });
          return asJson({ ok: true, proposalId: String(res.insertedId) });
        }
      ),
    ],
  });
}
