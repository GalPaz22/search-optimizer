import { z } from "zod";

export const ExperimentType = z.enum([
  "boost",
  "pin",
  "softCategoryBoost",
  "personalizationWeight",
  "filterTag",
  "categoryRule",
]);
export type ExperimentType = z.infer<typeof ExperimentType>;

export const ExperimentStatus = z.enum([
  "proposed",
  "approved",
  "running",
  "paused",
  "completed",
  "promoted",
  "rejected",
  "killed",
]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

// Config patch applied to the tenant store object for a variant arm.
// Shapes by experiment type — a patch may combine keys when types compose.
export const ArmPatch = z
  .object({
    productBoosts: z.record(z.string(), z.number().int().min(0).max(3)).optional(),
    pinnedResults: z
      .array(
        z.object({
          query: z.string().min(1),
          productIds: z.array(z.union([z.string(), z.number()])).min(1),
          enabled: z.boolean().default(true),
        })
      )
      .optional(),
    softCategoriesBoost: z.record(z.string(), z.number()).optional(),
    profileBoostMultiplier: z.number().min(0).max(5).optional(),
    // Rule-based cross-category association: "when this experiment's targeted
    // query fires, also surface products from these categories" — e.g. show
    // cognac alongside brandy on query "brandy". Resolved dynamically per
    // request by the dashboard-server hook (piggybacks on the existing
    // pinned-results mechanism), not a static product list.
    categoryAssociation: z
      .object({
        softCategories: z.array(z.string()).default([]),
        categories: z.array(z.string()).default([]),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .refine((v) => v.softCategories.length > 0 || v.categories.length > 0, {
        message: "categoryAssociation needs at least one softCategory or category",
      })
      .optional(),
  })
  .strict();
export type ArmPatch = z.infer<typeof ArmPatch>;

export const Arm = z.object({
  key: z.string().min(1), // "control" | "v1" | ...
  weight: z.number().positive(), // relative weight among arms
  patch: ArmPatch.default({}), // control arm must be {}
});
export type Arm = z.infer<typeof Arm>;

// Time-of-day condition, e.g. 22:00–06:00 wraps past midnight. Shared by
// experiments (targeting) and permanent rules (condition) — same evaluator
// on both sides (assignment.ts here, experiments-hook.mjs in dashboard-server).
export const TimeWindow = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string().default("Asia/Jerusalem"),
});
export type TimeWindow = z.infer<typeof TimeWindow>;

export const Targeting = z.object({
  mode: z.enum(["all", "queryMatch"]),
  patterns: z.array(z.string()).default([]),
  matchType: z.enum(["exact", "contains"]).default("contains"),
  timeWindow: TimeWindow.optional(),
});
export type Targeting = z.infer<typeof Targeting>;

export const Guardrails = z.object({
  minSessionsPerArm: z.number().int().positive().default(1000),
  maxDurationDays: z.number().int().positive().default(21),
  maxConversionDropPct: z.number().positive().default(20),
});

export const ExperimentInput = z.object({
  tenantApiKey: z.string().min(1),
  dbName: z.string().min(1),
  name: z.string().min(1),
  hypothesis: z.string().min(1),
  source: z.enum(["agent", "manual", "nl"]).default("manual"),
  proposalId: z.string().optional(),
  type: ExperimentType,
  targeting: Targeting,
  layer: z.string().default("default"),
  arms: z.array(Arm).min(2),
  trafficPct: z.number().min(1).max(100).default(100),
  guardrails: Guardrails.prefault({}),
  schedule: z
    .object({ startAt: z.coerce.date().optional(), endAt: z.coerce.date().optional() })
    .default({}),
});
export type ExperimentInput = z.infer<typeof ExperimentInput>;

export interface ExperimentDoc extends ExperimentInput {
  _id?: any;
  status: ExperimentStatus;
  createdAt: Date;
  approvedBy?: string;
  statusHistory: { status: ExperimentStatus; at: Date; by?: string; note?: string }[];
}

export const ProposalStatus = z.enum(["pending", "approved", "rejected", "expired"]);

export interface ProposalDoc {
  _id?: any;
  kind?: "experiment";
  tenantApiKey: string;
  hypothesis: string;
  evidence: Record<string, unknown>;
  draftExperiment: ExperimentInput;
  agentRunId?: string;
  status: z.infer<typeof ProposalStatus>;
  reviewerNotes?: string;
  createdAt: Date;
  expiresAt: Date;
}

// Catalog enrichment is deliberately separate from experiments: changing a
// product document is global state and would contaminate an A/B control arm.
export const CatalogFilterChange = z.object({
  filter: z.string().trim().min(2).max(80),
  productIds: z.array(z.string().min(1)).min(1).max(500),
  rationale: z.string().min(20),
});
export type CatalogFilterChange = z.infer<typeof CatalogFilterChange>;

export interface CatalogFilterProposalDoc {
  _id?: any;
  kind: "catalogFilter";
  tenantApiKey: string;
  dbName: string;
  hypothesis: string;
  evidence: Record<string, unknown>;
  catalogChange: CatalogFilterChange;
  agentRunId?: string;
  status: z.infer<typeof ProposalStatus>;
  createdAt: Date;
  expiresAt: Date;
}

// Permanent, always-on rules ("boost all red wines 22:00-06:00", "always
// show whiskey on 'bourbon'") — distinct from experiments because they have
// no control group and no measurement; they just apply to 100% of matching
// traffic until disabled. Condition reuses Targeting (query match and/or
// time window); patch reuses the exact same ArmPatch shapes as experiments.
export const RuleInput = z.object({
  tenantApiKey: z.string().min(1),
  dbName: z.string().min(1),
  name: z.string().min(1),
  naturalLanguageText: z.string().min(1),
  condition: Targeting,
  patch: ArmPatch,
});
export type RuleInput = z.infer<typeof RuleInput>;

export const RuleStatus = z.enum(["active", "disabled"]);

export interface RuleDoc extends RuleInput {
  _id?: any;
  status: z.infer<typeof RuleStatus>;
  createdAt: Date;
}

// Shape published to Redis under rules:active:{apiKey}.
export interface ActiveRuleWire {
  id: string;
  condition: Targeting;
  patch: ArmPatch;
}

export interface ArmMetrics {
  arm: string;
  sessions: number;
  searches: number;
  clicks: number;
  ctr: number;
  /** Sessions with >=1 click. Unlike `ctr` (clicks/searches, which can exceed
   * 100%), this is a Bernoulli proportion over sessions, so it is the click
   * figure the significance tests can legitimately use. */
  clickSessions: number;
  clickRate: number;
  atcSessions: number;
  atcRate: number;
  orders: number;
  cvr: number;
  revenue: number;
  revenuePerSession: number;
}

export interface MetricsSnapshot {
  experimentId: string;
  asOf: Date;
  arms: ArmMetrics[];
  contaminationRate: number;
  stats?: {
    zConv: number | null;
    pConv: number | null;
    probBestConv: number | null;
    probBestRps: number | null;
    // Click-based readout, so ranking experiments stay decidable on tenants
    // that have no order/revenue tracking wired up.
    zClick: number | null;
    pClick: number | null;
    probBestClick: number | null;
  };
}

// Shape published to Redis under experiments:active:{apiKey} — consumed
// by dashboard-server/experiments-hook.js. Keep both sides in sync.
export interface ActiveExperimentWire {
  id: string;
  layer: string;
  targeting: Targeting;
  trafficPct: number;
  arms: { key: string; weight: number; patch: ArmPatch }[];
}
