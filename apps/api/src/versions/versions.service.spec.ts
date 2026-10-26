import { Test } from '@nestjs/testing';
import * as Y from 'yjs';
import { DocumentVersions, MAX_VERSIONS } from '@collab-docs/db';
import { CollabInternalClient } from '../collab/collab-internal.client';
import { VersionsService } from './versions.service';
import { PrismaService } from '../prisma/prisma.service';

const USER = '0190b1c2-0000-7000-8000-000000000001';
const DOCUMENT = '0190b1c2-0000-7000-8000-0000000000dd';
const VERSION = '0190b1c2-0000-7000-8000-0000000000ee';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: VERSION,
  kind: 'MANUAL' as const,
  label: 'before the rewrite',
  title: 'Plan',
  createdAt: new Date('2026-03-01T10:00:00Z'),
  author: { id: USER, name: 'Ada' },
  ...overrides,
});

function docWithParagraph(text: string): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('content').insert(0, [paragraph]);
  return doc;
}

async function setup() {
  const prisma = {
    documentVersion: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(row()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(row()),
      count: jest.fn().mockResolvedValue(1),
    },
  };
  const versions = {
    readDoc: jest.fn().mockResolvedValue(docWithParagraph('hello')),
    countManual: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ id: VERSION }),
  };
  const collab = {
    flush: jest.fn().mockResolvedValue(true),
    restore: jest.fn().mockResolvedValue({ restored: true }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      VersionsService,
      { provide: PrismaService, useValue: prisma },
      { provide: DocumentVersions, useValue: versions },
      { provide: CollabInternalClient, useValue: collab },
    ],
  }).compile();
  return { service: moduleRef.get(VersionsService), prisma, versions, collab };
}

describe('VersionsService', () => {
  describe('list', () => {
    it('reads the document’s versions newest first and presents them without database types', async () => {
      const { service, prisma } = await setup();
      prisma.documentVersion.findMany.mockResolvedValue([row()]);

      const result = await service.list(DOCUMENT);

      expect(prisma.documentVersion.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { documentId: DOCUMENT },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(result).toEqual([
        {
          id: VERSION,
          kind: 'MANUAL',
          label: 'before the rewrite',
          title: 'Plan',
          author: { id: USER, name: 'Ada' },
          createdAt: '2026-03-01T10:00:00.000Z',
        },
      ]);
    });

    it('keeps versions without an author or label', async () => {
      const { service, prisma } = await setup();
      prisma.documentVersion.findMany.mockResolvedValue([
        row({ kind: 'AUTO', label: null, author: null }),
      ]);
      expect((await service.list(DOCUMENT))[0]).toMatchObject({
        kind: 'AUTO',
        label: null,
        author: null,
      });
    });
  });

  describe('get', () => {
    it('is scoped to the document and returns the content as sanitised JSON', async () => {
      const { service, prisma, versions } = await setup();
      const doc = docWithParagraph('hello');
      const destroy = jest.spyOn(doc, 'destroy');
      versions.readDoc.mockResolvedValue(doc);

      const result = await service.get(DOCUMENT, VERSION);

      expect(prisma.documentVersion.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: VERSION, documentId: DOCUMENT } }),
      );
      expect(versions.readDoc).toHaveBeenCalledWith(DOCUMENT, VERSION);
      expect(result.content).toEqual({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
      });
      expect(result).toMatchObject({ id: VERSION, title: 'Plan' });
      expect(destroy).toHaveBeenCalled();
    });

    it('answers NOT_FOUND for a version of another document', async () => {
      const { service, prisma, versions } = await setup();
      prisma.documentVersion.findFirst.mockResolvedValue(null);
      await expect(service.get(DOCUMENT, VERSION)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(versions.readDoc).not.toHaveBeenCalled();
    });

    it('answers NOT_FOUND when the stored state is gone', async () => {
      const { service, versions } = await setup();
      versions.readDoc.mockResolvedValue(null);
      await expect(service.get(DOCUMENT, VERSION)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('createManual', () => {
    it('asks collab to write its buffer before snapshotting, then returns the presented version', async () => {
      const { service, collab, versions } = await setup();
      const order: string[] = [];
      collab.flush.mockImplementation(async () => (order.push('flush'), true));
      versions.create.mockImplementation(async () => (order.push('create'), { id: VERSION }));

      const result = await service.createManual(DOCUMENT, USER, 'before the rewrite');

      expect(order).toEqual(['flush', 'create']);
      expect(versions.create).toHaveBeenCalledWith({
        documentId: DOCUMENT,
        kind: 'MANUAL',
        label: 'before the rewrite',
        createdBy: USER,
      });
      expect(result).toMatchObject({ id: VERSION, label: 'before the rewrite', flushed: true });
    });

    it('stores a missing or empty label as null', async () => {
      const { service, versions } = await setup();
      await service.createManual(DOCUMENT, USER);
      await service.createManual(DOCUMENT, USER, '');
      expect(versions.create.mock.calls.map(([arg]) => arg.label)).toEqual([null, null]);
    });

    it('reports that collab could not flush without failing the snapshot', async () => {
      const { service, collab } = await setup();
      collab.flush.mockResolvedValue(false);
      expect(await service.createManual(DOCUMENT, USER)).toMatchObject({ flushed: false });
    });

    it('refuses the snapshot beyond the saved versions limit', async () => {
      const { service, versions, collab } = await setup();
      versions.countManual.mockResolvedValue(MAX_VERSIONS);
      await expect(service.createManual(DOCUMENT, USER)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect(collab.flush).not.toHaveBeenCalled();
      expect(versions.create).not.toHaveBeenCalled();
    });
  });

  describe('restore', () => {
    it('delegates to collab once the version is known to belong to the document', async () => {
      const { service, prisma, collab } = await setup();

      await expect(service.restore(DOCUMENT, VERSION, USER)).resolves.toEqual({ restored: true });

      expect(prisma.documentVersion.count).toHaveBeenCalledWith({
        where: { id: VERSION, documentId: DOCUMENT },
      });
      expect(collab.restore).toHaveBeenCalledWith(DOCUMENT, VERSION, USER);
    });

    it('answers NOT_FOUND for a version of another document without calling collab', async () => {
      const { service, prisma, collab } = await setup();
      prisma.documentVersion.count.mockResolvedValue(0);
      await expect(service.restore(DOCUMENT, VERSION, USER)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      expect(collab.restore).not.toHaveBeenCalled();
    });
  });
});
