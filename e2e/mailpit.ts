import { type APIRequestContext, expect } from '@playwright/test';

const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, '');

interface MessageSummary {
  ID: string;
}

/**
 * The newest link to `/<path>/<token>` mailed to `address`; polls because mail goes out through a queue. Every
 * message of the address is searched, since a new account also receives its confirmation email.
 */
async function linkFor(address: string, path: string, what: string): Promise<string> {
  const pattern = new RegExp(`https?://[^\\s"'<>]+/${path}/[A-Za-z0-9_-]+`);
  let link = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        );
        if (!search.ok) return '';
        const { messages } = (await search.json()) as { messages: MessageSummary[] };
        // newest first
        for (const summary of messages) {
          const message = (await (
            await fetch(`${MAILPIT_URL}/api/v1/message/${summary.ID}`)
          ).json()) as { Text?: string; HTML?: string };
          link = pattern.exec(`${message.Text} ${message.HTML}`)?.[0] ?? '';
          if (link) return link;
        }
        return '';
      },
      { message: `${what} for ${address}`, timeout: 20_000 },
    )
    .not.toBe('');
  return link;
}

export function inviteLinkFor(address: string): Promise<string> {
  return linkFor(address, 'invite', 'an invitation mail');
}

export function confirmationLinkFor(address: string): Promise<string> {
  return linkFor(address, 'verify-email', 'a confirmation mail');
}

/** Opens the link of the confirmation email, as its owner would; needed before a document can be shared with them. */
export async function confirmEmail(request: APIRequestContext, address: string): Promise<void> {
  const page = await request.get(await confirmationLinkFor(address));
  expect(await page.text()).toContain('Email address confirmed');
}
