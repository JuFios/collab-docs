import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { type Transporter, createTransport } from 'nodemailer';
import { APP_CONFIG, type AppConfig, logEvent } from '@collab-docs/shared/nest';

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

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async send(message: MailMessage): Promise<void> {
    await this.getTransport().sendMail({ from: this.config.SMTP_FROM, ...message });
    logEvent('mail.sent', { subject: message.subject });
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }

  private getTransport(): Transporter {
    this.transport ??= createTransport({
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      secure: false,
      ...(this.config.SMTP_USER
        ? { auth: { user: this.config.SMTP_USER, pass: this.config.SMTP_PASSWORD } }
        : {}),
    });
    return this.transport;
  }
}
