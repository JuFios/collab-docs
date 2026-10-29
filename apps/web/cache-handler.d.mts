/** Types of `cache-handler.mjs`, for its tests (Next loads the module itself). */
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
  hset(key: string, values: Record<string, string | number>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface CacheEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the shape is Next's and varies by kind
  value: any;
  lastModified: number;
}

export function serialize(entry: unknown): string;
export function deserialize(text: string): unknown;

export class MemoryStore implements Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>;
  hset(key: string, values: Record<string, string | number>): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  readonly expiries: Map<string, number>;
}

export default class CacheHandler {
  constructor(options?: { serverDistDir?: string }, store?: Store);
  get(
    key: string,
    ctx: { kind?: string; tags?: string[]; softTags?: string[] },
  ): Promise<CacheEntry | null>;
  set(key: string, data: unknown): Promise<void>;
  revalidateTag(tags: string | string[]): Promise<void>;
  resetRequestCache(): void;
}
