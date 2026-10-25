import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@collab-docs/db';
import {
  ATTACHMENT_READ_TTL_SECONDS,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  type Attachment,
  type AttachmentMime,
  type AttachmentUrl,
  type PresignAttachmentInput,
  type PresignedAttachment,
  SNIFF_BYTES,
  filenameMatchesMime,
  isAttachmentMime,
  sniffImageType,
} from '@collab-docs/shared';
import {
  APP_CONFIG,
  AppException,
  type AppConfig,
  ValidationFailedException,
  logEvent,
} from '@collab-docs/shared/nest';
import { PermissionsService, notFound } from '../permissions';
import { S3Storage } from '../storage';
import { PlanLimitsService } from '../workspaces';

interface AttachmentRow {
  id: string;
  documentId: string;
  mime: string;
  size: number;
  status: 'PENDING' | 'READY';
  createdAt: Date;
}

const present = (row: AttachmentRow): Attachment => ({
  id: row.id,
  documentId: row.documentId,
  mime: row.mime as AttachmentMime,
  size: row.size,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

const unprocessable = (reason: string, message: string) =>
  new AppException('VALIDATION_FAILED', message, { status: 422, details: { reason } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const attachmentKey = (workspaceId: string, documentId: string): string =>
  `ws/${workspaceId}/doc/${documentId}/${randomUUID()}`;

/**
 * Image uploads (spec §3, §6). Files go straight from the browser to the bucket through a presigned POST;
 * this service reserves quota, verifies what actually arrived and hands out short-lived read URLs.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(PermissionsService) private readonly permissions: PermissionsService,
    @Inject(PlanLimitsService) private readonly limits: PlanLimitsService,
    @Inject(S3Storage) private readonly s3: S3Storage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Needs EDIT on the document. Reserves `size` bytes of the workspace quota until the upload is completed or swept. */
  async presign(
    documentId: string,
    userId: string,
    input: PresignAttachmentInput,
  ): Promise<PresignedAttachment> {
    // the DTO already limits the type; this keeps the service safe for any other caller
    if (!isAttachmentMime(input.mime)) {
      throw new ValidationFailedException([
        { field: 'mime', messages: ['Unsupported image type'] },
      ]);
    }
    if (!filenameMatchesMime(input.filename, input.mime)) {
      throw new ValidationFailedException([
        { field: 'filename', messages: [`The file extension does not match ${input.mime}`] },
      ]);
    }
    const maxBytes = this.config.ATTACHMENT_MAX_BYTES;
    if (input.size > maxBytes) {
      throw new AppException('PAYLOAD_TOO_LARGE', `Images can be at most ${maxBytes} bytes`, {
        details: { maxBytes },
      });
    }

    const attachment = await this.prisma.$transaction(
      async (tx) => {
        // re-checked inside the transaction: the document may have been deleted or the role changed
        const { document } = await this.permissions.assertDocumentAccess(
          userId,
          documentId,
          'EDIT',
          tx,
        );
        await this.limits.lockWorkspace(tx, document.workspaceId);
        await this.limits.assertCanAddStorage(tx, document.workspaceId, input.size);
        return tx.attachment.create({
          data: {
            workspaceId: document.workspaceId,
            documentId,
            key: attachmentKey(document.workspaceId, documentId),
            size: input.size,
            mime: input.mime,
            uploadedBy: userId,
          },
          select: { id: true, key: true },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    const post = await this.s3.presignPost({
      key: attachment.key,
      contentType: input.mime,
      size: input.size,
      expiresInSeconds: ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
    return {
      attachmentId: attachment.id,
      url: post.url,
      fields: post.fields,
      expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Needs EDIT on the attachment's document. Checks what is really in the bucket (size, type, magic number);
   * an object that does not match is deleted along with its row and the call fails with 422.
   */
  async complete(attachmentId: string, userId: string): Promise<Attachment> {
    const row = await this.find(attachmentId);
    await this.permissions.assertDocumentAccess(userId, row.documentId, 'EDIT');
    if (row.status === 'READY') return present(row);

    const info = await this.s3.head(row.key);
    if (!info) throw unprocessable('not_uploaded', 'The file has not been uploaded');
    if (info.size !== row.size) {
      return this.reject(row, 'size_mismatch', 'The uploaded file does not have the declared size');
    }
    if (info.contentType !== row.mime) {
      return this.reject(row, 'type_mismatch', 'The uploaded file does not have the declared type');
    }
    const sniffed = sniffImageType(await this.s3.readHead(row.key, SNIFF_BYTES));
    if (sniffed !== row.mime) {
      return this.reject(
        row,
        'content_mismatch',
        'The file content is not the declared image type',
      );
    }

    // fails when the sweeper removed the row in the meantime
    const { count } = await this.prisma.attachment.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'READY' },
    });
    if (count === 0) throw notFound('Attachment');
    logEvent('attachment.completed', { attachmentId: row.id, size: row.size });
    return present({ ...row, status: 'READY' });
  }

  /** Needs VIEW on the document. Only completed uploads can be read. */
  async url(attachmentId: string, userId: string): Promise<AttachmentUrl> {
    const row = await this.find(attachmentId);
    await this.permissions.assertDocumentAccess(userId, row.documentId, 'VIEW');
    if (row.status !== 'READY') throw notFound('Attachment');
    const url = await this.s3.presignGet({
      key: row.key,
      contentType: row.mime,
      expiresInSeconds: ATTACHMENT_READ_TTL_SECONDS,
    });
    return {
      url,
      expiresAt: new Date(Date.now() + ATTACHMENT_READ_TTL_SECONDS * 1000).toISOString(),
    };
  }

  private async find(attachmentId: string): Promise<AttachmentRow & { key: string }> {
    const row = UUID.test(attachmentId)
      ? await this.prisma.attachment.findUnique({
          where: { id: attachmentId },
          select: {
            id: true,
            documentId: true,
            key: true,
            mime: true,
            size: true,
            status: true,
            createdAt: true,
          },
        })
      : null;
    if (!row) throw notFound('Attachment');
    return row;
  }

  private async reject(
    row: AttachmentRow & { key: string },
    reason: string,
    message: string,
  ): Promise<never> {
    await this.s3.delete(row.key);
    await this.prisma.attachment.deleteMany({ where: { id: row.id, status: 'PENDING' } });
    logEvent('attachment.rejected', { attachmentId: row.id, reason });
    throw unprocessable(reason, message);
  }
}
