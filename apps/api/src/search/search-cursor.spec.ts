import { decodeCursor, encodeCursor } from './search-cursor';

const ID = '0190b1c2-0000-7000-8000-0000000000aa';

describe('search cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor({ rank: '0.6079271', id: ID }))).toEqual({
      rank: '0.6079271',
      id: ID,
    });
  });

  it.each([
    ['not base64 json', '%%%'],
    ['json that is not an object', Buffer.from('7').toString('base64url')],
    ['null', Buffer.from('null').toString('base64url')],
    [
      'a rank that is not a number',
      Buffer.from(JSON.stringify({ r: '1); DROP TABLE documents; --', i: ID })).toString(
        'base64url',
      ),
    ],
    [
      'an id that is not a uuid',
      Buffer.from(JSON.stringify({ r: '1', i: 'x' })).toString('base64url'),
    ],
    ['missing fields', Buffer.from('{}').toString('base64url')],
  ])('rejects %s', (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});
