import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { BullModule, OnWorkerEvent, WorkerHost, getQueueToken } from '@nestjs/bullmq';
import type { ConnectionOptions, Job, JobsOptions, Queue } from 'bullmq';
import { Counter, Gauge } from 'prom-client';
import type { AppConfig } from './config';
import { getCorrelationId, runWithCorrelationId } from './correlation';
import { InjectPinoLogger, PinoLogger, logEvent } from './logger';
import { MetricsService } from './metrics';

export const QUEUE_NAMES = {
  searchSync: 'search-sync',
  publicRevalidate: 'public-revalidate',
  mail: 'mail',
  billingWebhook: 'billing-webhook',
  billingDelivery: 'billing-delivery',
  linkExpiry: 'link-expiry',
  versionPrune: 'version-prune',
  attachmentCleanup: 'attachment-cleanup',
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

/** BullMQ connection options from `REDIS_URL`. Every queue and worker opens (and closes) its own connection. */
export function queueConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = Number(url.pathname.replace('/', ''));
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    // BullMQ workers need unlimited retries
    maxRetriesPerRequest: null,
  };
}

/** Adds a job to `queue`, stamping the ambient correlation id into its data. */
export function addJob<T extends object>(
  queue: Queue,
  jobName: string,
  data: T,
  options?: JobsOptions,
) {
  return queue.add(jobName, { ...data, correlationId: getCorrelationId() }, options);
}

/**
 * Producer-side helpers and queue metrics. The queues themselves are `BullModule` providers
 * (`@InjectQueue(name)`); this service looks them up by name and adds what BullMQ does not: the ambient
 * correlation id in every job, and the queue metrics.
 */
@Injectable()
export class QueueService {
  private readonly jobsGauge: Gauge<'queue' | 'state'>;
  private readonly enqueueFailures: Counter<'queue'>;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService<AppConfig, true>,
    metrics: MetricsService,
    @InjectPinoLogger(QueueService.name) private readonly logger: PinoLogger,
  ) {
    this.jobsGauge = new Gauge({
      name: 'queue_jobs',
      help: 'Jobs per queue and state',
      labelNames: ['queue', 'state'],
      registers: [metrics.registry],
      collect: async () => {
        await Promise.all(
          Object.values(QUEUE_NAMES).map(async (name) => {
            const counts = await this.getQueue(name).getJobCounts(...COUNTED_STATES);
            for (const state of COUNTED_STATES) {
              this.jobsGauge.set({ queue: name, state }, counts[state] ?? 0);
            }
          }),
        ).catch(() => undefined);
      },
    });
    this.enqueueFailures = new Counter({
      name: 'queue_enqueue_failures_total',
      help: 'Jobs that could not be enqueued (the triggering request still succeeds)',
      labelNames: ['queue'],
      registers: [metrics.registry],
    });
  }

  /** Counts a job that could not be enqueued and logs it as `event`; the triggering request still succeeds. */
  recordEnqueueFailure(queue: string, event: string, fields: Record<string, unknown>): void {
    this.enqueueFailures.inc({ queue });
    logEvent(this.logger, event, { queue, ...fields });
  }

  /** A numeric tunable from the environment (the debounce windows of the derived-data queues). */
  setting(key: 'REVALIDATE_DEBOUNCE_MS' | 'SEARCH_DEBOUNCE_MS'): number {
    return this.config.get(key, { infer: true });
  }

  getQueue(name: QueueName | (string & {})): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }

  /** Adds a job, stamping the ambient correlation id into its data. */
  add<T extends object>(
    queueName: QueueName | (string & {}),
    jobName: string,
    data: T,
    options?: JobsOptions,
  ) {
    return addJob(this.getQueue(queueName), jobName, data, options);
  }
}

/** Counts finished jobs per queue and result. */
@Injectable()
export class QueueMetrics {
  readonly processed: Counter<'queue' | 'result'>;

  constructor(metrics: MetricsService) {
    this.processed = new Counter({
      name: 'queue_jobs_processed_total',
      help: 'Processed jobs per queue and result',
      labelNames: ['queue', 'result'],
      registers: [metrics.registry],
    });
  }
}

/**
 * Base class of the queue processors (`@Processor(name)` classes): runs every job inside its original correlation
 * context, counts the results and logs failures. Subclasses implement `handle`; a thrown error makes BullMQ
 * retry with the queue's backoff.
 */
export abstract class QueueProcessor<T extends object = Record<string, never>> extends WorkerHost {
  // property injection: subclasses declare their own constructors
  @Inject() private readonly queueMetrics!: QueueMetrics;
  @InjectPinoLogger(QueueProcessor.name) protected readonly logger!: PinoLogger;

  protected abstract handle(job: Job<T & JobEnvelope>): Promise<void>;

  process(job: Job<T & JobEnvelope>): Promise<void> {
    return runWithCorrelationId(job.data.correlationId ?? `job-${job.id}`, () => this.handle(job));
  }

  @OnWorkerEvent('completed')
  protected onCompleted(): void {
    this.queueMetrics.processed.inc({ queue: this.worker.name, result: 'completed' });
  }

  @OnWorkerEvent('failed')
  protected onFailed(job: Job<T & JobEnvelope> | undefined, error: Error): void {
    this.queueMetrics.processed.inc({ queue: this.worker.name, result: 'failed' });
    runWithCorrelationId(job?.data?.correlationId ?? 'unknown', () =>
      logEvent(this.logger, 'queue.job_failed', {
        queue: this.worker.name,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: error.message,
      }),
    );
  }

  @OnWorkerEvent('error')
  protected onError(error: Error): void {
    this.logger.error({ err: error, queue: this.worker.name }, 'worker error');
  }
}

/** Registers every queue once, for all processes; processors are added by the worker modules. */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        connection: queueConnection(config.get('REDIS_URL', { infer: true })),
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),
    BullModule.registerQueue(...Object.values(QUEUE_NAMES).map((name) => ({ name }))),
  ],
  providers: [QueueService, QueueMetrics],
  exports: [BullModule, QueueService, QueueMetrics],
})
export class QueueModule {}
