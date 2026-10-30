import { renderVerifyEmail } from './verify-email';

const data = {
  name: 'Ada',
  link: 'http://localhost:3000/verify-email/abc',
  expiresAt: '2026-11-01T00:00:00.000Z',
};

describe('renderVerifyEmail', () => {
  it('greets the person and carries the link in both bodies', () => {
    const email = renderVerifyEmail(data);
    expect(email.subject).toBe('Confirm your email address for Collab Docs');
    for (const body of [email.html, email.text]) {
      expect(body).toContain('Ada');
      expect(body).toContain('http://localhost:3000/verify-email/abc');
    }
  });

  it('says that the address can be lost if it is not confirmed in time', () => {
    const email = renderVerifyEmail(data);
    for (const body of [email.html, email.text]) {
      expect(body).toContain('within 48 hours of signing up');
      expect(body).toContain('can lose this address to a new registration');
    }
  });

  it('escapes user-controlled values in the HTML body', () => {
    const email = renderVerifyEmail({
      ...data,
      name: '"><script>alert(1)</script>',
      link: 'http://localhost:3000/verify-email/a"b',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('a"b');
  });
});
