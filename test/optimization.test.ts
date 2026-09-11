import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWindow, normalizeQuery, dateRange } from "../src/optimization/analytics.js";
import { ActionInput, alcoholFreeEvidence } from "../src/optimization/actions.js";

const start = new Date("2026-09-01T00:00:00Z"), end = new Date("2026-09-08T00:00:00Z");
const event = (minute: number, fields: Record<string, unknown>) => ({ timestamp: new Date(+start + minute * 60_000), ...fields });
test("attribution excludes preceding, other-query, stale, direct and unidentified actions", () => {
  const q = [event(10, { query: " ZIN  ", session_id: "a", deliveredProducts: ["wine"] }), event(20, { query: "zin", sessionId: "b", deliveredProducts: [] }), event(25, { query: "zin", deliveredProducts: ["wine"] })];
  const c = [event(9, { session_id: "a", search_query: "zin" }), event(12, { session_id: "a", search_query: "direct" }), event(13, { session_id: "a", search_query: "gin" }), event(41, { session_id: "a", search_query: "zin" }), event(15, { session_id: "x", search_query: "zin" }), event(15, { search_query: "zin" }), event(50, { sessionId: "b", search_query: " ZIN " })];
  const r = analyzeWindow(q, [], c, start, end);
  assert.equal(r.identities, 2); assert.equal(r.missingSession, 1); assert.equal(r.cartIdentities, 1); assert.equal(r.cartRate, 0.5); assert.equal(r.attributedCartEvents, 1); assert.equal(r.terms[0].zeroResults, 1);
});
test("no click-selected fallback and no imaginary zero-result count", () => {
  const r = analyzeWindow([event(10, { query: "x" })], [event(11, { search_query: "x", session_id: "a" })], [], start, end);
  assert.equal(r.identities, 0); assert.equal(r.clickRate, null); assert.equal(r.terms[0].zeroResults, 0);
});
test("repeated cart events do not inflate identifier rates", () => {
  const r = analyzeWindow([event(0, { query: "x", session_id: "a" })], [], [1, 2, 3].map(m => event(m, { search_query: "x", session_id: "a" })), start, end);
  assert.equal(r.cartRate, 1); assert.equal(r.attributedCartEvents, 3);
});
test("timestamp range supports BSON and ISO strings; query normalization preserves language", () => {
  assert.equal(dateRange(start, end).$or.length, 2); assert.equal(normalizeQuery("  יין   ללא אלכוהול "), "יין ללא אלכוהול");
});
test("alcohol-free wine rejects alcohol, soda and missing evidence", () => {
  assert.equal(alcoholFreeEvidence({ name: "יין ללא אלכוהול", description: "אחוז אלכוהול: 11.50%" }, true).ok, false);
  assert.equal(alcoholFreeEvidence({ name: "היביסקוס ללא אלכוהול", category: ["יין"], description: "סודה; אחוז אלכוהול: 0" }, true).ok, false);
  assert.equal(alcoholFreeEvidence({ name: "יין לבן" }, true).ok, false);
  assert.equal(alcoholFreeEvidence({ name: "יין ללא אלכוהול", description: "אחוז אלכוהול: 0%" }, true).ok, true);
  assert.equal(alcoholFreeEvidence({ name: "משקה ללא אלכוהול", description: "אחוז אלכוהול: 0" }, false).ok, true);
});
test("executable actions cannot have empty or contradictory scopes", () => {
  const base = { title: "test action", query: "wine", rationale: "Source-backed product classification repair", evidence: {} };
  assert.equal(ActionInput.safeParse({ ...base, kind: "catalogRepair", filter: "wine" }).success, false);
  assert.equal(ActionInput.safeParse({ ...base, kind: "investigate" }).success, true);
  const id = "123456789012345678901234";
  assert.equal(ActionInput.safeParse({ ...base, kind: "reprocess", productIds: [id] }).success, false);
  assert.equal(ActionInput.safeParse({ ...base, kind: "catalogRepair", filter: "wine", productIds: [id], removeTagProductIds: [id] }).success, false);
});
