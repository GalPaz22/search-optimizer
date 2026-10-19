import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProductVisibilityInput } from '../src/api/routes/products.js';

const productId = '1234567890abcdef12345678';
test('visibility accepts only explicit booleans, never truthy strings or numbers', () => {
  for (const hidden of [true, false]) assert.equal(ProductVisibilityInput.safeParse({ productId, hidden }).success, true);
  for (const hidden of ['true', 'false', 1, 0, null, undefined]) assert.equal(ProductVisibilityInput.safeParse({ productId, hidden }).success, false);
});
test('visibility rejects arbitrary document ids, store overrides and unrelated product fields', () => {
  assert.equal(ProductVisibilityInput.safeParse({ productId: 'platform-product-id', hidden: true }).success, false);
  assert.equal(ProductVisibilityInput.safeParse({ productId, hidden: true, dbName: 'another-store' }).success, false);
  assert.equal(ProductVisibilityInput.safeParse({ productId, hidden: true, price: 0 }).success, false);
  assert.equal(ProductVisibilityInput.safeParse({ productId: { $ne: null }, hidden: true }).success, false);
});

test('boosts reject cross-store overrides, duplicate ids, unbounded batches and invalid levels', async () => {
  const { ProductBoostInput } = await import('../src/api/routes/products.js');
  for (const level of [0, 1, 2, 3]) assert.equal(ProductBoostInput.safeParse({ productIds: [productId], level }).success, true);
  for (const level of [-1, 4, 1.5, '3', null]) assert.equal(ProductBoostInput.safeParse({ productIds: [productId], level }).success, false);
  for (const productIds of [[], ['bad-id'], [productId, productId], Array(101).fill(productId)]) assert.equal(ProductBoostInput.safeParse({ productIds, level: 1 }).success, false);
  assert.equal(ProductBoostInput.safeParse({ productIds: [productId], level: 1, dbName: 'other' }).success, false);
});
