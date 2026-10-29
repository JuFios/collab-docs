import { describe, expect, it } from 'vitest';
import CacheHandler, { MemoryStore, deserialize, serialize } from './cache-handler.mjs';

const page = (tags: string) => ({
  kind: 'APP_PAGE',
  html: '<p>hi</p>',
  rscData: Buffer.from('rsc payload'),
  segmentData: new Map([['/_index', Buffer.from('segment')]]),
  headers: { 'x-next-cache-tags': tags },
  status: 200,
});

/** Two replicas: separate handler instances that share one store, as two processes share Redis. */
function replicas() {
  const store = new MemoryStore();
  return [new CacheHandler({}, store), new CacheHandler({}, store)] as const;
}

describe('ISR cache handler', () => {
  it('keeps the Buffers and Maps of an entry', () => {
    const value = page('a');
    const back = deserialize(serialize({ value, lastModified: 1 })) as { value: typeof value };
    expect(Buffer.isBuffer(back.value.rscData)).toBe(true);
    expect(back.value.rscData.toString()).toBe('rsc payload');
    expect(back.value.segmentData).toBeInstanceOf(Map);
    expect(back.value.segmentData.get('/_index')?.toString()).toBe('segment');
  });

  it('serves what another replica rendered', async () => {
    const [one, two] = replicas();
    await one.set('/published/a', page('_N_T_/published/a,doc:1'));
    expect((await two.get('/published/a', {}))?.value.html).toBe('<p>hi</p>');
  });

  it('misses an entry once any of its tags is revalidated, on whichever replica', async () => {
    const [one, two] = replicas();
    await one.set('/published/a', page('_N_T_/published/a,doc:1'));
    await one.set('/published/b', page('_N_T_/published/b,doc:2'));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await two.revalidateTag('doc:1');
    expect(await one.get('/published/a', {})).toBeNull();
    expect(await one.get('/published/b', {})).not.toBeNull();
    // rendered again after the revalidation, it is fresh
    await new Promise((resolve) => setTimeout(resolve, 2));
    await one.set('/published/a', page('_N_T_/published/a,doc:1'));
    expect(await two.get('/published/a', {})).not.toBeNull();
  });

  it('checks the tags of a fetch entry from the call', async () => {
    const [one, two] = replicas();
    await one.set('fetch-key', { kind: 'FETCH', data: { body: 'x' }, revalidate: 60 });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await two.revalidateTag(['doc:9']);
    expect(await one.get('fetch-key', { kind: 'FETCH', tags: ['doc:9'] })).toBeNull();
    expect(await one.get('fetch-key', { kind: 'FETCH', tags: ['doc:8'] })).not.toBeNull();
  });

  it('lets the revalidation marks expire with the entries they could invalidate', async () => {
    const store = new MemoryStore();
    await new CacheHandler({}, store).revalidateTag(['doc:1', 'pub:a']);
    expect([...store.expiries.values()]).toEqual([30 * 24 * 3600]);
  });

  it('treats a store that fails as a miss and drops the write, but reports a lost revalidation', async () => {
    const broken = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
      del: () => Promise.reject(new Error('down')),
      hmget: () => Promise.reject(new Error('down')),
      hset: () => Promise.reject(new Error('down')),
      expire: () => Promise.reject(new Error('down')),
    };
    const handler = new CacheHandler({}, broken);
    expect(await handler.get('/x', {})).toBeNull();
    await expect(handler.set('/x', page('a'))).resolves.toBeUndefined();
    await expect(handler.revalidateTag('a')).rejects.toThrow('down');
  });
});
