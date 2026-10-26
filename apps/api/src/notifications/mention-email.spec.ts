import { renderMentionEmail } from './mention-email';

const data = {
  actorName: 'Ada',
  documentTitle: 'Plan',
  excerpt: 'Can you look at this, @Grace?',
  link: 'http://localhost:3000/w/1/d/2?thread=3',
};

describe('renderMentionEmail', () => {
  it('names the author, the document, the excerpt and the link in both bodies', () => {
    const email = renderMentionEmail(data);
    expect(email.subject).toBe('Ada mentioned you in Plan');
    for (const body of [email.html, email.text]) {
      expect(body).toContain('Ada');
      expect(body).toContain('Plan');
      expect(body).toContain('Can you look at this, @Grace?');
      expect(body).toContain('http://localhost:3000/w/1/d/2?thread=3');
    }
  });

  it('escapes everything users write in the HTML part', () => {
    const email = renderMentionEmail({
      actorName: '<b>Ada</b>',
      documentTitle: '"><script>alert(1)</script>',
      excerpt: '<img src=x onerror=alert(1)> & more',
      link: 'http://localhost:3000/?a=1&b="2"',
    });
    expect(email.html).not.toMatch(/<script|<img|<b>/);
    expect(email.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; more');
    expect(email.html).toContain('a=1&amp;b=&quot;2&quot;');
  });

  it('keeps line breaks out of the subject and names an untitled document', () => {
    expect(
      renderMentionEmail({ ...data, actorName: 'Ada\r\nBcc: x@evil.test' }).subject,
    ).not.toMatch(/[\r\n]/);
    expect(renderMentionEmail({ ...data, documentTitle: '  ' }).subject).toBe(
      'Ada mentioned you in Untitled',
    );
  });
});
