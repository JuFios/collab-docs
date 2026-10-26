import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { publishedImageSrc } from '@/lib/public/published';
import { ContentRenderer } from './content-renderer';

const doc = (...content: unknown[]) => ({ type: 'doc' as const, content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });
const html = (content: ReturnType<typeof doc>, slug = 'plan-3fa9c1') =>
  renderToStaticMarkup(
    <ContentRenderer content={content} resolveImageSrc={publishedImageSrc(slug)} />,
  );

/** Hostile payloads as they could reach the renderer if sanitisation upstream ever let them through. */
const PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg onload=alert(1)>',
  "'; alert(String.fromCharCode(88,83,83)); //",
  '<iframe src="javascript:alert(1)"></iframe>',
  '</p><script>alert(1)</script><p>',
  '<a href="javascript:alert(1)">x</a>',
];

const HREFS = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  '//evil.test/x',
  '/relative/path',
  'file:///etc/passwd',
];

describe('ContentRenderer on the server (published page)', () => {
  it.each(PAYLOADS)('escapes %s in text', (payload) => {
    const out = html(doc({ type: 'paragraph', content: [text(payload)] }));
    expect(out).not.toMatch(/<script|<iframe|<svg|<img/i);
    if (payload.includes('<')) expect(out).toContain('&lt;');
  });

  it.each(PAYLOADS)('escapes %s in attributes it renders', (payload) => {
    const out = html(
      doc(
        { type: 'image', attrs: { attachmentId: '0192f4a8-7a3b', alt: payload } },
        { type: 'codeBlock', attrs: { language: payload }, content: [text(payload)] },
        { type: 'mention', attrs: { id: 'u', label: payload } },
      ),
    );
    expect(out).not.toMatch(/<script|<iframe|<svg/i);
    // a handler would have to sit inside a tag of its own, and every `<` of a value is escaped
    expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/<[a-z][^>]*\sonerror=/i);
  });

  it.each(HREFS)('drops the link for the href %s', (href) => {
    const out = html(
      doc({
        type: 'paragraph',
        content: [text('label', [{ type: 'link', attrs: { href } }])],
      }),
    );
    expect(out).not.toContain('<a ');
    expect(out).toContain('label');
  });

  it('forces rel on every link that is kept', () => {
    const out = html(
      doc({
        type: 'paragraph',
        content: [
          text('a', [{ type: 'link', attrs: { href: 'https://example.com/x', rel: 'opener' } }]),
          text('b', [{ type: 'link', attrs: { href: 'mailto:team@example.com' } }]),
        ],
      }),
    );
    const anchors = out.match(/<a [^>]*>/g) ?? [];
    expect(anchors).toHaveLength(2);
    for (const anchor of anchors) {
      expect(anchor).toContain('rel="noopener noreferrer nofollow ugc"');
    }
  });

  it('skips unknown nodes and marks and never uses dangerouslySetInnerHTML', () => {
    const out = html(
      doc(
        { type: 'script', content: [text('alert(1)')] },
        { type: 'html', attrs: { value: '<b>x</b>' } },
        { type: 'paragraph', content: [text('kept', [{ type: 'style', attrs: { css: 'x' } }])] },
      ),
    );
    expect(out).toBe('<div><p><span>kept</span></p></div>');
  });

  it('renders task items as disabled checkboxes and mentions as @label', () => {
    const out = html(
      doc(
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [text('todo')] }],
            },
          ],
        },
        { type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'u1', label: 'Ada' } }] },
      ),
    );
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('disabled=""');
    expect(out).toContain('@Ada');
  });

  it('serves images through the media handler of the page they belong to', () => {
    const out = html(
      doc({
        type: 'image',
        attrs: { attachmentId: '0192f4a8-7a3b-7c11-9d4e-5b2a1c3d4e5f', alt: 'A cat' },
      }),
      'plan-3fa9c1',
    );
    expect(out).toContain('src="/media/0192f4a8-7a3b-7c11-9d4e-5b2a1c3d4e5f?slug=plan-3fa9c1"');
    expect(out).toContain('alt="A cat"');
  });

  it('matches the markup of a representative page', () => {
    expect(
      html(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Plan')] },
          {
            type: 'paragraph',
            content: [text('Ship '), text('it', [{ type: 'bold' }, { type: 'italic' }])],
          },
          {
            type: 'orderedList',
            attrs: { start: 3 },
            content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('x')] }] }],
          },
          { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('a < b')] },
        ),
      ),
    ).toMatchInlineSnapshot(
      `"<div><h2><span>Plan</span></h2><p><span>Ship </span><span><em><strong>it</strong></em></span></p><ol start="3"><li><p><span>x</span></p></li></ol><pre class="overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm"><code data-language="ts"><span>a &lt; b</span></code></pre></div>"`,
    );
  });
});
