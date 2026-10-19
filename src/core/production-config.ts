export function validateProductionConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const missing = ['MONGODB_URI', 'REDIS_URL', 'OPS_PASSWORD', 'ANTHROPIC_API_KEY', 'SEARCH_SERVICE_URL', 'REPROCESS_SERVICE_URL'].filter(key => !env[key]?.trim());
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(', ')}`);
  for (const key of ['SEARCH_SERVICE_URL', 'REPROCESS_SERVICE_URL']) {
    const url = new URL(env[key]!);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error(`${key} must use a remote HTTPS service`);
  }
  const redis = new URL(env.REDIS_URL!);
  if (!['redis:', 'rediss:'].includes(redis.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname)) throw new Error('REDIS_URL must use the shared production Redis');
}
