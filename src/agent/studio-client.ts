import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { controlDb, tenantDb } from '../core/db.js';
import { Tenant } from '../core/tenant.js';
import { RuleInput } from '../core/types.js';
import { proposeBoost, proposeVisibility } from '../optimization/boosts.js';

export function dashboardChatEngine(env: NodeJS.ProcessEnv = process.env) {
  const engine = env.DASHBOARD_CHAT_ENGINE || 'studio';
  if (!['studio', 'optimizer'].includes(engine)) throw Error('DASHBOARD_CHAT_ENGINE must be studio or optimizer');
  return engine;
}
export function studioConfig(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try { url = new URL(env.STUDIO_SERVICE_URL || (env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:4320')); }
  catch { throw Error('יש להגדיר את כתובת tenant-studio בשרת'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (env.NODE_ENV === 'production' && (url.protocol !== 'https:' || ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw Error('כתובת tenant-studio אינה תקינה לפרודקשן');
  if (!env.STUDIO_CUSTOMER_API_TOKEN) throw Error('יש להשלים את החיבור המאובטח ל־tenant-studio');
  return { origin: url.origin, token: env.STUDIO_CUSTOMER_API_TOKEN };
}
const actions = z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('productBoost'), term: z.string().min(2).max(80), level: z.number().int().min(0).max(3), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('productVisibility'), term: z.string().min(2).max(80), hidden: z.boolean(), limit: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('pin'), query: z.string().min(1).max(200), productIds: z.array(z.string().min(1).max(150)).min(1).max(20).refine(ids => new Set(ids).size === ids.length) }).strict(),
])).max(6);
const doneSchema = z.object({ type: z.literal('done'), engine: z.literal('tenant-studio'), summary: z.string().max(12000), actions,
  draft: z.object({ id: z.string().uuid(), projectId: z.string().uuid(), changes: z.array(z.string().max(2000)).max(100), version: z.number().int().positive() }).nullable(),
  modelCalls: z.number().int().min(0).max(24), usage: z.array(z.unknown()).max(24),
});
export async function studioRequest(operation: 'turn' | 'approve', body: Record<string, unknown>, signal?: AbortSignal) {
  const config = studioConfig();
  const response = await fetch(new URL(`/api/customer-chat/${operation}`, config.origin), { method: 'POST', headers: { 'content-type': 'application/json', 'X-Studio-Customer-Token': config.token }, body: JSON.stringify(body), signal, redirect: 'error' });
  if (!response.ok) {
    let message = `tenant-studio החזיר שגיאה (${response.status})`;
    try { const data = await response.json() as any; if (typeof data.error === 'string') message = data.error; } catch {}
    throw Error(message);
  }
  return response;
}
export async function runStudioTurn(body: Record<string, unknown>, signal: AbortSignal, onEvent: (event: any) => Promise<void>) {
  const response = await studioRequest('turn', body, signal);
  if (!response.body) throw Error('לא התקבלה תשובה מ־tenant-studio');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', result: z.infer<typeof doneSchema> | null = null, count = 0;
  const consume = async (line: string) => {
    if (!line.trim()) return;
    if (++count > 2000) throw Error('תשובת הסטודיו חרגה ממגבלת האירועים');
    const event = JSON.parse(line);
    if (event.type === 'error') throw Error(typeof event.message === 'string' ? event.message : 'הסטודיו לא השלים את התשובה');
    if (event.type === 'done') result = doneSchema.parse(event);
    else if (['note','tool','tool_done'].includes(event.type)) await onEvent(event);
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); pending += decoder.decode(value, { stream: !done });
      if (pending.length > 512000) throw Error('תשובת הסטודיו גדולה מדי');
      const lines = pending.split('\n'); pending = lines.pop() || '';
      for (const line of lines) await consume(line);
      if (done) { await consume(pending); break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!result) throw Error('הסטודיו סיים בלי תשובה מלאה. לא הופעלו שינויים.');
  return result as z.infer<typeof doneSchema>;
}
export async function saveStudioProposals(tenant: Tenant, runId: string, result: z.infer<typeof doneSchema>) {
  const db = await controlDb(); let count = 0;
  for (const action of result.actions) {
    let proposal: any;
    if (action.kind === 'productBoost') proposal = await proposeBoost(tenant, { ...action, agentRunId: runId });
    else if (action.kind === 'productVisibility') proposal = await proposeVisibility(tenant, { ...action, agentRunId: runId });
    else {
      const aliases = action.productIds.map(id => [...new Set([id, id.split(':').pop()!])]);
      const ids = aliases.flat(), rows = await (await tenantDb(tenant.dbName)).collection('products').find({ $or: [
        { _id: { $in: ids.filter(id => /^[a-f\d]{24}$/i.test(id)).map(id => new ObjectId(id)) } },
        { id: { $in: ids.flatMap(id => Number.isFinite(Number(id)) ? [id, Number(id)] : [id]) } },
      ] }).project({ _id: 1, id: 1, name: 1, hidden: 1, stockStatus: 1, stock_status: 1 }).toArray();
      const ordered = aliases.map(ids => rows.find(row => ids.includes(String(row._id)) || ids.includes(String(row.id))));
      if (ordered.some(p => !p || p.hidden || (p.stockStatus || p.stock_status) !== 'instock')) throw Error('מוצר לנעיצה אינו זמין בחנות. יש לבקש הצעה מעודכנת.');
      const draftRule = RuleInput.parse({ tenantApiKey: tenant.apiKey, dbName: tenant.dbName, name: `נעיצות: ${action.query}`, naturalLanguageText: `נעיצה לפי הסדר בחיפוש ״${action.query}״`, condition: { mode: 'queryMatch', patterns: [action.query], matchType: 'exact' }, patch: { pinnedResults: [{ query: action.query, productIds: ordered.map(p => String(p!._id)), enabled: true }] } });
      await db.collection('proposals').insertOne({ kind: 'rule', tenantApiKey: tenant.apiKey, dbName: tenant.dbName, agentRunId: runId, status: 'pending', draftRule, evidence: { summary: draftRule.naturalLanguageText }, createdAt: new Date() });
      proposal = {};
    }
    if (proposal.error) throw Error(proposal.error);
    count++;
  }
  if (result.draft) {
    await db.collection('proposals').insertOne({ kind: 'studioRevision', tenantApiKey: tenant.apiKey, dbName: tenant.dbName, agentRunId: runId, status: 'pending', studioDraftId: result.draft.id, studioProjectId: result.draft.projectId, studioChanges: result.draft.changes, evidence: { summary: 'שינויי חיפוש שהוכנו ב־tenant-studio' }, createdAt: new Date() });
    count++;
  }
  return count;
}
