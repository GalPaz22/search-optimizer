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

const PinnedResultsPatch = z
  .array(
    z.object({
      query: z.string().min(1),
      productIds: z.array(z.union([z.string(), z.number()])).min(1),
      enabled: z.boolean().default(true),
    })
  )
  .optional();

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
    pinnedResults: PinnedResultsPatch,
  }),
  notes: z.string(),
  warnings: z.array(z.string()).default([]),
});

/**
 * Turns a free-text merchandising instruction ("boost all red wines at
 * night", "always show whiskey when someone searches bourbon", "pin these
 * three watches on 'venu'") into a structured condition + patch, grounded in
 * this tenant's real category labels and, for pin requests, real product
 * ids looked up by name. Never throws — callers get a rejected promise with
 * a readable message instead, since this is a synchronous user-facing
 * action (unlike the hook, there's no "fall back to control" here).
 */
export async function parseRuleText(tenant: Tenant, text: string): Promise<ParsedRuleDraft> {
  const labels = await getTenantLabels(tenant);

  let draft: ParsedRuleDraft | null = null;
  const mcpServer = createSdkMcpServer({
    name: "rule-parser",
    version: "1.0.0",
    tools: [
      tool(
        "search_products",
        "Search this store's real product catalog by name to find the actual product id(s) needed for a pinning instruction. Call this whenever the merchant names specific products to pin — never invent or guess a product id.",
        { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) },
        async ({ query: q, limit }) => {
          const db = await tenantDb(tenant.dbName);
          const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
          const products = await db
            .collection("products")
            .find({ name: rx, hidden: { $ne: true } })
            .project({ id: 1, name: 1, price: 1 })
            .limit(limit)
            .toArray();
          return {
            content: [{ type: "text", text: JSON.stringify(products.map((p) => ({ id: p.id, name: p.name, price: p.price }))) }],
          };
        }
      ),
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

Choosing the right patch field matters — they are NOT interchangeable:
- patch.pinnedResults = [{query, productIds, enabled}] — use when the merchant names SPECIFIC, ENUMERABLE products (by name, SKU, or "these N items") to force into fixed positions on a specific query. Call search_products first to look up each named product's real id — never invent an id. Do not use this for "pin all of category X" — that's an open-ended, changing set; use softCategoriesBoost instead so new matching products are automatically included.
- patch.softCategoriesBoost = { "<soft category label>": <positive number, higher = more boost> } — use for "boost/prioritize/always show first" instructions about a whole category or product line (not a fixed list of specific items). You MUST use one of this store's ACTUAL soft-category labels listed below, not the merchant's casual phrase — pick the closest real match. A very high value (e.g. 100+) makes the category dominate its own matching query.
- patch.categoryAssociation = { softCategories: [...], categories: [...], limit } — use for "also show Y when someone searches X" cross-category association instructions, where Y is a DIFFERENT category than what the query would normally match. Requires condition.mode "queryMatch" with the trigger query in patterns.
- patch.productBoosts / profileBoostMultiplier = only if the instruction is clearly about specific products' boost score, or personalization strength.

This store's real soft-category labels: ${JSON.stringify(labels.softCategories)}
This store's real (hard) category labels: ${JSON.stringify(labels.categories)}

If the instruction references a concept with no close match in those lists, or names a product you can't find via search_products, still produce your best-guess condition/patch but add a clear warning string explaining the mismatch.

Call emit_parsed_rule exactly once with your final result, then stop.`;

  const stream = query({
    prompt: `Merchant instruction: "${text}"`,
    options: {
      systemPrompt,
      model: "claude-fable-5",
      maxTurns: 8,
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
