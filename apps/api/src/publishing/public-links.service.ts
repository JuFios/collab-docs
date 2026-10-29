import { Injectable } from '@nestjs/common';
import { Prisma, type PublicLink as PublicLinkRow } from '@collab-docs/db';
import {
  type CreatePublicLinkInput,
  type CreatedPublicLink,
  PUBLIC_LINK_MAX_TTL_DAYS,
  type PublicLink,
  canManageDocument,
} from '@collab-docs/shared';
import {
  AppException,
  InjectPinoLogger,
  PinoLogger,
  ValidationFailedException,
  logEvent,
} from '@collab-docs/nest';
import { CollabInternalClient } from '../collab/collab-internal.client';
import { PermEventsService } from '../permissions/perm-events.service';
import { type DocumentAccessResult, notFound } from '../permissions/permissions.service';
import { LIVE_DOCUMENT } from '../prisma/live-document';
import { PrismaService } from '../prisma/prisma.service';
import { generateSlug } from '../workspaces/slug';
import { LinkExpiryService } from './link-expiry.service';
import { statusOf } from './link-status';
import { newLinkToken } from './link-token';
import { RevalidationService } from './revalidation.service';

const DAY_MS = 24 * 3600 * 1000;
/** A slug collision (6 random hex digits next to the title) or a concurrent publish; both resolve on retry. */
const MAX_ATTEMPTS = 5;

const present = (link: PublicLinkRow): PublicLink => ({
  id: link.id,
  mode: link.mode,
  slug: link.slug,
  status: statusOf(link),
  expiresAt: link.expiresAt?.toISOString() ?? null,
  revokedAt: link.revokedAt?.toISOString() ?? null,
  createdAt: link.createdAt.toISOString(),
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/** `undefined` leaves the expiry alone, `null` removes it; anything else must lie in the future. */
function parseExpiry(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = new Date(value);
  const now = Date.now();
  // `new Date` rolls 2030-02-31 over to March; a day that does not exist is a typo, not a date
  const [year, month, day] = value.split('T')[0]!.split('-').map(Number);
  const real = new Date(Date.UTC(year!, month! - 1, day!));
  const exists = real.getUTCMonth() === month! - 1 && real.getUTCDate() === day;
  const problem =
    Number.isNaN(date.getTime()) || !exists
      ? 'must be a valid date and time'
      : date.getTime() <= now
        ? 'must be a time in the future'
        : date.getTime() > now + PUBLIC_LINK_MAX_TTL_DAYS * DAY_MS
          ? `must be within ${PUBLIC_LINK_MAX_TTL_DAYS} days`
          : null;
  if (problem) throw new ValidationFailedException([{ field: 'expiresAt', messages: [problem] }]);
  return date;
}

/**
 * Lifecycle of a document's public links (P4): one VIEW link whose slug never changes and one EDIT link
 * whose secret is new every time it is enabled. Callers hold EDIT (`@DocumentAccess`); managing links
 * additionally needs MANAGE or authorship, like sharing.
 */
@Injectable()
export class PublicLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collab: CollabInternalClient,
    private readonly revalidation: RevalidationService,
    private readonly expiry: LinkExpiryService,
    private readonly permEvents: PermEventsService,
    @InjectPinoLogger(PublicLinksService.name) private readonly logger: PinoLogger,
  ) {}

  private assertCanManage(userId: string, current: DocumentAccessResult): void {
    if (!canManageDocument(current.access, current.document.createdBy === userId)) {
      throw new AppException('FORBIDDEN', 'You do not have permission to do this');
    }
  }

  async list(userId: string, current: DocumentAccessResult): Promise<PublicLink[]> {
    this.assertCanManage(userId, current);
    const links = await this.prisma.publicLink.findMany({
      where: { documentId: current.document.id },
      orderBy: { mode: 'asc' },
    });
    return links.map(present);
  }

  /**
   * Enables a link. VIEW is idempotent: an active link comes back unchanged (an `expiresAt` in the request
   * is applied), a revoked or expired one is reactivated under the same slug. EDIT always issues a new
   * secret and a new link row, so the previous URL stops working and its open guest sockets are cut off.
   */
  async create(
    userId: string,
    current: DocumentAccessResult,
    input: CreatePublicLinkInput,
  ): Promise<CreatedPublicLink> {
    this.assertCanManage(userId, current);
    const expiresAt = parseExpiry(input.expiresAt);
    return input.mode === 'VIEW'
      ? this.publish(userId, current, expiresAt)
      : this.enableEdit(userId, current, expiresAt ?? null);
  }

  async update(
    userId: string,
    current: DocumentAccessResult,
    linkId: string,
    rawExpiresAt: string | null,
  ): Promise<PublicLink> {
    this.assertCanManage(userId, current);
    const expiresAt = parseExpiry(rawExpiresAt) ?? null;
    const before = await this.find(current, linkId);
    if (before.revokedAt) {
      throw new AppException('CONFLICT', 'The link was revoked; enable it again instead');
    }
    const after = await this.prisma.publicLink.update({
      where: { id: before.id },
      data: { expiresAt },
    });
    await this.expiry.reschedule(before, after);
    if (statusOf(before) !== 'active') await this.linkChanged(after, 'expiry_changed');
    // open guest sockets keep a timer for the old expiry; a shorter one must not wait for the periodic check
    if (after.mode === 'EDIT') await this.cutOffGuests(current);
    return present(after);
  }

  async revoke(userId: string, current: DocumentAccessResult, linkId: string): Promise<void> {
    this.assertCanManage(userId, current);
    const link = await this.find(current, linkId);
    if (link.revokedAt) return;
    const { count } = await this.prisma.publicLink.updateMany({
      where: { id: link.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return;
    await this.expiry.reschedule(link, null);
    logEvent(this.logger, 'public_link.revoked', {
      linkId: link.id,
      documentId: link.documentId,
      mode: link.mode,
    });
    if (link.mode === 'VIEW') {
      logEvent(this.logger, 'document.unpublished', {
        documentId: link.documentId,
        slug: link.slug,
      });
      await this.revalidation.request(link.documentId, 'unpublish');
    } else {
      await this.cutOffGuests(current);
    }
  }

  // --- VIEW -------------------------------------------------------------------------------------------------

  private async publish(
    userId: string,
    current: DocumentAccessResult,
    expiresAt: Date | null | undefined,
  ): Promise<CreatedPublicLink> {
    const documentId = current.document.id;
    // what the page will show is read from storage: have collab write its buffer first (it may be down)
    const flushed = await this.collab.flush(documentId);

    for (let attempt = 1; ; attempt++) {
      try {
        const { before, link } = await this.prisma.$transaction(async (tx) => {
          if ((await tx.document.count({ where: { id: documentId, ...LIVE_DOCUMENT } })) === 0) {
            throw notFound('Document');
          }
          const existing = await tx.publicLink.findUnique({
            where: { documentId_mode: { documentId, mode: 'VIEW' } },
          });
          if (!existing) {
            const title = await tx.document.findUniqueOrThrow({
              where: { id: documentId },
              select: { title: true },
            });
            const link = await tx.publicLink.create({
              data: {
                documentId,
                mode: 'VIEW',
                slug: generateSlug(title.title, 'page'),
                expiresAt: expiresAt ?? null,
                createdBy: userId,
              },
            });
            return { before: null, link };
          }
          if (statusOf(existing) === 'active') {
            if (expiresAt === undefined) return { before: existing, link: existing };
            const link = await tx.publicLink.update({
              where: { id: existing.id },
              data: { expiresAt },
            });
            return { before: existing, link };
          }
          const link = await tx.publicLink.update({
            where: { id: existing.id },
            data: { revokedAt: null, expiresAt: expiresAt ?? null },
          });
          return { before: existing, link };
        });

        await this.expiry.reschedule(before, link);
        if (!before || statusOf(before) !== 'active') {
          logEvent(this.logger, 'public_link.created', {
            linkId: link.id,
            documentId,
            mode: 'VIEW',
            reactivated: before !== null,
          });
          logEvent(this.logger, 'document.published', { documentId, slug: link.slug, flushed });
          await this.revalidation.request(documentId, 'publish');
        }
        return { ...present(link), token: null, flushed };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  // --- EDIT -------------------------------------------------------------------------------------------------

  private async enableEdit(
    userId: string,
    current: DocumentAccessResult,
    expiresAt: Date | null,
  ): Promise<CreatedPublicLink> {
    const documentId = current.document.id;
    for (let attempt = 1; ; attempt++) {
      const { token, hash } = newLinkToken();
      try {
        const { previous, link } = await this.prisma.$transaction(async (tx) => {
          if ((await tx.document.count({ where: { id: documentId, ...LIVE_DOCUMENT } })) === 0) {
            throw notFound('Document');
          }
          const previous = await tx.publicLink.findUnique({
            where: { documentId_mode: { documentId, mode: 'EDIT' } },
          });
          // a new row, not a new hash on the old one: collab ties open guest sockets to the link id
          if (previous) await tx.publicLink.delete({ where: { id: previous.id } });
          const link = await tx.publicLink.create({
            data: { documentId, mode: 'EDIT', tokenHash: hash, expiresAt, createdBy: userId },
          });
          return { previous, link };
        });

        await this.expiry.reschedule(previous, link);
        logEvent(this.logger, 'public_link.created', {
          linkId: link.id,
          documentId,
          mode: 'EDIT',
          replacedLinkId: previous?.id,
        });
        if (previous) await this.cutOffGuests(current);
        return { ...present(link), token, flushed: null };
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  // --- helpers ----------------------------------------------------------------------------------------------

  private async find(current: DocumentAccessResult, linkId: string): Promise<PublicLinkRow> {
    const link = await this.prisma.publicLink.findFirst({
      where: { id: linkId, documentId: current.document.id },
    });
    if (!link) throw notFound('Link');
    return link;
  }

  private async linkChanged(link: PublicLinkRow, reason: string): Promise<void> {
    logEvent(this.logger, 'public_link.updated', { linkId: link.id, mode: link.mode, reason });
    if (link.mode === 'VIEW') await this.revalidation.request(link.documentId, 'publish');
  }

  /** Collab re-reads the link of every guest socket of the document now instead of at its next 60 s check. */
  private async cutOffGuests(current: DocumentAccessResult): Promise<void> {
    await this.permEvents.permChanged({
      workspaceId: current.document.workspaceId,
      documentId: current.document.id,
      reason: 'link_changed',
    });
  }
}
