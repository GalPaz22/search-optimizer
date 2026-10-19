import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { METHODOLOGY, rankQueries } from "../../analytics/conversion.js";
import { auditCandidates, queryEvidence } from "../../analytics/evidence.js";
import { reportDigest, trackingIssues } from "../../analytics/report.js";
import { analyticsFor, rememberQueries, RunContext, workspaceContext } from "../context.js";
import { asJson, days, fail } from "./shared.js";

const compactRow = (r: any) => ({
  query: r.query, searches: r.searches, searchSessions: r.searchSessions, missingSession: r.missingSession, zeroRate: r.zeroRate,
  clicks: r.clicks, carts: r.carts, checkouts: r.checkouts, purchases: r.purchases, explicitPurchases: r.explicitPurchases, inferredPurchases: r.inferredPurchases,
  clickRate: r.clickRate, cartRate: r.cartRate, purchaseRate: r.purchaseRate, attributedRevenue: r.attributedRevenue, leakStage: r.leakStage, sessionsBelowAverage: r.sessionsBelowAverage, delivered: r.delivered.slice(0, 4),
});

/** Read-only tools over the store's own shopper data (tenant-studio: workspace, customer_analytics, shopper_activity, audit, baseline). */
export function insightTools(ctx: RunContext) {
  return [
    tool("get_workspace", "Refresh the store's whole picture: production settings, rules and experiments live in search, open work and measured outcomes, recently rejected proposals, previous reviews and earlier operator requests. Already given at the start of the run; call again after changes.", {}, async () => {
      try { return asJson(await workspaceContext(ctx.tenant)); } catch (e) { return fail(e); }
    }),
    tool("get_conversion_report", "The deterministic conversion report this run started from (funnel, tracking issues, biggest leaks, zero results, baseline, audit candidates). Already given at the start of the run.", {}, async () => {
      if (!ctx.report) return asJson({ error: "No data report was built for this run; use store_funnel and customer_analytics." });
      return asJson(reportDigest(ctx.report));
    }),
    tool("customer_analytics", "Per-query purchase conversion with explicit/inferred attribution, for a 1–90 day window. sort: searches | low_conversion / high_conversion (purchase rate, else cart rate; needs minSessions distinct search sessions — state the threshold) | opportunity (sessions below the store average) | purchases | carts | clicks. Pass query for a drilldown of queries containing it. Rates are fractions of distinct search sessions; purchaseRate is null when the store does not track purchases. Low conversion alone is not proof of poor relevance.", {
      days, sort: z.enum(["searches", "low_conversion", "high_conversion", "opportunity", "purchases", "carts", "clicks"]).default("searches"),
      limit: z.number().int().min(1).max(30).default(15), minSessions: z.number().int().min(1).max(100000).default(20), query: z.string().min(1).max(200).optional(),
    }, async ({ days, sort, limit, minSessions, query }) => {
      try {
        const a = await analyticsFor(ctx, days), ranked = rankQueries(a.rows, { sort, limit, minSessions, query });
        rememberQueries(ctx, ranked.rows.map(r => r.query));
        return asJson({
          window: { from: new Date(a.ev.from), to: new Date(a.ev.to) }, sources: a.ev.sources, excludedAutomatedQueries: a.excluded,
          store: { sessions: a.funnel.sessions, rates: a.funnel.rates, orders: a.funnel.orders, revenue: a.funnel.revenue, coverage: a.funnel.coverage },
          tracking: trackingIssues(a.ev, a.funnel, a.activity),
          queries: ranked.rows.map(compactRow), matchingQueries: ranked.matching, methodology: METHODOLOGY,
        });
      } catch (e) { return fail(e); }
    }),
    tool("store_funnel", "Store-level search funnel over distinct sessions (searched → clicked → carted → checkout → purchased), orders and revenue split into search-assisted and total, purchase rate of carting sessions with vs without search, daily activity, logging/tracking gaps and measurement issues.", { days }, async ({ days }) => {
      try {
        const a = await analyticsFor(ctx, days);
        return asJson({ window: { from: new Date(a.ev.from), to: new Date(a.ev.to) }, sources: a.ev.sources, excludedAutomatedQueries: a.excluded, funnel: a.funnel,
          perDay: a.activity.perDay.slice(-35), tracking: trackingIssues(a.ev, a.funnel, a.activity, [], [], a.baseline.catalogMatchRate), catalog: a.catalog && { products: a.catalog.size, visible: a.catalog.visible, available: a.catalog.available } });
      } catch (e) { return fail(e); }
    }),
    tool("query_evidence", "Everything known about one real query: its funnel, the results the search showed (names logged in deliveredProducts), what shoppers clicked/carted/bought with catalog availability and document ids, searches per day and related queries. Use before diagnosing or changing any query.", { query: z.string().min(1).max(200), days }, async ({ query, days }) => {
      try {
        const a = await analyticsFor(ctx, days), e = queryEvidence(a.ev, a.rows, a.catalog, query);
        rememberQueries(ctx, [e.query, ...e.relatedQueries.map(r => r.query)]);
        return asJson(e.funnel || e.chosenProducts.length ? e : { ...e, note: "No shopper searched or chose products for this query in the window." });
      } catch (e) { return fail(e); }
    }),
    tool("search_audit", "Queries worth diagnosing first, interleaved by failure mode: zero results, searched-but-never-clicked, click→cart and cart→purchase leaks sized by sessions below average, production failures, catalog gaps and top queries. classification separates search problems from catalog gaps (shoppers want products that are missing, hidden or out of stock — fix the feed or stock, not ranking).", { days, limit: z.number().int().min(1).max(30).default(12) }, async ({ days, limit }) => {
      try {
        const a = await analyticsFor(ctx, days), list = auditCandidates(a.rows, a.baseline, { limit });
        rememberQueries(ctx, list.map(c => c.query));
        return asJson({ candidates: list, catalogMatchRate: a.baseline.catalogMatchRate });
      } catch (e) { return fail(e); }
    }),
    tool("production_baseline", "What the current search does well: per query, the products shoppers clearly choose (keep targets), and queries that fail (zero results or never clicked) or whose chosen products are unavailable (gap). Any change must keep the targets of working queries.", {
      days, status: z.enum(["works", "gap", "fails", "unclear"]).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(40).default(20),
    }, async ({ days, status, offset, limit }) => {
      try {
        const a = await analyticsFor(ctx, days), list = a.baseline.queries.filter(q => !status || q.status === status);
        rememberQueries(ctx, list.slice(offset, offset + limit).map(q => q.query));
        return asJson({ summary: a.baseline.summary, catalogMatchRate: a.baseline.catalogMatchRate, queries: list.slice(offset, offset + limit), nextOffset: list.length > offset + limit ? offset + limit : null });
      } catch (e) { return fail(e); }
    }),
  ];
}
