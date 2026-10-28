import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { QUEUE_NAMES, QueueMetrics, QueueProcessor, getLoggerToken } from '@collab-docs/nest';
import { AttachmentCleanupProcessor } from './attachment-cleanup.processor';
import { AttachmentSweeper } from './attachment-sweeper';

async function setup(sweep: () => Promise<unknown> = () => Promise.resolve()) {
  const queue = { upsertJobScheduler: jest.fn().mockResolvedValue(undefined) };
  const sweeper = { sweep: jest.fn(sweep) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AttachmentCleanupProcessor,
      { provide: getQueueToken(QUEUE_NAMES.attachmentCleanup), useValue: queue },
      { provide: AttachmentSweeper, useValue: sweeper },
      // injected into the base class
      { provide: QueueMetrics, useValue: { processed: { inc: jest.fn() } } },
      { provide: getLoggerToken(QueueProcessor.name), useValue: { error: jest.fn() } },
    ],
  }).compile();
  return { processor: moduleRef.get(AttachmentCleanupProcessor), queue, sweeper };
}

const job = { id: '1', attemptsMade: 0, data: {} } as unknown as Job;

describe('AttachmentCleanupProcessor', () => {
  it('schedules the sweep once an hour, under one scheduler id so a restart does not add a second', async () => {
    const { processor, queue } = await setup();
    await processor.onModuleInit();
    await processor.onModuleInit();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    for (const call of queue.upsertJobScheduler.mock.calls) {
      expect(call).toEqual(['attachment-cleanup-hourly', { every: 3_600_000 }, { name: 'sweep' }]);
    }
  });

  it('sweeps when the job runs', async () => {
    const { processor, sweeper } = await setup();
    await processor.process(job);
    expect(sweeper.sweep).toHaveBeenCalledTimes(1);
  });

  it('lets a failing sweep fail the job, so that BullMQ retries it', async () => {
    const { processor } = await setup(() => Promise.reject(new Error('storage down')));
    await expect(processor.process(job)).rejects.toThrow('storage down');
  });
});
