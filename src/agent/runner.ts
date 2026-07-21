import { query } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { controlDb } from "../core/db.js";
import { getTenantByApiKey, listTenants } from "../core/tenant.js";
import { buildAnalyticsServer } from "./tools.js";
import { systemPrompt } from "./prompts.js";

export const MONTHLY_BUDGET_USD = Number(process.env.AGENT_MONTHLY_BUDGET_USD) || 20;

function startOfMonth(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Sum of costUsd across this tenant's agent runs since the start of the current calendar month. */
export async function getMonthlySpend(
  cdb: Awaited<ReturnType<typeof controlDb>>,
  apiKey: string,
  now: Date = new Date()
): Promise<number> {
  const rows = await cdb
    .collection("agent_runs")
    .find({ tenantApiKey: apiKey, startedAt: { $gte: startOfMonth(now) } })
    .project({ costUsd: 1 })
    .toArray();
  return rows.reduce((sum, r: any) => sum + (r.costUsd || 0), 0);
}

export async function runAgentForTenant(apiKey: string): Promise<{ runId: string; summary: string }> {
  const cdb = await controlDb();

  // Budget check comes before the tenant lookup/SDK call so an over-budget
  // tenant never incurs an API call, regardless of apiKey validity.
  const spentSoFar = await getMonthlySpend(cdb, apiKey);
  if (spentSoFar >= MONTHLY_BUDGET_USD) {
    const runId = new ObjectId();
    const summary = `Skipped: this tenant has already spent $${spentSoFar.toFixed(2)} this month, at or above the $${MONTHLY_BUDGET_USD} monthly budget. Resumes automatically next calendar month.`;
    await cdb.collection("agent_runs").insertOne({
      _id: runId,
      tenantApiKey: apiKey,
      startedAt: new Date(),
      endedAt: new Date(),
      status: "skipped_budget",
      toolCalls: 0,
      proposals: 0,
      costUsd: 0,
      summary,
    });
    console.warn(`[agent] skipping ${apiKey}: monthly budget exhausted ($${spentSoFar.toFixed(2)}/$${MONTHLY_BUDGET_USD})`);
    return { runId: String(runId), summary };
  }

  const tenant = await getTenantByApiKey(apiKey);
  if (!tenant) throw new Error(`Unknown tenant apiKey: ${apiKey}`);

  const runId = new ObjectId();
  await cdb.collection("agent_runs").insertOne({
    _id: runId,
    tenantApiKey: apiKey,
    startedAt: new Date(),
    status: "running",
    toolCalls: 0,
    proposals: 0,
  });

  const mcpServer = buildAnalyticsServer(tenant, String(runId));
  let summary = "";
  let toolCalls = 0;
  let costUsd = 0;

  try {
    const stream = query({
      prompt:
        "Run your full process: first measure and report on any currently running experiments, then look at the last 30 days of search data for genuinely new opportunities. Only propose something if it clearly meets the bar — zero proposals is a fine outcome. Follow your rules strictly.",
      options: {
        systemPrompt: systemPrompt(tenant.context),
        model: "claude-fable-5",
        maxTurns: 30,
        allowedTools: ["mcp__tenant-analytics"],
        mcpServers: { "tenant-analytics": mcpServer },
        stderr: (data: string) => console.error("[agent stderr]", data),
      },
    });

    for await (const message of stream) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") toolCalls++;
          if (block.type === "text") summary = block.text;
        }
      }
      if (message.type === "result") {
        costUsd = (message as any).total_cost_usd ?? 0;
        if ((message as any).result) summary = (message as any).result;
      }
    }

    const proposals = await cdb.collection("proposals").countDocuments({ agentRunId: String(runId) });
    await cdb.collection("agent_runs").updateOne(
      { _id: runId },
      { $set: { status: "completed", endedAt: new Date(), toolCalls, proposals, costUsd, summary } }
    );

    const newTotal = spentSoFar + costUsd;
    if (newTotal >= MONTHLY_BUDGET_USD) {
      console.warn(`[agent] ${tenant.dbName} crossed monthly budget this run: $${newTotal.toFixed(2)}/$${MONTHLY_BUDGET_USD} — will skip until next month`);
    }
    return { runId: String(runId), summary };
  } catch (e) {
    await cdb.collection("agent_runs").updateOne(
      { _id: runId },
      { $set: { status: "failed", endedAt: new Date(), toolCalls, costUsd, error: (e as Error).message } }
    );
    throw e;
  }
}

export async function runAgentForAllTenants(): Promise<void> {
  const tenants = await listTenants();
  for (const t of tenants) {
    try {
      console.log(`[agent] running for tenant ${t.dbName}`);
      await runAgentForTenant(t.apiKey);
    } catch (e) {
      console.error(`[agent] run failed for ${t.dbName}:`, (e as Error).message);
    }
  }
}

async function lastAgentRunAt(cdb: Awaited<ReturnType<typeof controlDb>>, apiKey: string): Promise<Date | null> {
  const last = await cdb
    .collection("agent_runs")
    .find({ tenantApiKey: apiKey, status: { $in: ["completed", "failed", "skipped_budget"] } })
    .sort({ startedAt: -1 })
    .limit(1)
    .toArray();
  return last[0]?.startedAt ?? null;
}

/**
 * Runs the agent for each tenant only if its last completed/failed/skipped run
 * is older than intervalMs (or it has never run). Interval-based rather than a
 * fixed calendar-cron field so cadence doesn't drift at month boundaries and
 * self-heals if the service was briefly down — call this from a frequent
 * cron tick (e.g. hourly), not a once-daily one. Budget enforcement happens
 * inside runAgentForTenant itself, so a due-but-over-budget tenant still
 * "runs" (cheaply, recording a skipped_budget row) rather than being silently
 * invisible in agent_runs.
 */
export async function runAgentForDueTenants(intervalMs: number): Promise<void> {
  const cdb = await controlDb();
  const tenants = await listTenants();
  const now = Date.now();
  for (const t of tenants) {
    const last = await lastAgentRunAt(cdb, t.apiKey);
    if (last && now - last.getTime() < intervalMs) continue;
    try {
      console.log(`[agent] running for tenant ${t.dbName} (due; last run ${last?.toISOString() ?? "never"})`);
      await runAgentForTenant(t.apiKey);
    } catch (e) {
      console.error(`[agent] run failed for ${t.dbName}:`, (e as Error).message);
    }
  }
}
