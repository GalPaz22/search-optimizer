// Deterministic experiment assignment. MUST stay byte-identical in behavior
// with dashboard-server/experiments-hook.js (assignArm there).

export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export interface AssignableExperiment {
  id: string;
  trafficPct: number;
  arms: { key: string; weight: number }[];
}

/**
 * Returns the arm key for a session, or null if the session is not enrolled.
 * bucket ∈ [0,10000); enrolled iff bucket < trafficPct*100; arm chosen by
 * cumulative weights across the enrolled range.
 */
export function assignArm(exp: AssignableExperiment, sessionId: string): string | null {
  if (!sessionId) return null;
  const bucket = fnv1a32(`${exp.id}:${sessionId}`) % 10000;
  const enrolledRange = Math.floor(exp.trafficPct * 100);
  if (bucket >= enrolledRange) return null;
  const totalWeight = exp.arms.reduce((s, a) => s + a.weight, 0);
  if (totalWeight <= 0) return null;
  let cum = 0;
  for (const arm of exp.arms) {
    cum += (arm.weight / totalWeight) * enrolledRange;
    if (bucket < cum) return arm.key;
  }
  return exp.arms[exp.arms.length - 1].key;
}

export interface TimeWindowLike {
  startHour: number;
  endHour: number;
  timezone: string;
}

/** Current hour (0-23) in the given IANA timezone. */
export function currentHourInTimezone(timezone: string, now: Date = new Date()): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: timezone,
  }).format(now);
  return parseInt(hourStr, 10) % 24;
}

export function timeWindowMatches(tw: TimeWindowLike, now: Date = new Date()): boolean {
  const hour = currentHourInTimezone(tw.timezone, now);
  if (tw.startHour === tw.endHour) return true; // 24h window
  if (tw.startHour < tw.endHour) return hour >= tw.startHour && hour < tw.endHour;
  // wraps past midnight, e.g. 22 -> 6
  return hour >= tw.startHour || hour < tw.endHour;
}

/**
 * A targeting/condition matches when its query condition (if any) AND its
 * time-window condition (if any) both hold. mode:"all" with no timeWindow
 * always matches.
 */
export function queryMatchesTargeting(
  targeting: {
    mode: "all" | "queryMatch";
    patterns: string[];
    matchType: "exact" | "contains";
    timeWindow?: TimeWindowLike;
  },
  query: string,
  now: Date = new Date()
): boolean {
  if (targeting.mode === "queryMatch") {
    const q = (query || "").trim().toLowerCase();
    if (!q) return false;
    const matched = targeting.patterns.some((p) => {
      const pat = p.trim().toLowerCase();
      return targeting.matchType === "exact" ? q === pat : q.includes(pat);
    });
    if (!matched) return false;
  }
  if (targeting.timeWindow && !timeWindowMatches(targeting.timeWindow, now)) return false;
  return true;
}
