import { Test } from '@nestjs/testing';
import * as Y from 'yjs';
import { DocumentStateReader } from '@collab-docs/db';
import { REDIS_CLIENT, getLoggerToken } from '@collab-docs/nest';
import { PrismaService } from '../prisma/prisma.service';
import { CommentBlocksService } from './comment-blocks.service';

const DOCUMENT = '0190b1c2-0000-7000-8000-0000000000d1';

/** A stored document with one paragraph whose block id is `p1`. */
function storedDoc(): Y.Doc {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.setAttribute('id', 'p1');
  paragraph.insert(0, [new Y.XmlText('hello')]);
  doc.getXmlFragment('content').insert(0, [paragraph]);
  return doc;
}

async function setup() {
  const store = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
  const prisma = {
    document: { findUnique: jest.fn().mockResolvedValue({ revision: 7n }) },
  };
  const reader = { readDoc: jest.fn(async () => storedDoc()) };
  const logger = { warn: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      CommentBlocksService,
      { provide: PrismaService, useValue: prisma },
      { provide: DocumentStateReader, useValue: reader },
      { provide: REDIS_CLIENT, useValue: redis },
      { provide: getLoggerToken(CommentBlocksService.name), useValue: logger },
    ],
  }).compile();
  return { service: moduleRef.get(CommentBlocksService), redis, prisma, reader, logger, store };
}

describe('CommentBlocksService', () => {
  it('reads the document once per revision and serves the cached ids after that', async () => {
    const { service, reader, store } = await setup();
    expect(await service.of(DOCUMENT)).toEqual(new Set(['p1']));
    expect(await service.of(DOCUMENT)).toEqual(new Set(['p1']));
    expect(reader.readDoc).toHaveBeenCalledTimes(1);
    expect([...store.keys()]).toEqual([`comment-blocks:${DOCUMENT}:7`]);
  });

  it('reads the document again after a change bumped its revision', async () => {
    const { service, reader, prisma } = await setup();
    await service.of(DOCUMENT);
    prisma.document.findUnique.mockResolvedValue({ revision: 8n });
    await service.of(DOCUMENT);
    expect(reader.readDoc).toHaveBeenCalledTimes(2);
  });

  it('still answers when Redis is unavailable', async () => {
    const { service, redis, logger } = await setup();
    redis.get.mockRejectedValue(new Error('redis is down'));
    redis.set.mockRejectedValue(new Error('redis is down'));
    expect(await service.of(DOCUMENT)).toEqual(new Set(['p1']));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('answers null, and caches nothing, when the document cannot be read', async () => {
    const { service, reader, store } = await setup();
    reader.readDoc.mockRejectedValue(new Error('corrupt'));
    expect(await service.of(DOCUMENT)).toBeNull();
    expect(store.size).toBe(0);
  });
});
