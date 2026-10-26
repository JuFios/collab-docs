'use client';

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import {
  Bold,
  Braces,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListChecks,
  ListOrdered,
  Redo2,
  Undo2,
} from 'lucide-react';
import { type ComponentType, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LinkDialog } from './link-dialog';

interface ToolbarAction {
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  active?: boolean;
  disabled?: boolean;
  run: () => void;
}

export function EditorToolbar({
  editor,
  onPickImage,
}: {
  editor: Editor;
  /** Omitted where images cannot be uploaded (guests). */
  onPickImage?: () => void;
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive('bold'),
      italic: current.isActive('italic'),
      code: current.isActive('code'),
      link: current.isActive('link'),
      href: (current.getAttributes('link').href as string | undefined) ?? '',
      h1: current.isActive('heading', { level: 1 }),
      h2: current.isActive('heading', { level: 2 }),
      h3: current.isActive('heading', { level: 3 }),
      bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'),
      taskList: current.isActive('taskList'),
      codeBlock: current.isActive('codeBlock'),
      canUndo: current.can().undo(),
      canRedo: current.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();

  const groups: ToolbarAction[][] = [
    [
      { label: 'Undo', icon: Undo2, disabled: !state.canUndo, run: () => chain().undo().run() },
      { label: 'Redo', icon: Redo2, disabled: !state.canRedo, run: () => chain().redo().run() },
    ],
    [
      {
        label: 'Heading 1',
        icon: Heading1,
        active: state.h1,
        run: () => chain().toggleHeading({ level: 1 }).run(),
      },
      {
        label: 'Heading 2',
        icon: Heading2,
        active: state.h2,
        run: () => chain().toggleHeading({ level: 2 }).run(),
      },
      {
        label: 'Heading 3',
        icon: Heading3,
        active: state.h3,
        run: () => chain().toggleHeading({ level: 3 }).run(),
      },
    ],
    [
      { label: 'Bold', icon: Bold, active: state.bold, run: () => chain().toggleBold().run() },
      {
        label: 'Italic',
        icon: Italic,
        active: state.italic,
        run: () => chain().toggleItalic().run(),
      },
      {
        label: 'Inline code',
        icon: Code,
        active: state.code,
        run: () => chain().toggleCode().run(),
      },
      { label: 'Link', icon: LinkIcon, active: state.link, run: () => setLinkOpen(true) },
    ],
    [
      {
        label: 'Bulleted list',
        icon: List,
        active: state.bulletList,
        run: () => chain().toggleBulletList().run(),
      },
      {
        label: 'Numbered list',
        icon: ListOrdered,
        active: state.orderedList,
        run: () => chain().toggleOrderedList().run(),
      },
      {
        label: 'To-do list',
        icon: ListChecks,
        active: state.taskList,
        run: () => chain().toggleTaskList().run(),
      },
      {
        label: 'Code block',
        icon: Braces,
        active: state.codeBlock,
        run: () => chain().toggleCodeBlock().run(),
      },
      ...(onPickImage ? [{ label: 'Image', icon: ImageIcon, run: onPickImage }] : []),
    ],
  ];

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-background p-1"
    >
      {groups.map((group) => (
        <div key={group[0]?.label} className="flex items-center gap-0.5">
          {group.map(({ label, icon: Icon, active, disabled, run }) => (
            <Button
              key={label}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={label}
              title={label}
              aria-pressed={active === undefined ? undefined : active}
              disabled={disabled}
              // keep the text selection: the toolbar must not take focus from the editor
              onMouseDown={(event) => event.preventDefault()}
              onClick={run}
              className={cn('h-8 w-8', active && 'bg-accent text-accent-foreground')}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </Button>
          ))}
        </div>
      ))}
      {linkOpen ? (
        <LinkDialog
          open
          initialHref={state.href}
          onOpenChange={setLinkOpen}
          onSubmit={(href) => {
            chain().extendMarkRange('link').setLink({ href }).run();
            setLinkOpen(false);
          }}
          onRemove={() => {
            chain().extendMarkRange('link').unsetLink().run();
            setLinkOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
