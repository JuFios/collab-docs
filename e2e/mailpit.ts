import { expect } from '@playwright/test';

const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, '');

interface MessageSummary {
  ID: string;
}

/** The invite link in the newest mail sent to `address`; polls because mail goes out through a queue. */
export async function inviteLinkFor(address: string): Promise<string> {
  let link = '';
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
        );
        if (!search.ok) return '';
        const { messages } = (await search.json()) as { messages: MessageSummary[] };
        const newest = messages[0];
        if (!newest) return '';
        const message = (await (
          await fetch(`${MAILPIT_URL}/api/v1/message/${newest.ID}`)
        ).json()) as {
          Text?: string;
          HTML?: string;
        };
        link =
          /https?:\/\/[^\s"'<>]+\/invite\/[A-Za-z0-9_-]+/.exec(
            `${message.Text} ${message.HTML}`,
          )?.[0] ?? '';
        return link;
      },
      { message: `an invitation mail for ${address}`, timeout: 20_000 },
    )
    .not.toBe('');
  return link;
}
