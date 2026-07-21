import { controlDb, getRedis } from "../core/db.js";
import { ActiveRuleWire, RuleDoc } from "../core/types.js";

export const ACTIVE_RULES_KEY = (apiKey: string) => `rules:active:${apiKey}`;
const ACTIVE_TTL_SECONDS = 120; // refreshed every 30s by cron; TTL bounds staleness if we die

function toWire(rule: RuleDoc): ActiveRuleWire {
  return { id: String(rule._id), condition: rule.condition, patch: rule.patch };
}

/** Rewrites rules:active:{apiKey} in Redis from Mongo truth. */
export async function publishActiveRules(apiKey: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    console.warn("[rules publisher] Redis unavailable; hook will serve unmodified store");
    return;
  }
  const db = await controlDb();
  const active = (await db
    .collection("rules")
    .find({ tenantApiKey: apiKey, status: "active" })
    .toArray()) as unknown as RuleDoc[];

  const key = ACTIVE_RULES_KEY(apiKey);
  if (active.length === 0) {
    await redis.del(key);
    return;
  }
  await redis.set(key, JSON.stringify(active.map(toWire)), { EX: ACTIVE_TTL_SECONDS });
}

/** Cron target: refresh keys for every tenant with active rules. */
export async function refreshAllActiveRuleKeys(): Promise<void> {
  const db = await controlDb();
  const apiKeys: string[] = await db.collection("rules").distinct("tenantApiKey", { status: "active" });
  for (const apiKey of apiKeys) {
    try {
      await publishActiveRules(apiKey);
    } catch (e) {
      console.error(`[rules publisher] refresh failed for ${apiKey}:`, (e as Error).message);
    }
  }
}
