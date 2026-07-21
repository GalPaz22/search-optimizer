import { FastifyInstance } from "fastify";
import { controlDb } from "../../core/db.js";
import { getTenantByApiKey } from "../../core/tenant.js";
import { parseRuleText } from "../../rules/parse.js";
import { createRule, deleteRule, getRuleTriggerCounts, listRules, setRuleStatus } from "../../rules/engine.js";
import { ArmPatch, ExperimentInput, ExperimentType, RuleInput, Targeting } from "../../core/types.js";

function inferExperimentType(patch: ArmPatch): ExperimentType {
  if (patch.categoryAssociation) return "categoryRule";
  if (patch.pinnedResults) return "pin";
  if (patch.softCategoriesBoost) return "softCategoryBoost";
  if (patch.productBoosts) return "boost";
  if (patch.profileBoostMultiplier != null) return "personalizationWeight";
  return "boost";
}

export async function ruleRoutes(app: FastifyInstance) {
  app.post("/rules/parse", async (req, reply) => {
    const { tenantApiKey, text } = (req.body ?? {}) as { tenantApiKey?: string; text?: string };
    if (!tenantApiKey || !text) return reply.code(400).send({ error: "tenantApiKey and text are required" });
    const tenant = await getTenantByApiKey(tenantApiKey);
    if (!tenant) return reply.code(404).send({ error: "unknown tenant" });
    try {
      const draft = await parseRuleText(tenant, text);
      return draft;
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  app.get("/rules", async (req) => {
    const { tenant } = req.query as { tenant?: string };
    const rules = await listRules({ tenantApiKey: tenant });
    const withCounts = await Promise.all(
      rules.map(async (r) => ({ ...r, last24hTriggers: await getRuleTriggerCounts(r).catch(() => 0) }))
    );
    return withCounts;
  });

  app.post("/rules", async (req, reply) => {
    const body = req.body as {
      tenantApiKey: string;
      dbName: string;
      name: string;
      naturalLanguageText: string;
      condition: Targeting;
      patch: ArmPatch;
      mode: "permanent" | "experiment";
      trafficPct?: number;
    };

    if (body.mode === "experiment") {
      const draftExperiment: ExperimentInput = ExperimentInput.parse({
        tenantApiKey: body.tenantApiKey,
        dbName: body.dbName,
        name: body.name,
        hypothesis: body.naturalLanguageText,
        source: "nl",
        type: inferExperimentType(body.patch),
        targeting: body.condition,
        arms: [
          { key: "control", weight: 1, patch: {} },
          { key: "v1", weight: 1, patch: body.patch },
        ],
        trafficPct: body.trafficPct ?? 50,
      });
      // Route through the same proposals flow as agent-authored suggestions —
      // it already has approve/reject/approve-and-start wired in the ops UI.
      const cdb = await controlDb();
      const res = await cdb.collection("proposals").insertOne({
        tenantApiKey: body.tenantApiKey,
        hypothesis: `(manually authored rule) ${body.naturalLanguageText}`,
        evidence: { source: "Rules tab", naturalLanguageText: body.naturalLanguageText },
        draftExperiment,
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 86400_000),
      });
      return { mode: "experiment", proposalId: String(res.insertedId) };
    }

    const parsed = RuleInput.safeParse({
      tenantApiKey: body.tenantApiKey,
      dbName: body.dbName,
      name: body.name,
      naturalLanguageText: body.naturalLanguageText,
      condition: body.condition,
      patch: body.patch,
    });
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const rule = await createRule(parsed.data);
    return { mode: "permanent", rule };
  });

  app.post("/rules/:id/:action", async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    try {
      if (action === "enable") return await setRuleStatus(id, "active");
      if (action === "disable") return await setRuleStatus(id, "disabled");
      return reply.code(400).send({ error: `unknown action '${action}'` });
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.delete("/rules/:id", async (req, reply) => {
    try {
      await deleteRule((req.params as { id: string }).id);
      return { ok: true };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });
}
