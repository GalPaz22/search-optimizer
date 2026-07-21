import { ObjectId } from "mongodb";
import { controlDb, ensureTenantExperimentIndexes } from "../core/db.js";
import { ExperimentDoc, ExperimentInput, ExperimentStatus } from "../core/types.js";
import { publishActiveExperiments } from "./publisher.js";

const TRANSITIONS: Record<string, ExperimentStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["running", "rejected"],
  running: ["paused", "completed", "killed", "promoted"],
  paused: ["running", "killed", "completed"],
  completed: ["promoted"],
  promoted: [],
  rejected: [],
  killed: [],
};

export class ConflictError extends Error {}

function patchKeys(exp: ExperimentInput): Set<string> {
  const keys = new Set<string>();
  for (const arm of exp.arms) for (const k of Object.keys(arm.patch ?? {})) keys.add(k);
  return keys;
}

function targetingOverlaps(a: ExperimentInput["targeting"], b: ExperimentInput["targeting"]): boolean {
  if (a.mode === "all" || b.mode === "all") return true;
  const pa = a.patterns.map((p) => p.toLowerCase());
  const pb = b.patterns.map((p) => p.toLowerCase());
  return pa.some((x) => pb.some((y) => x.includes(y) || y.includes(x)));
}

/**
 * Refuses activation when another running/approved experiment in the same
 * tenant has overlapping targeting AND touches the same patch keys.
 */
export async function assertNoConflict(exp: ExperimentInput, excludeId?: string): Promise<void> {
  const db = await controlDb();
  const others = (await db
    .collection("experiments")
    .find({
      tenantApiKey: exp.tenantApiKey,
      status: { $in: ["approved", "running", "paused"] },
      ...(excludeId ? { _id: { $ne: new ObjectId(excludeId) } } : {}),
    })
    .toArray()) as unknown as ExperimentDoc[];

  const myKeys = patchKeys(exp);
  for (const other of others) {
    const overlap = targetingOverlaps(exp.targeting, other.targeting);
    const sharedKeys = [...patchKeys(other)].filter((k) => myKeys.has(k));
    if (overlap && sharedKeys.length > 0) {
      throw new ConflictError(
        `Conflicts with experiment "${other.name}" (${other._id}): overlapping targeting and shared patch keys [${sharedKeys.join(", ")}]`
      );
    }
  }
}

export async function createExperiment(
  input: ExperimentInput,
  initialStatus: ExperimentStatus = "proposed"
): Promise<ExperimentDoc> {
  const control = input.arms.find((a) => a.key === "control");
  if (!control) throw new Error("A 'control' arm is required");
  if (Object.keys(control.patch ?? {}).length > 0) throw new Error("Control arm patch must be empty");

  const db = await controlDb();
  const doc: ExperimentDoc = {
    ...input,
    status: initialStatus,
    createdAt: new Date(),
    statusHistory: [{ status: initialStatus, at: new Date() }],
  };
  const res = await db.collection("experiments").insertOne(doc as any);
  return { ...doc, _id: res.insertedId };
}

export async function getExperiment(id: string): Promise<ExperimentDoc | null> {
  const db = await controlDb();
  return (await db.collection("experiments").findOne({ _id: new ObjectId(id) })) as ExperimentDoc | null;
}

export async function listExperiments(filter: { tenantApiKey?: string; status?: string } = {}) {
  const db = await controlDb();
  const q: Record<string, unknown> = {};
  if (filter.tenantApiKey) q.tenantApiKey = filter.tenantApiKey;
  if (filter.status) q.status = filter.status;
  return db.collection("experiments").find(q).sort({ createdAt: -1 }).limit(200).toArray();
}

export async function transition(
  id: string,
  to: ExperimentStatus,
  by?: string,
  note?: string
): Promise<ExperimentDoc> {
  const exp = await getExperiment(id);
  if (!exp) throw new Error("Experiment not found");
  const allowed = TRANSITIONS[exp.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`Illegal transition ${exp.status} → ${to} (allowed: ${allowed.join(", ") || "none"})`);
  }

  if (to === "approved" || to === "running") {
    await assertNoConflict(exp, String(exp._id));
  }
  if (to === "running") {
    await ensureTenantExperimentIndexes(exp.dbName);
  }

  const db = await controlDb();
  await db.collection("experiments").updateOne(
    { _id: new ObjectId(id) },
    {
      $set: { status: to, ...(to === "approved" ? { approvedBy: by } : {}) },
      $push: { statusHistory: { status: to, at: new Date(), by, note } } as any,
    }
  );

  // Any transition into or out of "running" changes what the search hook must see.
  await publishActiveExperiments(exp.tenantApiKey);
  return (await getExperiment(id))!;
}
