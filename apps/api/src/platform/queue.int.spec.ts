import { Processor } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import type { Job } from 'bullmq';
import {
  type JobEnvelope,
  QueueProcessor,
  QueueService,
  WorkerPlatformModule,
  enqueueDebounced,
  getCorrelationId,
  runWithCorrelationId,
} from '@collab-docs/nest';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await wait(25);
  }
}

// the handlers are swapped per test; the processors are real @Processor classes started by the Nest module
const handlers: Record<string, (job: Job<JobEnvelope>) => Promise<void>> = {};

@Processor('mail', { concurrency: 5 })
class MailProbe extends QueueProcessor {
  protected handle(job: Job<JobEnvelope>): Promise<void> {
    return handlers.mail?.(job) ?? Promise.resolve();
  }
}

@Processor('search-sync', { concurrency: 5 })
class SearchProbe extends QueueProcessor {
  protected handle(job: Job<JobEnvelope>): Promise<void> {
    return handlers['search-sync']?.(job) ?? Promise.resolve();
  }
}

describe('queues', () => {
  let queues: QueueService;
  let close: () => Promise<void>;

  beforeAll(async () => {
    // own database: the HTTP suite flushes db 15 and the two suites run in parallel
    const url = new URL(process.env.REDIS_URL as string);
    url.pathname = '/14';
    process.env.REDIS_URL = url.toString();
    const redis = new Redis(process.env.REDIS_URL);
    await redis.flushdb();
    redis.disconnect();
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerPlatformModule.forRoot()],
      providers: [MailProbe, SearchProbe],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    queues = app.get(QueueService);
    close = () => app.close();
  });

  afterAll(async () => {
    await close();
  });

  it('carries the correlation id into the job and restores it in the processor', async () => {
    const seen: Array<string | undefined> = [];
    const payloads: unknown[] = [];
    handlers.mail = async (job) => {
      seen.push(getCorrelationId());
      payloads.push(job.data);
    };

    await runWithCorrelationId('corr-from-request-1', () =>
      queues.add('mail', 'send', { to: 'a@example.test' }),
    );

    await until(() => seen.length === 1);
    expect(seen).toEqual(['corr-from-request-1']);
    expect(payloads[0]).toMatchObject({
      to: 'a@example.test',
      correlationId: 'corr-from-request-1',
    });
  });

  it('applies the default retry, backoff and cleanup options to every job', async () => {
    const job = await queues.add('billing-webhook', 'deliver', { eventId: 'evt_1' });
    expect(job.opts).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600, count: 1000 },
    });
  });

  describe('enqueueDebounced', () => {
    const documentId = '0190b1c2-0000-7000-8000-0000000000aa';

    it('collapses a burst of changes in the window into one job, and re-queues changes made after it ran', async () => {
      const queue = queues.getQueue('search-sync');
      const runs: number[] = [];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = false;
      handlers['search-sync'] = async () => {
        active = true;
        runs.push(Date.now());
        await gate;
      };

      const first = await enqueueDebounced(queue, documentId, 300);
      const second = await enqueueDebounced(queue, documentId, 300);
      const third = await enqueueDebounced(queue, documentId, 300);
      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);
      expect(await queue.getJobCounts('delayed', 'waiting')).toMatchObject({ delayed: 1 });

      // the job starts after the window; a change made while it is processing must create a new job
      await until(() => active);
      const during = await enqueueDebounced(queue, documentId, 300);
      expect(during.id).not.toBe(first.id);

      release();
      await until(() => runs.length === 2);
      expect(runs).toHaveLength(2);
    });
  });
});
