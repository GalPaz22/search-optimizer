import { FastifyInstance } from 'fastify';
import { getMongo, tenantDb } from '../../core/db.js';
import { getTenantByApiKey } from '../../core/tenant.js';
import { conversationDetail, conversationFilters, readConciergeSettings, saveConciergeSettings } from '../../concierge/management.js';
const defaults = { getMongo, tenantDb, getTenantByApiKey, readConciergeSettings, saveConciergeSettings };
export async function conciergeRoutes(app: FastifyInstance, options: { services?: typeof defaults } = {}) {
  const services = options.services || defaults;
  const scoped = async (tenant?: string) => tenant ? services.getTenantByApiKey(tenant) : null;
  app.get('/concierge/settings', async (req, reply) => {
    const store = await scoped((req.query as any).tenant);
    if (!store) return reply.code(400).send({ error: 'יש לבחור חנות מחוברת' });
    try { return await services.readConciergeSettings(await services.getMongo(), store.dbName); }
    catch (error) { if ((error as any).status) return reply.code((error as any).status).send({ error: (error as Error).message }); throw error; }
  });
  app.put('/concierge/settings', async (req, reply) => {
    const store = await scoped((req.query as any).tenant);
    if (!store) return reply.code(400).send({ error: 'יש לבחור חנות מחוברת' });
    const raw = req.body as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reply.code(400).send({ error: 'הגדרות לא תקינות' });
    const { by, ...body } = raw;
    try { return await services.saveConciergeSettings(await services.getMongo(), store.dbName, body, typeof by === 'string' ? by.slice(0, 200) : undefined); }
    catch (error) { if ((error as any).status) return reply.code((error as any).status).send({ error: (error as Error).message }); throw error; }
  });
  app.get('/concierge/conversations', async (req, reply) => {
    const input = req.query as Record<string, string>, store = await scoped(input.tenant);
    if (!store) return reply.code(400).send({ error: 'יש לבחור חנות מחוברת' });
    let options; try { options = conversationFilters(input); } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const { filter, hasTranscript, page, limit } = options, collection = (await services.tenantDb(store.dbName)).collection('concierge_conversations');
    const [rows, total, withTranscript] = await Promise.all([
      collection.find(filter, { projection: { _id: 0, conversation_id: 1, query: 1, reason: 1, created_at: 1, updated_at: 1, turns: 1, transcript: { $slice: 1 }, messages: 1 }, maxTimeMS: 15000 }).sort({ updated_at: -1, conversation_id: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      collection.countDocuments(filter, { maxTimeMS: 15000 }),
      collection.countDocuments({ $and: [filter, hasTranscript] }, { maxTimeMS: 15000 }),
    ]);
    return { page, limit, total, withTranscript, totalPages: Math.ceil(total / limit), conversations: rows.map(row => {
      const detail = conversationDetail(row);
      return { id: detail.id, query: detail.query, reason: detail.reason, createdAt: detail.createdAt, updatedAt: detail.updatedAt, turns: detail.turns, hasTranscript: detail.hasTranscript,
        preview: (detail.transcript[0]?.message || detail.transcript[0]?.reply || detail.legacy[0]?.text || '').slice(0, 180) };
    }) };
  });
  app.get('/concierge/conversations/:id', async (req, reply) => {
    const store = await scoped((req.query as any).tenant), id = (req.params as any).id;
    if (!store) return reply.code(400).send({ error: 'יש לבחור חנות מחוברת' });
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return reply.code(400).send({ error: 'מזהה שיחה אינו תקין' });
    const row = await (await services.tenantDb(store.dbName)).collection('concierge_conversations').findOne({ conversation_id: id }, { projection: { conversation_id: 1, query: 1, reason: 1, created_at: 1, updated_at: 1, turns: 1, transcript: 1, messages: 1 }, maxTimeMS: 15000 });
    return row ? conversationDetail(row) : reply.code(404).send({ error: 'השיחה לא נמצאה בחנות שלך' });
  });
}
