import test from "node:test";
import assert from "node:assert/strict";
import { compareAround, dayOf, funnelsByDay } from "../src/optimization/plans.js";

const at = (day: string, hour = 10) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
const search = (q: string, s: string, t: number) => ({ q, s, t, delivered: 5, names: [], zero: false });
const click = (q: string, s: string, t: number) => ({ q, s, t: t + 60_000, pid: "1", name: "p", url: "" });

function events() {
  const queries: any[] = [], clicks: any[] = [];
  // Before approval: 4 sessions a day, 1 clicks. After: 4 a day, 3 click.
  for (const [day, clicked] of [["2026-09-28", 1], ["2026-09-29", 1], ["2026-10-01", 3], ["2026-10-02", 3]] as const) {
    for (let i = 0; i < 4; i++) {
      const s = `${day}-${i}`, t = at(day) + i * 3_600_000;
      queries.push(search("יין ריף אדום", s, t));
      if (i < clicked) clicks.push(click("יין ריף אדום", s, t));
    }
    queries.push(search("וודקה", `${day}-x`, at(day)));
  }
  return { dbName: "t", from: at("2026-09-20"), to: at("2026-10-02", 20), queries, clicks, carts: [], checkouts: [], purchases: [], sources: {} } as any;
}

test("days follow the Israel calendar", () => {
  assert.equal(dayOf(Date.parse("2026-10-01T22:30:00Z")), "2026-10-02");
  assert.equal(dayOf(Date.parse("2026-10-01T20:30:00Z")), "2026-10-01");
});

test("compares the targeted queries before and after approval, day by day", () => {
  const m = compareAround(funnelsByDay(events()), [{ text: "ריף", exact: false }], new Date(at("2026-09-30")));
  assert.equal(m.approvedDay, "2026-09-30");
  assert.equal(m.series[0].day, "2026-09-20", "series starts at the loaded window when approval is recent");
  assert.equal(m.before.sessions, 8);
  assert.equal(m.before.clickRate, 0.25);
  assert.equal(m.after.sessions, 8);
  assert.equal(m.after.clickRate, 0.75);
  assert.equal(m.after.purchaseRate, null, "no purchase tracking means no purchase rate");
  assert.equal(m.series.find(d => d.day === "2026-09-30")!.searches, 0, "quiet days stay in the series");
});

test("a plan approved before the loaded window has no before-period, only the time since", () => {
  const m = compareAround(funnelsByDay(events()), [{ text: "ריף", exact: false }], new Date(at("2026-09-01")));
  assert.equal(m.before.days, 0);
  assert.equal(m.after.sessions, 16);
});

test("exact patterns do not match longer queries", () => {
  const m = compareAround(funnelsByDay(events()), [{ text: "ריף", exact: true }], new Date(at("2026-09-30")));
  assert.equal(m.before.sessions + m.after.sessions, 0);
});
