import { controlDb } from "../core/db.js";
import { Tenant } from "../core/tenant.js";
import { ArmPatch, ExperimentInput, RuleInput, Targeting } from "../core/types.js";
import { analyticsFor, createRunContext } from "../agent/context.js";
import { guardSearchChange } from "../agent/guards.js";
import { assertNoConflict } from "../engine/experiments.js";
import { Baseline, BaselineQuery, ChosenProduct } from "../analytics/baseline.js";
import { Catalog } from "../analytics/catalog.js";
import { QueryRow } from "../analytics/conversion.js";
import { createAction } from "./actions.js";

/**
 * Weekly triage of every shopper query: how far each one falls below the
 * store's own click and add-to-cart rates, ranked by the sessions it loses.
 * Rates are shrunk toward the store average so a 2-session query cannot
 * outrank real demand, and zero-result searches count in full.
 */

const SHRINK = 5, MIN_SESSIONS = 2, MIN_SCORE = 0.3, MAX_RANKED = 300, MAX_NEW_PROPOSALS = 10, EXPERIMENT_SESSIONS = 20;
const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const norm = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type Issue = "zero_results" | "low_click" | "click_no_cart" | "low_cart" | "catalog_gap" | "below_average" | "small_sample";
export interface RankedQuery {
  query: string; rank: number; score: number; searches: number; sessions: number;
  clickRate: number | null; cartRate: number | null; zeroRate: number | null;
  clickShortfall: number; cartShortfall: number; zeroSearches: number;
  issues: Issue[]; leakStage: string | null; status: BaselineQuery["status"] | null; delivered: string[];
}
export interface StoreRates { click: number | null; cart: number | null }

export function rankWeeklyQueries(rows: QueryRow[], store: StoreRates, baseline: Baseline | null): RankedQuery[] {
  const byQuery = new Map((baseline?.queries ?? []).map(q => [q.query, q]));
  const shortfall = (hits: number, sessions: number, base: number | null) => {
    if (base === null || !sessions) return 0;
    const shrunk = (hits + SHRINK * base) / (sessions + SHRINK);
    return Math.max(0, (base - shrunk) * sessions);
  };
  const out: Omit<RankedQuery, "rank">[] = [];
  for (const r of rows) {
    const sessions = r.searchSessions, zeroSearches = r.zeroSearches;
    if (sessions < MIN_SESSIONS && zeroSearches < MIN_SESSIONS) continue;
    const clickShortfall = shortfall(r.clickSessions, sessions, store.click), cartShortfall = shortfall(r.cartSessions, sessions, store.cart);
    const score = zeroSearches + clickShortfall + cartShortfall;
    if (score < MIN_SCORE) continue;
    const b = byQuery.get(r.query) ?? null, issues: Issue[] = [];
    if ((r.zeroRate ?? 0) >= 0.3) issues.push("zero_results");
    if (store.click !== null && r.clickRate !== null && r.clickRate < store.click * 0.6) issues.push("low_click");
    const storeClickToCart = store.click && store.cart !== null ? store.cart / store.click : null;
    if (storeClickToCart !== null && r.clickRate && (r.cartRate ?? 0) / r.clickRate < storeClickToCart * 0.5) issues.push("click_no_cart");
    else if (store.cart !== null && r.cartRate !== null && r.cartRate < store.cart * 0.5 && !issues.includes("low_click")) issues.push("low_cart");
    if (b?.unavailable.length) issues.push("catalog_gap");
    if (!issues.length) issues.push("below_average");
    if (sessions < 5) issues.push("small_sample");
    out.push({
      query: r.query, score: round(score), searches: r.searches, sessions, clickRate: r.clickRate, cartRate: r.cartRate, zeroRate: r.zeroRate,
      clickShortfall: round(clickShortfall), cartShortfall: round(cartShortfall), zeroSearches, issues,
      leakStage: (r as { leakStage?: string }).leakStage ?? null, status: b?.status ?? null, delivered: r.delivered.slice(0, 6),
    });
  }
  out.sort((a, b) => b.score - a.score || b.searches - a.searches);
  return out.slice(0, MAX_RANKED).map((q, i) => ({ ...q, rank: i + 1 }));
}

/** One-off queries are too small to rank one by one; together they show how much demand the long tail loses. */
export function longTail(rows: QueryRow[]) {
  const once = rows.filter(r => r.searchSessions < MIN_SESSIONS && r.zeroSearches < MIN_SESSIONS);
  const zero = once.filter(r => r.zeroSearches > 0), silent = once.filter(r => !r.zeroSearches && !r.clickSessions && !r.cartSessions);
  const sample = (list: QueryRow[]) => list.sort((a, b) => b.searches - a.searches).slice(0, 30).map(r => r.query);
  return { queries: once.length, searches: once.reduce((s, r) => s + r.searches, 0), zeroResults: zero.length, noEngagement: silent.length, zeroExamples: sample(zero), noEngagementExamples: sample(silent) };
}

export type SuggestionKind = "promote_chosen" | "borrow_related" | "category_association" | "restock";
export interface Suggestion {
  kind: SuggestionKind; query: string; score: number; mode: "rule" | "experiment" | "action";
  products: { catalogId: string; name: string; clicks: number; carts: number; purchases: number }[];
  relatedQuery?: string; softCategory?: string; hypothesis: string; summary: string;
}

const productRef = (p: ChosenProduct) => ({ catalogId: p.catalogId as string, name: p.name, clicks: p.clicks, carts: p.carts, purchases: p.purchases });
const chosenLine = (p: ChosenProduct) => `${p.name} (${p.carts} הוספות לסל, ${p.clicks} קליקים${p.purchases ? `, ${p.purchases} רכישות` : ""})`;

/**
 * Concrete merchandising suggestions from shopper behaviour only:
 * - promote_chosen: products shoppers already pick for this query sit below the top results;
 * - borrow_related: the query fails while a closely related query works — show what shoppers chose there;
 * - category_association: those related choices share one soft category — surface the category instead;
 * - restock: products shoppers chose for the query are out of stock or hidden.
 */
export function suggestForQuery(q: RankedQuery, baseline: Baseline, catalog: Catalog | null): Suggestion[] {
  const out: Suggestion[] = [], b = baseline.queries.find(x => x.query === q.query);
  const top = new Set(q.delivered.slice(0, 3).map(norm));
  const pinnable = (p: ChosenProduct) => !!p.catalogId && p.available && !p.hidden;
  const mode = q.sessions >= EXPERIMENT_SESSIONS ? "experiment" : "rule";

  if (b?.status === "works") {
    const buried = b.targets.filter(p => pinnable(p) && !top.has(norm(p.name)) && (p.carts > 0 || p.purchases > 0 || p.clicks >= 3)).slice(0, 3);
    if (buried.length && (q.issues.includes("low_click") || q.issues.includes("click_no_cart") || q.issues.includes("low_cart") || q.cartShortfall >= 1)) out.push({
      kind: "promote_chosen", query: q.query, score: q.score, mode, products: buried.map(productRef),
      summary: `לקדם לראש התוצאות ${buried.length === 1 ? "מוצר שהקונים כבר בוחרים" : `${buried.length} מוצרים שהקונים כבר בוחרים`}`,
      hypothesis: `השבוע "${q.query}" נחפש ב-${q.sessions} סשנים; ${pct(q.clickRate)} הקליקו ו-${pct(q.cartRate)} הוסיפו לסל. הקונים שבחרו בכל זאת בחרו ב: ${buried.map(chosenLine).join("; ")} — אבל המוצרים האלה אינם בשלוש התוצאות הראשונות. הצמדתם לראש התוצאות אמורה לקצר את הדרך לעגלה.`,
    });
  }

  if (b && b.status !== "works" && (q.issues.includes("zero_results") || q.issues.includes("low_click"))) {
    const related = baseline.queries
      .filter(x => x.query !== q.query && x.status === "works" && Math.min(x.query.length, q.query.length) >= 3 && (x.query.includes(q.query) || q.query.includes(x.query)))
      .sort((a, c) => c.carts - a.carts || c.searches - a.searches)[0];
    const words = q.query.split(" ").filter(w => w.length >= 3);
    const chosen = related?.targets.filter(pinnable).slice(0, 8) ?? [];
    const picks = chosen.filter(p => words.some(w => norm(p.name).includes(w)));
    if (related && chosen.length) {
      const counts = new Map<string, number>();
      for (const p of chosen) for (const s of new Set(catalog?.match({ pid: p.pid, name: p.name })?.softCategory ?? [])) counts.set(s, (counts.get(s) ?? 0) + 1);
      const [soft, n] = [...counts.entries()].sort((a, c) => c[1] - a[1])[0] ?? [];
      const evidence = `החיפוש הקרוב "${related.query}" עובד: ${related.searches} חיפושים, ${related.carts} הוספות לסל.`;
      if (soft && n! >= 3) out.push({
        kind: "category_association", query: q.query, score: q.score, mode: "rule", relatedQuery: related.query, softCategory: soft, products: [],
        summary: `להציג מוצרים מהקטגוריה "${soft}"`,
        hypothesis: `השבוע "${q.query}" נחפש ב-${q.sessions} סשנים עם ${q.zeroSearches} חיפושים ללא תוצאות ו-${pct(q.clickRate)} קליקים. ${evidence} ${n} מתוך ${chosen.length} המוצרים שהקונים בחרו שם שייכים לקטגוריה "${soft}", ולכן כדאי לחבר את החיפוש לקטגוריה הזו.`,
      });
      else if (picks.length) out.push({
        kind: "borrow_related", query: q.query, score: q.score, mode: "rule", relatedQuery: related.query, products: picks.slice(0, 3).map(productRef),
        summary: `להציג את מה שהקונים בוחרים בחיפוש "${related.query}"`,
        hypothesis: `השבוע "${q.query}" נחפש ב-${q.sessions} סשנים עם ${q.zeroSearches} חיפושים ללא תוצאות ו-${pct(q.clickRate)} קליקים. ${evidence} הקונים בחרו שם ב: ${picks.slice(0, 3).map(chosenLine).join("; ")}.`,
      });
    }
  }

  const gone = (b?.unavailable ?? []).filter(p => p.clicks + p.carts + p.purchases >= 3).slice(0, 5);
  if (gone.length) out.push({
    kind: "restock", query: q.query, score: q.score, mode: "action", products: gone.filter(p => p.catalogId).map(productRef),
    summary: `${gone.length === 1 ? "מוצר שהקונים בוחרים" : `${gone.length} מוצרים שהקונים בוחרים`} אזל או מוסתר`,
    hypothesis: `בחיפוש "${q.query}" הקונים בחרו ב: ${gone.map(p => `${p.name} (${p.stockStatus ?? (p.hidden ? "מוסתר" : "לא בקטלוג")})`).join("; ")}. אי אפשר להציג אותם כרגע; לחדש מלאי, לבטל הסתרה או להציע חלופה.`,
  });
  return out;
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function draftChange(s: Suggestion): { targeting: Targeting; patch: ArmPatch; name: string; text: string } | null {
  const term = s.query, targeting = Targeting.parse({ mode: "queryMatch", patterns: [term], matchType: "exact" });
  if (s.kind === "category_association" && s.softCategory) return {
    targeting, name: `קטגוריה לחיפוש: ${term}`.slice(0, 120),
    text: `בחיפוש "${term}" להציג גם מוצרים מהקטגוריה "${s.softCategory}", כמו שהקונים בוחרים בחיפוש "${s.relatedQuery}".`.slice(0, 500),
    patch: ArmPatch.parse({ categoryAssociation: { softCategories: [s.softCategory], categories: [], limit: 5 } }),
  };
  if ((s.kind === "promote_chosen" || s.kind === "borrow_related") && s.products.length) return {
    targeting, name: `קידום מוצרים: ${term}`.slice(0, 120),
    text: `בחיפוש "${term}" להצמיד לראש התוצאות: ${s.products.map(p => p.name).join(", ")}. שאר התוצאות נשארות.`.slice(0, 500),
    patch: ArmPatch.parse({ pinnedResults: [{ query: term, productIds: s.products.map(p => p.catalogId), enabled: true }] }),
  };
  return null;
}

/** Recently rejected or already-live changes on the same query are not proposed again. */
async function alreadyHandled(tenant: Tenant, query: string) {
  const db = await controlDb(), since = new Date(Date.now() - 30 * 86400_000);
  const scope = { $or: [{ dbName: tenant.dbName }, { tenantApiKey: tenant.apiKey }] };
  const [proposal, rule, experiment] = await Promise.all([
    db.collection("proposals").findOne({ ...scope, "evidence.query": query, $or: [{ status: "pending" }, { status: "rejected", reviewedAt: { $gte: since } }] }),
    db.collection("rules").findOne({ dbName: tenant.dbName, status: "active", "condition.patterns": query }),
    db.collection("experiments").findOne({ tenantApiKey: tenant.apiKey, status: { $in: ["approved", "running", "paused"] }, "targeting.patterns": query }),
  ]);
  return !!(proposal || rule || experiment);
}

async function persistSuggestion(tenant: Tenant, s: Suggestion, reviewId: string, ctx: { catalog: Catalog | null; baseline: Baseline }) {
  const evidence = { query: s.query, score: s.score, kind: s.kind, relatedQuery: s.relatedQuery ?? null, softCategory: s.softCategory ?? null, products: s.products, weeklyReviewId: reviewId, summary: s.summary };
  if (s.kind === "restock") {
    await createAction(tenant, { kind: "investigate", query: s.query, title: `מלאי חסר בחיפוש: ${s.query}`.slice(0, 200), rationale: s.hypothesis, evidence });
    return "action";
  }
  const change = draftChange(s);
  if (!change) return null;
  const check = await guardSearchChange({ dbName: tenant.dbName, targeting: change.targeting, patch: change.patch, catalog: ctx.catalog, baseline: ctx.baseline });
  if (check.errors.length) return null;
  const guard = { warnings: check.warnings, protectedQueries: check.protectedQueries };
  const common = { tenantApiKey: tenant.apiKey, dbName: tenant.dbName, hypothesis: s.hypothesis, evidence, guard, source: "weekly_review", status: "pending", createdAt: new Date(), expiresAt: new Date(Date.now() + 7 * 86400_000) };
  const db = await controlDb();
  if (s.mode === "experiment") {
    const draft = ExperimentInput.parse({
      tenantApiKey: tenant.apiKey, dbName: tenant.dbName, name: `${change.name} (A/B)`, hypothesis: s.hypothesis, source: "agent", type: "pin",
      targeting: change.targeting, arms: [{ key: "control", weight: 50, patch: {} }, { key: "promote", weight: 50, patch: change.patch }], trafficPct: 100,
    });
    try { await assertNoConflict(draft); } catch { return null; }
    await db.collection("proposals").insertOne({ kind: "experiment", draftExperiment: draft, ...common });
    return "experiment";
  }
  const draftRule = RuleInput.parse({ tenantApiKey: tenant.apiKey, dbName: tenant.dbName, name: change.name, naturalLanguageText: change.text, condition: change.targeting, patch: change.patch });
  await db.collection("proposals").insertOne({ kind: "rule", draftRule, ...common });
  return "rule";
}

export async function runWeeklyReview(tenant: Tenant, days = 7) {
  const ctx = createRunContext(tenant, `weekly-${Date.now()}`, null);
  const a = await analyticsFor(ctx, days);
  const store: StoreRates = { click: a.funnel.rates.click, cart: a.funnel.rates.cart };
  const ranked = rankWeeklyQueries(a.rows, store, a.baseline);
  const suggestions = ranked.slice(0, 40).flatMap(q => suggestForQuery(q, a.baseline, a.catalog));
  const tail = longTail(a.rows);
  const db = await controlDb(), generatedAt = new Date();
  const { insertedId } = await db.collection("weekly_query_reviews").insertOne({
    dbName: tenant.dbName, tenantApiKey: tenant.apiKey, generatedAt, days, store, scannedQueries: a.rows.length,
    searches: a.rows.reduce((s, r) => s + r.searches, 0), excludedSynthetic: a.excluded, queries: ranked, suggestions, tail,
  });
  const reviewId = String(insertedId), created: Record<string, number> = {};
  const seen = new Set<string>();
  let budget = MAX_NEW_PROPOSALS;
  for (const s of suggestions) {
    const isChange = s.kind !== "restock", key = `${s.query}:${isChange}`;
    if (isChange && budget <= 0) continue;
    if (seen.has(key) || (isChange && await alreadyHandled(tenant, s.query))) continue;
    const kind = await persistSuggestion(tenant, s, reviewId, { catalog: a.catalog, baseline: a.baseline }).catch(() => null);
    if (!kind) continue;
    seen.add(key); created[kind] = (created[kind] ?? 0) + 1;
    if (isChange) budget--;
  }
  await db.collection("weekly_query_reviews").updateOne({ _id: insertedId }, { $set: { created } });
  return { reviewId, generatedAt, days, store, scannedQueries: a.rows.length, queries: ranked, suggestions, tail, created };
}

export async function latestWeeklyReview(tenant: Tenant) {
  const db = await controlDb();
  const doc = await db.collection("weekly_query_reviews").findOne({ dbName: tenant.dbName }, { sort: { generatedAt: -1 }, projection: { tenantApiKey: 0 } });
  return doc ? { ...doc, _id: String(doc._id) } : null;
}
