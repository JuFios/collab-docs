import { describe, expect, it } from 'vitest';
import {
  createDocumentInputSchema,
  moveDocumentInputSchema,
  trashItemListSchema,
  treeNodeListSchema,
} from './documents';

const uuid = '0198a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';

describe('document schemas', () => {
  it('accepts the tree the api returns and rejects an unknown access level', () => {
    const node = {
      id: uuid,
      parentId: null,
      title: 'Plan',
      icon: null,
      position: 'a0',
      visibility: 'WORKSPACE',
      myAccess: 'EDIT',
    };
    expect(treeNodeListSchema.safeParse([node]).success).toBe(true);
    expect(treeNodeListSchema.safeParse([{ ...node, myAccess: 'NONE' }]).success).toBe(false);
  });

  it('parses trash items', () => {
    const item = {
      id: uuid,
      title: 'Old',
      icon: '🗑',
      deletedAt: '2026-10-23T10:00:00Z',
      documentCount: 3,
      canRestore: false,
    };
    expect(trashItemListSchema.parse([item])).toEqual([item]);
  });

  it('trims titles and enforces the api length limit', () => {
    expect(createDocumentInputSchema.parse({ title: '  Notes  ' }).title).toBe('Notes');
    expect(createDocumentInputSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('allows a move to the root and rejects a malformed parent', () => {
    expect(moveDocumentInputSchema.safeParse({ parentId: null }).success).toBe(true);
    expect(moveDocumentInputSchema.safeParse({ parentId: 'nope' }).success).toBe(false);
  });
});
