import { renderInviteEmail } from './invite-email';

const data = {
  workspaceName: 'Acme',
  inviterName: 'Ada',
  role: 'EDITOR',
  link: 'http://localhost:3000/invite/abc',
  expiresAt: '2026-11-01T00:00:00.000Z',
};

describe('renderInviteEmail', () => {
  it('mentions the workspace, inviter, role and link in both bodies', () => {
    const email = renderInviteEmail(data);
    expect(email.subject).toBe('Ada invited you to Acme on Collab Docs');
    for (const body of [email.html, email.text]) {
      expect(body).toContain('Acme');
      expect(body).toContain('Ada');
      expect(body).toContain('editor');
      expect(body).toContain('http://localhost:3000/invite/abc');
    }
  });

  it('escapes user-controlled values in the HTML body', () => {
    const email = renderInviteEmail({
      ...data,
      workspaceName: '<img src=x onerror=alert(1)>',
      inviterName: '"><script>alert(1)</script>',
      link: 'http://localhost:3000/invite/a"b',
    });
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(email.html).not.toContain('invite/a"b');
    expect(email.html).toContain('invite/a&quot;b');
  });

  it('keeps the subject on one line', () => {
    const email = renderInviteEmail({ ...data, inviterName: 'Ada\r\nBcc: evil@example.com' });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
});
