import { ObjectId } from "mongodb";
import { controlDb } from "../core/db.js";
import { getTenantByApiKey, Tenant } from "../core/tenant.js";
import { searchReport } from "./analytics.js";
import { createAction } from "./actions.js";
import { compareRepair, prioritizeFailures } from "./failures.js";

export async function collectDailyReport(tenant: Tenant) {
  const raw = await searchReport(tenant.dbName, 7), db = await controlDb();
  const report = { ...raw, failures: prioritizeFailures(raw.current, raw.previous, raw.quality.comparable) };
  const result = await db.collection("optimization_reports").insertOne({ ...report, tenantApiKey: tenant.apiKey });
  const findings = report.failures.slice(0, 12);
  for (const t of findings) await createAction(tenant, {
    kind: "investigate", title: `בדיקת חיפוש: ${t.query}`.slice(0, 200), query: t.query,
    rationale: `בשבעת הימים האחרונים: ${t.metrics.searches} חיפושים, ${t.metrics.identities} מזהים, ${t.metrics.cartIdentities} מזהים עם הוספה מיוחסת לעגלה. סיבות לבדיקה: ${t.reasons.join(", ")}. ${t.nextStep}`,
    evidence: { reportId: String(result.insertedId), start: report.current.start, end: report.current.end, ...t },
  });
  if (report.current.missingSessionRate && report.current.missingSessionRate > 0.1 || !report.quality.comparable || !report.quality.checkoutEvents) await createAction(tenant, {
    kind: "investigate", query: "__tracking__", title: "השלמת מדידה ואימות ההשוואה השבועית",
    rationale: "יש פערי מדידה שמגבילים ייחוס והערכת שיפור; לבדוק מזהים חסרים, הפסקות קליטה וחיבור רכישות. אין לתקן מעקב באמצעות שינוי קטלוג.",
    evidence: { reportId: String(result.insertedId), missingSessionRate: report.current.missingSessionRate, previousGaps: report.previous.trackingGapDays, quality: report.quality },
  });
  await measureRepairOutcomes(tenant);
  return { reportId: String(result.insertedId), ...report };
}

export async function measureRepairOutcomes(tenant: Tenant, now = new Date()) {
  const db = await controlDb();
  const actions = await db.collection("optimization_actions").find({ dbName: tenant.dbName, status: "verified", kind: { $ne: "investigate" }, "outcome.final": { $ne: true } }).limit(20).toArray();
  for (const action of actions) {
    // Cache/catalog verification is the earliest defensible start of exposure.
    const verifiedAt = new Date(action.verification?.at), appliedAt = new Date(action.appliedAt);
    if (!Number.isFinite(+verifiedAt) || !Number.isFinite(+appliedAt)) continue;
    const dueAt = new Date(+verifiedAt + 7 * 86400_000 + 30 * 60_000);
    if (+now < +dueAt) {
      await db.collection("optimization_actions").updateOne({ _id: action._id }, { $set: { outcome: { status: "collecting", dueAt, final: false } } });
      continue;
    }
    const [before, after] = await Promise.all([
      searchReport(tenant.dbName, 7, appliedAt),
      searchReport(tenant.dbName, 7, new Date(+verifiedAt + 7 * 86400_000)),
    ]);
    const comparison = compareRepair(action.query, before.current, after.current);
    const overlapping = await db.collection("optimization_actions").countDocuments({ dbName: tenant.dbName, _id: { $ne: action._id }, query: action.query,
      appliedAt: { $gte: before.current.start, $lt: after.current.end } });
    await db.collection("optimization_actions").updateOne({ _id: action._id, status: "verified" }, { $set: { outcome: {
      ...comparison, measuredAt: now, final: true, overlappingRepairs: overlapping,
      nextStep: comparison.status === "insufficient_evidence" ? "Collect a larger controlled sample; do not declare success."
        : (comparison.cartRateDelta ?? 0) < 0 ? "Investigate observed regression and prepare a reviewed rollback or experiment."
        : "Validate the observed change with a controlled experiment before attributing uplift.",
    } } });
  }
}

export async function latestReport(dbName: string) {
  return (await controlDb()).collection("optimization_reports").find({ dbName }).sort({ generatedAt: -1 }).limit(1).next();
}

/** Durable lease per store prevents overlapping daily runs across keys/processes. */
export async function runDailyOptimization() {
  const db = await controlDb(), policies = await db.collection("optimization_policies").find({ enabled: true }).toArray();
  for (const policy of policies) {
    const now = new Date();
    const claimed = await db.collection("optimization_policies").findOneAndUpdate({ _id: policy._id, enabled: true, $and: [
      { $or: [{ nextRunAt: { $exists: false } }, { nextRunAt: { $lte: now } }] },
      { $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lt: now } }] },
    ] }, { $set: { leaseUntil: new Date(+now + 3600000), lastAttemptAt: now } }, { returnDocument: "after" });
    if (!claimed) continue;
    try {
      const tenant = await getTenantByApiKey(policy.tenantApiKey);
      if (!tenant || tenant.dbName !== policy.dbName) throw new Error("Policy tenant mapping changed");
      await collectDailyReport(tenant);
      if (policy.agentEnabled) {
        const { runAgentForTenant } = await import("../agent/runner.js");
        await runAgentForTenant(tenant.apiKey);
      }
      await db.collection("optimization_policies").updateOne({ _id: policy._id }, { $set: { lastRunAt: new Date(), nextRunAt: new Date(+now + 86400000) }, $unset: { leaseUntil: "", lastError: "" } });
    } catch (error) {
      await db.collection("optimization_policies").updateOne({ _id: policy._id }, { $set: { lastError: (error as Error).message, nextRunAt: new Date(Date.now() + 3600000) }, $unset: { leaseUntil: "" } });
    }
  }
}
