import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb } from "../../core/db.js";
import { ArmPatch, ExperimentInput, RuleInput, Targeting } from "../../core/types.js";
import { assertNoConflict } from "../../engine/experiments.js";
import { analyticsFor, RunContext } from "../context.js";
import { guardSearchChange } from "../guards.js";
import { asJson, fail } from "./shared.js";
import { proposeBoost, proposeVisibility } from "../../optimization/boosts.js";
import { latestWeeklyReview } from "../../optimization/weekly.js";

/** Upper bound on experiment + rule proposals one run may leave for review. */
export const MAX_PROPOSALS_PER_RUN = 6;

const TargetingInput = z.object({
  mode: z.enum(["all", "queryMatch"]),
  patterns: z.array(z.string().min(1)).default([]),
  matchType: z.enum(["exact", "contains"]).default("contains"),
});

async function proposalBudget(runId: string) {
  const used = await (await controlDb()).collection("proposals").countDocuments({ agentRunId: runId, kind: { $in: [null, "experiment", "rule"] } });
  if (used >= MAX_PROPOSALS_PER_RUN) throw new Error(`This run already left ${used} proposals for review (limit ${MAX_PROPOSALS_PER_RUN}); prioritise and stop proposing.`);
}

/** Search changes: A/B experiments (measured) and permanent rules (scoped fixes), both human-approved. */
export function changeTools(ctx: RunContext) {
  const { tenant, runId } = ctx;
  const guard = async (targeting: z.infer<typeof TargetingInput>, patch: ArmPatch) => {
    const a = await analyticsFor(ctx, 30).catch(() => null);
    return guardSearchChange({ dbName: tenant.dbName, targeting, patch, catalog: a?.catalog ?? null, baseline: a?.baseline ?? null });
  };
  return [
    tool("promote_products",
      "Promote (or un-promote) products in ALL searches by a word in their name — a brand, series or product type, e.g. 'ריף'. One call finds the matching visible products and saves ONE pending change that the operator approves in the chat; nothing changes until then. level 1–3 (3 = strongest), 0 removes promotion. Use the shopper-facing word exactly as the operator wrote it.",
      { term: z.string().min(2).max(80), level: z.number().int().min(0).max(3).default(3), limit: z.number().int().min(1).max(100).default(40), inStockOnly: z.boolean().default(true) },
      async input => {
        try { return asJson(await proposeBoost(tenant, { ...input, agentRunId: runId })); } catch (e) { return fail(e); }
      }),
    tool("hide_products",
      "Hide products from search results (or show them again with hidden=false) by a word in their name. One call finds the matching products and saves ONE pending change the operator approves in the chat; nothing changes until then.",
      { term: z.string().min(2).max(80), hidden: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(40) },
      async input => {
        try { return asJson(await proposeVisibility(tenant, { ...input, agentRunId: runId })); } catch (e) { return fail(e); }
      }),
    tool("weekly_query_review",
      "The ranked list of this week's queries that most need fixing (click and add-to-cart shortfall vs the store average, zero results), with concrete merchandising suggestions already prepared for them. Use for 'what should I fix' / 'suggestions to improve search'.",
      { limit: z.number().int().min(1).max(30).default(10) },
      async ({ limit }) => {
        try {
          const review: any = await latestWeeklyReview(tenant);
          if (!review) return asJson({ note: "No weekly review has been run yet; use search_audit instead." });
          return asJson({ generatedAt: review.generatedAt, store: review.store, scannedQueries: review.scannedQueries, queries: review.queries.slice(0, limit), suggestions: review.suggestions.slice(0, limit).map((s: any) => ({ kind: s.kind, query: s.query, summary: s.summary, products: s.products?.map((p: any) => p.name) })) });
        } catch (e) { return fail(e); }
      }),
    tool("list_experiments", "All experiments for this store with status, type, targeting and hypothesis — learn from what already ran, won, lost or was rejected.", {}, async () => {
      try {
        const rows = await (await controlDb()).collection("experiments").find({ dbName: tenant.dbName }).project({ name: 1, hypothesis: 1, type: 1, status: 1, targeting: 1, trafficPct: 1, createdAt: 1, statusHistory: 1 }).sort({ createdAt: -1 }).limit(50).toArray();
        return asJson(rows);
      } catch (e) { return fail(e); }
    }),
    tool("read_experiment_results", "Latest metrics snapshot for an experiment: per-arm sessions, clicks, carts, orders, revenue and Bayesian/z-test readouts.", { experimentId: z.string().regex(/^[a-f\d]{24}$/i) }, async ({ experimentId }) => {
      try {
        const db = await controlDb();
        if (!(await db.collection("experiments").findOne({ _id: new ObjectId(experimentId), dbName: tenant.dbName }))) return asJson({ error: "Experiment not found in this store" });
        const snap = await db.collection("experiment_metrics").find({ experimentId }).sort({ asOf: -1 }).limit(1).toArray();
        return asJson(snap[0] ?? { error: "no metrics yet" });
      } catch (e) { return fail(e); }
    }),
    tool("propose_experiment",
      "Submit an A/B experiment for human review. hypothesis must cite numbers from this run's tools; arms must include a 'control' arm with an empty patch. Pinned products must be visible, in-stock catalog products (Mongo document id or the store's own id); pins must stay within targeting. " +
      "For cross-category surfacing use type 'categoryRule' with patch {\"categoryAssociation\": {\"softCategories\": [...], \"categories\": [...], \"limit\": 5}} on specific queries (resolved per request through the store's pinned-results mechanism). The result lists queries that already work and are affected: keep their chosen products visible.",
      {
        name: z.string().min(3), hypothesis: z.string().min(20), evidence: z.record(z.string(), z.unknown()),
        type: z.enum(["boost", "pin", "softCategoryBoost", "personalizationWeight", "filterTag", "categoryRule"]),
        targeting: TargetingInput,
        arms: z.array(z.object({ key: z.string(), weight: z.number().positive(), patch: z.record(z.string(), z.unknown()) })),
        trafficPct: z.number().min(1).max(100).default(50),
      },
      async input => {
        try {
          await proposalBudget(runId);
          const draft = ExperimentInput.safeParse({ tenantApiKey: tenant.apiKey, dbName: tenant.dbName, name: input.name, hypothesis: input.hypothesis, source: "agent", type: input.type, targeting: input.targeting, arms: input.arms, trafficPct: input.trafficPct });
          if (!draft.success) return asJson({ error: "invalid experiment", details: draft.error.flatten() });
          if (!draft.data.arms.some(a => a.key === "control" && Object.keys(a.patch).length === 0)) return asJson({ error: "a 'control' arm with empty patch is required" });
          await assertNoConflict(draft.data);
          const checks = await Promise.all(draft.data.arms.filter(a => a.key !== "control").map(a => guard(input.targeting, a.patch)));
          const errors = checks.flatMap(c => c.errors);
          if (errors.length) return asJson({ error: "Guard checks failed; fix the patch", details: errors });
          const guardInfo = { warnings: [...new Set(checks.flatMap(c => c.warnings))], protectedQueries: checks[0]?.protectedQueries ?? [] };
          const res = await (await controlDb()).collection("proposals").insertOne({
            kind: "experiment", tenantApiKey: tenant.apiKey, dbName: tenant.dbName, hypothesis: input.hypothesis, evidence: input.evidence, draftExperiment: draft.data,
            guard: guardInfo, agentRunId: runId, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400_000),
          });
          return asJson({ ok: true, proposalId: String(res.insertedId), ...guardInfo });
        } catch (e) { return fail(e); }
      }),
    tool("propose_rule",
      "Submit a permanent merchandising rule for human review — no control arm, applies to every matching search until disabled. Use only for scoped, evidence-backed fixes on specific queries (mode queryMatch): a query that returns nothing while the catalog sells the product, or returns the wrong kind of product. Measured bets belong in propose_experiment. " +
      "patch may use pinnedResults (visible in-stock products only; keep other relevant results), categoryAssociation or softCategoriesBoost. naturalLanguageText explains the rule to the merchant in Hebrew.",
      {
        name: z.string().min(3).max(120), naturalLanguageText: z.string().min(10).max(500), hypothesis: z.string().min(20).max(3000), evidence: z.record(z.string(), z.unknown()),
        condition: TargetingInput, patch: z.record(z.string(), z.unknown()),
      },
      async input => {
        try {
          await proposalBudget(runId);
          if (input.condition.mode !== "queryMatch" || !input.condition.patterns.length) return asJson({ error: "Permanent rules must target specific queries (mode queryMatch with patterns)" });
          const patch = ArmPatch.safeParse(input.patch);
          if (!patch.success) return asJson({ error: "invalid patch", details: patch.error.flatten() });
          if (patch.data.productBoosts || patch.data.profileBoostMultiplier != null) return asJson({ error: "Global product boosts and personalization weights need a controlled experiment, not a permanent rule" });
          if (!Object.keys(patch.data).length) return asJson({ error: "The rule changes nothing" });
          const draftRule = RuleInput.parse({ tenantApiKey: tenant.apiKey, dbName: tenant.dbName, name: input.name, naturalLanguageText: input.naturalLanguageText, condition: Targeting.parse(input.condition), patch: patch.data });
          const cdb = await controlDb();
          if (await cdb.collection("proposals").findOne({ kind: "rule", dbName: tenant.dbName, status: "pending", "draftRule.name": input.name })) return asJson({ error: "A pending rule proposal with this name already exists" });
          const check = await guard(input.condition, patch.data);
          if (check.errors.length) return asJson({ error: "Guard checks failed; fix the patch", details: check.errors });
          const res = await cdb.collection("proposals").insertOne({
            kind: "rule", tenantApiKey: tenant.apiKey, dbName: tenant.dbName, hypothesis: input.hypothesis, evidence: input.evidence, draftRule,
            guard: { warnings: check.warnings, protectedQueries: check.protectedQueries }, agentRunId: runId, status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400_000),
          });
          return asJson({ ok: true, proposalId: String(res.insertedId), warnings: check.warnings, protectedQueries: check.protectedQueries });
        } catch (e) { return fail(e); }
      }),
  ];
}
