import type { Type } from '@nestjs/common';
import { createValidationPipe } from '@collab-docs/nest';
import {
  ATTACHMENT_FILENAME_MAX_LENGTH,
  COMMENT_BODY_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  VERSION_LABEL_MAX_LENGTH,
  WORKSPACE_NAME_MAX_LENGTH,
  createCommentInputSchema,
  createDocumentInputSchema,
  createPublicLinkInputSchema,
  createThreadInputSchema,
  createVersionInputSchema,
  createWorkspaceInputSchema,
  inviteInputSchema,
  loginInputSchema,
  moveDocumentInputSchema,
  presignAttachmentInputSchema,
  registerInputSchema,
  renameWorkspaceInputSchema,
  updatePublicLinkInputSchema,
} from '@collab-docs/shared';
import { LoginDto, RegisterDto } from './auth/auth.dto';
import { PresignAttachmentDto } from './attachments/attachments.dto';
import { CreateCommentDto, CreateThreadDto } from './comments/comments.dto';
import { CreateDocumentDto, MoveDocumentDto } from './documents/documents.dto';
import { CreatePublicLinkDto, UpdatePublicLinkDto } from './publishing/public-links.dto';
import { CreateVersionDto } from './versions/versions.dto';
import {
  CreateInviteDto,
  CreateWorkspaceDto,
  UpdateWorkspaceDto,
} from './workspaces/workspaces.dto';

/**
 * The web client validates forms with the zod schemas of `@collab-docs/shared` and the api validates the same
 * payloads with class-validator DTOs. Both have to give the same verdict (and the same normalised value), or a
 * form would accept what the api refuses, or the other way round.
 */

const UUID = '0190b1c2-0000-7000-8000-0000000000aa';
const pipe = createValidationPipe();

/** What the tests use of a zod schema (api has no direct dependency on zod). */
interface Schema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

type Verdict = { ok: true; value: unknown } | { ok: false };

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

async function viaDto(metatype: Type, payload: unknown): Promise<Verdict> {
  try {
    return { ok: true, value: plain(await pipe.transform(payload, { type: 'body', metatype })) };
  } catch {
    return { ok: false };
  }
}

function viaZod(schema: Schema, payload: unknown): Verdict {
  const result = schema.safeParse(payload);
  return result.success ? { ok: true, value: plain(result.data) } : { ok: false };
}

const text = (length: number, char = 'a') => char.repeat(length);

interface Pair {
  name: string;
  dto: Type;
  schema: Schema;
  /** A valid payload; the cases below change one field of it. */
  base: Record<string, unknown>;
  cases: Array<[label: string, change: Record<string, unknown>]>;
}

const pairs: Pair[] = [
  {
    name: 'register',
    dto: RegisterDto,
    schema: registerInputSchema,
    base: { email: 'ada@example.test', password: text(PASSWORD_MIN_LENGTH), name: 'Ada' },
    cases: [
      ['a valid payload', {}],
      ['an address with capitals and spaces', { email: '  Ada@Example.TEST ' }],
      ['an address without a domain', { email: 'ada' }],
      ['an address over 254 characters', { email: `${text(250)}@e.test` }],
      ['a password one short', { password: text(PASSWORD_MIN_LENGTH - 1) }],
      ['a password at the maximum', { password: text(PASSWORD_MAX_LENGTH) }],
      ['a password over the maximum', { password: text(PASSWORD_MAX_LENGTH + 1) }],
      ['a password that is not text', { password: 1234567890 }],
      ['a name with spaces around it', { name: '  Ada  ' }],
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['a name of 100 characters', { name: text(100) }],
      ['a name of 101 characters', { name: text(101) }],
      ['a missing name', { name: undefined }],
    ],
  },
  {
    name: 'login',
    dto: LoginDto,
    schema: loginInputSchema,
    base: { email: 'ada@example.test', password: 'whatever' },
    cases: [
      ['a valid payload', {}],
      ['an address with capitals and spaces', { email: ' ADA@example.test ' }],
      ['an invalid address', { email: 'not an address' }],
      ['an empty password', { password: '' }],
      ['a password at the maximum', { password: text(PASSWORD_MAX_LENGTH) }],
      ['a password over the maximum', { password: text(PASSWORD_MAX_LENGTH + 1) }],
      ['a missing password', { password: undefined }],
    ],
  },
  ...[
    ['create workspace', CreateWorkspaceDto, createWorkspaceInputSchema] as const,
    ['rename workspace', UpdateWorkspaceDto, renameWorkspaceInputSchema] as const,
  ].map(([name, dto, schema]): Pair => ({
    name,
    dto,
    schema,
    base: { name: 'Acme' },
    cases: [
      ['a valid name', {}],
      ['a name with spaces around it', { name: '  Acme  ' }],
      ['an empty name', { name: '' }],
      ['a blank name', { name: '   ' }],
      ['the longest name', { name: text(WORKSPACE_NAME_MAX_LENGTH) }],
      ['a name one too long', { name: text(WORKSPACE_NAME_MAX_LENGTH + 1) }],
      ['a name that is not text', { name: 42 }],
    ],
  })),
  {
    name: 'invite',
    dto: CreateInviteDto,
    schema: inviteInputSchema,
    base: { email: 'grace@example.test', role: 'EDITOR' },
    cases: [
      ['a valid invite', {}],
      ['an address with capitals and spaces', { email: ' Grace@Example.test ' }],
      ['an invalid address', { email: 'grace@' }],
      ['an admin role', { role: 'ADMIN' }],
      ['a viewer role', { role: 'VIEWER' }],
      ['the owner role', { role: 'OWNER' }],
      ['an unknown role', { role: 'ROOT' }],
      ['a missing role', { role: undefined }],
    ],
  },
  {
    name: 'create document',
    dto: CreateDocumentDto,
    schema: createDocumentInputSchema,
    base: { title: 'Notes' },
    cases: [
      ['a title only', {}],
      ['a parent', { parentId: UUID }],
      ['a parent that is not a uuid', { parentId: 'nope' }],
      ['a null parent', { parentId: null }],
      ['an empty title', { title: '' }],
      ['a title with spaces around it', { title: '  Notes  ' }],
      ['the longest title', { title: text(DOCUMENT_TITLE_MAX_LENGTH) }],
      ['a title one too long', { title: text(DOCUMENT_TITLE_MAX_LENGTH + 1) }],
      ['a missing title', { title: undefined }],
    ],
  },
  {
    name: 'move document',
    dto: MoveDocumentDto,
    schema: moveDocumentInputSchema,
    base: { parentId: UUID },
    cases: [
      ['a parent', {}],
      ['the root', { parentId: null }],
      ['a missing parent', { parentId: undefined }],
      ['a parent that is not a uuid', { parentId: 'nope' }],
      ['a sibling before', { beforeId: UUID }],
      ['a sibling after', { afterId: UUID }],
      ['a sibling that is not a uuid', { beforeId: 'nope' }],
      ['a null sibling before', { beforeId: null }],
      ['a null sibling after', { afterId: null }],
    ],
  },
  {
    name: 'create version',
    dto: CreateVersionDto,
    schema: createVersionInputSchema,
    base: {},
    cases: [
      ['no label', {}],
      ['a label', { label: 'Before the review' }],
      ['a label with spaces around it', { label: '  Before  ' }],
      ['a blank label', { label: '   ' }],
      ['the longest label', { label: text(VERSION_LABEL_MAX_LENGTH) }],
      ['a label one too long', { label: text(VERSION_LABEL_MAX_LENGTH + 1) }],
      ['a label that is not text', { label: 7 }],
    ],
  },
  {
    name: 'presign attachment',
    dto: PresignAttachmentDto,
    schema: presignAttachmentInputSchema,
    base: { filename: 'photo.png', mime: 'image/png', size: 1024 },
    cases: [
      ['a valid upload', {}],
      ['a file name with spaces around it', { filename: '  photo.png  ' }],
      ['an empty file name', { filename: '' }],
      ['the longest file name', { filename: text(ATTACHMENT_FILENAME_MAX_LENGTH) }],
      ['a file name one too long', { filename: text(ATTACHMENT_FILENAME_MAX_LENGTH + 1) }],
      ['a jpeg', { mime: 'image/jpeg', filename: 'photo.jpg' }],
      ['an svg', { mime: 'image/svg+xml' }],
      ['an unknown type', { mime: 'application/pdf' }],
      ['one byte', { size: 1 }],
      ['zero bytes', { size: 0 }],
      ['a negative size', { size: -5 }],
      ['a fractional size', { size: 1.5 }],
      ['a size as text', { size: '1024' }],
    ],
  },
  {
    name: 'create public link',
    dto: CreatePublicLinkDto,
    schema: createPublicLinkInputSchema,
    base: { mode: 'VIEW' },
    cases: [
      ['a view link without expiry', {}],
      ['an edit link', { mode: 'EDIT' }],
      ['an unknown mode', { mode: 'COMMENT' }],
      ['a lower-case mode', { mode: 'view' }],
      ['no mode', { mode: undefined }],
      ['an expiry in UTC', { expiresAt: '2030-01-31T12:00:00Z' }],
      ['an expiry with milliseconds', { expiresAt: '2030-01-31T12:00:00.250Z' }],
      ['an expiry with an offset', { expiresAt: '2030-01-31T12:00:00+02:00' }],
      ['a null expiry', { expiresAt: null }],
      ['a date without a time', { expiresAt: '2030-01-31' }],
      ['an expiry without a zone', { expiresAt: '2030-01-31T12:00:00' }],
      ['an expiry that is not text', { expiresAt: 1893499200000 }],
      ['free text as expiry', { expiresAt: 'next week' }],
    ],
  },
  {
    name: 'update public link',
    dto: UpdatePublicLinkDto,
    schema: updatePublicLinkInputSchema,
    base: { expiresAt: '2030-01-31T12:00:00Z' },
    cases: [
      ['a new expiry', {}],
      ['no expiry any more', { expiresAt: null }],
      ['a missing expiry', { expiresAt: undefined }],
      ['a date without a time', { expiresAt: '2030-01-31' }],
      ['an expiry that is not text', { expiresAt: 5 }],
    ],
  },
  {
    name: 'create comment',
    dto: CreateCommentDto,
    schema: createCommentInputSchema,
    base: { body: 'Looks good' },
    cases: [
      ['a valid comment', {}],
      ['a comment with spaces around it', { body: '  Looks good \n' }],
      ['a mention', { body: 'cc @[0198d6c0-0000-7000-8000-00000000000a]' }],
      ['an empty body', { body: '' }],
      ['a blank body', { body: ' \n\t ' }],
      ['a missing body', { body: undefined }],
      ['the longest body', { body: text(COMMENT_BODY_MAX_LENGTH) }],
      ['a body one too long', { body: text(COMMENT_BODY_MAX_LENGTH + 1) }],
      ['a body that is not text', { body: 7 }],
    ],
  },
  {
    name: 'create thread',
    dto: CreateThreadDto,
    schema: createThreadInputSchema,
    base: { blockId: 'block-1', body: 'Why?' },
    cases: [
      ['a valid thread', {}],
      ['a generated id', { blockId: 'a1B2_c3-D4' }],
      ['the longest block id', { blockId: text(64) }],
      ['a block id one too long', { blockId: text(65) }],
      ['an empty block id', { blockId: '' }],
      ['a block id with a space', { blockId: 'a b' }],
      ['a block id with markup', { blockId: '<b>' }],
      ['a block id with a slash', { blockId: 'a/b' }],
      ['a block id that is not text', { blockId: 5 }],
      ['a missing block id', { blockId: undefined }],
      ['a blank body', { body: '  ' }],
    ],
  },
];

describe.each(pairs)('$name: DTO and schema', ({ dto, schema, base, cases }) => {
  it.each(cases)('agree on %s', async (_label, change) => {
    const payload = { ...base, ...change };
    const fromDto = await viaDto(dto, payload);
    const fromZod = viaZod(schema, payload);
    expect(fromDto).toEqual(fromZod);
  });
});
