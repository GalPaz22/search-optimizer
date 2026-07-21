import { ObjectId } from "mongodb";
import { controlDb, ensureTenantRuleIndexes } from "../core/db.js";
import { RuleDoc, RuleInput } from "../core/types.js";
import { publishActiveRules } from "./publisher.js";

export async function createRule(input: RuleInput): Promise<RuleDoc> {
  const db = await controlDb();
  const doc: RuleDoc = { ...input, status: "active", createdAt: new Date() };
  const res = await db.collection("rules").insertOne(doc as any);
  await ensureTenantRuleIndexes(input.dbName);
  await publishActiveRules(input.tenantApiKey);
  return { ...doc, _id: res.insertedId };
}

export async function listRules(filter: { tenantApiKey?: string } = {}): Promise<RuleDoc[]> {
  const db = await controlDb();
  const q: Record<string, unknown> = {};
  if (filter.tenantApiKey) q.tenantApiKey = filter.tenantApiKey;
  return db.collection("rules").find(q).sort({ createdAt: -1 }).limit(200).toArray() as unknown as Promise<
    RuleDoc[]
  >;
}

export async function getRule(id: string): Promise<RuleDoc | null> {
  const db = await controlDb();
  return db.collection("rules").findOne({ _id: new ObjectId(id) }) as unknown as Promise<RuleDoc | null>;
}

export async function setRuleStatus(id: string, status: "active" | "disabled"): Promise<RuleDoc> {
  const rule = await getRule(id);
  if (!rule) throw new Error("Rule not found");
  const db = await controlDb();
  await db.collection("rules").updateOne({ _id: new ObjectId(id) }, { $set: { status } });
  await publishActiveRules(rule.tenantApiKey);
  return (await getRule(id))!;
}

export async function deleteRule(id: string): Promise<void> {
  const rule = await getRule(id);
  if (!rule) throw new Error("Rule not found");
  const db = await controlDb();
  await db.collection("rules").deleteOne({ _id: new ObjectId(id) });
  await publishActiveRules(rule.tenantApiKey);
}

/** Last-24h trigger count per rule, from the tenant-local rule_applications counter. */
export async function getRuleTriggerCounts(rule: RuleDoc): Promise<number> {
  const { tenantDb } = await import("../core/db.js");
  const db = await tenantDb(rule.dbName);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const docs = await db
    .collection("rule_applications")
    .find({ rule_id: String(rule._id), date: { $in: [today, yesterday] } })
    .toArray();
  return docs.reduce((s: number, d: any) => s + (d.count || 0), 0);
}
