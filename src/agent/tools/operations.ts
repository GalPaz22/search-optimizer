import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb } from "../../core/db.js";
import { searchReport } from "../../optimization/analytics.js";
import { ActionInput, createAction, executeAction, reconcileAction } from "../../optimization/actions.js";
import { DiagnosisInput, recordDiagnosis } from "../../optimization/diagnosis.js";
import { collectDailyReport } from "../../optimization/service.js";
import { rememberQueries, RunContext } from "../context.js";
import { actionSummary, asJson, fail, objectId } from "./shared.js";

// reconcileAction returns either the stored action or a short {actionId, status} result.
const summarize = (r: any) => (r?._id ? actionSummary(r) : r);

/** The daily repair loop: failure queue, diagnoses, and scoped catalog actions with verification. */
export function operationsTools(ctx: RunContext) {
  const { tenant, runId } = ctx;
  return [
    tool("get_failure_priorities", "Refresh and persist the seven-day failure queue (zero results and attributed search-to-cart shortfall; a triage score, not lost revenue) with stable investigation ids for record_failure_diagnosis, plus operator notes.", {}, async () => {
      try {
        const report = await collectDailyReport(tenant), db = await controlDb();
        const issues = await db.collection("optimization_actions").find({ dbName: tenant.dbName, kind: "investigate", status: "pending" }).sort({ lastSeenAt: -1, createdAt: -1 }).limit(100).toArray();
        const top = report.failures.slice(0, 12);
        rememberQueries(ctx, [...top.map(f => f.query), ...issues.map(i => i.query)]);
        return asJson({
          reportId: report.reportId, priorities: top.map(f => ({ ...f, examples: f.examples.slice(0, 1) })), quality: report.quality,
          issues: issues.filter(a => top.some(f => f.query === a.query) || String(a.evidence?.source ?? "").startsWith("operator") || a.query === "__tracking__").slice(0, 20)
            .map(a => ({ issueId: String(a._id), ...actionSummary(a), operatorNote: String(a.evidence?.source ?? "").startsWith("operator") })),
          more: "Use list_optimization_actions to page remaining work and get_optimization_action for detailed evidence.",
        });
      } catch (e) { return fail(e); }
    }),
    tool("record_failure_diagnosis", "Persist the investigated cause, specific evidence, next step and links to saved repairs/proposals for an open investigation. Every investigated priority needs a diagnosis, even if blocked. action_ready requires real linked actions or proposals; a queued repair is not a resolved issue.", DiagnosisInput.shape, async input => {
      try { return asJson(await recordDiagnosis(tenant, input, runId)); } catch (e) { return fail(e); }
    }),
    tool("get_daily_search_report", "Seven days against the prior seven with same-query 30-minute attributed click/cart identifier rates and tracking quality (cart-level; use customer_analytics for purchases).", {}, async () => {
      try {
        const report = await searchReport(tenant.dbName);
        return asJson({ ...report, current: { ...report.current, terms: report.current.terms.slice(0, 20).map(t => ({ ...t, examples: t.examples.slice(0, 1) })) }, previous: { ...report.previous, terms: report.previous.terms.slice(0, 10).map(t => ({ ...t, examples: [] })) } });
      } catch (e) { return fail(e); }
    }),
    tool("list_optimization_actions", "Page compact summaries of existing issues, repairs, failures and the store's daily policy. Check all pages before creating work to avoid duplicates.", { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(15) }, async ({ offset, limit }) => {
      try {
        const db = await controlDb();
        const rows = await db.collection("optimization_actions").find({ dbName: tenant.dbName }).sort({ createdAt: -1, _id: -1 }).skip(offset).limit(limit + 1).toArray();
        return asJson({ actions: rows.slice(0, limit).map(actionSummary), nextOffset: rows.length > limit ? offset + limit : null, policy: await db.collection("optimization_policies").findOne({ dbName: tenant.dbName }, { projection: { enabled: 1, agentEnabled: 1, autoExecuteCatalog: 1 } }) });
      } catch (e) { return fail(e); }
    }),
    tool("get_optimization_action", "One store-scoped action with exact product scope, diagnosis, verification and outcome. Product evidence is paged in fives; evidenceText may be truncated — never infer omitted evidence.", { actionId: objectId, productOffset: z.number().int().min(0).default(0) }, async ({ actionId, productOffset }) => {
      try {
        const a = await (await controlDb()).collection("optimization_actions").findOne({ _id: new ObjectId(actionId), dbName: tenant.dbName });
        if (!a) return asJson({ error: "Action not found in this store" });
        const evidenceText = JSON.stringify(a.evidence);
        return asJson({ ...actionSummary(a), rationale: a.rationale, productIds: a.productIds, removeTagProductIds: a.removeTagProductIds,
          categories: a.categories, reprocess: a.reprocess, diagnosis: a.diagnosis, verification: a.verification, outcome: a.outcome,
          evidenceText: evidenceText?.slice(0, 3000), evidenceTruncated: (evidenceText?.length ?? 0) > 3000,
          products: a.selectedProducts?.slice(productOffset, productOffset + 5).map((p: any) => ({ ...p, description: String(p.description ?? "").slice(0, 1000), descriptionTruncated: String(p.description ?? "").length > 1000 })),
          nextProductOffset: a.selectedProducts?.length > productOffset + 5 ? productOffset + 5 : null });
      } catch (e) { return fail(e); }
    }),
    tool("create_optimization_action", "Create a previewable catalog repair (soft-category tag add/remove, category correction), a targeted reprocess of at most 100 products, or an investigation. Include original-source evidence, explicit Mongo document ids and only the reprocess fields needed. Alcohol-free wine needs evidence of BOTH wine and no alcohol. Empty product sets are investigation only. Nothing changes in the live catalog here.", ActionInput.shape, async input => {
      try { return asJson(await createAction(tenant, input, runId)); } catch (e) { return fail(e); }
    }),
    tool("execute_optimization_action", "Execute a pending catalog/reprocess action — only when this store's autoExecuteCatalog policy permits it. Scoped products, before-state audit and post-reprocess verification are enforced; otherwise the action stays ready for the operator.", { actionId: objectId }, async ({ actionId }) => {
      try {
        const policy = await (await controlDb()).collection("optimization_policies").findOne({ dbName: tenant.dbName });
        if (!policy?.autoExecuteCatalog) return asJson({ error: "Automatic catalog execution is off for this store; the action is ready for the operator in Daily optimization" });
        return asJson(summarize(await executeAction(actionId, tenant.apiKey, `agent:${runId}`)));
      } catch (e) { return fail(e); }
    }),
    tool("verify_optimization_action", "Check a submitted reprocess job and verify exact catalog postconditions. Queued is not completed; catalog verification is not live ranking or revenue proof.", { actionId: objectId }, async ({ actionId }) => {
      try { return asJson(summarize(await reconcileAction(actionId, tenant.dbName))); } catch (e) { return fail(e); }
    }),
  ];
}
