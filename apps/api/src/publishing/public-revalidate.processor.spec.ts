import type { HttpService } from '@nestjs/axios';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { of } from 'rxjs';
import { PublicRevalidateProcessor } from './public-revalidate.processor';
import type { PrismaService } from '../prisma/prisma.service';

const WEB = 'http://web:3000';
const link = (overrides: Record<string, unknown> = {}) => ({
  slug: 'plan-3fa9c1',
  revokedAt: null,
  expiresAt: null,
  document: { deletedAt: null },
  ...overrides,
});

function setup(row: ReturnType<typeof link> | null, pageStatus = 404) {
  const prisma = { publicLink: { findUnique: jest.fn().mockResolvedValue(row) } };
  const http = {
    post: jest.fn().mockReturnValue(of({ status: 200 })),
    get: jest.fn().mockReturnValue(of({ status: pageStatus })),
  };
  const config = { get: (key: string) => (key === 'WEB_INTERNAL_URL' ? WEB : 'secret') };
  const processor = new PublicRevalidateProcessor(
    prisma as unknown as PrismaService,
    config as unknown as ConfigService<never, true>,
    http as unknown as HttpService,
  );
  const logger = { info: jest.fn(), warn: jest.fn() };
  Object.assign(processor, { logger });
  const run = (reason: string) =>
    processor.process({
      id: '1',
      attemptsMade: 0,
      data: { documentId: 'doc', reason },
    } as unknown as Job);
  return { http, logger, run };
}

describe('PublicRevalidateProcessor', () => {
  it('drops the tag of a page that is still published without looking at the page', async () => {
    const { http, run } = setup(link());
    await run('title');
    expect(http.post).toHaveBeenCalledWith(
      `${WEB}/internal/revalidate`,
      { tags: ['pub:plan-3fa9c1'] },
      expect.objectContaining({ headers: { 'x-revalidate-secret': 'secret' } }),
    );
    expect(http.get).not.toHaveBeenCalled();
  });

  it('waits for a page that has just been published to answer 200', async () => {
    const ok = setup(link(), 200);
    await ok.run('publish');
    expect(ok.http.get).toHaveBeenCalledTimes(1);
    const cachedNotFound = setup(link(), 404);
    await expect(cachedNotFound.run('publish')).rejects.toThrow('answers 404');
  });

  it('does nothing for a document that never had a page', async () => {
    const { http, run } = setup(null);
    await run('content');
    expect(http.post).not.toHaveBeenCalled();
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['deleted', { document: { deletedAt: new Date() } }],
  ])('accepts a %s page once the web app answers 404', async (_name, overrides) => {
    const { http, run } = setup(link(overrides), 404);
    await run('unpublish');
    expect(http.get).toHaveBeenCalledWith(
      `${WEB}/p/plan-3fa9c1`,
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('fails the job while the old page is still served, so the queue invalidates again', async () => {
    const { logger, run } = setup(link({ revokedAt: new Date() }), 200);
    await expect(run('unpublish')).rejects.toThrow(
      'answers 200 after its invalidation, expected 404',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'revalidate.failed', reason: 'unpublish' }),
      'revalidate.failed',
    );
  });
});
