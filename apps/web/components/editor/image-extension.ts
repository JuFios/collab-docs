import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { ImageView } from './image-view';

/**
 * The `image` block of the content model: an attachment id and an alt text, nothing else. There is deliberately no
 * `src`: pasted external images are dropped by the parser instead of becoming remote requests for every reader.
 */
export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes) => ({ 'data-attachment-id': attributes.attachmentId }),
      },
      alt: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-alt'),
        renderHTML: (attributes) => (attributes.alt ? { 'data-alt': attributes.alt } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-attachment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
