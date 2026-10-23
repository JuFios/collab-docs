import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { type Job, type JobsOptions, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { Counter, Gauge } from 'prom-client';
import { APP_CONFIG } from './app-config';
import type { AppConfig } from './config';
import { getCorrelationId, runWithCorrelationId } from './correlation';
import { logEvent, getRootLogger } from './logger';
import { MetricsService } from './metrics';
import { createRedis } from './redis';

export const QUEUE_NAMES = {
  searchSync: 'search-sync',
  publicRevalidate: 'public-revalidate',
  mail: 'mail',
  billingWebhook: 'billing-webhook',
  linkExpiry: 'link-expiry',
  versionPrune: 'version-prune',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/** Every job payload carries the correlation id of the request/job that enqueued it. */
export interface JobEnvelope {
  correlationId?: string;
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const COUNTED_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/**
 * Debounced enqueue (spec §7a): the first call in a `delayMs` window creates a delayed job, later calls are
 * dropped by BullMQ deduplication. The job must read the latest state from the database when it runs, so
 * nothing is lost. Never use `jobId = documentId`: BullMQ remembers finished ids and would drop later changes.
 */
export function enqueueDebounced<T extends object = Record<string, never>>(
  queue: Queue,
  documentId: string,
  delayMs: number,
  extra?: T,
) {
  return queue.add(
    'process',
    { ...extra, documentId, correlationId: getCorrelationId() },
    { delay: delayMs, deduplication: { id: documentId, ttl: delayMs } },
  );
}

@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly jobsGauge: Gauge<'queue' | 'state'>;
  private readonly processed: Counter<'queue' | 'result'>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.connection = createRedis(config.REDIS_URL, { forQueues: true });
    this.jobsGauge = new Gauge({
      name: 'queue_jobs',
      help: 'Jobs per queue and state',
      labelNames: ['queue', 'state'],
      registers: [metrics.registry],
      collect: async () => {
        for (const name of Object.values(QUEUE_NAMES)) this.getQueue(name);
        await Promise.all(
          [...this.queues].map(async ([name, queue]) => {
            const counts = await queue.getJobCounts(...COUNTED_STATES);
            for (const state of COUNTED_STATES) {
              this.jobsGauge.set({ queue: name, state }, counts[state] ?? 0);
            }
          }),
        ).catch(() => undefined);
      },
    });
    this.processed = new Counter({
      name: 'queue_jobs_processed_total',
      help: 'Processed jobs per queue and result',
      labelNames: ['queue', 'result'],
      registers: [metrics.registry],
    });
  }

  getQueue(name: QueueName | (string & {})): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /** Adds a job, stamping the ambient correlation id into its data. */
  add<T extends object>(
    queueName: QueueName | (string & {}),
    jobName: string,
    data: T,
    options?: JobsOptions,
  ) {
    return this.getQueue(queueName).add(
      jobName,
      { ...data, correlationId: getCorrelationId() },
      options,
    );
  }

  /** Registers a processor; runs each job inside its original correlation context. */
  process<T extends object>(
    queueName: QueueName | (string & {}),
    handler: (job: Job<T & JobEnvelope>) => Promise<void>,
    options: { concurrency?: number } = {},
  ): Worker {
    const worker = new Worker<T & JobEnvelope>(
      queueName,
      (job) =>
        runWithCorrelationId(job.data.correlationId ?? `job-${job.id}`, async () => {
          await handler(job);
        }),
      { connection: this.connection, concurrency: options.concurrency ?? 5 },
    );
    worker.on('completed', () => this.processed.inc({ queue: queueName, result: 'completed' }));
    worker.on('failed', (job, error) => {
      this.processed.inc({ queue: queueName, result: 'failed' });
      runWithCorrelationId(job?.data?.correlationId ?? 'unknown', () =>
        logEvent('queue.job_failed', {
          queue: queueName,
          jobId: job?.id,
          attemptsMade: job?.attemptsMade,
          error: error.message,
        }),
      );
    });
    worker.on('error', (error) =>
      getRootLogger().error({ err: error, queue: queueName }, 'worker error'),
    );
    this.workers.push(worker);
    return worker;
  }

  /** Graceful shutdown: stop taking jobs, wait for active ones, then close connections. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    if (this.connection.status !== 'end') {
      await this.connection.quit().catch(() => this.connection.disconnect());
    }
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
