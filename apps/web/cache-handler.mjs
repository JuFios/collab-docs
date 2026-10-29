// @ts-check
/**
 * The ISR cache of every web replica, kept in Redis (`cacheHandler` in next.config.ts, as the Next.js self-hosting
 * guide recommends for more than one instance). Without it each process keeps its own cache, and `revalidateTag`
 * from `/internal/revalidate` reaches only the process that received the call.
 *
 * It keeps the semantics of Next's own file-system cache: an entry is stored with the time it was written, a
 * revalidated tag is stored with the time of the revalidation, and an entry with a tag revalidated at or after it was
 * written is a miss, so the next request renders it again. Entries are namespaced by build, so a new deployment never
 * reads the pages of the previous one. Without `REDIS_URL` (a build, `next dev`) it falls back to a per-process map;
 * when Redis cannot be reached a read is a miss and a write is dropped, which costs renders, never correctness.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';

const TAGS_HEADER = 'x-next-cache-tags';
const ENTRY_TTL_SECONDS = 30 * 24 * 3600;
/** Kinds of `value` whose tags travel in the stored response headers (the other kind, FETCH, gets them per call). */
const RESPONSE_KINDS = new Set(['APP_PAGE', 'APP_ROUTE', 'PAGES']);

/** JSON that keeps the Buffers (RSC payloads, route bodies) and Maps (segment data) of a cache entry. */
export function serialize(entry) {
  return JSON.stringify(entry, function replace(key, value) {
    const raw = this[key];
    if (Buffer.isBuffer(raw)) return { $buffer: raw.toString('base64') };
    if (raw instanceof Map) return { $map: [...raw.entries()] };
    return value;
  });
}

export function deserialize(text) {
  return JSON.parse(text, (_key, value) => {
    if (value && typeof value === 'object') {
      if (typeof value.$buffer === 'string') return Buffer.from(value.$buffer, 'base64');
      if (Array.isArray(value.$map)) return new Map(value.$map);
    }
    return value;
  });
}

function tagsOf(entry, ctx) {
  const value = entry.value;
  if (value && RESPONSE_KINDS.has(value.kind)) {
    const header = value.headers?.[TAGS_HEADER];
    return typeof header === 'string' ? header.split(',') : [];
  }
  return [...(ctx?.tags ?? []), ...(ctx?.softTags ?? [])];
}

function buildIdOf(serverDistDir) {
  try {
    return readFileSync(path.join(serverDistDir, '..', 'BUILD_ID'), 'utf8').trim();
  } catch {
    return 'development';
  }
}

/** In-memory stand-in with the few Redis commands the handler uses. */
export class MemoryStore {
  constructor() {
    this.strings = new Map();
    this.hashes = new Map();
    this.expiries = new Map();
  }
  async expire(key, seconds) {
    this.expiries.set(key, seconds);
  }
  async get(key) {
    return this.strings.get(key) ?? null;
  }
  async set(key, value) {
    this.strings.set(key, value);
  }
  async del(key) {
    this.strings.delete(key);
  }
  async hmget(key, ...fields) {
    const hash = this.hashes.get(key) ?? new Map();
    return fields.map((field) => hash.get(field) ?? null);
  }
  async hset(key, values) {
    const hash = this.hashes.get(key) ?? new Map();
    for (const [field, value] of Object.entries(values)) hash.set(field, String(value));
    this.hashes.set(key, hash);
  }
}

/** One client per process, shared by the handler instances Next creates. */
let shared;
function defaultStore() {
  if (shared) return shared;
  const url = process.env.REDIS_URL;
  if (!url) return (shared = new MemoryStore());
  const client = new Redis(url, {
    // a cache must not hold a request up: fail fast while Redis is away, and keep trying in the background
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  client.on('error', () => {
    // reported by the failing command; the connection retries on its own
  });
  return (shared = client);
}

export default class CacheHandler {
  /**
   * @param {{ serverDistDir?: string }} [options] what Next passes
   * @param {object} [store] Redis-like client (tests)
   */
  constructor(options = {}, store = defaultStore()) {
    this.store = store;
    const prefix = `next-cache:${buildIdOf(options.serverDistDir ?? '.next/server')}`;
    this.entryKey = (key) => `${prefix}:entry:${key}`;
    this.tagsKey = `${prefix}:tags`;
  }

  async get(key, ctx) {
    try {
      const text = await this.store.get(this.entryKey(key));
      if (!text) return null;
      const entry = deserialize(text);
      const tags = tagsOf(entry, ctx);
      if (tags.length > 0) {
        const revalidatedAt = await this.store.hmget(this.tagsKey, ...tags);
        if (revalidatedAt.some((at) => at !== null && Number(at) >= entry.lastModified))
          return null;
      }
      return entry;
    } catch (error) {
      warn('read', error);
      return null;
    }
  }

  async set(key, data) {
    try {
      if (data === null) {
        await this.store.del(this.entryKey(key));
        return;
      }
      const text = serialize({ value: data, lastModified: Date.now() });
      await this.store.set(this.entryKey(key), text, 'EX', ENTRY_TTL_SECONDS);
    } catch (error) {
      warn('write', error);
    }
  }

  async revalidateTag(tags) {
    const list = [tags].flat().filter(Boolean);
    if (list.length === 0) return;
    const now = Date.now();
    try {
      await this.store.hset(this.tagsKey, Object.fromEntries(list.map((tag) => [tag, now])));
      // a mark older than every entry invalidates nothing, so the hash of a finished build goes away with them
      await this.store.expire(this.tagsKey, ENTRY_TTL_SECONDS);
    } catch (error) {
      // the caller must know: a revalidation that was not recorded leaves stale pages behind
      warn('revalidate', error);
      throw error;
    }
  }

  resetRequestCache() {}
}

function warn(action, error) {
  // one JSON line, like the logs of the other services
  process.stderr.write(
    `${JSON.stringify({
      level: 40,
      time: Date.now(),
      msg: `isr cache ${action} failed`,
      err: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
