import { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { controlDb } from "../../core/db.js";
import { getTenantByApiKey, storeProfile } from "../../core/tenant.js";
import { buildConversionReport, latestConversionReports } from "../../analytics/report.js";

export async function conversionRoutes(app: FastifyInstance) {
  const store = async (req: any, reply: any) => {
    const t = req.query?.tenant ? await getTenantByApiKey(String(req.query.tenant)) : null;
    if (!t) reply.code(400).send({ error: "Select a valid store" });
    return t;
  };

  /** Latest data report, latest agent report (with the live status of what it linked) and the active run. */
  app.get("/conversion", async (req, reply) => {
    const t = await store(req, reply);
    if (!t) return;
    const cdb = await controlDb();
    const [reports, profile, run] = await Promise.all([
      latestConversionReports(t.dbName), storeProfile(t.dbName),
      cdb.collection("agent_runs").find({ dbName: t.dbName }).sort({ startedAt: -1 }).limit(1).project({ steps: 0 }).next(),
    ]);
    const proposals = reports.agent?.proposals ?? [];
    const actionIds = [...new Set(proposals.flatMap((p: any) => p.actionIds ?? []))] as string[], proposalIds = [...new Set(proposals.flatMap((p: any) => p.proposalIds ?? []))] as string[];
    const [actions, linkedProposals] = await Promise.all([
      actionIds.length ? cdb.collection("optimization_actions").find({ _id: { $in: actionIds.map(id => new ObjectId(id)) }, dbName: t.dbName }).project({ title: 1, status: 1, kind: 1, query: 1 }).toArray() : [],
      proposalIds.length ? cdb.collection("proposals").find({ _id: { $in: proposalIds.map(id => new ObjectId(id)) } }).project({ status: 1, kind: 1, "draftExperiment.name": 1, "draftRule.name": 1, "catalogChange.filter": 1 }).toArray() : [],
    ]);
    return { store: profile, ...reports, linked: { actions, proposals: linkedProposals }, run };
  });

  /** Rebuild the deterministic report now (read-only on the tenant; no model calls). */
  app.post("/conversion/refresh", async (req, reply) => {
    const t = await store(req, reply);
    if (!t) return;
    const days = Number((req.query as any).days ?? 30);
    try { return await buildConversionReport(t, { days }); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
}
