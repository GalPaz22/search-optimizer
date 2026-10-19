import { controlDb } from "../core/db.js";
import { storeProfile, Tenant } from "../core/tenant.js";
import { dailyActivity } from "../analytics/activity.js";
import { buildBaseline } from "../analytics/baseline.js";
import { Catalog, loadCatalog } from "../analytics/catalog.js";
import { classifyLeaks, queryFunnel, storeFunnel, suspectedSynthetic } from "../analytics/conversion.js";
import { DAY_MS, loadStoreEvents, normalizeQuery, StoreEvents } from "../analytics/events.js";
import { ConversionReport } from "../analytics/report.js";
import { measuredConversion } from "../analytics/measurement.js";

/**
 * Everything one agent run shares: the store, the data report it started
 * from, analytics loaded per window (loaded once, reused by every tool), and
 * the set of real shopper queries the agent has seen — the report it submits
 * may only cite those, so no finding can rest on an invented query.
 */
export interface RunContext {
  tenant: Tenant;
  runId: string;
  report: ConversionReport | null;
  knownQueries: Set<string>;
  analytics: Map<number, Promise<Analytics>>;
  catalog?: Promise<Catalog | null>;
}

export interface Analytics {
  ev: StoreEvents; catalog: Catalog | null; excluded: string[];
  funnel: ReturnType<typeof storeFunnel>; rows: ReturnType<typeof classifyLeaks>;
  baseline: ReturnType<typeof buildBaseline>; activity: ReturnType<typeof dailyActivity>;
}

export function createRunContext(tenant: Tenant, runId: string, report: ConversionReport | null): RunContext {
  const ctx: RunContext = { tenant, runId, report, knownQueries: new Set(), analytics: new Map() };
  if (report) {
    const q = report.queries, b = report.baseline;
    for (const list of [q.top, q.opportunity, q.lowConversion, q.zeroResults, b.works, b.gaps, b.fails, report.audit] as { query: string }[][]) rememberQueries(ctx, list.map(x => x.query));
    rememberQueries(ctx, report.zeroSearches.map((z: any) => z.query));
  }
  return ctx;
}

export const rememberQueries = (ctx: RunContext, queries: unknown[]) => { for (const q of queries) { const n = normalizeQuery(q); if (n) ctx.knownQueries.add(n); } };

export function analyticsFor(ctx: RunContext, days: number): Promise<Analytics> {
  if (!ctx.analytics.has(days)) {
    ctx.catalog ??= loadCatalog(ctx.tenant.dbName).catch(() => null);
    ctx.analytics.set(days, (async () => {
      const to = new Date(), ev = await loadStoreEvents(ctx.tenant.dbName, new Date(+to - days * DAY_MS), to), catalog = await ctx.catalog!;
      const raw = queryFunnel(ev), sessions = new Set(ev.queries.map(q => q.s).filter(Boolean)).size;
      const excluded = suspectedSynthetic(raw, sessions), skip = new Set(excluded);
      const clean = skip.size ? { ...ev, queries: ev.queries.filter(q => !skip.has(q.q)) } : ev;
      const measured = measuredConversion(clean, storeFunnel(clean), skip.size ? queryFunnel(clean) : raw);
      const funnel = measured.funnel, rows = classifyLeaks(measured.rows, funnel);
      rememberQueries(ctx, rows.map(r => r.query));
      return { ev: clean, catalog, excluded, funnel, rows, baseline: buildBaseline(clean, rows, catalog), activity: dailyActivity(clean) };
    })());
    ctx.analytics.get(days)!.catch(() => ctx.analytics.delete(days));
  }
  return ctx.analytics.get(days)!;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").slice(0, n);

/**
 * The picture every run starts with (tenant-studio's WORKSPACE block): the
 * merchant's production settings, what is live in search right now (rules,
 * running experiments), open work and its outcomes, what reviewers rejected,
 * earlier operator requests and the previous reviews. A failed read only
 * leaves its part out.
 */
export async function workspaceContext(tenant: Tenant) {
  const cdb = await controlDb(), dbName = tenant.dbName, since = new Date(Date.now() - 45 * DAY_MS);
  const safe = <T>(p: Promise<T>) => p.catch(() => null);
  const [store, rules, experiments, actions, proposals, rejected, runs, reports, policy] = await Promise.all([
    safe(storeProfile(dbName)),
    safe(cdb.collection("rules").find({ dbName, status: "active" }).project({ name: 1, naturalLanguageText: 1, condition: 1, patch: 1 }).limit(30).toArray()),
    safe(cdb.collection("experiments").find({ dbName, status: { $in: ["running", "paused", "approved"] } }).project({ name: 1, status: 1, type: 1, targeting: 1, trafficPct: 1, hypothesis: 1 }).limit(20).toArray()),
    safe(cdb.collection("optimization_actions").find({ dbName, status: { $nin: ["dismissed"] } }).sort({ createdAt: -1 }).limit(60).project({ query: 1, kind: 1, status: 1, title: 1, "diagnosis.status": 1, "diagnosis.cause": 1, "outcome.status": 1, "outcome.cartRateDelta": 1 }).toArray()),
    safe(cdb.collection("proposals").find({ $or: [{ dbName }, { tenantApiKey: tenant.apiKey }, { "draftExperiment.dbName": dbName }], status: "pending" }).project({ kind: 1, hypothesis: 1, "draftExperiment.name": 1, "draftRule.name": 1, "catalogChange.filter": 1 }).limit(20).toArray()),
    safe(cdb.collection("proposals").find({ $or: [{ dbName }, { tenantApiKey: tenant.apiKey }, { "draftExperiment.dbName": dbName }], status: "rejected", reviewedAt: { $gte: since } }).project({ kind: 1, hypothesis: 1, reviewerNotes: 1, "draftExperiment.name": 1, "draftRule.name": 1 }).limit(15).toArray()),
    safe(cdb.collection("agent_runs").find({ $or: [{ dbName }, { tenantApiKey: tenant.apiKey }] }).sort({ startedAt: -1 }).limit(8).project({ request: 1, startedAt: 1, status: 1 }).toArray()),
    safe(cdb.collection("conversion_reports").find({ dbName, source: "agent" }).sort({ generatedAt: -1 }).limit(2).project({ generatedAt: 1, summary: 1, "proposals.title": 1, "proposals.kind": 1, "proposals.queries": 1 }).toArray()),
    safe(cdb.collection("optimization_policies").findOne({ dbName }, { projection: { enabled: 1, agentEnabled: 1, autoExecuteCatalog: 1 } })),
  ]);
  const byStatus = (list: any[] | null) => (list ?? []).reduce((m: Record<string, number>, a: any) => ({ ...m, [`${a.kind}:${a.status}`]: (m[`${a.kind}:${a.status}`] ?? 0) + 1 }), {});
  return {
    store: store && { ...store, softCategoriesBoosted: Object.keys(store.softCategoriesBoosted).length ? store.softCategoriesBoosted : undefined },
    liveInSearch: {
      rules: (rules ?? []).map((r: any) => ({ id: String(r._id), name: r.name, text: clip(r.naturalLanguageText, 160), condition: r.condition, patchKeys: Object.keys(r.patch ?? {}) })),
      experiments: (experiments ?? []).map((e: any) => ({ id: String(e._id), name: e.name, status: e.status, type: e.type, targeting: e.targeting, trafficPct: e.trafficPct })),
    },
    openWork: {
      actionsByKindAndStatus: byStatus(actions),
      openInvestigations: (actions ?? []).filter((a: any) => a.kind === "investigate" && a.status === "pending").slice(0, 12).map((a: any) => ({ id: String(a._id), query: a.query, title: clip(a.title, 100), diagnosis: a.diagnosis?.status ?? null, cause: a.diagnosis?.cause ?? null })),
      measuredOutcomes: (actions ?? []).filter((a: any) => a.outcome?.status && a.outcome.status !== "collecting").slice(0, 8).map((a: any) => ({ id: String(a._id), query: a.query, outcome: a.outcome.status, cartRateDelta: a.outcome.cartRateDelta ?? null })),
      pendingProposals: (proposals ?? []).map((p: any) => ({ id: String(p._id), kind: p.kind ?? "experiment", name: p.draftExperiment?.name ?? p.draftRule?.name ?? p.catalogChange?.filter ?? null, hypothesis: clip(p.hypothesis, 140) })),
    },
    rejectedRecently: (rejected ?? []).map((p: any) => ({ kind: p.kind ?? "experiment", name: p.draftExperiment?.name ?? p.draftRule?.name ?? null, hypothesis: clip(p.hypothesis, 140), reviewerNotes: clip(p.reviewerNotes, 200) })),
    previousReviews: (reports ?? []).map((r: any) => ({ at: r.generatedAt, summary: clip(r.summary, 900), proposals: (r.proposals ?? []).slice(0, 8).map((p: any) => `${p.kind}: ${clip(p.title, 90)}`) })),
    earlierRequests: (runs ?? []).filter((r: any) => r.request).map((r: any) => ({ at: r.startedAt, request: clip(r.request, 200) })),
    policy: policy ? { dailyReport: !!policy.enabled, dailyAgent: !!policy.agentEnabled, autoExecuteCatalog: !!policy.autoExecuteCatalog } : null,
  };
}
