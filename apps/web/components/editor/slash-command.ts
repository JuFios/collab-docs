import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { SlashMenu, type SlashMenuHandle, type SlashMenuProps } from './slash-menu';
import { type SlashItem, filterSlashItems } from './slash-items';

interface SlashCommandOptions {
  pickImage?: () => void;
}

const slashKey = new PluginKey('slashCommand');

function place(element: HTMLElement, props: SuggestionProps<SlashItem, SlashItem>): void {
  const rect = props.clientRect?.();
  if (!rect) return;
  element.style.position = 'fixed';
  element.style.zIndex = '50';
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.bottom + 4}px`;
}

/** "/" opens a menu of block types at the cursor. */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',

  addOptions() {
    return { pickImage: undefined };
  },

  addProseMirrorPlugins() {
    const { pickImage } = this.options;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: slashKey,
        char: '/',
        items: ({ query }) => filterSlashItems(query, { images: pickImage !== undefined }),
        command: ({ editor, range, props }) =>
          props.run({ editor, range, pickImage: pickImage ?? (() => undefined) }),
        render: () => {
          let renderer: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null = null;
          return {
            onStart: (props) => {
              renderer = new ReactRenderer<SlashMenuHandle, SlashMenuProps>(SlashMenu, {
                props,
                editor: props.editor,
              });
              // inside the page's main landmark, so that the menu is not content outside every region; it is
              // placed with `position: fixed` and so does not depend on where it is mounted
              (props.editor.view.dom.closest('main') ?? document.body).append(renderer.element);
              place(renderer.element, props);
            },
            onUpdate: (props) => {
              renderer?.updateProps(props);
              if (renderer) place(renderer.element, props);
            },
            onKeyDown: (props) => renderer?.ref?.onKeyDown(props) ?? false,
            onExit: () => {
              renderer?.element.remove();
              renderer?.destroy();
              renderer = null;
            },
          };
        },
      }),
    ];
  },
});
