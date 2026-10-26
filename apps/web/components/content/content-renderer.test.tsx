// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentRenderer, collectImageIds } from './content-renderer';

const doc = (...content: unknown[]) => ({ type: 'doc' as const, content });
const text = (value: string, marks?: unknown[]) => ({ type: 'text', text: value, marks });

afterEach(cleanup);

describe('ContentRenderer', () => {
  it('renders the supported blocks', () => {
    const { container } = render(
      <ContentRenderer
        content={doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
          {
            type: 'paragraph',
            content: [
              text('a '),
              text('bold', [{ type: 'bold' }]),
              { type: 'hardBreak' },
              text('b'),
            ],
          },
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('x')] }] }],
          },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: true },
                content: [{ type: 'paragraph', content: [text('done')] }],
              },
            ],
          },
          { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1')] },
        )}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('br')).not.toBeNull();
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1');
  });

  it('renders only links with an allowed protocol, with the forced rel', () => {
    render(
      <ContentRenderer
        content={doc({
          type: 'paragraph',
          content: [
            text('good', [{ type: 'link', attrs: { href: 'https://example.com/a' } }]),
            text('bad', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
            text('data', [{ type: 'link', attrs: { href: 'data:text/html,x' } }]),
          ],
        })}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com/a');
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(links[0]?.getAttribute('rel')).toContain('ugc');
  });

  it('resolves images through the caller and shows a placeholder otherwise', () => {
    const image = { type: 'image', attrs: { attachmentId: 'a1', alt: 'A cat' } };
    const { rerender } = render(
      <ContentRenderer content={doc(image)} resolveImageSrc={(id) => `/media/${id}`} />,
    );
    expect(screen.getByRole('img', { name: 'A cat' })).toHaveAttribute('src', '/media/a1');
    rerender(<ContentRenderer content={doc(image)} />);
    expect(screen.getByRole('img', { name: 'A cat' }).tagName).toBe('DIV');
  });

  it('ignores unknown nodes and never renders markup from text', () => {
    const { container } = render(
      <ContentRenderer
        content={doc(
          { type: 'iframe', attrs: { src: 'https://evil.test' } },
          { type: 'paragraph', content: [text('<img src=x onerror=alert(1)>')] },
        )}
      />,
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('collectImageIds', () => {
  it('finds images at any depth', () => {
    expect(
      collectImageIds(
        doc(
          { type: 'image', attrs: { attachmentId: 'a' } },
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [{ type: 'image', attrs: { attachmentId: 'b' } }] },
            ],
          },
        ),
      ),
    ).toEqual(['a', 'b']);
  });
});
