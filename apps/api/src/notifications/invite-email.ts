import { escapeHtml } from './html';

export interface InviteEmailData {
  workspaceName: string;
  inviterName: string;
  role: string;
  /** Absolute accept URL containing the invite token. */
  link: string;
  expiresAt: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Subjects are plain text but still must not carry line breaks (header injection). */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function renderInviteEmail(data: InviteEmailData): RenderedEmail {
  const workspace = escapeHtml(data.workspaceName);
  const inviter = escapeHtml(data.inviterName);
  const role = escapeHtml(data.role.toLowerCase());
  const link = escapeHtml(data.link);
  const expires = escapeHtml(new Date(data.expiresAt).toUTCString());
  return {
    subject: oneLine(`${data.inviterName} invited you to ${data.workspaceName} on Collab Docs`),
    html: [
      '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
      `<p><strong>${inviter}</strong> invited you to join <strong>${workspace}</strong> on Collab Docs as ${role}.</p>`,
      `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>`,
      `<p>Or open this link: <a href="${link}">${link}</a></p>`,
      `<p style="color:#555">The invitation expires on ${expires}. If you were not expecting it, you can ignore this email.</p>`,
      '</body></html>',
    ].join('\n'),
    text: [
      `${data.inviterName} invited you to join ${data.workspaceName} on Collab Docs as ${data.role.toLowerCase()}.`,
      '',
      `Accept the invitation: ${data.link}`,
      '',
      `The invitation expires on ${new Date(data.expiresAt).toUTCString()}.`,
      'If you were not expecting it, you can ignore this email.',
    ].join('\n'),
  };
}
