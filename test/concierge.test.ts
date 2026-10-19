import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { conciergeRoutes } from '../src/api/routes/concierge.js';
import { conversationDetail, conversationFilters, readConciergeSettings, saveConciergeSettings } from '../src/concierge/management.js';

function fixture(auditFailure = false) {
  let accounts: any[] = [
    { _id: '1', dbName: 'beautics', concierge: false, credentials: { dbName: 'beautics' } },
    { _id: '2', dbName: 'beautics', platform: 'woocommerce', concierge: true, credentials: { dbName: 'beautics', conciergeSystemPrompt: 'legacy override' } },
    { _id: '3', dbName: 'other', conciergeInstructions: 'other instructions', credentials: { dbName: 'other' } },
    { _id: '4', dbName: 'beautics', credentials: { dbName: 'other', conciergeInstructions: 'inconsistent legacy record' } },
  ];
  const audits: any[] = [];
  let ended = false;
  const session = { async withTransaction(fn: any) { const before = structuredClone(accounts); try { await fn(); } catch (e) { accounts = before; throw e; } }, async endSession() { ended = true; } };
  const users = {
    find(filter: any) { return { sort() { return this; }, async toArray() { return structuredClone(accounts.filter(u => u.dbName === filter.dbName)); } }; },
    async updateMany(filter: any, update: any, options: any) {
      assert.equal(options.session, session);
      for (const user of accounts.filter(u => u.dbName === filter.dbName && filter._id.$in.includes(u._id))) {
        for (const [key, value] of Object.entries(update.$set)) {
          if (key.startsWith('credentials.')) user.credentials[key.split('.')[1]] = value;
          else user[key] = value;
        }
      }
    },
  };
  const client: any = { startSession: () => session, db: (name: string) => ({ collection: () => name === 'users' ? users : { async insertOne(doc: any, options: any) { assert.equal(options.session, session); if (auditFailure) throw Error('audit unavailable'); audits.push(doc); } } }) };
  return { client, audits, accounts: () => accounts, ended: () => ended };
}

test('prompt saves synchronize store keys, clear legacy overrides and preserve activation and other stores', async () => {
  const f = fixture(), before = await readConciergeSettings(f.client, 'beautics');
  assert.equal(before.enabled, true); assert.equal(before.systemPrompt, 'legacy override');
  const saved = await saveConciergeSettings(f.client, 'beautics', { revision: before.revision, instructions: '  הוראות חדשות  ', context: 'רקע', systemPrompt: '' }, 'owner');
  assert.equal(saved.instructions, 'הוראות חדשות'); assert.equal(saved.systemPrompt, '');
  assert.notEqual(saved.revision, before.revision); assert.equal(f.ended(), true);
  for (const user of f.accounts().slice(0, 2)) { assert.equal(user.conciergeInstructions, 'הוראות חדשות'); assert.equal(user.credentials.conciergeSystemPrompt, null); }
  assert.equal(f.accounts()[0].concierge, false); assert.equal(f.accounts()[1].concierge, true);
  assert.equal(f.accounts()[2].conciergeInstructions, 'other instructions');
  assert.equal(f.accounts()[3].conciergeInstructions, undefined);
  assert.equal(f.audits[0].appliedBy, 'owner'); assert.equal(f.audits[0].dbName, 'beautics');
  await assert.rejects(saveConciergeSettings(f.client, 'beautics', { revision: before.revision, instructions: 'stale', context: '', systemPrompt: '' }), (e: any) => e.status === 409);
  assert.equal(f.audits.length, 1);
});
test('audit failure rolls back prompt edits and invalid input never starts a save', async () => {
  const f = fixture(true), before = await readConciergeSettings(f.client, 'beautics');
  await assert.rejects(saveConciergeSettings(f.client, 'beautics', { revision: before.revision, instructions: 'new', context: '', systemPrompt: '' }), /audit unavailable/);
  assert.deepEqual(await readConciergeSettings(f.client, 'beautics'), before);
  for (const extra of [{ dbName: 'other' }, { instructions: 'x'.repeat(8001) }, { revision: 'bad' }]) {
    await assert.rejects(saveConciergeSettings(f.client, 'beautics', { revision: before.revision, instructions: '', context: '', systemPrompt: '', ...extra }), (e: any) => e.status === 400);
  }
});
test('history exposes complete human text and cards but never session keys, costs or tool payloads', () => {
  const reply = 'תשובה'.repeat(3000);
  const row = { conversation_id: 'a', query: 'בייס', session_id: 'private', usage: { tokens: 9 }, estimated_cost_usd: 1, transcript: [{ message: 'שאלה', reply, tools: [{ secret: true }], products: [{ name: 'בייס', price: { invalid: true } }, null] }] };
  const result = conversationDetail(row);
  assert.equal(result.transcript[0].reply, reply); assert.equal(result.transcript[0].products[0].price, null);
  assert.equal(result.hasTranscript, true);
  for (const secret of ['session_id','private','estimated_cost_usd','tokens','secret']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(conversationDetail({ conversation_id: 'old', turns: 5, query: 'חיפוש' }).hasTranscript, false);
  assert.deepEqual(conversationDetail({ messages: [{ role: 'tool', content: 'hidden' }, { role: 'assistant', content: 'תשובה ישנה' }] }).legacy, [{ role: 'assistant', text: 'תשובה ישנה' }]);
});
test('history filters use literal search, bounded pagination and distinguish metadata from transcripts', () => {
  const parsed = conversationFilters({ days: 'all', query: '.*', content: 'transcript', page: '2' });
  const pattern = (parsed.filter as any).$and[0].$or[0].query;
  assert.equal(pattern.test('anything'), false); assert.equal(pattern.test('literal .*'), true);
  assert.equal(parsed.page, 2); assert.equal(parsed.limit, 25);
  assert.deepEqual(conversationFilters({ days: 'all', content: 'metadata' }).filter, { $and: [{ $nor: [parsed.hasTranscript] }] });
  const invalidFilters: Record<string, string>[] = [{ page: '0' }, { page: '1.5' }, { days: '365' }, { query: 'a'.repeat(201) }, { content: 'raw' }];
  for (const invalid of invalidFilters) assert.throws(() => conversationFilters(invalid));
});
test('history routes read only the resolved store and a foreign conversation returns 404', async () => {
  const seen: string[] = [];
  const rows: any = { 'store-a': [{ conversation_id: 'a:1.2', query: 'בייס', turns: 2 }], 'store-b': [{ conversation_id: 'foreign', query: 'secret' }] };
  const app = Fastify();
  await app.register(conciergeRoutes, { services: {
    getTenantByApiKey: async (key: string) => key === 'key-a' ? { dbName: 'store-a' } : null,
    tenantDb: async (name: string) => { seen.push(name); return { collection: () => ({
      find: () => ({ sort() { return this; }, skip() { return this; }, limit() { return this; }, async toArray() { return rows[name]; } }),
      countDocuments: async () => rows[name].length,
      findOne: async ({ conversation_id }: any) => rows[name].find((r: any) => r.conversation_id === conversation_id),
    }) }; },
  } as any });
  try {
    assert.equal((await app.inject('/concierge/conversations')).statusCode, 400);
    const list = await app.inject('/concierge/conversations?tenant=key-a&days=all&dbName=store-b');
    assert.equal(list.statusCode, 200); assert.equal(list.json().conversations[0].id, 'a:1.2');
    assert.equal((await app.inject('/concierge/conversations/foreign?tenant=key-a')).statusCode, 404);
    assert.equal((await app.inject('/concierge/conversations/a%3A1.2?tenant=key-a')).statusCode, 200);
    assert.equal((await app.inject('/concierge/conversations/%24bad?tenant=key-a')).statusCode, 400);
    assert.ok(seen.every(name => name === 'store-a'));
  } finally { await app.close(); }
});
