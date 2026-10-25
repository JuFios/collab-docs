import { describe, expect, it } from 'vitest';
import {
  filenameMatchesMime,
  fileExtension,
  presignAttachmentInputSchema,
  sniffImageType,
} from './attachments';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('sniffImageType', () => {
  it('recognises the four allowed formats', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      'image/png',
    );
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('image/jpeg');
    expect(sniffImageType(text('GIF89a\x01\x00'))).toBe('image/gif');
    expect(sniffImageType(text('GIF87a\x01\x00'))).toBe('image/gif');
    expect(sniffImageType(text('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBe('image/webp');
  });

  it('rejects text, SVG, RIFF containers that are not WebP, and short input', () => {
    expect(sniffImageType(text('hello world, not an image'))).toBeNull();
    expect(sniffImageType(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(text('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffImageType(text('RIFF\x24\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe('file names', () => {
  it('reads the extension', () => {
    expect(fileExtension('photo.PNG')).toBe('png');
    expect(fileExtension('archive.tar.gz')).toBe('gz');
    expect(fileExtension('noext')).toBeNull();
    expect(fileExtension('.png')).toBeNull();
    expect(fileExtension('trailing.')).toBeNull();
  });

  it('accepts only extensions that belong to the declared type', () => {
    expect(filenameMatchesMime('a.jpg', 'image/jpeg')).toBe(true);
    expect(filenameMatchesMime('a.JPEG', 'image/jpeg')).toBe(true);
    expect(filenameMatchesMime('a.png', 'image/jpeg')).toBe(false);
    expect(filenameMatchesMime('a.svg', 'image/png')).toBe(false);
    expect(filenameMatchesMime('a', 'image/png')).toBe(false);
  });
});

describe('presignAttachmentInputSchema', () => {
  const valid = { filename: 'a.png', mime: 'image/png', size: 10 };

  it('accepts a valid request', () => {
    expect(presignAttachmentInputSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects SVG, other types, empty or fractional sizes', () => {
    expect(
      presignAttachmentInputSchema.safeParse({ ...valid, mime: 'image/svg+xml' }).success,
    ).toBe(false);
    expect(presignAttachmentInputSchema.safeParse({ ...valid, mime: 'text/plain' }).success).toBe(
      false,
    );
    expect(presignAttachmentInputSchema.safeParse({ ...valid, size: 0 }).success).toBe(false);
    expect(presignAttachmentInputSchema.safeParse({ ...valid, size: 1.5 }).success).toBe(false);
  });
});
