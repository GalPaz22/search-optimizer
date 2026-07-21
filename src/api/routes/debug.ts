import { FastifyInstance } from "fastify";
import { getRedis } from "../../core/db.js";
import { ACTIVE_KEY, publishActiveExperiments } from "../../engine/publisher.js";
import { ACTIVE_RULES_KEY, publishActiveRules } from "../../rules/publisher.js";

/** Small introspection surface for diagnosing "the Mongo state looks right
 * but production doesn't reflect it" — shows exactly what a client reading
 * the same Redis instance as dashboard-server would see for a tenant. */
export async function debugRoutes(app: FastifyInstance) {
  app.get("/debug/redis", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant) return reply.code(400).send({ error: "tenant (apiKey) query param required" });
    const redis = await getRedis();
    if (!redis) return reply.code(503).send({ error: "Redis unavailable from this service right now" });

    const [expRaw, rulesRaw] = await Promise.all([redis.get(ACTIVE_KEY(tenant)), redis.get(ACTIVE_RULES_KEY(tenant))]);
    return {
      experimentsKey: ACTIVE_KEY(tenant),
      experiments: expRaw ? JSON.parse(expRaw) : null,
      rulesKey: ACTIVE_RULES_KEY(tenant),
      rules: rulesRaw ? JSON.parse(rulesRaw) : null,
    };
  });

  app.post("/debug/republish", async (req, reply) => {
    const { tenant } = req.query as { tenant?: string };
    if (!tenant) return reply.code(400).send({ error: "tenant (apiKey) query param required" });
    await Promise.all([publishActiveExperiments(tenant), publishActiveRules(tenant)]);
    const redis = await getRedis();
    if (!redis) return reply.code(503).send({ error: "Redis unavailable from this service right now" });
    const [expRaw, rulesRaw] = await Promise.all([redis.get(ACTIVE_KEY(tenant)), redis.get(ACTIVE_RULES_KEY(tenant))]);
    return {
      republished: true,
      experiments: expRaw ? JSON.parse(expRaw) : null,
      rules: rulesRaw ? JSON.parse(rulesRaw) : null,
    };
  });
}
