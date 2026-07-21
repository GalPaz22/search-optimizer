import { controlDb, getRedis } from "../core/db.js";
import { ActiveExperimentWire, ExperimentDoc } from "../core/types.js";

export const ACTIVE_KEY = (apiKey: string) => `experiments:active:${apiKey}`;
const ACTIVE_TTL_SECONDS = 120; // refreshed every 30s by cron; TTL bounds staleness if we die

export function toWire(exp: ExperimentDoc): ActiveExperimentWire {
  return {
    id: String(exp._id),
    layer: exp.layer,
    targeting: exp.targeting,
    trafficPct: exp.trafficPct,
    arms: exp.arms.map((a) => ({ key: a.key, weight: a.weight, patch: a.patch ?? {} })),
  };
}

/** Rewrites experiments:active:{apiKey} in Redis from Mongo truth. */
export async function publishActiveExperiments(apiKey: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) {
    console.warn("[publisher] Redis unavailable; hook will serve control");
    return;
  }
  const db = await controlDb();
  const running = (await db
    .collection("experiments")
    .find({ tenantApiKey: apiKey, status: "running" })
    .toArray()) as unknown as ExperimentDoc[];

  const key = ACTIVE_KEY(apiKey);
  if (running.length === 0) {
    await redis.del(key);
    return;
  }
  await redis.set(key, JSON.stringify(running.map(toWire)), { EX: ACTIVE_TTL_SECONDS });
}

/** Cron target: refresh keys for every tenant with running experiments. */
export async function refreshAllActiveKeys(): Promise<void> {
  const db = await controlDb();
  const apiKeys: string[] = await db.collection("experiments").distinct("tenantApiKey", { status: "running" });
  for (const apiKey of apiKeys) {
    try {
      await publishActiveExperiments(apiKey);
    } catch (e) {
      console.error(`[publisher] refresh failed for ${apiKey}:`, (e as Error).message);
    }
  }
}
