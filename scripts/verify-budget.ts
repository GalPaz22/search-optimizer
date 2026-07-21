// Verifies the $20/tenant monthly agent budget: seeds synthetic agent_runs
// costs in control_plane, confirms getMonthlySpend sums correctly, and that
// runAgentForTenant refuses to call the SDK once the budget is hit (returns a
// skipped_budget row instead of an actual run — no live API cost incurred).
import assert from "node:assert";
import { controlDb, getMongo } from "../src/core/db.js";
import { getMonthlySpend, runAgentForTenant, MONTHLY_BUDGET_USD } from "../src/agent/runner.js";

const FAKE_API_KEY = "so-budget-test-tenant";
const cdb = await controlDb();

await cdb.collection("agent_runs").deleteMany({ tenantApiKey: FAKE_API_KEY });

const now = new Date();
const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5);

await cdb.collection("agent_runs").insertMany([
  { tenantApiKey: FAKE_API_KEY, startedAt: thisMonth, status: "completed", costUsd: 7.5, toolCalls: 10, proposals: 1 },
  { tenantApiKey: FAKE_API_KEY, startedAt: thisMonth, status: "completed", costUsd: 6.0, toolCalls: 8, proposals: 0 },
  // last month's spend must NOT count toward this month's budget
  { tenantApiKey: FAKE_API_KEY, startedAt: lastMonth, status: "completed", costUsd: 100, toolCalls: 5, proposals: 2 },
]);

const spend = await getMonthlySpend(cdb, FAKE_API_KEY, now);
assert.ok(Math.abs(spend - 13.5) < 1e-9, `expected $13.50 spent this month, got $${spend}`);
assert.ok(spend < MONTHLY_BUDGET_USD, "test setup should still be under budget at this point");
console.log(`OK: monthly spend correctly sums to $${spend.toFixed(2)} (excludes last month's $100)`);

// Push over budget and confirm the agent refuses to run (no SDK call, no API key needed)
await cdb.collection("agent_runs").insertOne({
  tenantApiKey: FAKE_API_KEY,
  startedAt: thisMonth,
  status: "completed",
  costUsd: 10,
  toolCalls: 5,
  proposals: 0,
});
const spendAfter = await getMonthlySpend(cdb, FAKE_API_KEY, now);
assert.ok(spendAfter >= MONTHLY_BUDGET_USD, `expected to be at/over $${MONTHLY_BUDGET_USD} budget, got $${spendAfter}`);

let threw = false;
try {
  // FAKE_API_KEY doesn't exist in the real users collection — if the budget
  // check didn't short-circuit before the tenant lookup, this would throw
  // "Unknown tenant apiKey" instead of returning a clean skip.
  const result = await runAgentForTenant(FAKE_API_KEY);
  assert.ok(result.summary.includes("Skipped"), `expected a skip summary, got: ${result.summary}`);
  assert.ok(result.summary.includes("budget"), "skip summary should mention budget");
} catch (e) {
  threw = true;
  console.error("UNEXPECTED THROW:", (e as Error).message);
}
assert.equal(threw, false, "over-budget run must return cleanly, not throw (and must not reach getTenantByApiKey/SDK)");

const skippedRow = await cdb
  .collection("agent_runs")
  .findOne({ tenantApiKey: FAKE_API_KEY, status: "skipped_budget" });
assert.ok(skippedRow, "a skipped_budget row must be recorded for ops-UI visibility");

console.log("BUDGET-VERIFY-OK");

await cdb.collection("agent_runs").deleteMany({ tenantApiKey: FAKE_API_KEY });
await (await getMongo()).close();
process.exit(0);
