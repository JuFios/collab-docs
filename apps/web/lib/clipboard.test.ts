// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const execCommand = vi.fn<(command: string) => boolean>();

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  vi.clearAllMocks();
  setClipboard(undefined);
  document.body.innerHTML = '';
});

describe('copyText', () => {
  it('uses the Clipboard API where there is one', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    await expect(copyText('https://example.test/a')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('https://example.test/a');
  });

  it('copies from a selected field where the API is missing', async () => {
    setClipboard(undefined);
    document.execCommand = execCommand;
    execCommand.mockImplementation(() => {
      const field = document.querySelector('textarea');
      expect(field?.value).toBe('plain http');
      return true;
    });
    await expect(copyText('plain http')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the API refuses', async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('denied'))) });
    document.execCommand = execCommand;
    execCommand.mockReturnValue(true);
    await expect(copyText('x')).resolves.toBe(true);
  });

  it('reports a failure when nothing can copy', async () => {
    setClipboard(undefined);
    document.execCommand = execCommand;
    execCommand.mockReturnValue(false);
    await expect(copyText('x')).resolves.toBe(false);
  });

  it('keeps the copy field inside an open dialog, which holds focus', async () => {
    setClipboard(undefined);
    document.body.innerHTML = '<div role="dialog"><button id="b">Copy</button></div>';
    document.querySelector<HTMLButtonElement>('#b')?.focus();
    document.execCommand = execCommand;
    execCommand.mockImplementation(() => {
      expect(document.querySelector('[role="dialog"] textarea')).not.toBeNull();
      return true;
    });
    await expect(copyText('x')).resolves.toBe(true);
    expect(document.activeElement?.id).toBe('b');
  });
});
