import { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { controlDb } from "../../core/db.js";
import { createExperiment, transition } from "../../engine/experiments.js";
import { CatalogFilterProposalDoc, ProposalDoc } from "../../core/types.js";
import { applyCatalogFilterChange } from "../../catalog/filters.js";
import { applyWithoutTest, isDirectlyApplicable } from "../../engine/promote.js";
import { siblingApiKeys } from "../../core/tenant.js";

type Proposal = ProposalDoc | CatalogFilterProposalDoc;

// When a caller scopes a request to a store (the client dashboard always
// does), a proposal belonging to another store is reported as not found.
async function ownedBy(proposal: Proposal, tenant?: string): Promise<boolean> {
  if (!tenant) return true;
  return (await siblingApiKeys(tenant)).includes(proposal.tenantApiKey);
}

async function findPending(id: string, tenant?: string): Promise<Proposal | null> {
  if (!ObjectId.isValid(id)) return null;
  const db = await controlDb();
  const proposal = (await db.collection("proposals").findOne({ _id: new ObjectId(id), status: "pending" })) as Proposal | null;
  return proposal && (await ownedBy(proposal, tenant)) ? proposal : null;
}

async function applyCatalogProposal(id: string, proposal: CatalogFilterProposalDoc, by: string | undefined, reply: any) {
  const db = await controlDb();
  const lock = await db.collection("proposals").updateOne(
    { _id: new ObjectId(id), status: "pending" },
    { $set: { status: "applying", reviewedBy: by, reviewedAt: new Date() } }
  );
  if (lock.modifiedCount !== 1) return reply.code(409).send({ error: "proposal is already being applied" });
  try {
    return await applyCatalogFilterChange({
      proposalId: id,
      tenantApiKey: proposal.tenantApiKey,
      dbName: proposal.dbName,
      change: proposal.catalogChange,
      by,
    });
  } catch (e) {
    await db.collection("proposals").updateOne(
      { _id: new ObjectId(id), status: "applying" },
      { $set: { status: "pending", applyError: (e as Error).message } }
    );
    return reply.code(409).send({ error: (e as Error).message });
  }
}

export async function proposalRoutes(app: FastifyInstance) {
  app.get("/proposals", async (req) => {
    const { status = "pending", tenant } = req.query as { status?: string; tenant?: string };
    const db = await controlDb();
    const q: Record<string, unknown> = { status };
    if (tenant) q.tenantApiKey = { $in: await siblingApiKeys(tenant) };
    return db.collection("proposals").find(q).sort({ createdAt: -1 }).limit(100).toArray();
  });

  app.post("/proposals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { by, start, tenant } = (req.body ?? {}) as { by?: string; start?: boolean; tenant?: string };
    const db = await controlDb();
    const proposal = await findPending(id, tenant);
    if (!proposal) return reply.code(404).send({ error: "pending proposal not found" });

    if (proposal.kind === "catalogFilter") return applyCatalogProposal(id, proposal, by, reply);

    const exp = await createExperiment({ ...proposal.draftExperiment, proposalId: id }, "approved");
    await db
      .collection("proposals")
      .updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved", reviewedBy: by, reviewedAt: new Date() } });

    // approve-and-start in one click from the UI
    if (start) return transition(String(exp._id), "running", by, "started on proposal approval");
    return exp;
  });

  // Accept a proposal as is: the change goes live for all traffic, no A/B test.
  app.post("/proposals/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { by, tenant } = (req.body ?? {}) as { by?: string; tenant?: string };
    const proposal = await findPending(id, tenant);
    if (!proposal) return reply.code(404).send({ error: "pending proposal not found" });

    if (proposal.kind === "catalogFilter") return applyCatalogProposal(id, proposal, by, reply);

    const variant = proposal.draftExperiment.arms.find((a) => a.key !== "control");
    if (!isDirectlyApplicable(variant?.patch)) {
      return reply.code(409).send({ error: "This change can only run as an A/B test" });
    }
    const db = await controlDb();
    const lock = await db.collection("proposals").updateOne(
      { _id: new ObjectId(id), status: "pending" },
      { $set: { status: "approved", reviewedBy: by, reviewedAt: new Date(), appliedWithoutTest: true } }
    );
    if (lock.modifiedCount !== 1) return reply.code(409).send({ error: "proposal was already reviewed" });
    const exp = await createExperiment({ ...proposal.draftExperiment, proposalId: id }, "approved");
    return applyWithoutTest(String(exp._id), by);
  });

  app.post("/proposals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { by, note, tenant } = (req.body ?? {}) as { by?: string; note?: string; tenant?: string };
    if (!(await findPending(id, tenant))) return reply.code(404).send({ error: "pending proposal not found" });
    const db = await controlDb();
    const res = await db
      .collection("proposals")
      .updateOne(
        { _id: new ObjectId(id), status: "pending" },
        { $set: { status: "rejected", reviewerNotes: note, reviewedBy: by, reviewedAt: new Date() } }
      );
    if (res.matchedCount === 0) return reply.code(404).send({ error: "pending proposal not found" });
    return { ok: true };
  });
}
