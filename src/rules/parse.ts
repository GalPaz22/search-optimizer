import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Targeting, ArmPatch } from "../core/types.js";
import { Tenant } from "../core/tenant.js";
import { tenantDb } from "../core/db.js";

export interface ParsedRuleDraft {
  name: string;
  condition: Targeting;
  patch: ArmPatch;
  notes: string;
  warnings: string[];
}

async function getTenantLabels(tenant: Tenant): Promise<{ softCategories: string[]; categories: string[] }> {
  const db = await tenantDb(tenant.dbName);
  const [softCategories, categories] = await Promise.all([
    db.collection("products").distinct("softCategory"),
    db.collection("products").distinct("category"),
  ]);
  const flat = (v: unknown[]): string[] =>
    [...new Set(v.flat().filter((x): x is string => typeof x === "string" && x.trim().length > 0))].slice(0, 300);
  return { softCategories: flat(softCategories), categories: flat(categories) };
}

const EmitParsedRule = z.object({
  name: z.string().min(3).max(80),
  condition: z.object({
    mode: z.enum(["all", "queryMatch"]),
    patterns: z.array(z.string()).default([]),
    matchType: z.enum(["exact", "contains"]).default("contains"),
    timeWindow: z
      .object({
        startHour: z.number().int().min(0).max(23),
        endHour: z.number().int().min(0).max(23),
        timezone: z.string().default("Asia/Jerusalem"),
      })
      .optional(),
  }),
  patch: z.object({
    productBoosts: z.record(z.string(), z.number()).optional(),
    softCategoriesBoost: z.record(z.string(), z.number()).optional(),
    profileBoostMultiplier: z.number().optional(),
    categoryAssociation: z
      .object({
        softCategories: z.array(z.string()).default([]),
        categories: z.array(z.string()).default([]),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .optional(),
  }),
  notes: z.string(),
  warnings: z.array(z.string()).default([]),
});

/**
 * Turns a free-text merchandising instruction ("boost all red wines at
 * night", "always show whiskey when someone searches bourbon") into a
 * structured condition + patch, grounded in this tenant's real category
 * labels so e.g. "red wines" maps to whatever soft-category string this
 * store actually uses. Never throws — callers get a rejected promise with a
 * readable message instead, since this is a synchronous user-facing action
 * (unlike the hook, there's no "fall back to control" here).
 */
export async function parseRuleText(tenant: Tenant, text: string): Promise<ParsedRuleDraft> {
  const labels = await getTenantLabels(tenant);

  let draft: ParsedRuleDraft | null = null;
  const mcpServer = createSdkMcpServer({
    name: "rule-parser",
    version: "1.0.0",
    tools: [
      tool(
        "emit_parsed_rule",
        "Call this exactly once with the structured rule you parsed from the merchant's sentence.",
        EmitParsedRule.shape,
        async (input) => {
          draft = input as ParsedRuleDraft;
          return { content: [{ type: "text", text: "recorded" }] };
        }
      ),
    ],
  });

  const systemPrompt = `You translate a merchant's plain-language search-merchandising instruction into a structured rule for a store${
    tenant.context ? ` (context: ${tenant.context})` : ""
  }.

A rule has a CONDITION (when it applies) and a PATCH (what it does):
- condition.mode "all" = applies to every search; "queryMatch" = only when the search query contains/equals one of condition.patterns.
- condition.timeWindow = optional hour range (0-23, e.g. startHour:22, endHour:6 means 22:00-06:00, wrapping past midnight). Include this ONLY if the instruction mentions a time of day / night / hours.
- patch.softCategoriesBoost = { "<soft category label>": <positive number, higher = more boost } — use for "boost X" instructions about a whole category. You MUST use one of this store's ACTUAL soft-category labels listed below, not the merchant's casual phrase — pick the closest real match.
- patch.categoryAssociation = { softCategories: [...], categories: [...], limit } — use for "also show Y when someone searches X" cross-category association instructions. Requires condition.mode "queryMatch" with the trigger query in patterns.
- patch.productBoosts / profileBoostMultiplier = only if the instruction is clearly about specific products or personalization strength.

This store's real soft-category labels: ${JSON.stringify(labels.softCategories)}
This store's real (hard) category labels: ${JSON.stringify(labels.categories)}

If the instruction references a concept with no close match in those lists, still produce your best-guess condition/patch but add a clear warning string explaining the mismatch (e.g. "no soft-category label resembling 'red wine' found — used closest match X, please verify").

Call emit_parsed_rule exactly once with your result, then stop.`;

  const stream = query({
    prompt: `Merchant instruction: "${text}"`,
    options: {
      systemPrompt,
      model: "claude-fable-5",
      maxTurns: 3,
      allowedTools: ["mcp__rule-parser"],
      mcpServers: { "rule-parser": mcpServer },
    },
  });

  for await (const message of stream) {
    // draining the stream is enough — emit_parsed_rule captures the result
    void message;
  }

  if (!draft) throw new Error("The parser did not produce a rule — try rephrasing the instruction.");

  const parsed = EmitParsedRule.safeParse(draft);
  if (!parsed.success) throw new Error(`Parsed rule failed validation: ${JSON.stringify(parsed.error.flatten())}`);

  return parsed.data;
}
