// M2 verification: synthetic funnel data → aggregateExperiment → hand-checked numbers.
// Creates and drops db "so_metrics_test_db"; experiment doc is removed afterwards.
import assert from "node:assert";
import { getMongo, tenantDb, controlDb, ensureTenantExperimentIndexes } from "../src/core/db.js";
import { aggregateExperiment } from "../src/metrics/aggregate.js";
import { probVariantBeatsControlRps } from "../src/metrics/stats.js";
import { ExperimentDoc } from "../src/core/types.js";

const DB = "so_metrics_test_db";
const t0 = new Date(Date.now() - 3600_000);
const later = new Date(Date.now() - 1800_000);

const client = await getMongo();
await client.db(DB).dropDatabase();
await ensureTenantExperimentIndexes(DB);
const db = await tenantDb(DB);

const cdb = await controlDb();
const { insertedId } = await cdb.collection("experiments").insertOne({
  tenantApiKey: "so-metrics-test",
  dbName: DB,
  name: "metrics verification",
  hypothesis: "synthetic",
  source: "manual",
  type: "pin",
  targeting: { mode: "all", patterns: [], matchType: "contains" },
  layer: "default",
  arms: [
    { key: "control", weight: 1, patch: {} },
    { key: "v1", weight: 1, patch: {} },
  ],
  trafficPct: 100,
  guardrails: {},
  schedule: {},
  status: "running",
  createdAt: t0,
  statusHistory: [{ status: "running", at: t0 }],
} as any);

// control: 3 sessions, 4 searches, 2 clicks, 1 ATC session, 1 order of 100
// v1:      2 sessions, 2 searches, 3 clicks, 1 ATC session, 2 orders (50+30) in one session
const exposures = [
  { experiment_id: String(insertedId), arm: "control", session_id: "c1", query: "x", timestamp: later },
  { experiment_id: String(insertedId), arm: "control", session_id: "c2", query: "x", timestamp: later },
  { experiment_id: String(insertedId), arm: "control", session_id: "c3", query: "x", timestamp: later },
  { experiment_id: String(insertedId), arm: "v1", session_id: "v1s", query: "x", timestamp: later },
  { experiment_id: String(insertedId), arm: "v1", session_id: "v2s", query: "x", timestamp: later },
];
await db.collection("experiment_exposures").insertMany(exposures);
await db.collection("queries").insertMany([
  { query: "x", session_id: "c1", timestamp: later },
  { query: "x", session_id: "c1", timestamp: later },
  { query: "x", session_id: "c2", timestamp: later },
  { query: "x", session_id: "c3", timestamp: later },
  { query: "x", session_id: "v1s", timestamp: later },
  { query: "x", session_id: "v2s", timestamp: later },
]);
await db.collection("product_clicks").insertMany([
  { product_id: "p", session_id: "c1", timestamp: later },
  { product_id: "p", session_id: "c2", timestamp: later },
  { product_id: "p", session_id: "v1s", timestamp: later },
  { product_id: "p", session_id: "v1s", timestamp: later },
  { product_id: "p", session_id: "v2s", timestamp: later },
]);
// Production tenants store cart/checkout_events `timestamp` as an ISO string
// while queries/product_clicks use a BSON date — mirrored here (one Date in the
// mix) so the aggregator stays type-tolerant. A Date-only bound silently
// matched nothing here, reporting 0 add-to-carts and 0 orders forever.
await db.collection("cart").insertMany([
  { session_id: "c1", timestamp: later.toISOString() },
  { session_id: "v1s", timestamp: later },
]);
await db.collection("checkout_events").insertMany([
  { session_id: "c1", timestamp: later.toISOString(), orderData: { total_price: "100" } },
  { session_id: "v1s", timestamp: later.toISOString(), orderData: { total_price: "50" } },
  { session_id: "v1s", timestamp: later.toISOString(), orderData: { total_price: "30" } },
]);

const exp = (await cdb.collection("experiments").findOne({ _id: insertedId })) as unknown as ExperimentDoc;
const snap = await aggregateExperiment(exp);

const control = snap.arms.find((a) => a.arm === "control")!;
const v1 = snap.arms.find((a) => a.arm === "v1")!;

assert.equal(control.sessions, 3);
assert.equal(control.searches, 4);
assert.equal(control.clicks, 2);
assert.equal(control.clickSessions, 2, "c1 and c2 each clicked once");
assert.ok(Math.abs(control.clickRate - 2 / 3) < 1e-9);
assert.equal(control.atcSessions, 1);
assert.equal(control.orders, 1);
assert.equal(control.revenue, 100);
assert.ok(Math.abs(control.revenuePerSession - 100 / 3) < 1e-9);

assert.equal(v1.sessions, 2);
assert.equal(v1.searches, 2);
assert.equal(v1.clicks, 3);
assert.equal(v1.clickSessions, 2, "v1s clicked twice + v2s once = 2 clicking sessions");
assert.equal(v1.clickRate, 1);
assert.equal(v1.atcSessions, 1);
assert.equal(v1.orders, 1, "two orders in one session = 1 converting session");
assert.equal(v1.revenue, 80);
assert.equal(v1.revenuePerSession, 40);

assert.ok(snap.stats && snap.stats.probBestConv! > 0 && snap.stats.probBestConv! < 1);
assert.ok(
  snap.stats!.probBestClick! > 0 && snap.stats!.probBestClick! <= 1,
  "click-based P(win) must be computed so experiments stay decidable without order data"
);
assert.ok(snap.stats!.probBestRps != null, "revenue exists in this fixture, so rev/session P(win) is computable");
assert.equal(
  probVariantBeatsControlRps([0, 0, 0], [0, 0]),
  null,
  "no revenue in either arm must report no signal, not a spurious 100% for the variant"
);
assert.equal(snap.contaminationRate, 0);

console.log("METRICS-VERIFY-OK");
console.log(JSON.stringify(snap.arms, null, 2));

await client.db(DB).dropDatabase();
await cdb.collection("experiments").deleteOne({ _id: insertedId });
await cdb.collection("experiment_metrics").deleteMany({ experimentId: String(insertedId) });
process.exit(0);
