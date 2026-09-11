import { MongoClient, Db } from "mongodb";
import { createClient, RedisClientType } from "redis";
import "dotenv/config";

const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) throw new Error("MONGODB_URI is required");

let client: MongoClient | null = null;

export async function getMongo(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(mongoUri!, { maxPoolSize: 10 });
    await client.connect();
  }
  return client;
}

export async function controlDb(): Promise<Db> {
  return (await getMongo()).db("control_plane");
}

export async function coreUsersDb(): Promise<Db> {
  return (await getMongo()).db("users");
}

export async function tenantDb(dbName: string): Promise<Db> {
  return (await getMongo()).db(dbName);
}

let redis: RedisClientType | null = null;
let redisLastFailAt = 0;
const REDIS_RETRY_COOLDOWN_MS = 30_000;

export async function getRedis(): Promise<RedisClientType | null> {
  if (redis?.isOpen) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (Date.now() - redisLastFailAt < REDIS_RETRY_COOLDOWN_MS) return null;
  try {
    redis = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: (retries) => (retries > 2 ? false : 500),
      },
    });
    redis.on("error", (e) => console.error("[redis]", e.message));
    // Never let a dead Redis block an API call — publish is best-effort.
    await Promise.race([
      redis.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("redis connect timeout")), 4000)),
    ]);
    return redis;
  } catch (e) {
    console.error("[redis] connect failed:", (e as Error).message);
    redisLastFailAt = Date.now();
    try { await redis?.disconnect(); } catch {}
    redis = null;
    return null;
  }
}

export async function ensureIndexes(): Promise<void> {
  const db = await controlDb();
  await db.collection("optimization_policies").createIndex({ dbName: 1 }, { unique: true });
  await db.collection("optimization_reports").createIndex({ dbName: 1, generatedAt: -1 });
  await db.collection("optimization_actions").createIndex({ dbName: 1, status: 1, createdAt: -1 });
  await db.collection("optimization_actions").createIndex({ dbName: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["pending", "applying", "dispatch_pending", "reprocessing", "verifying"] } } });
  await db.collection("experiments").createIndex({ tenantApiKey: 1, status: 1 });
  await db.collection("proposals").createIndex({ tenantApiKey: 1, status: 1 });
  await db.collection("experiment_metrics").createIndex({ experimentId: 1, asOf: -1 });
  await db.collection("agent_runs").createIndex({ tenantApiKey: 1, startedAt: -1 });
  await db.collection("rules").createIndex({ tenantApiKey: 1, status: 1 });
  await db.collection("catalog_change_audits").createIndex({ tenantApiKey: 1, appliedAt: -1 });
}

/** Tenant-side index; called lazily when an experiment starts for that tenant. */
export async function ensureTenantExperimentIndexes(dbName: string): Promise<void> {
  const db = await tenantDb(dbName);
  await db
    .collection("experiment_exposures")
    .createIndex({ experiment_id: 1, session_id: 1 }, { unique: true });
  await db.collection("experiment_exposures").createIndex({ experiment_id: 1, arm: 1 });
  await db.collection("session_aliases").createIndex({ old_session_id: 1 });
}

/** Tenant-side index; called lazily when a rule goes active for that tenant. */
export async function ensureTenantRuleIndexes(dbName: string): Promise<void> {
  const db = await tenantDb(dbName);
  await db.collection("rule_applications").createIndex({ rule_id: 1, date: 1 }, { unique: true });
}
