import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Transporter, createTransport } from 'nodemailer';
import { type AppConfig, logEvent, InjectPinoLogger, PinoLogger } from '@collab-docs/nest';

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
    await this.getTransport().sendMail({
      from: this.config.get('SMTP_FROM', { infer: true }),
      ...message,
    });
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
