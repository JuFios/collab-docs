import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@collab-docs/db';
import {
  ATTACHMENT_READ_TTL_SECONDS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  SNIFF_BYTES,
} from '@collab-docs/shared';
import { getLoggerToken } from '@collab-docs/nest';
import { PermissionsService } from '../permissions/permissions.service';
import { S3Storage } from '../storage/s3.service';
import { PlanLimitsService } from '../workspaces/plan-limits.service';
import type { AttachmentRow } from './attachment-access';
import { AttachmentsService } from './attachments.service';

const USER = '0190b1c2-0000-7000-8000-000000000001';
const WORKSPACE = '0190b1c2-0000-7000-8000-0000000000aa';
const DOCUMENT = '0190b1c2-0000-7000-8000-0000000000dd';
const MAX_BYTES = 1024;

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const TEXT_HEAD = Uint8Array.from(Buffer.from('<svg xmlns="..."'));

const row = (overrides: Partial<AttachmentRow> = {}): AttachmentRow => ({
  id: 'att-1',
  documentId: DOCUMENT,
  key: `ws/${WORKSPACE}/doc/${DOCUMENT}/object`,
  mime: 'image/png',
  size: 100,
  status: 'PENDING',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

async function setup() {
  const tx = { attachment: { create: jest.fn().mockResolvedValue({ id: 'att-1', key: 'k' }) } };
  const prisma = {
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
    attachment: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const permissions = {
    assertDocumentAccess: jest.fn().mockResolvedValue({ document: { workspaceId: WORKSPACE } }),
  };
  const limits = {
    lockWorkspace: jest.fn().mockResolvedValue(undefined),
    assertCanAddStorage: jest.fn().mockResolvedValue(undefined),
  };
  const s3 = {
    presignPost: jest.fn().mockResolvedValue({ url: 'https://bucket.test', fields: { k: 'v' } }),
    presignGet: jest.fn().mockResolvedValue('https://bucket.test/read'),
    head: jest.fn().mockResolvedValue({ size: 100, contentType: 'image/png' }),
    readHead: jest.fn().mockResolvedValue(PNG_HEAD),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { info: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AttachmentsService,
      { provide: PrismaClient, useValue: prisma },
      { provide: PermissionsService, useValue: permissions },
      { provide: PlanLimitsService, useValue: limits },
      { provide: S3Storage, useValue: s3 },
      { provide: ConfigService, useValue: { get: () => MAX_BYTES } },
      { provide: getLoggerToken(AttachmentsService.name), useValue: logger },
    ],
  }).compile();
  return {
    service: moduleRef.get(AttachmentsService),
    prisma,
    tx,
    permissions,
    limits,
    s3,
    logger,
  };
}

describe('AttachmentsService', () => {
  describe('presign', () => {
    const input = { filename: 'photo.png', mime: 'image/png' as const, size: 100 };

    it('reserves quota under the workspace lock and returns a presigned upload', async () => {
      const { service, permissions, limits, tx, s3 } = await setup();

      const result = await service.presign(DOCUMENT, USER, input);

      expect(permissions.assertDocumentAccess).toHaveBeenCalledWith(USER, DOCUMENT, 'EDIT', tx);
      expect(limits.lockWorkspace).toHaveBeenCalledWith(tx, WORKSPACE);
      expect(limits.assertCanAddStorage).toHaveBeenCalledWith(tx, WORKSPACE, 100);
      expect(tx.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: WORKSPACE,
            documentId: DOCUMENT,
            size: 100,
            mime: 'image/png',
            uploadedBy: USER,
            key: expect.stringMatching(new RegExp(`^ws/${WORKSPACE}/doc/${DOCUMENT}/`)),
          }),
        }),
      );
      expect(s3.presignPost).toHaveBeenCalledWith({
        key: 'k',
        contentType: 'image/png',
        size: 100,
        expiresInSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
      });
      expect(result).toMatchObject({
        attachmentId: 'att-1',
        url: 'https://bucket.test',
        fields: { k: 'v' },
      });
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('refuses a type that is not an allowed image', async () => {
      const { service, prisma } = await setup();
      await expect(
        service.presign(DOCUMENT, USER, { ...input, mime: 'image/svg+xml' as never }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a file name whose extension does not belong to the type', async () => {
      const { service, prisma } = await setup();
      await expect(
        service.presign(DOCUMENT, USER, { ...input, filename: 'photo.exe' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses a file over the size limit before touching the database', async () => {
      const { service, prisma } = await setup();
      await expect(
        service.presign(DOCUMENT, USER, { ...input, size: MAX_BYTES + 1 }),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: { maxBytes: MAX_BYTES } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('stops when the caller cannot edit the document, without reserving anything', async () => {
      const { service, permissions, tx, s3 } = await setup();
      permissions.assertDocumentAccess.mockRejectedValue(new Error('forbidden'));
      await expect(service.presign(DOCUMENT, USER, input)).rejects.toThrow('forbidden');
      expect(tx.attachment.create).not.toHaveBeenCalled();
      expect(s3.presignPost).not.toHaveBeenCalled();
    });

    it('passes the plan limit error through and signs nothing', async () => {
      const { service, limits, tx, s3 } = await setup();
      limits.assertCanAddStorage.mockRejectedValue(new Error('PLAN_LIMIT_EXCEEDED'));
      await expect(service.presign(DOCUMENT, USER, input)).rejects.toThrow('PLAN_LIMIT_EXCEEDED');
      expect(tx.attachment.create).not.toHaveBeenCalled();
      expect(s3.presignPost).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('is idempotent for an upload that is already READY', async () => {
      const { service, s3 } = await setup();
      const result = await service.complete(row({ status: 'READY' }));
      expect(result).toMatchObject({ id: 'att-1', status: 'READY' });
      expect(s3.head).not.toHaveBeenCalled();
    });

    it('marks a verified upload READY and logs it', async () => {
      const { service, prisma, s3, logger } = await setup();

      const result = await service.complete(row());

      expect(s3.readHead).toHaveBeenCalledWith(expect.any(String), SNIFF_BYTES);
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'PENDING' },
        data: { status: 'READY' },
      });
      expect(result).toMatchObject({ status: 'READY', mime: 'image/png', size: 100 });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'attachment.completed', attachmentId: 'att-1' }),
        'attachment.completed',
      );
    });

    it('answers 422 not_uploaded while the object is missing, and keeps the row', async () => {
      const { service, s3, prisma } = await setup();
      s3.head.mockResolvedValue(null);
      await expect(service.complete(row())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'not_uploaded' },
      });
      expect(s3.delete).not.toHaveBeenCalled();
      expect(prisma.attachment.deleteMany).not.toHaveBeenCalled();
    });

    it.each([
      ['size_mismatch', { size: 999, contentType: 'image/png' }, PNG_HEAD],
      ['type_mismatch', { size: 100, contentType: 'image/jpeg' }, PNG_HEAD],
      ['content_mismatch', { size: 100, contentType: 'image/png' }, TEXT_HEAD],
    ])('deletes the object and the row on %s', async (reason, info, head) => {
      const { service, s3, prisma, logger } = await setup();
      s3.head.mockResolvedValue(info);
      s3.readHead.mockResolvedValue(head);

      await expect(service.complete(row())).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason },
      });

      expect(s3.delete).toHaveBeenCalledWith(row().key);
      expect(prisma.attachment.deleteMany).toHaveBeenCalledWith({
        where: { id: 'att-1', status: 'PENDING' },
      });
      expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'attachment.rejected', reason }),
        'attachment.rejected',
      );
    });

    it('answers NOT_FOUND when the sweeper removed the row in the meantime', async () => {
      const { service, prisma } = await setup();
      prisma.attachment.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.complete(row())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('url', () => {
    it('signs a short-lived read URL for a READY attachment', async () => {
      const { service, s3 } = await setup();
      const result = await service.url(row({ status: 'READY' }));
      expect(s3.presignGet).toHaveBeenCalledWith({
        key: row().key,
        contentType: 'image/png',
        expiresInSeconds: ATTACHMENT_READ_TTL_SECONDS,
      });
      expect(result.url).toBe('https://bucket.test/read');
      expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('hides an upload that has not been completed', async () => {
      const { service, s3 } = await setup();
      await expect(service.url(row({ status: 'PENDING' }))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(s3.presignGet).not.toHaveBeenCalled();
    });
  });
});
