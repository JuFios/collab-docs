import { MENTION_TOKEN } from '@collab-docs/shared';

/** A person picked from the autocomplete while a comment was being written. */
export interface PickedMention {
  id: string;
  name: string;
}

interface MentionTrigger {
  /** Index of the `@` in the text. */
  start: number;
  /** What was typed after it, up to the caret. */
  query: string;
}

/** Longest query worth sending: the api rejects more (`MENTIONABLE_QUERY_MAX_LENGTH`). */
const QUERY_PATTERN = /(?<![\p{L}\p{N}_.])@([^\s@]{0,50})$/u;

/** The `@query` the caret is at the end of, or `null` when the caret is not in one (an `@` inside a word is not). */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const match = QUERY_PATTERN.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: match.index, query: match[1] ?? '' };
}

/** Replaces the `@query` at the caret with `@Name ` and returns the new text and caret position. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turns the text the user sees (`Thanks @Ann Lee`) into the body the api stores (`Thanks @[<user id>]`). Only a
 * name that was picked from the autocomplete becomes a token; text that merely looks like a mention stays text. A
 * name picked twice (two people called Alex) is matched in the order they were picked.
 */
export function serializeBody(text: string, picked: readonly PickedMention[]): string {
  const names = [...new Set(picked.map((mention) => mention.name).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (names.length === 0) return text;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_.])@(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );
  const unused = [...picked];
  return text.replace(pattern, (whole, name: string) => {
    const index = unused.findIndex((mention) => mention.name === name);
    if (index === -1) return whole;
    const [mention] = unused.splice(index, 1);
    return `@[${mention!.id}]`;
  });
}

type BodyPart = { type: 'text'; text: string } | { type: 'mention'; userId: string; name: string };

/**
 * Splits a stored body for display. A token is shown as `@Name` only for a user the api listed in `mentions`;
 * anything else renders as plain "@someone" so a raw id never reaches the page.
 */
export function splitBody(
  body: string,
  mentions: readonly { userId: string; name: string }[],
): BodyPart[] {
  const names = new Map(mentions.map((mention) => [mention.userId.toLowerCase(), mention.name]));
  const parts: BodyPart[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    if (match.index > last) parts.push({ type: 'text', text: body.slice(last, match.index) });
    const userId = match[1]!.toLowerCase();
    parts.push({ type: 'mention', userId, name: names.get(userId) ?? 'someone' });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ type: 'text', text: body.slice(last) });
  return parts;
}
