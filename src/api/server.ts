import Fastify from "fastify";
import basicAuth from "@fastify/basic-auth";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimentRoutes } from "./routes/experiments.js";
import { proposalRoutes } from "./routes/proposals.js";
import { metricsRoutes } from "./routes/metrics.js";
import { agentRoutes } from "./routes/agent.js";
import { ruleRoutes } from "./routes/rules.js";
import { optimizationRoutes } from "./routes/optimization.js";
import { debugRoutes } from "./routes/debug.js";
import { listTenants } from "../core/tenant.js";
import { getMongo, getRedis } from "../core/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildServer() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });

  const opsPassword = process.env.OPS_PASSWORD;
  if (opsPassword) {
    await app.register(basicAuth, {
      validate: async (username, password) => {
        if (password !== opsPassword) throw new Error("Unauthorized");
      },
      authenticate: { realm: "search-optimizer" },
    });
    app.addHook("onRequest", function (req: any, reply: any, done: any) {
      // UI static assets stay open; /api/health stays open too (Render's own
      // health checker hits it without credentials); everything else under
      // /api/* requires auth.
      if (req.url.startsWith("/api/") && req.url !== "/api/health") {
        return (app as any).basicAuth(req, reply, done);
      }
      done();
    } as any);
  } else {
    app.log.warn("OPS_PASSWORD not set — API is unauthenticated (dev only)");
  }

  // Unauthenticated on purpose (Render's health checker hits this with no
  // credentials) — mirrors dashboard-server's /health shape: booleans only,
  // no connection strings or other sensitive detail.
  app.get("/api/health", async () => {
    const [redis, mongoOk] = await Promise.all([
      getRedis(),
      getMongo()
        .then((c) => c.db("admin").command({ ping: 1 }))
        .then(() => true)
        .catch(() => false),
    ]);
    return {
      ok: true,
      ts: new Date().toISOString(),
      services: {
        redis: { connected: !!redis?.isOpen },
        mongodb: { connected: mongoOk },
      },
    };
  });
  app.get("/api/tenants", async () => listTenants());

  await app.register(experimentRoutes, { prefix: "/api" });
  await app.register(proposalRoutes, { prefix: "/api" });
  await app.register(metricsRoutes, { prefix: "/api" });
  await app.register(agentRoutes, { prefix: "/api" });
  await app.register(ruleRoutes, { prefix: "/api" });
  await app.register(debugRoutes, { prefix: "/api" });

  await app.register(optimizationRoutes, { prefix: "/api" });

  // Serve built ops UI if present
  const uiDist = path.resolve(__dirname, "../../ui/dist");
  try {
    await app.register(fastifyStatic, { root: uiDist, wildcard: false });
  } catch {
    app.log.warn("ops UI not built (ui/dist missing) — API-only mode");
  }
  app.setNotFoundHandler((req, reply) => {
    if (!req.url.startsWith("/api/")) return (reply as any).sendFile?.("index.html") ?? reply.code(404).send();
    reply.code(404).send({ error: "not found" });
  });

  return app;
}
