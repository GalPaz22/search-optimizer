import { StoreEvents } from "./events.js";
import { uniquePurchases } from "./conversion.js";

const dayOf = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
export type Day = { day: string; searches: number; clicks: number; carts: number; checkouts: number; purchases: number };

/**
 * Per-day counts per source. A search log that goes quiet while clicks keep
 * flowing is a logging gap (missing data), not a traffic drop; a day with many
 * searches and no clicks or carts at all is a tracking gap on the storefront.
 */
export function dailyActivity(ev: StoreEvents) {
  const days = new Map<string, Day>();
  const bump = (t: number, k: keyof Omit<Day, "day">) => {
    const d = dayOf(t);
    if (!days.has(d)) days.set(d, { day: d, searches: 0, clicks: 0, carts: 0, checkouts: 0, purchases: 0 });
    days.get(d)![k]++;
  };
  for (const e of ev.queries) bump(e.t, "searches");
  for (const e of ev.clicks) bump(e.t, "clicks");
  for (const e of ev.carts) bump(e.t, "carts");
  for (const e of ev.checkouts) bump(e.t, "checkouts");
  for (const e of uniquePurchases(ev.purchases).list) bump(e.t, "purchases");
  const perDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const clickDays = perDay.filter(d => d.clicks > 0 || d.carts > 0), silent = clickDays.filter(d => d.searches === 0);
  return {
    perDay,
    searchLogging: perDay.some(d => d.searches > 0),
    searchLogGapDays: silent.map(d => d.day),
    trackingGapDays: perDay.filter(d => d.searches >= 10 && !d.clicks && !d.carts).map(d => d.day),
  };
}
