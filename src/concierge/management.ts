import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MongoClient } from 'mongodb';

const fail = (message: string, status = 400) => Object.assign(Error(message), { status });
export const ConciergeSettingsInput = z.object({
  revision: z.string().regex(/^[a-f\d]{64}$/),
  instructions: z.string().max(8000).transform(s => s.trim()),
  context: z.string().max(4000).transform(s => s.trim()),
  systemPrompt: z.string().max(16000).transform(s => s.trim()),
}).strict();
const fields = { platform: 1, concierge: 1, conciergeInstructions: 1, conciergeContext: 1, conciergeSystemPrompt: 1, 'credentials.dbName': 1, 'credentials.conciergeInstructions': 1, 'credentials.conciergeContext': 1, 'credentials.conciergeSystemPrompt': 1 };
const setting = (user: any, key: string) => typeof user[key] === 'string' ? user[key] : typeof user.credentials?.[key] === 'string' ? user.credentials[key] : '';
async function state(client: MongoClient, dbName: string, session?: any) {
  const accounts = await client.db('users').collection('users').find({ dbName }, { projection: fields, ...(session ? { session } : {}) }).sort({ _id: 1 }).toArray();
  const users = accounts.filter(u => !u.credentials?.dbName || u.credentials.dbName === dbName);
  if (!users.length) throw fail('החנות לא נמצאה', 404);
  const primary = users.find(u => u.platform) || users[0];
  const revision = createHash('sha256').update(JSON.stringify(users)).digest('hex');
  return { users, settings: { revision, enabled: primary.concierge === true, instructions: setting(primary, 'conciergeInstructions'), context: setting(primary, 'conciergeContext'), systemPrompt: setting(primary, 'conciergeSystemPrompt') } };
}
export async function readConciergeSettings(client: MongoClient, dbName: string) { return (await state(client, dbName)).settings; }
export async function saveConciergeSettings(client: MongoClient, dbName: string, body: unknown, actor?: string) {
  const parsed = ConciergeSettingsInput.safeParse(body);
  if (!parsed.success) throw fail('הגדרות לא תקינות: עד 8,000 תווים להוראות, 4,000 לרקע ו־16,000 לפרומפט הראשי');
  const input = parsed.data, session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const before = await state(client, dbName, session);
      if (before.settings.revision !== input.revision) throw fail('ההוראות עודכנו מאז פתיחת המסך. יש לרענן לפני שמירה כדי לשמור על השינויים האחרונים.', 409);
      const update = { conciergeInstructions: input.instructions, conciergeContext: input.context, conciergeSystemPrompt: input.systemPrompt || null,
        'credentials.conciergeInstructions': input.instructions, 'credentials.conciergeContext': input.context, 'credentials.conciergeSystemPrompt': input.systemPrompt || null, conciergeSettingsUpdatedAt: new Date() };
      await client.db('users').collection('users').updateMany({ dbName, _id: { $in: before.users.map(u => u._id) } }, { $set: update }, { session });
      await client.db('control_plane').collection('catalog_change_audits').insertOne({ dbName, kind: 'conciergeInstructions', appliedBy: actor || null, appliedAt: new Date(), before: before.settings,
        after: { instructions: input.instructions, context: input.context, systemPrompt: input.systemPrompt } }, { session });
    });
  } finally { await session.endSession(); }
  return { ...await readConciergeSettings(client, dbName), saved: true, message: 'ההוראות נשמרו. מנוע החיפוש המעודכן קורא אותן בכל הודעה חדשה בקונסיירז׳.' };
}
const humanText = (value: unknown) => typeof value === 'string' ? value : '';
export function conversationDetail(row: any) {
  const transcript = Array.isArray(row.transcript) ? row.transcript.filter((turn: any) => turn && typeof turn === 'object').map((turn: any) => ({
    at: turn.at || null, finishedAt: turn.finished_at || null, opening: turn.opening === true, query: humanText(turn.query),
    message: humanText(turn.message), reply: humanText(turn.reply), error: typeof turn.error === 'string' ? turn.error : null,
    stopped: !!turn.stopped, rejected: !!turn.rejected,
    products: (Array.isArray(turn.products) ? turn.products : []).filter((p: any) => p && typeof p === 'object').map((p: any) => ({ id: String(p.product_id ?? p.id ?? ''), name: humanText(p.name || p.title), price: typeof p.price === 'string' || typeof p.price === 'number' ? p.price : null, image: humanText(p.image), url: humanText(p.url) })),
  })) : [];
  // Older readable messages are supported; model tool calls and raw session identifiers stay internal.
  const legacy = !transcript.length && Array.isArray(row.messages) ? row.messages.filter((m: any) => m && ['user','assistant'].includes(m.role) && (typeof m.text === 'string' || typeof m.content === 'string')).map((m: any) => ({ role: m.role, text: m.text || m.content || '' })) : [];
  return { id: row.conversation_id, query: humanText(row.query), reason: humanText(row.reason), createdAt: row.created_at || null, updatedAt: row.updated_at || row.created_at || null,
    turns: typeof row.turns === 'number' ? row.turns : transcript.length, hasTranscript: !!(transcript.length || legacy.length), transcript, legacy };
}
export function conversationFilters(input: Record<string, string>, now = Date.now()) {
  const page = Number(input.page || '1'), days = input.days || '30', content = input.content || 'all', query = (input.query || '').trim();
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !['7','30','90','all'].includes(days) || !['all','transcript','metadata'].includes(content) || query.length > 200) throw fail('מסנני השיחות אינם תקינים');
  const clauses: any[] = [];
  if (days !== 'all') clauses.push({ $or: [{ updated_at: { $gte: new Date(now - Number(days) * 86400000) } }, { updated_at: { $exists: false }, created_at: { $gte: new Date(now - Number(days) * 86400000) } }] });
  if (query) { const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); clauses.push({ $or: [{ query: rx }, { 'transcript.message': rx }, { 'transcript.reply': rx }, { 'messages.text': rx }, { 'messages.content': rx }] }); }
  const hasTranscript = { $or: [{ 'transcript.0': { $exists: true } }, { messages: { $elemMatch: { role: { $in: ['user', 'assistant'] }, $or: [{ text: { $type: 'string' } }, { content: { $type: 'string' } }] } } }] };
  if (content === 'transcript') clauses.push(hasTranscript);
  if (content === 'metadata') clauses.push({ $nor: [hasTranscript] });
  return { filter: clauses.length ? { $and: clauses } : {}, hasTranscript, page, limit: 25 };
}
