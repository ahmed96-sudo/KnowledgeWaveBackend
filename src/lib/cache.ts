/**
 * Tiny in-memory TTL cache for responses that do not depend on who is asking.
 * ponytail: per process (several API instances each keep their own copy, up to `ttlMs` stale), no LRU: when it
 * reaches `max` entries it is cleared. Use Redis if you need one shared cache.
 */
export function createCache({ ttlMs, max = 500, enabled = true }: { ttlMs: number; max?: number; enabled?: boolean }) {
  const store = new Map<string, { expires: number; value: unknown }>();
  const cache = {
    enabled,
    hits: 0,
    misses: 0,
    async get<T>(key: string, load: () => Promise<T>): Promise<T> {
      if (!cache.enabled) return load();
      const hit = store.get(key);
      if (hit && hit.expires > Date.now()) {
        cache.hits++;
        return hit.value as T;
      }
      cache.misses++;
      const value = await load();
      if (store.size >= max) store.clear();
      store.set(key, { expires: Date.now() + ttlMs, value });
      return value;
    },
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
  return cache;
}
