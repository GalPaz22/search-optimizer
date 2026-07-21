import { FastifyInstance } from "fastify";
import { controlDb } from "../../core/db.js";
import { getMonthlySpend, MONTHLY_BUDGET_USD, runAgentForTenant } from "../../agent/runner.js";

export async function agentRoutes(app: FastifyInstance) {
  app.post("/agent/run", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant) return reply.code(400).send({ error: "tenant (apiKey) query param required" });
    try {
      return await runAgentForTenant(tenant);
    } catch (e) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  app.get("/agent/runs", async (req) => {
    const { tenant } = req.query as { tenant?: string };
    const db = await controlDb();
    const q = tenant ? { tenantApiKey: tenant } : {};
    return db.collection("agent_runs").find(q).sort({ startedAt: -1 }).limit(50).toArray();
  });

  app.get("/agent/spend", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant) return reply.code(400).send({ error: "tenant (apiKey) query param required" });
    const db = await controlDb();
    const spent = await getMonthlySpend(db, tenant);
    return { spentUsd: spent, budgetUsd: MONTHLY_BUDGET_USD, remainingUsd: Math.max(0, MONTHLY_BUDGET_USD - spent) };
  });
}
