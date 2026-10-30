import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transporter, createTransport } from 'nodemailer';
import { type AppConfig, logEvent, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';
import { isReleasedAddress } from './released-address';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** SMTP delivery (Mailpit in development). The transport is created on first use. */
@Injectable()
export class MailerService implements OnApplicationShutdown {
  private transport?: Transporter;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    @InjectPinoLogger(MailerService.name) private readonly logger: PinoLogger,
  ) {}

  async send(message: MailMessage): Promise<void> {
    // an account that gave up its address has none to write to; the job is done, not retried
    if (isReleasedAddress(message.to)) {
      logEvent(this.logger, 'mail.skipped', {
        subject: message.subject,
        reason: 'released_address',
      });
      return;
    }
    try {
      await this.getTransport().sendMail({
        from: this.config.get('SMTP_FROM', { infer: true }),
        ...message,
      });
    } catch (error) {
      // the job fails and BullMQ retries it; the log line is what tells a delivery problem from a slow queue
      logEvent(this.logger, 'mail.failed', {
        subject: message.subject,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    logEvent(this.logger, 'mail.sent', { subject: message.subject });
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }

  private getTransport(): Transporter {
    this.transport ??= createTransport({
      host: this.config.get('SMTP_HOST', { infer: true }),
      port: this.config.get('SMTP_PORT', { infer: true }),
      secure: false,
      ...(this.config.get('SMTP_USER', { infer: true })
        ? {
            auth: {
              user: this.config.get('SMTP_USER', { infer: true }),
              pass: this.config.get('SMTP_PASSWORD', { infer: true }),
            },
          }
        : {}),
    });
    return this.transport;
  }
}
