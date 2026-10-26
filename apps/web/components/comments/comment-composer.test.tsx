// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const people = [
  { id: ANN, name: 'Ann Lee', email: 'ann@example.com' },
  { id: BOB, name: 'Bob Stone', email: 'bob@example.com' },
];
const searched: string[] = [];

vi.mock('@/lib/comments/queries', () => ({
  useMentionable: (_documentId: string, q: string, enabled: boolean) => {
    if (enabled) searched.push(q);
    return {
      data: enabled
        ? people.filter((person) => person.name.toLowerCase().startsWith(q.toLowerCase()))
        : undefined,
    };
  },
}));

import { CommentComposer } from './comment-composer';

afterEach(() => {
  cleanup();
  searched.length = 0;
});

function mount(onSubmit = vi.fn().mockResolvedValue(true)) {
  render(<CommentComposer documentId="doc-1" label="New comment" onSubmit={onSubmit} />);
  return { onSubmit, field: screen.getByRole('combobox', { name: 'New comment' }) };
}

describe('CommentComposer', () => {
  it('offers people after @ and inserts the picked name', async () => {
    const user = userEvent.setup();
    const { field } = mount();
    await user.type(field, 'Hi @an');
    const option = await screen.findByRole('option', { name: /Ann Lee/ });
    expect(screen.queryByRole('option', { name: /Bob/ })).toBeNull();
    expect(field).toHaveAttribute('aria-expanded', 'true');
    await user.click(option);
    expect(field).toHaveValue('Hi @Ann Lee ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searched).toContain('an');
  });

  it('submits the picked mention as a token and clears the field', async () => {
    const user = userEvent.setup();
    const { field, onSubmit } = mount();
    await user.type(field, '@bo');
    await user.keyboard('{Enter}');
    expect(field).toHaveValue('@Bob Stone ');
    await user.type(field, 'please look');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onSubmit).toHaveBeenCalledWith({
      body: `@[${BOB}] please look`,
      mentions: [{ id: BOB, name: 'Bob Stone' }],
    });
    await waitFor(() => expect(field).toHaveValue(''));
  });

  it('moves through the list with the arrow keys', async () => {
    const user = userEvent.setup();
    const { field } = mount();
    await user.type(field, '@');
    await screen.findAllByRole('option');
    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(field).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);
    await user.keyboard('{Enter}');
    expect(field).toHaveValue('@Bob Stone ');
  });

  it('closes the list on Escape without leaving the field', async () => {
    const user = userEvent.setup();
    const { field } = mount();
    await user.type(field, '@a');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(field).toHaveFocus();
  });

  it('keeps text that merely looks like a mention as text', async () => {
    const user = userEvent.setup();
    const { field, onSubmit } = mount();
    await user.type(field, 'cc @Ann Lee');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onSubmit).toHaveBeenCalledWith({ body: 'cc @Ann Lee', mentions: [] });
  });

  it('will not send an empty comment, and says why', async () => {
    const user = userEvent.setup();
    const { field, onSubmit } = mount();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    await user.type(field, '   ');
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Write something first');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a comment over the length limit', async () => {
    const user = userEvent.setup();
    const { field, onSubmit } = mount();
    await user.click(field);
    await user.paste('x'.repeat(4001));
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 4000');
    expect(screen.getByText('4001 / 4000')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const { field, onSubmit } = mount();
    await user.type(field, 'quick one');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledWith({ body: 'quick one', mentions: [] });
  });

  it('brings the text back when the comment could not be saved', async () => {
    const user = userEvent.setup();
    const { field } = mount(vi.fn().mockResolvedValue(false));
    await user.type(field, 'do not lose me');
    await user.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(field).toHaveValue('do not lose me'));
  });
});
