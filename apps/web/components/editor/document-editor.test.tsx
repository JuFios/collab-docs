// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import type { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentEditor } from './document-editor';

function mount(props: { editable: boolean; synced: boolean }) {
  const ydoc = new Y.Doc();
  const provider = {
    awareness: new Awareness(ydoc),
    on: () => undefined,
    off: () => undefined,
  } as unknown as WebsocketProvider;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DocumentEditor documentId="doc-1" ydoc={ydoc} provider={provider} {...props} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('DocumentEditor', () => {
  it('shows a skeleton and no editor until the document synced', () => {
    mount({ editable: true, synced: false });
    expect(screen.getByRole('status', { name: 'Loading the document' })).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('is editable with a toolbar for an editor', async () => {
    mount({ editable: true, synced: true });
    const textbox = await screen.findByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(textbox).toHaveAttribute('contenteditable', 'true'));
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
  });

  it('is read-only without any editing controls for a viewer', async () => {
    mount({ editable: false, synced: true });
    const textbox = await screen.findByRole('textbox', { name: 'Document content' });
    expect(textbox).toHaveAttribute('contenteditable', 'false');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('rebuilds as read-only when the access drops', async () => {
    const ydoc = new Y.Doc();
    const provider = {
      awareness: new Awareness(ydoc),
      on: () => undefined,
      off: () => undefined,
    } as unknown as WebsocketProvider;
    const tree = (editable: boolean) => (
      <QueryClientProvider client={client}>
        <DocumentEditor
          documentId="doc-1"
          ydoc={ydoc}
          provider={provider}
          synced
          editable={editable}
        />
      </QueryClientProvider>
    );
    const client = new QueryClient();
    const view = render(tree(true));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Document content' })).toHaveAttribute(
        'contenteditable',
        'true',
      ),
    );
    view.rerender(tree(false));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Document content' })).toHaveAttribute(
        'contenteditable',
        'false',
      ),
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
