import { decodeInboxCursor, encodeInboxCursor } from './inbox-cursor';

const ID = '0190b1c2-0000-7000-8000-0000000000aa';
const AT = '2026-10-26 17:47:31.123456+00';
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('inbox cursor', () => {
  it('round-trips', () => {
    expect(decodeInboxCursor(encodeInboxCursor({ createdAt: AT, id: ID }))).toEqual({
      createdAt: AT,
      id: ID,
    });
  });

  it.each([
    ['not base64 json', '%%%'],
    ['null', Buffer.from('null').toString('base64url')],
    ['a number', Buffer.from('7').toString('base64url')],
    ['a timestamp with an injection', encode({ t: "x'; DROP TABLE notifications; --", i: ID })],
    ['a timestamp that is not one', encode({ t: 'yesterday', i: ID })],
    ['an id that is not a uuid', encode({ t: AT, i: 'x' })],
    ['missing fields', '{}'],
  ])('rejects %s', (_label, raw) => {
    expect(decodeInboxCursor(raw)).toBeNull();
  });
});
