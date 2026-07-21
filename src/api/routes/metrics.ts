import { FastifyInstance } from "fastify";
import { controlDb } from "../../core/db.js";
import { getExperiment } from "../../engine/experiments.js";
import { aggregateExperiment } from "../../metrics/aggregate.js";
import { ExperimentDoc } from "../../core/types.js";

export async function metricsRoutes(app: FastifyInstance) {
  app.get("/experiments/:id/metrics", async (req, reply) => {
    const { id } = req.params as { id: string };
    const db = await controlDb();
    const history = await db
      .collection("experiment_metrics")
      .find({ experimentId: id })
      .sort({ asOf: -1 })
      .limit(50)
      .toArray();
    return { latest: history[0] ?? null, history };
  });

  app.post("/experiments/:id/metrics/refresh", async (req, reply) => {
    const exp = await getExperiment((req.params as any).id);
    if (!exp) return reply.code(404).send({ error: "not found" });
    return aggregateExperiment(exp as ExperimentDoc);
  });
}
