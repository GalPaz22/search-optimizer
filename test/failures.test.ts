import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWindow } from "../src/optimization/analytics.js";
import { compareRepair, prioritizeFailures } from "../src/optimization/failures.js";
import { DiagnosisInput } from "../src/optimization/diagnosis.js";

const start = new Date("2026-08-01T00:00:00Z"), end = new Date("2026-08-08T00:00:00Z");
function window(rows: { query: string; n: number; carted?: number; clicked?: number; zero?: boolean; missing?: boolean; taggedNoise?: number }[]) {
  const queries: any[] = [], carts: any[] = [], clicks: any[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const session_id = row.missing ? undefined : `${row.query}-${i}`;
      queries.push({ query: row.query, session_id, timestamp: "2026-08-03T10:00:00Z", deliveredProducts: row.zero ? [] : ["product"] });
      if (i < (row.carted ?? 0)) carts.push({ search_query: row.query, session_id, timestamp: "2026-08-03T10:01:00Z" });
      if (i < (row.clicked ?? 0)) clicks.push({ search_query: row.query, session_id, timestamp: "2026-08-03T10:01:00Z" });
    }
    for (let i = 0; i < (row.taggedNoise ?? 0); i++) carts.push({ search_query: row.query, session_id: "unrelated", timestamp: "2026-08-03T10:02:00Z" });
  }
  return analyzeWindow(queries, clicks, carts, start, end);
}
const empty = window([]);
test("high-volume healthy search does not outrank actual failing demand; tagged carts do not mask failure", () => {
  const current = window([{ query: "healthy", n: 500, carted: 300, clicked: 400 }, { query: "failure", n: 80, clicked: 40, taggedNoise: 200 }, { query: "small", n: 5, zero: true }]);
  const failures = prioritizeFailures(current, empty, false);
  assert.equal(failures[0].query, "failure");
  assert.equal(failures[0].metrics.cartIdentities, 0);
  assert.ok(failures[0].reasons.includes("no_attributed_carts"));
  assert.ok(!failures.some(f => f.query === "healthy"));
});
test("missing identifiers surface a measurement blocker, not a conversion failure", () => {
  const current = window([{ query: "missing", n: 100, missing: true }, { query: "healthy", n: 30, clicked: 20, carted: 10 }]);
  const issue = prioritizeFailures(current, empty, false).find(f => f.query === "missing")!;
  assert.equal(issue.measurementReliable, false);
  assert.deepEqual(issue.reasons, ["measurement_or_sample_gap"]);
  assert.equal(issue.score, 0);
});
test("regression only uses comparable tracking and adequate prior sample", () => {
  const before = window([{ query: "regressed", n: 100, carted: 60, clicked: 80 }]);
  const current = window([{ query: "regressed", n: 100, carted: 25, clicked: 50 }]);
  assert.ok(prioritizeFailures(current, before, true)[0].reasons.includes("cart_rate_regression"));
  assert.equal(prioritizeFailures(current, before, false).length, 0);
});
test("explicit zero results remain actionable even without click/cart tracking", () => {
  const issue = prioritizeFailures(window([{ query: "zero", n: 40, zero: true }]), empty, false)[0];
  assert.ok(issue.reasons.includes("zero_results"));
  assert.ok(issue.reasons.includes("measurement_or_sample_gap"));
  assert.equal(issue.score, 40);
});
test("repair comparison rejects overlapping windows and suppresses under-sampled deltas", () => {
  const before = window([{ query: "wine", n: 40, carted: 10, clicked: 20 }]);
  assert.throws(() => compareRepair("wine", before, before), /disjoint/);
  const after = { ...window([{ query: "wine", n: 5, carted: 3, clicked: 4 }]), start: end, end: new Date("2026-08-15T00:00:00Z") };
  const result = compareRepair("wine", before, after);
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.cartRateDelta, null);
});
test("adequate follow-up reports observational delta, not proven uplift", () => {
  const before = window([{ query: "wine", n: 40, carted: 10, clicked: 20 }]);
  const after = { ...window([{ query: "wine", n: 40, carted: 20, clicked: 30 }]), start: end, end: new Date("2026-08-15T00:00:00Z") };
  const result = compareRepair(" WINE ", before, after);
  assert.equal(result.status, "observed");
  assert.equal(result.cartRateDelta, .25);
  assert.match(result.interpretation, /not purchase conversion or causal uplift/);
});
test("action-ready diagnosis cannot be an unlinked generic note", () => {
  const input = { issueId: "a".repeat(24), status: "action_ready", cause: "ranking", evidence: "Observed irrelevant results across 80 searches.", nextStep: "Review and execute the exact saved repair." };
  assert.equal(DiagnosisInput.safeParse(input).success, false);
  assert.equal(DiagnosisInput.safeParse({ ...input, actionIds: ["b".repeat(24)] }).success, true);
});
