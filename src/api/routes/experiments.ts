import { FastifyInstance } from "fastify";
import { ExperimentInput } from "../../core/types.js";
import {
  ConflictError,
  createExperiment,
  getExperiment,
  listExperiments,
  transition,
} from "../../engine/experiments.js";
import { promoteExperiment } from "../../engine/promote.js";

const ACTIONS: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  start: "running",
  pause: "paused",
  resume: "running",
  kill: "killed",
  complete: "completed",
};

export async function experimentRoutes(app: FastifyInstance) {
  app.get("/experiments", async (req) => {
    const { tenant, status } = req.query as { tenant?: string; status?: string };
    return listExperiments({ tenantApiKey: tenant, status });
  });

  app.post("/experiments", async (req, reply) => {
    const parsed = ExperimentInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const status = (req.query as any)?.status === "approved" ? "approved" : "proposed";
    return createExperiment(parsed.data, status);
  });

  app.get("/experiments/:id", async (req, reply) => {
    const exp = await getExperiment((req.params as any).id);
    if (!exp) return reply.code(404).send({ error: "not found" });
    return exp;
  });

  app.post("/experiments/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    const { by, note } = (req.body ?? {}) as { by?: string; note?: string };

    if (action === "promote") {
      try {
        return await promoteExperiment(id, by);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }

    const to = ACTIONS[action];
    if (!to) return reply.code(400).send({ error: `unknown action '${action}'` });
    try {
      return await transition(id, to as any, by, note);
    } catch (e) {
      const code = e instanceof ConflictError ? 409 : 400;
      return reply.code(code).send({ error: (e as Error).message });
    }
  });
}
