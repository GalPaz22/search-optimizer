import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { controlDb, tenantDb } from "../core/db.js";
import { ExperimentInput } from "../core/types.js";
import { assertNoConflict } from "../engine/experiments.js";
import { Tenant } from "../core/tenant.js";

const asJson = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function buildAnalyticsServer(tenant: Tenant, agentRunId: string) {
  const days = (d: number) => new Date(Date.now() - d * 86400_000);

  return createSdkMcpServer({
    name: "tenant-analytics",
    version: "1.0.0",
    tools: [
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
        "get_query_funnel",
        "Funnel (searches → clicks → add-to-cart → orders + revenue) for queries containing a pattern, joined by session.",
        { pattern: z.string().min(1), days: z.number().int().min(1).max(90).default(30) },
        async ({ pattern, days: d }) => {
          const db = await tenantDb(tenant.dbName);
          const since = days(d);
          const rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const queryDocs = await db
            .collection("queries")
            .find({ query: rx, timestamp: { $gte: since } })
            .project({ session_id: 1, sessionId: 1 })
            .limit(5000)
            .toArray();
          let sessions = [
            ...new Set(queryDocs.map((q: any) => q.session_id ?? q.sessionId).filter(Boolean)),
          ];
          // Some tenants' `queries` docs carry no session id — fall back to
          // sessions that clicked a product from a matching search.
          if (sessions.length === 0) {
            const clickSessions = await db
              .collection("product_clicks")
              .distinct("session_id", { search_query: rx, timestamp: { $gte: since } });
            sessions = clickSessions.filter(Boolean);
          }
          const sessionMatch = { $in: sessions };
          const [clicks, atc, orders] = await Promise.all([
            db.collection("product_clicks").countDocuments({ session_id: sessionMatch, timestamp: { $gte: since } }),
            db.collection("cart").countDocuments({ session_id: sessionMatch, timestamp: { $gte: since } }),
            db
              .collection("checkout_events")
              .find({ session_id: sessionMatch, timestamp: { $gte: since } })
              .project({ "orderData.total_price": 1, total_price: 1 })
              .toArray(),
          ]);
          const revenue = (orders as any[]).reduce(
            (s, o) => s + (Number(o.orderData?.total_price ?? o.total_price ?? 0) || 0),
            0
          );
          return asJson({
            pattern,
            searches: queryDocs.length,
            sessions: sessions.length,
            clicks,
            addToCarts: atc,
            orders: orders.length,
            revenue,
          });
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
            .find({ tenantApiKey: tenant.apiKey })
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
