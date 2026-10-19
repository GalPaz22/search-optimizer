import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { ObjectId } from 'mongodb';
import { productRoutes } from '../src/api/routes/products.js';
const first = new ObjectId('1234567890abcdef12345678'), second = new ObjectId('2234567890abcdef12345678');

async function setup(rows: any[]) {
  const app = Fastify(), writes: any[] = [], audits: any[] = [], invalidated: string[] = [];
  const services = {
    getTenantByApiKey: async (key: string) => key === 'key-a' ? { dbName: 'store-a', apiKey: key } : null,
    tenantDb: async (name: string) => { assert.equal(name, 'store-a'); return { collection: () => ({
      find: (filter: any) => ({ project: () => ({ toArray: async () => rows.filter(row => filter._id.$in.some((id: ObjectId) => id.equals(row._id))) }) }),
      updateMany: async (filter: any, update: any) => { writes.push({ filter, update }); return { matchedCount: rows.length }; },
    }) }; },
    controlDb: async () => ({ collection: () => ({ insertOne: async (data: any) => { audits.push(data); } }) }),
    invalidateDashboardReports: (name: string) => { invalidated.push(name); },
    clearSearchCache: async (name: string) => { assert.equal(name, 'store-a'); return true; },
  };
  await productRoutes(app, { services: services as any });
  const put = (body: unknown, tenant = 'key-a') => app.inject({ method: 'PUT', url: `/dashboard/products/boost?tenant=${tenant}`, payload: body as any });
  return { app, put, writes, audits, invalidated };
}
test('boost writes exact authenticated-store identities, audits previous values, clears cached search, and unsets on reset', async () => {
  const t = await setup([{ _id: first, name: 'One', boost: 1 }, { _id: second, name: 'Two' }]);
  try {
    let response = await t.put({ productIds: [String(first), String(second)], level: 3 });
    assert.equal(response.statusCode, 200); assert.equal(response.json().updated, 2);
    assert.equal(t.writes[0].update.$set.boost, 3); assert.equal(t.writes[0].filter.hidden.$ne, true);
    assert.equal(t.audits[0].productBefore[0].boost, 1); assert.deepEqual(t.invalidated, ['store-a']);
    response = await t.put({ productIds: [String(first), String(second)], level: 0 });
    assert.equal(response.statusCode, 200); assert.deepEqual(t.writes[1].update.$unset, { boost: '' });
  } finally { await t.app.close(); }
});
test('a missing or foreign product fails the entire selection before any write', async () => {
  const t = await setup([{ _id: first, name: 'One' }]);
  try { const response = await t.put({ productIds: [String(first), String(second)], level: 2 }); assert.equal(response.statusCode, 404); assert.equal(t.writes.length, 0); }
  finally { await t.app.close(); }
});
test('hidden products cannot be promoted but their promotion can be cleared', async () => {
  const t = await setup([{ _id: first, hidden: true, boost: 2 }]);
  try {
    assert.equal((await t.put({ productIds: [String(first)], level: 3 })).statusCode, 409); assert.equal(t.writes.length, 0);
    assert.equal((await t.put({ productIds: [String(first)], level: 0 })).statusCode, 200);
    assert.equal((await t.put({ productIds: [String(first)], level: 1 }, 'other-key')).statusCode, 400);
  } finally { await t.app.close(); }
});
