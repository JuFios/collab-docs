import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentStateReader } from '@collab-docs/db';
import {
  ATTACHMENT_READ_TTL_SECONDS,
  type CollabTicket,
  type EditLinkState,
  type PublicDocument,
} from '@collab-docs/shared';
import { extractMeta, sanitizeContent, yDocToContentJson } from '@collab-docs/shared/content';
import {
  AppException,
  type AppConfig,
  getCorrelationId,
  signCollabTicket,
} from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { S3Storage } from '../storage/s3.service';
import { statusOf } from './link-status';
import { hashToken } from './link-token';

/** One answer for every reason a page is not available, so the endpoint does not tell what exists. */
const pageNotFound = () => new AppException('NOT_FOUND', 'Page not found');
const linkNotFound = () => new AppException('NOT_FOUND', 'Link not found');

/**
 * Anonymous reads (spec §6). Nothing here returns an id of a user or of a workspace. The page itself is cached by
 * Next (ISR), so these endpoints are hit once per rebuild, not once per visitor.
 */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: DocumentStateReader,
    private readonly s3: S3Storage,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** The sanitised content of a published page, from the stored (flushed) state. */
  async document(slug: string): Promise<PublicDocument> {
    const link = await this.liveViewLink(slug);
    const { document } = link;
    const doc = await this.reader.readDoc(document.id);
    try {
      const content = sanitizeContent(yDocToContentJson(doc));
      const changedAt = Math.max(
        document.updatedAt.getTime(),
        document.contentUpdatedAt?.getTime() ?? 0,
      );
      return {
        title: document.title,
        description: extractMeta(content).description,
        content,
        updatedAt: new Date(changedAt).toISOString(),
      };
    } finally {
      doc.destroy();
    }
  }

  /** The image must belong to the document that the slug publishes; the browser is sent to a short-lived URL. */
  async mediaUrl(attachmentId: string, slug: string): Promise<string> {
    const link = await this.liveViewLink(slug);
    const attachment = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, documentId: link.document.id, status: 'READY' },
      select: { key: true, mime: true },
    });
    if (!attachment) throw pageNotFound();
    return this.s3.presignGet({
      key: attachment.key,
      contentType: attachment.mime,
      expiresInSeconds: ATTACHMENT_READ_TTL_SECONDS,
    });
  }

  /** What `/edit-link/<token>` needs to decide between the editor and an explanation. */
  async editLink(token: string): Promise<EditLinkState> {
    const link = await this.liveEditLink(token);
    return {
      mode: 'EDIT',
      documentId: link.document.id,
      title: link.document.title,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    };
  }

  /**
   * A collab ticket for a guest: `{docId, linkId}` and no user. The secret is checked here (by hash); collab then
   * keeps re-reading the link, so revoking or expiring it ends the session.
   */
  async guestTicket(token: string): Promise<CollabTicket> {
    const link = await this.liveEditLink(token);
    const ticket = await signCollabTicket(
      this.config.get('COLLAB_TICKET_SECRET', { infer: true }),
      {
        docId: link.document.id,
        linkId: link.id,
        correlationId: getCorrelationId(),
      },
    );
    return {
      ticket,
      wsUrl: `${this.config.get('COLLAB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/ws`,
    };
  }

  // --- helpers ----------------------------------------------------------------------------------------------

  private async liveViewLink(slug: string) {
    const link = await this.prisma.publicLink.findUnique({
      where: { slug },
      include: {
        document: {
          select: {
            id: true,
            title: true,
            updatedAt: true,
            contentUpdatedAt: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!link || link.mode !== 'VIEW' || statusOf(link) !== 'active' || link.document.deletedAt) {
      throw pageNotFound();
    }
    return link;
  }

  private async liveEditLink(token: string) {
    const link = await this.prisma.publicLink.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { document: { select: { id: true, title: true, deletedAt: true } } },
    });
    if (!link || link.mode !== 'EDIT') throw linkNotFound();
    if (link.document.deletedAt) {
      throw new AppException('DOCUMENT_DELETED', 'This document was deleted');
    }
    if (statusOf(link) !== 'active') {
      throw new AppException('LINK_EXPIRED', 'This link has expired or was revoked');
    }
    return link;
  }
}
