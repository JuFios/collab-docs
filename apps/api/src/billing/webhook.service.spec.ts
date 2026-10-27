import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BILLING_EVENT_TYPES } from '@collab-docs/shared';
import { MetricsService, QUEUE_NAMES, QueueService, getLoggerToken } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookService } from './webhook.service';
import { signWebhook } from './webhook-signature';

const SECRET = 'dev-only-webhook-signing-secret-change-me';
const EVENT_ID = `evt_${'0'.repeat(31)}1`;

const body = (id = EVENT_ID) =>
  JSON.stringify({
    id,
    type: BILLING_EVENT_TYPES.checkoutCompleted,
    created: Date.now(),
    data: { checkoutSessionId: '0190b1c2-0000-7000-8000-0000000000b1' },
  });

const signed = (text: string) => ({ raw: Buffer.from(text), signature: signWebhook(SECRET, text) });

async function setup() {
  const prisma = {
    webhookEvent: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ status: 'RECEIVED' }),
    },
  };
  const queue = { getJob: jest.fn().mockResolvedValue(undefined) };
  const queues = {
    getQueue: jest.fn().mockReturnValue(queue),
    add: jest.fn().mockResolvedValue({}),
    recordEnqueueFailure: jest.fn(),
  };
  const logger = { info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      WebhookService,
      MetricsService,
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: queues },
      { provide: ConfigService, useValue: { get: () => SECRET } },
      { provide: getLoggerToken(WebhookService.name), useValue: logger },
    ],
  }).compile();
  return { prisma, queue, queues, logger, service: moduleRef.get(WebhookService) };
}

const deliver = (
  service: WebhookService,
  { raw, signature }: ReturnType<typeof signed> = signed(body()),
) => service.receive(raw, signature);

describe('WebhookService', () => {
  describe('signature', () => {
    it('refuses a forged delivery before anything is stored', async () => {
      const { service, prisma, queues } = await setup();
      const { raw } = signed(body());
      await expect(service.receive(raw, 't=1,v1=' + 'a'.repeat(64))).rejects.toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        status: 401,
      });
      expect(prisma.webhookEvent.createMany).not.toHaveBeenCalled();
      expect(queues.add).not.toHaveBeenCalled();
    });

    it('refuses a delivery without a header or without a body', async () => {
      const { service } = await setup();
      await expect(service.receive(Buffer.from(body()), undefined)).rejects.toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
      });
      await expect(service.receive(undefined, signWebhook(SECRET, body()))).rejects.toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
      });
    });

    it('refuses an old delivery', async () => {
      const { service } = await setup();
      const text = body();
      const old = signWebhook(SECRET, text, Date.now() - 6 * 60 * 1000);
      await expect(service.receive(Buffer.from(text), old)).rejects.toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
      });
    });

    it('refuses a correctly signed body that is not a provider event', async () => {
      const { service } = await setup();
      await expect(deliver(service, signed('{"hello":"world"}'))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(deliver(service, signed('not json'))).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });
  });

  describe('a new event', () => {
    it('is stored, queued once under its own id, and acknowledged', async () => {
      const { service, prisma, queues } = await setup();
      await expect(deliver(service)).resolves.toEqual({ received: true });

      expect(prisma.webhookEvent.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ eventId: EVENT_ID })],
        skipDuplicates: true,
      });
      expect(queues.add).toHaveBeenCalledTimes(1);
      expect(queues.add).toHaveBeenCalledWith(
        QUEUE_NAMES.billingWebhook,
        'process',
        { eventId: EVENT_ID },
        { jobId: EVENT_ID },
      );
    });

    it('fails the delivery when the queue is down, so that the provider delivers again', async () => {
      const { service, queues } = await setup();
      queues.add.mockRejectedValueOnce(new Error('redis down'));

      await expect(deliver(service)).rejects.toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
      });
      expect(queues.recordEnqueueFailure).toHaveBeenCalledWith(
        QUEUE_NAMES.billingWebhook,
        'webhook.enqueue_failed',
        expect.objectContaining({ eventId: EVENT_ID }),
      );
    });
  });

  describe('a repeated delivery', () => {
    it('of a processed event is acknowledged as a duplicate and queues nothing', async () => {
      const { service, prisma, queues, logger } = await setup();
      prisma.webhookEvent.createMany.mockResolvedValue({ count: 0 });
      prisma.webhookEvent.findUnique.mockResolvedValue({ status: 'PROCESSED' });

      await expect(deliver(service)).resolves.toEqual({ duplicate: true });

      expect(queues.add).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'webhook.duplicate_delivery', eventId: EVENT_ID }),
        'webhook.duplicate_delivery',
      );
    });

    it('of an event that was stored but never processed queues it again', async () => {
      const { service, prisma, queues } = await setup();
      prisma.webhookEvent.createMany.mockResolvedValue({ count: 0 });
      prisma.webhookEvent.findUnique.mockResolvedValue({ status: 'RECEIVED' });

      await expect(deliver(service)).resolves.toEqual({ received: true });

      expect(queues.add).toHaveBeenCalledWith(
        QUEUE_NAMES.billingWebhook,
        'process',
        { eventId: EVENT_ID },
        { jobId: EVENT_ID },
      );
    });

    it('retries the job that used up its attempts: BullMQ would ignore a second add under its id', async () => {
      const { service, prisma, queue, queues } = await setup();
      prisma.webhookEvent.createMany.mockResolvedValue({ count: 0 });
      const failed = { isFailed: jest.fn().mockResolvedValue(true), retry: jest.fn() };
      queue.getJob.mockResolvedValue(failed);

      await expect(deliver(service)).resolves.toEqual({ received: true });

      expect(failed.retry).toHaveBeenCalledWith('failed');
      expect(queues.add).not.toHaveBeenCalled();
    });

    it('leaves a job that is still waiting or running alone', async () => {
      const { service, prisma, queue, queues } = await setup();
      prisma.webhookEvent.createMany.mockResolvedValue({ count: 0 });
      const running = { isFailed: jest.fn().mockResolvedValue(false), retry: jest.fn() };
      queue.getJob.mockResolvedValue(running);

      await deliver(service);

      expect(running.retry).not.toHaveBeenCalled();
      // `add` under a known job id is a no-op in BullMQ; the call is harmless
      expect(queues.add).toHaveBeenCalledTimes(1);
    });
  });
});
