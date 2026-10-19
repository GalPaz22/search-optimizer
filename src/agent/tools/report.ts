import { tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb } from "../../core/db.js";
import { normalizeQuery } from "../../analytics/events.js";
import { RunContext } from "../context.js";
import { asJson, fail, objectId } from "./shared.js";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const ReportInput = z.object({
  summary: text(80, 6000),
  findings: z.array(z.object({
    query: z.string().nullable(),
    stage: z.enum(["zero_results", "no_click", "click_no_cart", "cart_no_purchase", "catalog_gap", "ranking", "vocabulary", "tracking", "other"]),
    title: text(5, 200), evidence: text(20, 1500), severity: z.union([z.literal(1), z.literal(2), z.literal(3)]), confidence: z.enum(["high", "medium", "low"]),
  })).max(15),
  proposals: z.array(z.object({
    kind: z.enum(["catalog", "experiment", "rule", "tracking", "merchandising", "content", "investigation"]),
    title: text(5, 200), evidence: text(20, 1500), queries: z.array(z.string()).max(8), change: text(10, 1500),
    expectedImpact: text(5, 800), metric: text(5, 400), validation: text(10, 800), risk: text(5, 600),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    actionIds: z.array(objectId).max(10).default([]), proposalIds: z.array(objectId).max(10).default([]),
  })).max(10),
  limitations: z.array(text(5, 500)).max(10).default([]),
});
export type ReportInput = z.infer<typeof ReportInput>;

/**
 * Checks every claim is grounded: cited queries must be real shopper queries
 * this run actually saw in the data, and linked actions/proposals must exist
 * in this store. Returns the problems (empty when valid).
 */
export async function validateReport(ctx: RunContext, input: ReportInput): Promise<string[]> {
  const problems: string[] = [];
  const unknown = (q: string) => !ctx.knownQueries.has(normalizeQuery(q));
  for (const f of input.findings) if (f.query && unknown(f.query)) problems.push(`finding "${f.title}" cites query "${f.query}" that this run never saw in the store's data`);
  for (const p of input.proposals) for (const q of p.queries) if (unknown(q)) problems.push(`proposal "${p.title}" cites query "${q}" that this run never saw in the store's data`);
  const actionIds = [...new Set(input.proposals.flatMap(p => p.actionIds))], proposalIds = [...new Set(input.proposals.flatMap(p => p.proposalIds))];
  const cdb = actionIds.length || proposalIds.length ? await controlDb() : null;
  if (cdb && actionIds.length) {
    const found = new Set((await cdb.collection("optimization_actions").find({ _id: { $in: actionIds.map(id => new ObjectId(id)) }, dbName: ctx.tenant.dbName }).project({ _id: 1 }).toArray()).map(a => String(a._id)));
    for (const id of actionIds) if (!found.has(id)) problems.push(`actionId ${id} does not exist in this store`);
  }
  if (cdb && proposalIds.length) {
    const found = new Set((await cdb.collection("proposals").find({ _id: { $in: proposalIds.map(id => new ObjectId(id)) }, $or: [{ dbName: ctx.tenant.dbName }, { tenantApiKey: ctx.tenant.apiKey }] }).project({ _id: 1 }).toArray()).map(a => String(a._id)));
    for (const id of proposalIds) if (!found.has(id)) problems.push(`proposalId ${id} does not exist in this store`);
  }
  return problems;
}

/**
 * Validates and stores the run's report (upsert per run). Also used by the
 * runner to rescue a report whose tool call was cut off by the run budget.
 */
export async function saveReport(ctx: RunContext, raw: unknown) {
  const input = ReportInput.parse(raw), problems = await validateReport(ctx, input);
  if (problems.length) return { error: "Report not saved — fix these and submit again", problems };
  const doc = {
    source: "agent", dbName: ctx.tenant.dbName, tenantApiKey: ctx.tenant.apiKey, runId: ctx.runId, dataReportId: ctx.report?.reportId ?? null,
    generatedAt: new Date(), days: ctx.report?.days ?? null, ...input,
    proposals: input.proposals.map(p => ({ ...p, id: String(new ObjectId()), queries: p.queries.map(normalizeQuery) })),
  };
  const cdb = await controlDb();
  const saved = await cdb.collection("conversion_reports").findOneAndUpdate({ source: "agent", runId: ctx.runId }, { $set: doc }, { upsert: true, returnDocument: "after" });
  await cdb.collection("agent_runs").updateOne({ _id: new ObjectId(ctx.runId) }, { $set: { reportId: String(saved?._id) } });
  return { ok: true, reportId: String(saved?._id), findings: input.findings.length, proposals: input.proposals.length };
}

/** The run's structured deliverable, rendered on the Conversion page. */
export function reportTools(ctx: RunContext) {
  return [
    tool("submit_conversion_report",
      "Save this run's conversion report. The run has a fixed cost budget: submit as soon as your main findings and saved actions exist, then keep working if budget remains and resubmit to update (a new call replaces the report). Hebrew prose. findings: observed leaks with evidence and confidence. proposals: prioritized improvements across catalog, experiment, rule, tracking, merchandising, content and investigation — each with evidence, the exact queries from the data, the change, expected impact (a hypothesis, never a promised uplift), success metric, validation with rollback, risk, and the ids of actions/proposals you actually saved this run. queries must be real shopper queries you saw in this run's tools. limitations: what the data cannot show.",
      ReportInput.shape,
      async raw => {
        try { return asJson(await saveReport(ctx, raw)); } catch (e) { return fail(e); }
      }),
  ];
}
