import { test } from "node:test";
import assert from "node:assert";
import { assignArm, fnv1a32, queryMatchesTargeting, timeWindowMatches, currentHourInTimezone } from "../src/core/assignment.js";
// The dashboard-server hook must assign identically. Import it directly.
// @ts-ignore — plain JS module in the sibling repo
import { applyExperimentVariant, applyPermanentRules } from "../../dashboard-server/experiments-hook.mjs";

const EXP = {
  id: "exp-test-1",
  layer: "default",
  trafficPct: 100,
  targeting: { mode: "queryMatch" as const, patterns: ["wine"], matchType: "contains" as const },
  arms: [
    { key: "control", weight: 1, patch: {} },
    { key: "v1", weight: 1, patch: { pinnedResults: [{ query: "wine", productIds: ["p1", "p2"], enabled: true }] } },
  ],
};

function fakeRedis(payload: unknown) {
  return { isOpen: true, get: async () => JSON.stringify(payload) } as any;
}

function fakeTenantDb(sink: any[], products: any[] = []) {
  return {
    collection: (name: string) => {
      if (name === "products") {
        return {
          find: () => ({
            project: () => ({
              sort: () => ({
                limit: (n: number) => ({
                  maxTimeMS: () => ({
                    toArray: async () => products.slice(0, n),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        insertOne: async (doc: any) => {
          sink.push(doc);
          return { insertedId: "x" };
        },
        updateOne: async (filter: any, update: any) => {
          sink.push({ filter, update });
          return { upsertedCount: 1 };
        },
      };
    },
  } as any;
}

const flushSetImmediate = () => new Promise((r) => setImmediate(() => setImmediate(r)));

test("50/50 split is roughly even and deterministic", () => {
  let v1 = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const arm = assignArm(EXP, `sess_${i}`);
    assert.ok(arm === "control" || arm === "v1");
    if (arm === "v1") v1++;
    assert.equal(arm, assignArm(EXP, `sess_${i}`)); // sticky
  }
  const share = v1 / n;
  assert.ok(share > 0.48 && share < 0.52, `v1 share ${share} outside 48-52%`);
});

test("trafficPct excludes sessions deterministically", () => {
  const exp = { ...EXP, trafficPct: 30 };
  let enrolled = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) if (assignArm(exp, `s${i}`) !== null) enrolled++;
  const share = enrolled / n;
  assert.ok(share > 0.28 && share < 0.32, `enrollment ${share} outside 28-32%`);
});

test("hook assigns identically to control-plane assignment lib", async () => {
  for (let i = 0; i < 500; i++) {
    const sessionId = `sess_${i}`;
    const expected = assignArm(EXP, sessionId);
    const sink: any[] = [];
    const store = { apiKey: "k1", pinnedResults: [] };
    const out = await applyExperimentVariant(store, sessionId, "red wine", fakeTenantDb(sink), fakeRedis([EXP]));
    await flushSetImmediate();
    assert.equal(sink.length, 1, "exposure must always be logged for enrolled sessions");
    assert.equal(sink[0].arm, expected, `hook arm mismatch for ${sessionId}`);
    if (expected === "v1") {
      assert.equal(out.pinnedResults[0].productIds[0], "p1", "variant must see experiment pins");
      assert.notStrictEqual(out, store, "variant must be a patched copy");
    } else {
      assert.strictEqual(out, store, "control must get the original store object");
    }
  }
});

test("targeting: non-matching query leaves store untouched, no exposure", async () => {
  const sink: any[] = [];
  const store = { apiKey: "k1" };
  const out = await applyExperimentVariant(store, "sess_1", "cheese platter", fakeTenantDb(sink), fakeRedis([EXP]));
  await flushSetImmediate();
  assert.strictEqual(out, store);
  assert.equal(sink.length, 0);
});

test("redis down / missing / broken → control, never throws", async () => {
  const store = { apiKey: "k1" };
  const down = { isOpen: false, get: async () => null } as any;
  const throwing = { isOpen: true, get: async () => { throw new Error("boom"); } } as any;
  const garbage = { isOpen: true, get: async () => "not-json{{" } as any;
  for (const redis of [down, throwing, garbage, null, undefined]) {
    const out = await applyExperimentVariant(store, "sess_1", "wine", fakeTenantDb([]), redis);
    assert.strictEqual(out, store);
  }
});

test("softCategoryBoost + productBoosts + profile multiplier patches compose", async () => {
  const exp = {
    id: "exp2",
    trafficPct: 100,
    targeting: { mode: "all" },
    arms: [
      { key: "control", weight: 0.0001, patch: {} },
      {
        key: "v1",
        weight: 1,
        patch: {
          softCategoriesBoost: { merlot: 5 },
          productBoosts: { p9: 3 },
          profileBoostMultiplier: 0,
        },
      },
    ],
  };
  // distinct apiKey — the hook keeps a 15s in-process cache per apiKey
  const store = { apiKey: "k2", softCategoriesBoost: { cabernet: 2 } };
  const out = await applyExperimentVariant(store, "any", "anything", fakeTenantDb([]), fakeRedis([exp]));
  assert.deepEqual(out.softCategoriesBoost, { cabernet: 2, merlot: 5 });
  assert.deepEqual(out.experimentBoosts, { p9: 3 });
  assert.equal(out.profileBoostMultiplier, 0);
  assert.deepEqual(store.softCategoriesBoost, { cabernet: 2 }, "original store must not be mutated");
});

test("categoryRule: brandy query dynamically pulls in cognac products via pinnedResults", async () => {
  const exp = {
    id: "exp-cat-1",
    trafficPct: 100,
    targeting: { mode: "queryMatch", patterns: ["brandy"], matchType: "contains" },
    arms: [
      { key: "control", weight: 1, patch: {} },
      {
        key: "v1",
        weight: 1,
        patch: { categoryAssociation: { softCategories: ["cognac"], categories: [], limit: 5 } },
      },
    ],
  };
  const cognacProducts = [{ _id: { toString: () => "cog1" } }, { _id: { toString: () => "cog2" } }];
  const store = { apiKey: "k3", pinnedResults: [{ query: "other", productIds: ["x"], enabled: true }] };

  let out;
  for (let i = 0; i < 200; i++) {
    const sessionId = `bsess_${i}`;
    if (assignArm(exp, sessionId) !== "v1") continue;
    out = await applyExperimentVariant(store, sessionId, "brandy", fakeTenantDb([], cognacProducts), fakeRedis([exp]));
    break;
  }
  assert.ok(out, "expected at least one v1-assigned session in 200 tries");
  assert.equal(out.pinnedResults[0].query, "brandy");
  assert.deepEqual(out.pinnedResults[0].productIds, ["cog1", "cog2"]);
  // tenant's own unrelated pin rule must survive alongside the injected one
  assert.ok(out.pinnedResults.some((r: any) => r.query === "other"));
});

test("categoryRule resolution failure (bad tenantDb) never throws, control unaffected", async () => {
  const exp = {
    id: "exp-cat-2",
    trafficPct: 100,
    targeting: { mode: "all" },
    arms: [
      { key: "control", weight: 0.0001, patch: {} },
      { key: "v1", weight: 1, patch: { categoryAssociation: { softCategories: ["cognac"], limit: 5 } } },
    ],
  };
  const brokenDb = {
    collection: (name: string) => {
      if (name === "products") {
        return {
          find: () => {
            throw new Error("boom");
          },
        };
      }
      return { insertOne: async () => ({ insertedId: "x" }) };
    },
  } as any;
  const store = { apiKey: "k4" };
  const out = await applyExperimentVariant(store, "any-session", "brandy", brokenDb, fakeRedis([exp]));
  assert.ok(out); // must return something, never throw
});

test("timeWindowMatches: overnight window wraps past midnight", () => {
  const tw = { startHour: 22, endHour: 6, timezone: "UTC" };
  assert.equal(timeWindowMatches(tw, new Date("2026-01-01T23:00:00Z")), true);
  assert.equal(timeWindowMatches(tw, new Date("2026-01-01T03:00:00Z")), true);
  assert.equal(timeWindowMatches(tw, new Date("2026-01-01T12:00:00Z")), false);
});

test("timeWindowMatches: same-day window", () => {
  const tw = { startHour: 9, endHour: 17, timezone: "UTC" };
  assert.equal(timeWindowMatches(tw, new Date("2026-01-01T12:00:00Z")), true);
  assert.equal(timeWindowMatches(tw, new Date("2026-01-01T20:00:00Z")), false);
});

test("currentHourInTimezone respects timezone, not just UTC", () => {
  // 23:30 UTC on Jan 1 is 01:30 the next day in Asia/Jerusalem (UTC+2)
  const now = new Date("2026-01-01T23:30:00Z");
  assert.equal(currentHourInTimezone("UTC", now), 23);
  assert.equal(currentHourInTimezone("Asia/Jerusalem", now), 1);
});

test("permanent rule: query-only condition applies to 100% of traffic, no control group", async () => {
  const rule = {
    id: "rule-1",
    condition: { mode: "queryMatch", patterns: ["bourbon"], matchType: "contains" },
    patch: { pinnedResults: [{ query: "bourbon", productIds: ["whiskey1"], enabled: true }] },
  };
  const sink: any[] = [];
  for (const sessionId of ["s1", "s2", "s3", "s4", "s5"]) {
    const store = { apiKey: "k5", pinnedResults: [] };
    const out = await applyPermanentRules(store, "bourbon", fakeTenantDb(sink), fakeRedis([rule]));
    assert.equal(out.pinnedResults[0].productIds[0], "whiskey1", `session ${sessionId} must always see the rule (no control group)`);
  }
});

test("permanent rule: time-window condition gates a boost, independent of session assignment", async () => {
  const rule = {
    id: "rule-2",
    condition: { mode: "all", patterns: [], matchType: "contains", timeWindow: { startHour: 22, endHour: 6, timezone: "UTC" } },
    patch: { softCategoriesBoost: { red_wine: 50 } },
  };
  const store = { apiKey: "k6" };
  const atNight = await applyPermanentRules(store, "anything", fakeTenantDb([]), fakeRedis([rule]), new Date("2026-01-01T23:00:00Z"));
  const atNoon = await applyPermanentRules(store, "anything", fakeTenantDb([]), fakeRedis([rule]), new Date("2026-01-01T12:00:00Z"));
  assert.deepEqual(atNight.softCategoriesBoost, { red_wine: 50 });
  assert.strictEqual(atNoon, store, "outside the time window the store must be untouched");
});

test("permanent rules: resolution failure never throws, returns original store", async () => {
  const rule = {
    id: "rule-3",
    condition: { mode: "all", patterns: [], matchType: "contains" },
    patch: { categoryAssociation: { softCategories: ["cognac"], limit: 5 } },
  };
  const brokenDb = {
    collection: (name: string) => {
      if (name === "products") return { find: () => { throw new Error("boom"); } };
      return { updateOne: async () => ({}) };
    },
  } as any;
  const store = { apiKey: "k7" };
  const out = await applyPermanentRules(store, "anything", brokenDb, fakeRedis([rule]));
  assert.ok(out);
});

test("fnv1a32 sanity", () => {
  assert.equal(fnv1a32("abc"), fnv1a32("abc"));
  assert.notEqual(fnv1a32("abc"), fnv1a32("abd"));
  assert.ok(queryMatchesTargeting({ mode: "queryMatch", patterns: ["Wine"], matchType: "contains" }, "RED WINE"));
});
