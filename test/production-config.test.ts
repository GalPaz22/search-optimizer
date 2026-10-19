import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfig } from '../src/core/production-config.js';
const valid = () => ({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://database', REDIS_URL: 'rediss://shared.example.com:6379', OPS_PASSWORD: 'configured', ANTHROPIC_API_KEY: 'configured', SEARCH_SERVICE_URL: 'https://search.example.com', REPROCESS_SERVICE_URL: 'https://processing.example.com' });
test('production refuses missing secrets and laptop dependencies before starting', () => {
  for (const key of Object.keys(valid()).filter(key => key !== 'NODE_ENV')) {
    const env: NodeJS.ProcessEnv = valid(); delete env[key];
    assert.throws(() => validateProductionConfig(env), new RegExp(key));
  }
  for (const key of ['REDIS_URL', 'SEARCH_SERVICE_URL', 'REPROCESS_SERVICE_URL']) {
    const env: NodeJS.ProcessEnv = valid(); env[key] = key === 'REDIS_URL' ? 'redis://127.0.0.1:6379' : 'http://127.0.0.1:8080';
    assert.throws(() => validateProductionConfig(env));
  }
  assert.doesNotThrow(() => validateProductionConfig(valid()));
  assert.doesNotThrow(() => validateProductionConfig({ NODE_ENV: 'development' }));
});
