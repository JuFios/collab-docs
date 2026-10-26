import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signCollabTicket, verifyCollabTicket } from './collab-ticket';

const SECRET = 'a-test-secret-of-sufficient-length';
const DOC = '0190b2c4-7d6a-7000-8000-0123456789ab';
const USER = '0190b2c4-7d6a-7000-8000-0123456789ac';

describe('collab ticket', () => {
  it('round-trips the claims', async () => {
    const ticket = await signCollabTicket(SECRET, {
      docId: DOC,
      sub: USER,
      correlationId: 'req-12345',
    });
    await expect(verifyCollabTicket(SECRET, ticket)).resolves.toEqual({
      docId: DOC,
      sub: USER,
      correlationId: 'req-12345',
    });
  });

  it('carries the link id of a guest', async () => {
    const ticket = await signCollabTicket(SECRET, { docId: DOC, linkId: 'link-1' });
    await expect(verifyCollabTicket(SECRET, ticket)).resolves.toEqual({
      docId: DOC,
      linkId: 'link-1',
    });
  });

  it('rejects a wrong secret, an expired ticket and a foreign audience', async () => {
    const ticket = await signCollabTicket(SECRET, { docId: DOC, sub: USER });
    await expect(
      verifyCollabTicket('another-secret-of-sufficient-length', ticket),
    ).rejects.toThrow();

    const old = await signCollabTicket(
      SECRET,
      { docId: DOC, sub: USER },
      new Date(Date.now() - 120_000),
    );
    await expect(verifyCollabTicket(SECRET, old)).rejects.toThrow();

    const foreign = await new SignJWT({ docId: DOC })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setAudience('api')
      .setIssuer('collab-docs-api')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyCollabTicket(SECRET, foreign)).rejects.toThrow();
  });

  it('rejects unsigned and incomplete tokens', async () => {
    await expect(verifyCollabTicket(SECRET, 'not-a-jwt')).rejects.toThrow();
    const noSubject = await new SignJWT({ docId: DOC })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('collab')
      .setIssuer('collab-docs-api')
      .setExpirationTime('1m')
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyCollabTicket(SECRET, noSubject)).rejects.toThrow();
  });
});
