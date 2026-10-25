import { describe, expect, it } from 'vitest';
import { CONTENT_LIMITS, LINK_REL } from './schema';
import { sanitizeContent, sanitizeHref, stripUnsafeChars } from './sanitize';
import type { ContentNode } from './types';

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const link = (href: unknown) => ({ type: 'link', attrs: { href } });

function collect(node: ContentNode, into: ContentNode[] = []): ContentNode[] {
  into.push(node);
  for (const child of node.content ?? []) collect(child, into);
  return into;
}

describe('sanitizeContent', () => {
  it('keeps a valid document unchanged', () => {
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Title')] },
      p(t('Hello '), t('world', [{ type: 'bold' }, { type: 'italic' }])),
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [p(t('one'))] }],
      },
      { type: 'codeBlock', attrs: { language: 'typescript' }, content: [t('const a = 1;\n')] },
    );
    expect(sanitizeContent(input)).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [t('Title')] },
        {
          type: 'paragraph',
          content: [t('Hello '), t('world', [{ type: 'bold' }, { type: 'italic' }])],
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [t('one')] }] }],
        },
        { type: 'codeBlock', attrs: { language: 'typescript' }, content: [t('const a = 1;\n')] },
      ],
    });
  });

  it('returns an empty paragraph for anything that is not a document', () => {
    const empty = { type: 'doc', content: [{ type: 'paragraph' }] };
    for (const input of [null, undefined, 'x', 42, [], {}, { type: 'doc' }, { content: 'nope' }]) {
      expect(sanitizeContent(input)).toEqual(empty);
    }
  });

  describe('XSS corpus', () => {
    it('removes <script> and other unknown nodes but keeps their text as plain text', () => {
      const result = sanitizeContent(
        doc(
          { type: 'script', content: [t('alert(1)')] },
          { type: 'iframe', attrs: { src: 'https://evil.example' } },
          p(t('ok'), { type: 'span', content: [t('<img src=x onerror=alert(1)>')] }),
        ),
      );
      const types = collect(result).map((node) => node.type);
      expect(types.every((type) => ['doc', 'paragraph', 'text'].includes(type))).toBe(true);
      expect(JSON.stringify(result)).not.toContain('iframe');
      // the markup survives only as inert text; no node carries attributes
      expect(collect(result).some((node) => node.attrs)).toBe(false);
    });

    it.each([
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example/x',
      '/relative',
      'https://user:pass@example.com/',
      '',
      42,
      null,
      { toString: () => 'https://example.com' },
    ])('drops the link mark for href %j but keeps the text', (href) => {
      const result = sanitizeContent(doc(p(t('click', [link(href)]))));
      expect(result.content[0]).toEqual({ type: 'paragraph', content: [t('click')] });
    });

    it('normalises safe links and forces rel; extra attributes are removed', () => {
      const result = sanitizeContent(
        doc(
          p(
            t('a', [
              {
                type: 'link',
                attrs: {
                  href: 'https://example.com',
                  rel: 'opener',
                  target: '_self',
                  onclick: 'x()',
                },
              },
            ]),
            t('b', [link('mailto:someone@example.com')]),
            t('c', [link('http://example.com/a?b=1#c')]),
          ),
        ),
      );
      const marks = collect(result)
        .filter((node) => node.type === 'text')
        .map((node) => node.marks);
      expect(marks).toEqual([
        [{ type: 'link', attrs: { href: 'https://example.com/', rel: LINK_REL } }],
        [{ type: 'link', attrs: { href: 'mailto:someone@example.com', rel: LINK_REL } }],
        [{ type: 'link', attrs: { href: 'http://example.com/a?b=1#c', rel: LINK_REL } }],
      ]);
    });

    it('drops event-handler and style attributes on known nodes', () => {
      const result = sanitizeContent(
        doc({
          type: 'paragraph',
          attrs: { id: 'block-1', onerror: 'alert(1)', style: 'x', class: 'y' },
          content: [t('x')],
        }),
      );
      expect(result.content[0]?.attrs).toEqual({ id: 'block-1' });
    });

    it('keeps images only with a valid attachment id and plain alt text', () => {
      const id = '0190b2c4-7d6a-7000-8000-0123456789ab';
      const result = sanitizeContent(
        doc(
          {
            type: 'image',
            attrs: { attachmentId: id, alt: 'a‮b', src: 'javascript:alert(1)', onerror: 'x' },
          },
          { type: 'image', attrs: { src: 'https://evil.example/x.png' } },
          { type: 'image', attrs: { attachmentId: 'not-a-uuid' } },
        ),
      );
      expect(result.content).toEqual([{ type: 'image', attrs: { attachmentId: id, alt: 'ab' } }]);
    });

    it('allows only listed code languages', () => {
      const result = sanitizeContent(
        doc(
          { type: 'codeBlock', attrs: { language: '"><script>' }, content: [t('x')] },
          { type: 'codeBlock', attrs: { language: 'Python' }, content: [t('y')] },
        ),
      );
      expect(result.content[0]?.attrs).toBeUndefined();
      expect(result.content[1]?.attrs).toEqual({ language: 'python' });
    });

    it('drops marks from code blocks and unknown marks everywhere', () => {
      const result = sanitizeContent(
        doc(
          { type: 'codeBlock', content: [t('x', [{ type: 'bold' }])] },
          p(
            t('y', [
              { type: 'underline' },
              { type: 'textStyle', attrs: { color: 'red' } },
              { type: 'bold' },
            ]),
          ),
        ),
      );
      expect(result.content[0]?.content?.[0]?.marks).toBeUndefined();
      expect(result.content[1]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
    });

    it('requires a user id for mentions and cleans the label', () => {
      const id = '0190b2c4-7d6a-7000-8000-0123456789ab';
      const result = sanitizeContent(
        doc(
          p(
            { type: 'mention', attrs: { id, label: 'Ann‮<b>' } },
            { type: 'mention', attrs: { id: 'x', label: 'Bob' } },
          ),
        ),
      );
      expect(result.content[0]?.content).toEqual([
        { type: 'mention', attrs: { id, label: 'Ann<b>' } },
      ]);
    });

    it('does not trust prototype keys', () => {
      const input = JSON.parse(
        '{"type":"doc","content":[{"type":"__proto__","content":[{"type":"text","text":"a"}]},{"type":"constructor"},{"type":"toString"}]}',
      );
      expect(sanitizeContent(input)).toEqual(doc(p(t('a'))));
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('structure', () => {
    it('unwraps nodes that are not allowed in their parent', () => {
      const result = sanitizeContent(
        doc(
          p({ type: 'paragraph', content: [t('nested')] }, { type: 'bulletList', content: [] }),
          { type: 'bulletList', content: [t('text directly in a list')] },
          t('bare text'),
        ),
      );
      expect(result).toEqual(doc(p(t('nested')), p(t('bare text'))));
    });

    it('guarantees list items start with a paragraph', () => {
      const result = sanitizeContent(
        doc({
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'codeBlock', content: [t('x')] }],
            },
            { type: 'taskItem' },
          ],
        }),
      );
      expect(result.content[0]).toEqual({
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph' }, { type: 'codeBlock', content: [t('x')] }],
          },
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph' }] },
        ],
      });
    });

    it('coerces headings to levels 1-3', () => {
      const levels = [0, 4, 2.5, '2', null, 3].map(
        (level) =>
          sanitizeContent(doc({ type: 'heading', attrs: { level }, content: [t('x')] })).content[0]
            ?.attrs?.level,
      );
      expect(levels).toEqual([1, 1, 1, 1, 1, 3]);
    });

    it('merges neighbouring text with the same marks', () => {
      const result = sanitizeContent(
        doc(p(t('a'), t('b'), t('c', [{ type: 'bold' }]), t('d', [{ type: 'bold' }]))),
      );
      expect(result.content[0]?.content).toEqual([t('ab'), t('cd', [{ type: 'bold' }])]);
    });
  });

  describe('limits', () => {
    it('caps nesting depth', () => {
      let node: unknown = p(t('deep'));
      for (let i = 0; i < 200; i += 1) {
        node = { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('x')), node] }] };
      }
      const result = sanitizeContent(doc(node));
      const depth = (n: ContentNode): number => 1 + Math.max(0, ...(n.content ?? []).map(depth));
      expect(depth(result)).toBeLessThanOrEqual(CONTENT_LIMITS.maxDepth + 2);
    });

    it('survives a chain of unknown wrappers deeper than the stack', () => {
      let node: unknown = t('core');
      for (let i = 0; i < 50_000; i += 1) node = { type: 'div', content: [node] };
      expect(() => sanitizeContent(doc(node))).not.toThrow();
    });

    it('truncates very long text', () => {
      const result = sanitizeContent(doc(p(t('a'.repeat(CONTENT_LIMITS.maxTextLength * 3)))));
      expect(result.content[0]?.content?.[0]?.text).toHaveLength(CONTENT_LIMITS.maxTextLength);
    });

    it('caps the number of nodes', () => {
      const paragraphs = Array.from({ length: CONTENT_LIMITS.maxNodes + 100 }, () => p());
      expect(sanitizeContent(doc(...paragraphs)).content.length).toBeLessThanOrEqual(
        CONTENT_LIMITS.maxNodes,
      );
    });
  });

  describe('control and bidi characters', () => {
    it('strips them from text', () => {
      expect(stripUnsafeChars('a\u0000b\u0007c‮d⁦e‏f\u0085g')).toBe('abcdefg');
    });

    it('keeps newlines and tabs, and joiners used by emoji', () => {
      expect(stripUnsafeChars('a\n\tb 👨‍👩‍👧')).toBe('a\n\tb 👨‍👩‍👧');
    });

    it('is applied to document text', () => {
      const result = sanitizeContent(doc(p(t('safe‮txt\u0000'))));
      expect(result.content[0]?.content?.[0]?.text).toBe('safetxt');
    });
  });
});

describe('sanitizeHref', () => {
  it('accepts only absolute http, https and mailto URLs', () => {
    expect(sanitizeHref('https://example.com/a b')).toBe('https://example.com/a%20b');
    expect(sanitizeHref('MAILTO:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeHref('ftp://example.com')).toBeNull();
    expect(sanitizeHref(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});
