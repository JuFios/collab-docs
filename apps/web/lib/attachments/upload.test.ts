// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { request: (...args: unknown[]) => request(...args) },
}));

import { uploadAttachment, validateImageFile } from './upload';

const png = (name = 'pixel.png', bytes = 4) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

/** Stands in for the browser's `XMLHttpRequest`; the test decides how the "bucket" answers. */
class FakeXhr {
  static last: FakeXhr | null = null;
  static answer: { status: number } | 'network-error' = { status: 204 };
  upload: {
    onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void;
  } = {};
  status = 0;
  onload?: () => void;
  onerror?: () => void;
  method = '';
  url = '';
  body: FormData | null = null;

  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    queueMicrotask(() => {
      if (FakeXhr.answer === 'network-error') return this.onerror?.();
      this.status = FakeXhr.answer.status;
      this.onload?.();
    });
  }
}

beforeEach(() => {
  FakeXhr.last = null;
  FakeXhr.answer = { status: 204 };
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  request.mockImplementation((path: string) =>
    Promise.resolve(
      path.endsWith('/presign')
        ? {
            attachmentId: 'att-1',
            url: 'http://bucket.test/upload',
            fields: { key: 'k', policy: 'p' },
          }
        : { id: 'att-1' },
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  request.mockReset();
});

describe('validateImageFile', () => {
  it('accepts an image whose name matches its type', () => {
    expect(validateImageFile(png())).toBe('image/png');
  });

  it('refuses a type that is not an image, before any request', () => {
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    expect(() => validateImageFile(file)).toThrow(/Only PNG, JPEG, WebP or GIF/);
  });

  it('refuses a name that contradicts the type', () => {
    expect(() => validateImageFile(png('pixel.exe'))).toThrow(/Only PNG/);
  });

  it('refuses an empty file', () => {
    expect(() => validateImageFile(png('empty.png', 0))).toThrow('The file is empty.');
  });
});

describe('uploadAttachment', () => {
  it('presigns, posts the policy fields before the file, then completes', async () => {
    const progress = vi.fn();
    await expect(uploadAttachment('doc-1', png(), progress)).resolves.toBe('att-1');

    expect(request).toHaveBeenNthCalledWith(
      1,
      '/documents/doc-1/attachments/presign',
      expect.objectContaining({
        method: 'POST',
        body: { filename: 'pixel.png', mime: 'image/png', size: 4 },
      }),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      '/attachments/att-1/complete',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(FakeXhr.last?.method).toBe('POST');
    expect(FakeXhr.last?.url).toBe('http://bucket.test/upload');
    // the bucket reads the policy fields first and the file last
    expect([...(FakeXhr.last?.body?.keys() ?? [])]).toEqual(['key', 'policy', 'file']);
    expect(progress).toHaveBeenCalledWith(0.5);
  });

  it('never asks the server about a file it refused itself', async () => {
    await expect(
      uploadAttachment('doc-1', new File(['x'], 'a.txt', { type: 'text/plain' })),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('reports a bucket that says the file is too large as 413, and does not complete', async () => {
    FakeXhr.answer = { status: 413 };
    await expect(uploadAttachment('doc-1', png())).rejects.toMatchObject({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports any other refusal of the bucket as a validation error', async () => {
    FakeXhr.answer = { status: 403 };
    await expect(uploadAttachment('doc-1', png())).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports an unreachable bucket as a network error', async () => {
    FakeXhr.answer = 'network-error';
    await expect(uploadAttachment('doc-1', png())).rejects.toMatchObject({
      status: 503,
      code: 'NETWORK_ERROR',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
