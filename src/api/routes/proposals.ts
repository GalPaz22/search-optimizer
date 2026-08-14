import { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { controlDb } from "../../core/db.js";
import { createExperiment, transition } from "../../engine/experiments.js";
import { CatalogFilterProposalDoc, ProposalDoc } from "../../core/types.js";
import { applyCatalogFilterChange } from "../../catalog/filters.js";

export async function proposalRoutes(app: FastifyInstance) {
  app.get("/proposals", async (req) => {
    const { status = "pending", tenant } = req.query as { status?: string; tenant?: string };
    const db = await controlDb();
    const q: Record<string, unknown> = { status };
    if (tenant) q.tenantApiKey = tenant;
    return db.collection("proposals").find(q).sort({ createdAt: -1 }).limit(100).toArray();
  });

  app.post("/proposals/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { by, start } = (req.body ?? {}) as { by?: string; start?: boolean };
    const db = await controlDb();
    const proposal = (await db
      .collection("proposals")
      .findOne({ _id: new ObjectId(id), status: "pending" })) as ProposalDoc | CatalogFilterProposalDoc | null;
    if (!proposal) return reply.code(404).send({ error: "pending proposal not found" });

    if (proposal.kind === "catalogFilter") {
      const lock = await db.collection("proposals").updateOne(
        { _id: new ObjectId(id), status: "pending" },
        { $set: { status: "applying", reviewedBy: by, reviewedAt: new Date() } }
      );
      if (lock.modifiedCount !== 1) return reply.code(409).send({ error: "proposal is already being applied" });
      try {
        const result = await applyCatalogFilterChange({
          proposalId: id,
          tenantApiKey: proposal.tenantApiKey,
          dbName: proposal.dbName,
          change: proposal.catalogChange,
          by,
        });
        return result;
      } catch (e) {
        await db.collection("proposals").updateOne(
          { _id: new ObjectId(id), status: "applying" },
          { $set: { status: "pending", applyError: (e as Error).message } }
        );
        return reply.code(409).send({ error: (e as Error).message });
      }
    }

    const exp = await createExperiment({ ...proposal.draftExperiment, proposalId: id }, "approved");
    await db
      .collection("proposals")
      .updateOne({ _id: new ObjectId(id) }, { $set: { status: "approved", reviewedBy: by, reviewedAt: new Date() } });

    // approve-and-start in one click from the UI
    if (start) return transition(String(exp._id), "running", by, "started on proposal approval");
    return exp;
  });

  app.post("/proposals/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { by, note } = (req.body ?? {}) as { by?: string; note?: string };
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
