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
