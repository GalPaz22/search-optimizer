import { coreUsersDb } from "./db.js";

export interface Tenant {
  apiKey: string;
  dbName: string;
  context?: string;
  softCategories?: unknown;
  softCategoriesBoosted?: Record<string, number>;
  pinnedResults?: unknown[];
}

export async function listTenants(): Promise<Tenant[]> {
  const db = await coreUsersDb();
  const docs = await db
    .collection("users")
    .find({ apiKey: { $exists: true }, dbName: { $exists: true } })
    .project({ apiKey: 1, dbName: 1, context: 1, "credentials.softCategoriesBoosted": 1, "credentials.pinnedResults": 1 })
    .toArray();
  return docs.map((d: any) => ({
    apiKey: d.apiKey,
    dbName: d.dbName,
    context: d.context,
    softCategoriesBoosted: d.credentials?.softCategoriesBoosted,
    pinnedResults: d.credentials?.pinnedResults,
  }));
}

/**
 * All user apiKeys that resolve to the same tenant dbName as the given key.
 * A store can have several user docs (e.g. separate search and tracking keys,
 * as manoVino does); dashboard-server's hook reads Redis under whichever key
 * the request authenticated with, so published state must exist under all of
 * them. Falls back to [apiKey] when the user doc is missing.
 */
export async function siblingApiKeys(apiKey: string): Promise<string[]> {
  const db = await coreUsersDb();
  const me: any = await db.collection("users").findOne({ apiKey }, { projection: { dbName: 1 } });
  if (!me?.dbName) return [apiKey];
  const docs = await db
    .collection("users")
    .find({ dbName: me.dbName, apiKey: { $exists: true } })
    .project({ apiKey: 1 })
    .toArray();
  const keys = new Set<string>(docs.map((d: any) => d.apiKey).filter(Boolean));
  keys.add(apiKey);
  return [...keys];
}

export async function getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
  const db = await coreUsersDb();
  const d: any = await db.collection("users").findOne({ apiKey });
  if (!d) return null;
  return {
    apiKey: d.apiKey,
    dbName: d.dbName,
    context: d.context,
    softCategoriesBoosted: d.credentials?.softCategoriesBoosted,
    pinnedResults: d.credentials?.pinnedResults,
  };
}
