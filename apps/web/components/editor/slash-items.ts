import type { Editor, Range } from '@tiptap/core';

export interface SlashItem {
  id: string;
  title: string;
  keywords: string[];
  run: (context: { editor: Editor; range: Range; pickImage: () => void }) => void;
}

const block =
  (apply: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
  ({ editor, range }: { editor: Editor; range: Range }) =>
    apply(editor.chain().focus().deleteRange(range)).run();

const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'text',
    title: 'Text',
    keywords: ['paragraph', 'plain'],
    run: block((c) => c.setParagraph()),
  },
  {
    id: 'heading-1',
    title: 'Heading 1',
    keywords: ['h1', 'title'],
    run: block((c) => c.setHeading({ level: 1 })),
  },
  {
    id: 'heading-2',
    title: 'Heading 2',
    keywords: ['h2', 'subtitle'],
    run: block((c) => c.setHeading({ level: 2 })),
  },
  {
    id: 'heading-3',
    title: 'Heading 3',
    keywords: ['h3'],
    run: block((c) => c.setHeading({ level: 3 })),
  },
  {
    id: 'bullet-list',
    title: 'Bulleted list',
    keywords: ['ul', 'unordered'],
    run: block((c) => c.toggleBulletList()),
  },
  {
    id: 'ordered-list',
    title: 'Numbered list',
    keywords: ['ol', 'ordered'],
    run: block((c) => c.toggleOrderedList()),
  },
  {
    id: 'task-list',
    title: 'To-do list',
    keywords: ['checkbox', 'task', 'todo'],
    run: block((c) => c.toggleTaskList()),
  },
  {
    id: 'code-block',
    title: 'Code block',
    keywords: ['code', 'snippet'],
    run: block((c) => c.toggleCodeBlock()),
  },
  {
    id: 'image',
    title: 'Image',
    keywords: ['picture', 'photo', 'upload'],
    run: ({ editor, range, pickImage }) => {
      editor.chain().focus().deleteRange(range).run();
      pickImage();
    },
  },
];

export function filterSlashItems(query: string, { images = true } = {}): SlashItem[] {
  const needle = query.trim().toLowerCase();
  const available = images ? SLASH_ITEMS : SLASH_ITEMS.filter((item) => item.id !== 'image');
  if (!needle) return [...available];
  return available.filter(
    (item) =>
      item.title.toLowerCase().includes(needle) ||
      item.keywords.some((keyword) => keyword.includes(needle)),
  );
}
