// Pragmatic significance testing:
// - two-proportion z-test on session→order conversion (rigor number)
// - Beta-Bernoulli Bayesian P(variant beats control) on conversion (headline, peeking-robust)
// - bootstrap P(variant ≥ control) on revenue/session

export function twoProportionZ(c1: number, n1: number, c2: number, n2: number) {
  if (n1 === 0 || n2 === 0) return { z: null, p: null };
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const pPool = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: null, p: null };
  const z = (p2 - p1) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

export function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function sampleBeta(alpha: number, beta: number): number {
  // Jöhnk-free: use two gamma samples via Marsaglia-Tsang
  const g1 = sampleGamma(alpha);
  const g2 = sampleGamma(beta);
  return g1 / (g1 + g2);
}

function sampleGamma(shape: number): number {
  if (shape < 1) {
    const u = Math.random();
    return sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do {
      x = gaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function gaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** P(variant conversion > control conversion) with Beta(1,1) prior. */
export function probVariantBeatsControlConv(
  controlConv: number,
  controlN: number,
  variantConv: number,
  variantN: number,
  draws = 5000
): number {
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    const pc = sampleBeta(1 + controlConv, 1 + controlN - controlConv);
    const pv = sampleBeta(1 + variantConv, 1 + variantN - variantConv);
    if (pv > pc) wins++;
  }
  return wins / draws;
}

/**
 * Bootstrap P(mean(variant revenue/session) > mean(control)). Inputs are
 * per-session revenue arrays. Returns null when there is no revenue signal at
 * all — with every value 0 the old `>=` comparison tied on every draw and
 * reported a confident-looking 100% for the variant, which reads as "promote
 * me" on tenants that simply have no order tracking. Ties count as half a win
 * so sparse revenue doesn't systematically inflate the variant either.
 */
export function probVariantBeatsControlRps(control: number[], variant: number[], draws = 2000): number | null {
  if (control.length === 0 || variant.length === 0) return null;
  const anyRevenue = control.some((v) => v > 0) || variant.some((v) => v > 0);
  if (!anyRevenue) return null;
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    const mv = bootstrapMean(variant);
    const mc = bootstrapMean(control);
    if (mv > mc) wins += 1;
    else if (mv === mc) wins += 0.5;
  }
  return wins / draws;
}

function bootstrapMean(arr: number[]): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[(Math.random() * arr.length) | 0];
  return sum / arr.length;
}
