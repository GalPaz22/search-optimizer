import { z } from "zod";

/** Tool output as MCP text content. Store keys never reach the model. */
export const asJson = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, (key, value) => (["apiKey", "tenantApiKey", "session_id", "sessionId"].includes(key) ? undefined : value)) }],
});
export const fail = (e: unknown) => asJson({ error: e instanceof Error ? e.message : String(e) });
export const objectId = z.string().regex(/^[a-f\d]{24}$/i);
export const days = z.number().int().min(1).max(90).default(30);

export const actionSummary = (a: any) => ({
  actionId: String(a._id), query: a.query, kind: a.kind, status: a.status,
  title: a.title, rationale: a.rationale?.slice(0, 250), filter: a.filter,
  productCount: (a.productIds?.length ?? 0) + (a.removeTagProductIds?.length ?? 0),
  diagnosis: a.diagnosis && { status: a.diagnosis.status, cause: a.diagnosis.cause, nextStep: a.diagnosis.nextStep?.slice(0, 200), actionIds: a.diagnosis.actionIds, proposalIds: a.diagnosis.proposalIds },
  outcome: a.outcome && { status: a.outcome.status, dueAt: a.outcome.dueAt, cartRateDelta: a.outcome.cartRateDelta },
  lastError: a.lastError?.slice(0, 250),
});
