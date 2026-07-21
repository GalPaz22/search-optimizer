import cron from "node-cron";
import { refreshAllActiveKeys } from "./engine/publisher.js";
import { refreshAllActiveRuleKeys } from "./rules/publisher.js";
import { aggregateAllRunning } from "./metrics/aggregate.js";
import { runAgentForDueTenants } from "./agent/runner.js";
import { controlDb } from "./core/db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AGENT_INTERVAL_MS = (Number(process.env.AGENT_INTERVAL_DAYS) || 2) * DAY_MS;

export function startCrons(): void {
  // Keep Redis active-keys alive (TTL 120s) and in sync with Mongo truth.
  cron.schedule("*/30 * * * * *", () => refreshAllActiveKeys().catch(console.error));
  cron.schedule("*/30 * * * * *", () => refreshAllActiveRuleKeys().catch(console.error));

  // Hourly per-arm funnel snapshots.
  cron.schedule("5 * * * *", () => aggregateAllRunning().catch(console.error));

  // Agent analysis: checked hourly, but only actually runs per-tenant once its
  // last run is older than AGENT_INTERVAL_MS (default 2 days) — interval-based
  // rather than a fixed calendar slot so it can't drift and self-heals after
  // downtime. Enable with AGENT_NIGHTLY=true (name kept for compat).
  if (process.env.AGENT_NIGHTLY === "true") {
    cron.schedule("20 * * * *", () => runAgentForDueTenants(AGENT_INTERVAL_MS).catch(console.error));
  }

  // Expire stale proposals daily.
  cron.schedule("0 4 * * *", async () => {
    const db = await controlDb();
    await db
      .collection("proposals")
      .updateMany({ status: "pending", expiresAt: { $lt: new Date() } }, { $set: { status: "expired" } });
  });
}
