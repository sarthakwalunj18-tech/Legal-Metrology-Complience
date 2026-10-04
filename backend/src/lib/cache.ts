interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal TTL cache.
 *
 * Deliberately in-process: the platform runs as a single Fastify instance, and
 * pulling in Redis purely for appearance would add operational cost without
 * buying correctness. Anything cached here must be either derived from immutable
 * statutory data or short-lived.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;

  constructor(private readonly defaultTtlMs: number, maxEntries = 500) {
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Refresh LRU position.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Read-through helper: computes on miss and caches the result. */
  async remember(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  invalidate(prefix?: string): void {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? null : Math.round((this.hits / total) * 100) / 100,
    };
  }
}

/** Caches an async, side-effect-free loader and de-duplicates concurrent calls. */
export function singleFlight<Args extends unknown[], T>(
  fn: (...args: Args) => Promise<T>,
): (...args: Args) => Promise<T> {
  const inFlight = new Map<string, Promise<T>>();

  return async (...args: Args): Promise<T> => {
    const key = JSON.stringify(args);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = fn(...args).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}
