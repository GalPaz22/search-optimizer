import { query } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId } from "mongodb";
import { controlDb } from "../core/db.js";
import { getTenantByApiKey, listTenants, Tenant } from "../core/tenant.js";
import { buildConversionReport, reportDigest } from "../analytics/report.js";
import { liveSearch } from "../analytics/live-search.js";
import { queryEvidence } from "../analytics/evidence.js";
import { analyticsFor, createRunContext, rememberQueries, RunContext, workspaceContext } from "./context.js";
import { ASK_PROMPT, openingMessage, QUERY_PROMPT, queryOpeningMessage, SYSTEM_PROMPT } from "./prompts.js";
import { buildAgentServer, MCP_SERVER } from "./tools/index.js";
import { saveReport } from "./tools/report.js";

// Spending limits are opt-in: unset means no cap (spend is still recorded per run).
export const MONTHLY_BUDGET_USD = Number(process.env.AGENT_MONTHLY_BUDGET_USD) || Infinity;
const RUN_BUDGET_USD = Number(process.env.AGENT_RUN_BUDGET_USD) || Infinity;
const MODEL = process.env.AGENT_MODEL || "claude-fable-5";
const MAX_TURNS = Number(process.env.AGENT_MAX_TURNS) || 45;
const EFFORT = process.env.AGENT_EFFORT as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
// Fable-class models think for minutes per turn; a full review takes well over 20 minutes.
const RUN_TIMEOUT_MS = (Number(process.env.AGENT_RUN_TIMEOUT_MIN) || 50) * 60_000;
const QUICK_MODEL = process.env.AGENT_QUICK_MODEL || "claude-sonnet-5";
const QUICK_EFFORT = process.env.AGENT_QUICK_EFFORT as "low" | "medium" | "high" | undefined;
const QUICK_MAX_TURNS = Number(process.env.AGENT_QUICK_MAX_TURNS) || 14;
const QUICK_BUDGET_USD = Number(process.env.AGENT_QUICK_BUDGET_USD) || Infinity;
const QUICK_DAYS = 30;
// $/MTok (input, output) for cost estimates when a run ends before the SDK reports its cost.
const PRICES: Record<string, [number, number]> = { "claude-fable-5": [10, 50], "claude-fable-5-1": [10, 50], "claude-opus-5": [5, 25], "claude-opus-5-5": [4, 20], "claude-sonnet-5": [2, 10], "claude-haiku-4-5": [1, 5] };
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;

type Runs = Awaited<ReturnType<typeof controlDb>>;
const startOfMonth = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1);

/** Sum of costUsd across this store's agent runs since the start of the current calendar month. */
export async function getMonthlySpend(cdb: Runs, apiKey: string, now: Date = new Date()): Promise<number> {
  const tenant = await getTenantByApiKey(apiKey);
  const rows = await cdb.collection("agent_runs")
    .find({ $or: [{ tenantApiKey: apiKey }, ...(tenant ? [{ dbName: tenant.dbName }] : [])], startedAt: { $gte: startOfMonth(now) } })
    .project({ costUsd: 1 }).toArray();
  return rows.reduce((sum, r: any) => sum + (r.costUsd || 0), 0);
}

/** In-flight runs of this process, so the operator can stop one. */
const active = new Map<string, AbortController>();
export function stopAgentRun(runId: string): boolean {
  const c = active.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export type LiveEvent = { type: "text"; delta: string } | { type: "reset" } | { type: "step"; name: string } | { type: "done" };
/** Token-level output of in-flight runs, for streaming the answer while it is written. */
const feeds = new Map<string, { text: string; step: string | null; listeners: Set<(e: LiveEvent) => void> }>();
function feed(runId: string) {
  const f = { text: "", step: null as string | null, listeners: new Set<(e: LiveEvent) => void>() };
  feeds.set(runId, f);
  const emit = (e: LiveEvent) => { for (const l of f.listeners) l(e); };
  return {
    text(delta: string) { f.text += delta; emit({ type: "text", delta }); },
    reset() { if (f.text) { f.text = ""; emit({ type: "reset" }); } },
    step(name: string) { f.step = name; f.text = ""; emit({ type: "step", name }); },
    end() { emit({ type: "done" }); feeds.delete(runId); },
  };
}
/** Current text and step of a running run plus a listener for what follows; null when the run is not live here. */
export function subscribeRun(runId: string, listener: (e: LiveEvent) => void) {
  const f = feeds.get(runId);
  if (!f) return null;
  f.listeners.add(listener);
  return { text: f.text, step: f.step, unsubscribe: () => { f.listeners.delete(listener); } };
}

const clip = (v: unknown, n: number) => { const s = typeof v === "string" ? v : JSON.stringify(v) ?? ""; return s.length > n ? s.slice(0, n) + "…" : s; };
const resultText = (content: unknown) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).join("") : "");
const errorOf = (text: string) => { try { const j = JSON.parse(text); return typeof j?.error === "string" ? j.error : null; } catch { return null; } };

interface Step { id: string; at: Date; type: "tool" | "note" | "system"; name?: string; input?: string; ok?: boolean; output?: string; text?: string }

/** Appends steps to the run document as the stream arrives (bounded, newest kept). */
function stepLog(cdb: Runs, runId: ObjectId) {
  let pending: Step[] = [], results: { id: string; ok: boolean; output: string }[] = [];
  return {
    add: (s: Omit<Step, "at">) => pending.push({ ...s, at: new Date() }),
    result: (id: string, ok: boolean, output: string) => results.push({ id, ok, output }),
    async flush(extra: Record<string, unknown> = {}) {
      const steps = pending, done = results;
      pending = []; results = [];
      if (steps.length) await cdb.collection("agent_runs").updateOne({ _id: runId }, { $push: { steps: { $each: steps, $slice: -400 } } as any, $set: { lastProgressAt: new Date(), ...extra } });
      else if (Object.keys(extra).length) await cdb.collection("agent_runs").updateOne({ _id: runId }, { $set: { lastProgressAt: new Date(), ...extra } });
      for (const r of done) await cdb.collection("agent_runs").updateOne({ _id: runId }, { $set: { "steps.$[s].ok": r.ok, "steps.$[s].output": r.output } }, { arrayFilters: [{ "s.id": r.id }] });
    },
  };
}

type Log = ReturnType<typeof stepLog>;

async function prepareReview(tenant: Tenant, runId: ObjectId, request: string | null | undefined, log: Log) {
  log.add({ id: "report", type: "system", text: "בונה דוח המרה מנתוני החנות" });
  await log.flush();
  const report = await buildConversionReport(tenant, { days: 30 }).catch(e => { log.add({ id: "report-error", type: "system", ok: false, text: `הדוח לא נבנה: ${(e as Error).message}` }); return null; });
  const workspace = await workspaceContext(tenant).catch(() => null);
  const ctx = createRunContext(tenant, String(runId), report);
  log.add({ id: "context", type: "system", text: report ? `דוח ${report.days} ימים: ${report.funnel.sessions.searched} סשנים עם חיפוש, ${report.funnel.orders.total} הזמנות, ${report.tracking.length} ממצאי מדידה` : "ממשיך בלי דוח נתונים" });
  await log.flush({ dataReportId: report?.reportId ?? null, status: "running" });
  return { ctx, prompt: openingMessage({ request, workspace, data: report ? reportDigest(report) : null }) };
}

const QUICK_TOOLS = ["query_evidence", "search_catalog", "get_product_source", "promote_products", "propose_rule", "propose_experiment"];
const liveRow = (p: any, i: number) => ({
  position: i + 1, id: p._id ?? p.id ?? null, name: p.name ?? p.title ?? "", price: p.price ?? null, stockStatus: p.stockStatus ?? p.stock_status ?? null,
  category: [p.category].flat().filter(Boolean).slice(0, 3), softCategory: [p.softCategory].flat().filter(Boolean).slice(0, 5), pinned: p.pinned || p.isPinned || undefined,
});

async function prepareQueryCheck(tenant: Tenant, runId: ObjectId, term: string, request: string | null | undefined, log: Log) {
  log.add({ id: "query", type: "system", text: `בודק את התוצאות והנתונים של "${term}"` });
  await log.flush({ status: "running" });
  const ctx = createRunContext(tenant, String(runId), null);
  rememberQueries(ctx, [term]);
  const [live, a] = await Promise.all([
    liveSearch(tenant, term).then(list => list.slice(0, 12).map(liveRow)).catch(e => ({ error: (e as Error).message })),
    analyticsFor(ctx, QUICK_DAYS),
  ]);
  const evidence = queryEvidence(a.ev, a.rows, a.catalog, term);
  rememberQueries(ctx, [evidence.query, ...evidence.relatedQueries.map(r => r.query)]);
  log.add({ id: "query-data", type: "system", text: `${Array.isArray(live) ? `${live.length} תוצאות חיות` : "תוצאות חיות לא זמינות"} · ${evidence.funnel?.searches ?? 0} חיפושים ב-${QUICK_DAYS} ימים` });
  await log.flush();
  const store = { windowDays: QUICK_DAYS, clickRate: a.funnel.rates.click, cartRate: a.funnel.rates.cart, purchaseRate: a.funnel.rates.purchase };
  return { ctx, prompt: queryOpeningMessage({ query: term, request, live, evidence, store }) };
}

const ASK_TOOLS = [
  "customer_analytics", "store_funnel", "query_evidence", "search_audit", "production_baseline", "weekly_query_review",
  "search_catalog", "get_product_source", "get_catalog_filter_coverage", "get_current_config",
  "promote_products", "hide_products", "propose_rule", "propose_experiment", "create_optimization_action",
  "list_optimization_actions", "list_experiments", "read_experiment_results",
];

async function prepareQuestion(tenant: Tenant, runId: ObjectId, request: string, conversationId: string, log: Log) {
  log.add({ id: "ask", type: "system", text: "קורא את ההודעה" });
  await log.flush({ status: "running" });
  const earlier = await (await controlDb()).collection("agent_runs").find({ dbName: tenant.dbName, conversationId, _id: { $ne: runId }, status: "completed" })
    .sort({ startedAt: -1 }).limit(6).project({ request: 1, summary: 1 }).toArray();
  const history = earlier.reverse().map(r => `Merchant: ${clip(r.request, 400)}\nAssistant: ${clip(r.summary, 700)}`).join("\n\n");
  const today = new Date().toISOString().slice(0, 10);
  return { ctx: createRunContext(tenant, String(runId), null), prompt: `STORE: ${tenant.dbName}\nTODAY: ${today}${history ? `\n\nHISTORY\n${history}` : ""}\n\nMESSAGE: ${request}` };
}

export type RunMode = "review" | "query" | "ask";
const LIGHT: Record<Exclude<RunMode, "review">, { prompt: string; tools: string[] }> = { query: { prompt: QUERY_PROMPT, tools: QUICK_TOOLS }, ask: { prompt: ASK_PROMPT, tools: ASK_TOOLS } };

async function execute(tenant: Tenant, runId: ObjectId, opts: { mode: RunMode; request?: string | null; query?: string | null; conversationId?: string; spentSoFar: number }, abort: AbortController) {
  const cdb = await controlDb(), log = stepLog(cdb, runId), live = feed(String(runId));
  let summary = "", toolCalls = 0, costUsd = 0, ctx: RunContext | null = null;
  // The latest report the agent tried to submit: kept so a budget cut during that call does not lose it.
  let pendingReport: unknown = null;
  // Token usage per API response, deduplicated by message id (one response streams as several messages).
  const usage = new Map<string, any>();
  const estimatedCost = () => {
    const [inP, outP] = PRICES[light ? QUICK_MODEL : MODEL] ?? PRICES["claude-fable-5"];
    let usd = 0;
    for (const u of usage.values()) usd += ((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * inP / 1e6 + (u.output_tokens ?? 0) * outP / 1e6;
    return Math.round(usd * 10000) / 10000;
  };
  const light = opts.mode === "review" ? null : LIGHT[opts.mode];
  const timeout = setTimeout(() => abort.abort(), light ? 10 * 60_000 : RUN_TIMEOUT_MS);
  try {
    const setup = opts.mode === "query" ? await prepareQueryCheck(tenant, runId, opts.query!, opts.request, log)
      : opts.mode === "ask" ? await prepareQuestion(tenant, runId, opts.request!, opts.conversationId ?? String(runId), log)
        : await prepareReview(tenant, runId, opts.request, log);
    ctx = setup.ctx;

    const stream = query({
      prompt: setup.prompt,
      options: {
        abortController: abort,
        systemPrompt: light ? light.prompt : SYSTEM_PROMPT,
        model: light ? QUICK_MODEL : MODEL,
        maxTurns: light ? QUICK_MAX_TURNS : MAX_TURNS,
        ...(light ? (QUICK_EFFORT ? { effort: QUICK_EFFORT } : {}) : EFFORT ? { effort: EFFORT } : {}),
        ...(() => { const cap = Math.min(light ? QUICK_BUDGET_USD : RUN_BUDGET_USD, MONTHLY_BUDGET_USD - opts.spentSoFar); return Number.isFinite(cap) ? { maxBudgetUsd: Math.max(0.01, cap) } : {}; })(),
        allowedTools: [`${TOOL_PREFIX}*`],
        tools: [],
        includePartialMessages: true,
        mcpServers: { [MCP_SERVER]: buildAgentServer(ctx, light?.tools) },
        stderr: (data: string) => console.error("[agent stderr]", data),
      },
    });

    for await (const message of stream) {
      if (message.type === "stream_event") {
        const ev: any = message.event;
        // Text written before a tool call is narration; the answer is the text of the last model turn.
        if (ev.type === "message_start") live.reset();
        else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") live.step(String(ev.content_block.name).replace(TOOL_PREFIX, ""));
        else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") live.text(ev.delta.text);
      } else if (message.type === "assistant") {
        const m: any = message.message;
        if (m?.id && m.usage) usage.set(m.id, m.usage);
        for (const block of message.message.content as any[]) {
          if (block.type === "tool_use") {
            toolCalls++;
            const name = String(block.name).replace(TOOL_PREFIX, "");
            if (name === "submit_conversion_report") pendingReport = block.input;
            log.add({ id: block.id, type: "tool", name, input: clip(block.input, 400) });
          }
          if (block.type === "text" && block.text?.trim()) { summary = block.text; log.add({ id: String(new ObjectId()), type: "note", text: clip(block.text, 600) }); }
        }
        await log.flush({ toolCalls });
      } else if (message.type === "user" && Array.isArray((message.message as any)?.content)) {
        for (const block of (message.message as any).content) {
          if (block?.type !== "tool_result") continue;
          const text = resultText(block.content), error = block.is_error ? text : errorOf(text);
          log.result(block.tool_use_id, !error, clip(error ?? text, 500));
        }
        await log.flush();
      } else if (message.type === "result") {
        costUsd = (message as any).total_cost_usd ?? 0;
        if ((message as any).result) summary = (message as any).result;
        if (message.is_error) throw new Error(`Agent run did not complete: ${message.subtype}`);
      }
    }

    const counts = await runCounts(cdb, tenant, runId);
    await log.flush({ status: "completed", endedAt: new Date(), toolCalls, ...counts, ...(light ? { reportMissing: false } : {}), costUsd, summary });
    if (opts.spentSoFar + costUsd >= MONTHLY_BUDGET_USD) console.warn(`[agent] ${tenant.dbName} reached the monthly budget ($${(opts.spentSoFar + costUsd).toFixed(2)}/$${MONTHLY_BUDGET_USD})`);
    return { runId: String(runId), summary };
  } catch (e) {
    const stopped = abort.signal.aborted, message = (e as Error).message, budget = /max_budget/.test(message);
    // Without a final result message the SDK reports no cost; estimate it so budgets stay honest.
    const costEstimated = !costUsd && usage.size > 0;
    if (costEstimated) costUsd = estimatedCost();
    // A budget cut often lands on the final report call itself: save what the agent submitted.
    let rescued = false;
    if (ctx && pendingReport && !(await cdb.collection("agent_runs").findOne({ _id: runId, reportId: { $exists: true } }))) {
      const saved: any = await saveReport(ctx, pendingReport).catch(err => ({ error: (err as Error).message }));
      rescued = !!saved?.ok;
      log.add({ id: "rescue", type: "system", ok: rescued, text: rescued ? "הדוח שהסוכן שלח נשמר אחרי שנגמר התקציב" : `הדוח האחרון לא נשמר: ${saved?.error ?? "לא תקין"}` });
    }
    const counts = await runCounts(cdb, tenant, runId).catch(() => ({}));
    await log.flush({
      status: stopped ? "stopped" : budget && rescued ? "completed" : "failed", endedAt: new Date(), toolCalls, ...counts, costUsd, costEstimated, summary, budgetExhausted: budget,
      error: stopped ? "נעצר לבקשת המפעיל או בגלל מגבלת זמן" : budget ? `תקציב הריצה נוצל ($${costUsd.toFixed(2)})${rescued ? " — הדוח נשמר" : ""}` : message,
    });
    if (stopped || budget) return { runId: String(runId), summary };
    throw e;
  } finally {
    clearTimeout(timeout);
    live.end();
  }
}

async function runCounts(cdb: Runs, tenant: Tenant, runId: ObjectId) {
  const [proposals, diagnoses, actions, runDoc] = await Promise.all([
    cdb.collection("proposals").countDocuments({ agentRunId: String(runId) }),
    cdb.collection("optimization_actions").countDocuments({ dbName: tenant.dbName, "diagnosis.agentRunId": String(runId) }),
    cdb.collection("optimization_actions").countDocuments({ dbName: tenant.dbName, agentRunId: String(runId) }),
    cdb.collection("agent_runs").findOne({ _id: runId }, { projection: { reportId: 1 } }),
  ]);
  return { proposals, diagnoses, actions, reportMissing: !runDoc?.reportId };
}

/**
 * Starts a run for one store and returns as soon as it is registered; the
 * analysis continues in the background (done resolves when it ends). Budget
 * and the per-store lock are checked first, so an over-budget or already
 * running store never reaches the model.
 */
export async function startAgentRun(apiKey: string, opts: { request?: string | null; query?: string | null; review?: boolean; conversationId?: string; trigger?: "manual" | "schedule" } = {}) {
  const tenant = await getTenantByApiKey(apiKey);
  if (!tenant) throw new Error("Unknown store");
  const cdb = await controlDb(), request = opts.request?.trim() ? opts.request.trim().slice(0, 2000) : null;
  const spentSoFar = await getMonthlySpend(cdb, apiKey);
  if (spentSoFar >= MONTHLY_BUDGET_USD) {
    const runId = new ObjectId();
    const summary = `דילוג: החנות כבר הוציאה $${spentSoFar.toFixed(2)} החודש, מעל תקציב של $${MONTHLY_BUDGET_USD}. יתחדש בחודש הבא.`;
    const conversationId = opts.conversationId && ObjectId.isValid(opts.conversationId) ? opts.conversationId : String(runId);
    await cdb.collection("agent_runs").insertOne({ _id: runId, tenantApiKey: apiKey, dbName: tenant.dbName, conversationId, request, trigger: opts.trigger ?? "manual", startedAt: new Date(), endedAt: new Date(), status: "skipped_budget", toolCalls: 0, proposals: 0, costUsd: 0, summary });
    return { runId: String(runId), status: "skipped_budget" as const, conversationId, done: Promise.resolve({ runId: String(runId), summary }) };
  }
  const runId = new ObjectId(), abort = new AbortController();
  const locks = cdb.collection<{ _id: string; until: Date; owner: string }>("agent_run_locks"), owner = String(runId);
  try {
    const lock = await locks.findOneAndUpdate({ _id: tenant.dbName, until: { $lt: new Date() } }, { $set: { until: new Date(Date.now() + 2 * 3_600_000), owner } }, { upsert: true, returnDocument: "after" });
    if (!lock) throw new Error("Analysis already running for this store");
  } catch (e: any) { if (e.code === 11000) throw new Error("Analysis already running for this store"); throw e; }

  const term = opts.query?.trim().slice(0, 200) || null;
  const mode: RunMode = term ? "query" : request && !opts.review ? "ask" : "review";
  const conversationId = opts.conversationId && ObjectId.isValid(opts.conversationId) && (await cdb.collection("agent_runs").findOne({ dbName: tenant.dbName, conversationId: opts.conversationId }, { projection: { _id: 1 } })) ? opts.conversationId : String(runId);
  await cdb.collection("agent_runs").insertOne({ _id: runId, tenantApiKey: apiKey, dbName: tenant.dbName, conversationId, request: request ?? (term ? `בדיקת החיפוש ״${term}״` : mode === "review" ? "סקירה מלאה של החנות" : null), query: term, mode, trigger: opts.trigger ?? "manual", model: mode === "review" ? MODEL : QUICK_MODEL, startedAt: new Date(), lastProgressAt: new Date(), status: "queued", steps: [], toolCalls: 0, proposals: 0 });
  active.set(String(runId), abort);
  const done = execute(tenant, runId, { mode, request, query: term, conversationId, spentSoFar }, abort).finally(async () => {
    active.delete(String(runId));
    await locks.deleteOne({ _id: tenant.dbName, owner });
  });
  done.catch(e => console.error(`[agent] run ${runId} for ${tenant.dbName} failed:`, (e as Error).message));
  return { runId: String(runId), status: "running" as const, conversationId, done };
}

/** Runs to completion (schedules and scripts). */
export async function runAgentForTenant(apiKey: string, opts: { request?: string | null; trigger?: "manual" | "schedule" } = {}) {
  return (await startAgentRun(apiKey, opts)).done;
}

async function lastAgentRunAt(cdb: Runs, dbName: string): Promise<Date | null> {
  const last = await cdb.collection("agent_runs").find({ dbName, status: { $in: ["completed", "failed", "skipped_budget", "stopped"] } }).sort({ startedAt: -1 }).limit(1).toArray();
  return last[0]?.startedAt ?? null;
}

/**
 * Runs each store whose last run is older than intervalMs (interval-based so
 * cadence self-heals after downtime; call it from a frequent tick). Stores
 * with a daily optimization policy are run by that schedule instead.
 */
export async function runAgentForDueTenants(intervalMs: number): Promise<void> {
  const cdb = await controlDb(), now = Date.now(), seen = new Set<string>();
  for (const t of await listTenants()) {
    if (seen.has(t.dbName)) continue;
    seen.add(t.dbName);
    if (await cdb.collection("optimization_policies").findOne({ dbName: t.dbName, $or: [{ enabled: true }, { agentEnabled: false }] })) continue;
    const last = await lastAgentRunAt(cdb, t.dbName);
    if (last && now - last.getTime() < intervalMs) continue;
    try {
      console.log(`[agent] running for ${t.dbName} (due; last run ${last?.toISOString() ?? "never"})`);
      await runAgentForTenant(t.apiKey, { trigger: "schedule" });
    } catch (e) {
      console.error(`[agent] run failed for ${t.dbName}:`, (e as Error).message);
    }
  }
}

/**
 * A restart kills in-flight runs. Runs silent for 10 minutes (every streamed
 * message refreshes lastProgressAt) are marked interrupted and their store
 * lock is released, so the store can be analysed again right away.
 */
export async function recoverInterruptedRuns(): Promise<void> {
  const cdb = await controlDb();
  const stale = new Date(Date.now() - 10 * 60_000);
  const dead = await cdb.collection("agent_runs").find({ status: { $in: ["queued", "running"] }, $or: [{ lastProgressAt: { $lt: stale } }, { lastProgressAt: { $exists: false }, startedAt: { $lt: stale } }] }).project({ _id: 1 }).toArray();
  const ids = dead.map(r => r._id).filter(id => !active.has(String(id)));
  if (!ids.length) return;
  await cdb.collection("agent_runs").updateMany({ _id: { $in: ids } }, { $set: { status: "failed", endedAt: new Date(), error: "הריצה נקטעה (השרת הופעל מחדש או נתקע)" } });
  await cdb.collection<{ _id: string; owner: string }>("agent_run_locks").deleteMany({ owner: { $in: ids.map(String) } });
}
