import { escapeHtml, oneLine } from './html';
import type { RenderedEmail } from './invite-email';

export interface MentionEmailData {
  actorName: string;
  documentTitle: string;
  /** Plain text start of the comment. */
  excerpt: string;
  /** Absolute URL of the document (the thread is opened from it). */
  link: string;
}

/** Everything that comes from users (names, title, comment) is escaped in the HTML part and kept out of the headers. */
export function renderMentionEmail(data: MentionEmailData): RenderedEmail {
  const title = data.documentTitle.trim() || 'Untitled';
  const actor = escapeHtml(data.actorName);
  const link = escapeHtml(data.link);
  return {
    subject: oneLine(`${data.actorName} mentioned you in ${title}`),
    html: [
      '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">',
      `<p><strong>${actor}</strong> mentioned you in a comment on <strong>${escapeHtml(title)}</strong>:</p>`,
      `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #ccc;color:#333;white-space:pre-wrap">${escapeHtml(data.excerpt)}</blockquote>`,
      `<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Open the document</a></p>`,
      `<p>Or open this link: <a href="${link}">${link}</a></p>`,
      '</body></html>',
    ].join('\n'),
    text: [
      `${data.actorName} mentioned you in a comment on ${title}:`,
      '',
      data.excerpt,
      '',
      `Open the document: ${data.link}`,
    ].join('\n'),
  };
}
