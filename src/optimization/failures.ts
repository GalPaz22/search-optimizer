import { analyzeWindow, normalizeQuery } from "./analytics.js";

type Window = ReturnType<typeof analyzeWindow>;
type Term = Window["terms"][number];
const rate = (success: number, total: number) => total ? success / total : null;
export const termMetrics = (t?: Term) => ({
  searches: t?.searches ?? 0, identities: t?.identities ?? 0,
  cartIdentities: t?.cartIdentities ?? 0,
  cartRate: t ? rate(t.cartIdentities, t.identities) : null,
  clickRate: t ? rate(t.clickIdentities, t.identities) : null,
  zeroRate: t ? rate(t.zeroResults, t.searches) : null,
  missingRate: t ? rate(t.missingSession, t.searches) : null,
});

/** A triage heuristic, not an estimate of recoverable orders or causal uplift. */
export function prioritizeFailures(current: Window, previous: Window, comparable: boolean) {
  const old = new Map(previous.terms.map(t => [t.query, t]));
  const usable = current.terms.filter(t => t.query && t.missingSession / t.searches <= .1);
  // Query-identifier pairs: do not mix this denominator with store-wide unique identifiers.
  const n = usable.reduce((sum, t) => sum + t.identities, 0);
  const baseline = n ? usable.reduce((sum, t) => sum + t.cartIdentities, 0) / n : 0;
  return current.terms.filter(t => t.query && t.query.length <= 200 && !["direct", "unknown", "null"].includes(t.query) && t.searches >= 5).flatMap(t => {
    const before = old.get(t.query), metrics = termMetrics(t);
    const measurementReliable = t.identities >= 5 && (metrics.missingRate ?? 1) <= .1 && !current.trackingGapDays.length;
    const observedSample = t.identities >= 5 && !current.trackingGapDays.length;
    const regression = measurementReliable && comparable && before && before.identities >= 20 && before.missingSession / before.searches <= .1
      ? Math.max(0, before.cartIdentities / before.identities - t.cartIdentities / t.identities) : 0;
    const reasons: string[] = [];
    if (t.zeroResults) reasons.push("zero_results");
    if (!measurementReliable) reasons.push("measurement_or_sample_gap");
    if (observedSample && !t.cartIdentities) reasons.push("no_attributed_carts");
    if (observedSample && t.clickIdentities / t.identities < .2) reasons.push("low_click_engagement");
    if (observedSample && t.cartIdentities / t.identities < baseline * .5) reasons.push("low_cart_rate");
    if (regression >= .1) reasons.push("cart_rate_regression");
    if (!reasons.length) return [];
    const shrunkRate = (t.cartIdentities + 10 * baseline) / (t.identities + 10);
    const shortfall = observedSample ? t.identities * Math.max(0, baseline - shrunkRate, regression) : 0;
    const coverage = 1 - (metrics.missingRate ?? 1);
    const score = Math.round((t.zeroResults + coverage * (shortfall + (observedSample && !t.cartIdentities ? Math.log1p(t.identities) : 0))) * 100) / 100;
    return [{ query: t.query, score, reasons, metrics, previous: termMetrics(before), measurementReliable,
      baselineCartRate: baseline, examples: t.examples,
      nextStep: !observedSample ? "Validate tracking and sample; inspect explicit zero-result cases without inferring conversion failure."
        : t.zeroResults ? "Check eligible products, stock, vocabulary and category coverage."
        : t.clickIdentities / t.identities < .2 ? "Inspect shown products and ranking against query intent and original descriptions."
        : "Inspect clicked products, stock, price and cart tracking before choosing a search intervention.",
    }];
  }).sort((a, b) => b.score - a.score || b.metrics.identities - a.metrics.identities || a.query.localeCompare(b.query));
}

/** Equal duration, disjoint windows are supplied by the caller; this is observational. */
export function compareRepair(query: string, before: Window, after: Window) {
  if (+before.end > +after.start || +before.end - +before.start !== +after.end - +after.start)
    throw new Error("Outcome windows must be disjoint and equal in duration");
  const q = normalizeQuery(query), b = before.terms.find(t => t.query === q), a = after.terms.find(t => t.query === q);
  const baseline = termMetrics(b), followup = termMetrics(a);
  const reasons = [];
  if (baseline.identities < 30 || followup.identities < 30) reasons.push("Fewer than 30 search identifiers in either window");
  if ((baseline.missingRate ?? 1) > .1 || (followup.missingRate ?? 1) > .1) reasons.push("Missing search identifiers");
  if (Math.abs((baseline.missingRate ?? 1) - (followup.missingRate ?? 1)) > .05) reasons.push("Identifier coverage changed");
  if (before.trackingGapDays.length || after.trackingGapDays.length) reasons.push("Tracking gaps");
  const delta = reasons.length ? null : followup.cartRate! - baseline.cartRate!;
  return { status: reasons.length ? "insufficient_evidence" : "observed", reasons, baseline, followup,
    cartRateDelta: delta, before: { start: before.start, end: before.end }, after: { start: after.start, end: after.end },
    interpretation: "Observational same-query search-to-cart identifier rates, not purchase conversion or causal uplift. Use a controlled experiment to attribute improvement.",
  };
}
