import { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { controlDb } from "../../core/db.js";
import { getTenantByApiKey } from "../../core/tenant.js";
import { createAction, executeAction, reconcileAction } from "../../optimization/actions.js";
import { collectDailyReport, latestReport } from "../../optimization/service.js";

export async function optimizationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant || !(await getTenantByApiKey(tenant))) return reply.code(400).send({ error: "Select a valid store" });
  });
  const store = async (req: any) => (await getTenantByApiKey(req.query.tenant))!;
  app.get("/optimization", async req => {
    const t = await store(req), db = await controlDb();
    const [report, actions, policy, review] = await Promise.all([
      latestReport(t.dbName),
      db.collection("optimization_actions").find({ dbName: t.dbName }).sort({ createdAt: -1 }).limit(100).toArray(),
      db.collection("optimization_policies").findOne({ dbName: t.dbName }),
      db.collection("agent_runs").find({ $or: [{ dbName: t.dbName }, { tenantApiKey: t.apiKey }], status: "completed" }).sort({ startedAt: -1 }).limit(1).project({ summary: 1, startedAt: 1, actions: 1, proposals: 1 }).next(),
    ]);
    return { report, actions, policy, review, reprocessConfigured: Boolean(process.env.REPROCESS_SERVICE_URL) };
  });
  app.post("/optimization/report", async req => collectDailyReport(await store(req)));
  app.post("/optimization/actions", async (req, reply) => {
    try { return await createAction(await store(req), req.body); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post("/optimization/actions/:id/:operation", async (req, reply) => {
    const { id, operation } = req.params as { id: string; operation: string };
    if (!ObjectId.isValid(id)) return reply.code(400).send({ error: "Invalid action id" });
    const t = await store(req);
    try {
      if (operation === "execute") return await executeAction(id, t.apiKey);
      if (operation === "verify") return await reconcileAction(id, t.dbName);
      if (operation === "dismiss") {
        const r = await (await controlDb()).collection("optimization_actions").updateOne({ _id: new ObjectId(id), dbName: t.dbName, status: "pending" }, { $set: { status: "dismissed", dismissedAt: new Date() } });
        if (!r.modifiedCount) return reply.code(409).send({ error: "Pending action not found" });
        return { ok: true };
      }
      return reply.code(400).send({ error: "Unknown operation" });
    } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.put("/optimization/policy", async (req, reply) => {
    const parsed = z.object({ enabled: z.boolean(), agentEnabled: z.boolean(), autoExecuteCatalog: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const t = await store(req);
    await (await controlDb()).collection("optimization_policies").updateOne({ dbName: t.dbName }, { $set: { ...parsed.data, tenantApiKey: t.apiKey, updatedAt: new Date() }, $setOnInsert: { nextRunAt: new Date() } }, { upsert: true });
    return { ok: true };
  });
}
