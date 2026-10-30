import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@collab-docs/db';
import { isReleasedEmail, mentionNotificationPayloadSchema } from '@collab-docs/shared';
import { type AppConfig, InjectPinoLogger, PinoLogger, logEvent } from '@collab-docs/nest';
import { viewableDocumentSql } from '../permissions/document-access-sql';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from './mailer.service';
import { renderMentionEmail } from './mention-email';

type MentionMailOutcome = 'sent' | 'skipped';

/**
 * Sends the email of a mention notification. Everything is read when the job runs: a notification that was
 * deleted with its comment, or whose recipient can no longer open the document, sends nothing.
 */
@Injectable()
export class MentionMailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(MentionMailService.name) private readonly logger: PinoLogger,
  ) {}

  async deliver(notificationId: string): Promise<MentionMailOutcome> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: { user: { select: { email: true } } },
    });
    const payload = mentionNotificationPayloadSchema.safeParse(notification?.payload);
    if (!notification || notification.type !== 'MENTION' || !payload.success) {
      logEvent(this.logger, 'mail.skipped', { notificationId, reason: 'gone' });
      return 'skipped';
    }
    const { documentId, workspaceId, threadId, documentTitle, actor, excerpt } = payload.data;
    if (isReleasedEmail(notification.user.email)) {
      logEvent(this.logger, 'mail.skipped', { notificationId, reason: 'released_address' });
      return 'skipped';
    }

    const [row] = await this.prisma.$queryRaw<{ viewable: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = ${documentId}::uuid AND ${viewableDocumentSql(Prisma.sql`${notification.userId}::uuid`)}
      ) AS viewable`;
    if (!row?.viewable) {
      logEvent(this.logger, 'mail.skipped', { notificationId, reason: 'no_access' });
      return 'skipped';
    }

    const link = new URL(
      `/workspaces/${workspaceId}/documents/${documentId}`,
      this.config.get('WEB_ORIGIN', { infer: true }),
    );
    link.searchParams.set('thread', threadId);
    await this.mailer.send({
      to: notification.user.email,
      ...renderMentionEmail({
        actorName: actor.name,
        documentTitle,
        excerpt,
        link: link.toString(),
      }),
    });
    return 'sent';
  }
}
