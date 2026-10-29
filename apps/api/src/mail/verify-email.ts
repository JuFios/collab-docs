import { escapeHtml, oneLine } from './html';
import type { RenderedEmail } from './invite-email';

export interface VerifyEmailData {
  name: string;
  /** Absolute confirmation URL containing the token. */
  link: string;
  expiresAt: string;
}

export function renderVerifyEmail(data: VerifyEmailData): RenderedEmail {
  const name = escapeHtml(data.name);
  const link = escapeHtml(data.link);
  const expires = escapeHtml(new Date(data.expiresAt).toUTCString());
  return {
    subject: oneLine('Confirm your email address for Collab Docs'),
    html: [
      '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
      `<p>Hi ${name}, confirm that this address is yours so that people can share documents with you.</p>`,
      `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Confirm email address</a></p>`,
      `<p>Or open this link: <a href="${link}">${link}</a></p>`,
      `<p style="color:#555">The link expires on ${expires}. If you did not create an account, you can ignore this email.</p>`,
      '</body></html>',
    ].join('\n'),
    text: [
      `Hi ${data.name}, confirm that this address is yours so that people can share documents with you.`,
      '',
      `Confirm your email address: ${data.link}`,
      '',
      `The link expires on ${new Date(data.expiresAt).toUTCString()}.`,
      'If you did not create an account, you can ignore this email.',
    ].join('\n'),
  };
}
