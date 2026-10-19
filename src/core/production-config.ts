import { dashboardChatEngine, studioConfig } from '../agent/studio-client.js';
export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const engine = dashboardChatEngine(env);
  const required = ['MONGODB_URI', 'REDIS_URL', 'OPS_PASSWORD', 'SEARCH_SERVICE_URL', 'REPROCESS_SERVICE_URL', ...(engine === 'optimizer' || env.AGENT_NIGHTLY === 'true' ? ['ANTHROPIC_API_KEY'] : [])];
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  if (engine === 'studio') studioConfig(env);
  for (const key of ['SEARCH_SERVICE_URL', 'REPROCESS_SERVICE_URL']) {
    const url = new URL(env[key]!);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error(`${key} must use a remote HTTPS service`);
  }
  const redis = new URL(env.REDIS_URL!);
  if (!['redis:', 'rediss:'].includes(redis.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname)) throw new Error('REDIS_URL must use the shared production Redis');
}
