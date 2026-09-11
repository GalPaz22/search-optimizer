import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb } from "../core/db.js";
import { Tenant } from "../core/tenant.js";
import { normalizeQuery } from "./analytics.js";

const ids = z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(10).default([]);
export const DiagnosisInput = z.object({
  issueId: z.string().regex(/^[a-f\d]{24}$/i),
  status: z.enum(["action_ready", "blocked", "observing", "not_a_defect"]),
  cause: z.enum(["missing_results", "wrong_category", "ranking", "vocabulary", "stock", "product_offer", "tracking", "insufficient_sample", "unknown"]),
  evidence: z.string().min(30).max(6000),
  nextStep: z.string().min(20).max(3000),
  actionIds: ids, proposalIds: ids,
}).strict().superRefine((v, ctx) => {
  if (v.status === "action_ready" && !v.actionIds.length && !v.proposalIds.length)
    ctx.addIssue({ code: "custom", message: "Action-ready requires a saved action or experiment proposal" });
});

export async function recordDiagnosis(tenant: Tenant, raw: unknown, agentRunId: string) {
  const input = DiagnosisInput.parse(raw), db = await controlDb();
  const issue = await db.collection("optimization_actions").findOne({ _id: new ObjectId(input.issueId), dbName: tenant.dbName, kind: "investigate", status: "pending" });
  if (!issue) throw new Error("Open investigation not found in this store");
  const actions = await db.collection("optimization_actions").find({ _id: { $in: input.actionIds.map(id => new ObjectId(id)) }, dbName: tenant.dbName, kind: { $ne: "investigate" }, status: { $nin: ["failed", "dismissed"] } }).toArray();
  if (actions.length !== new Set(input.actionIds).size || actions.some(a => normalizeQuery(a.query) !== normalizeQuery(issue.query))) throw new Error("Repair links must belong to this store and query");
  const proposals = await db.collection("proposals").countDocuments({ _id: { $in: input.proposalIds.map(id => new ObjectId(id)) }, tenantApiKey: tenant.apiKey });
  if (proposals !== new Set(input.proposalIds).size) throw new Error("Proposal links must belong to this tenant");
  const diagnosis = { ...input, agentRunId, updatedAt: new Date() };
  await db.collection("optimization_actions").updateOne({ _id: issue._id, status: "pending" }, { $set: { diagnosis }, $push: { diagnosisHistory: diagnosis } } as any);
  return { issueId: input.issueId, diagnosis };
}
