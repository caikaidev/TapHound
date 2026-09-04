/**
 * Base environment for spawned built-CLI processes. Some corporate
 * environments export NODE_USE_ENV_PROXY, which makes every Node child
 * print EnvHttpProxyAgent (UNDICI-EHPA) diagnostics and slows startup.
 * The CLI performs no proxy-aware fetch, so the variable is removed to
 * keep process-contract output deterministic.
 */
export function childSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_USE_ENV_PROXY;
  return env;
}
