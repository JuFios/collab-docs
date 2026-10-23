import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { jwtRoundTrip } from '@collab-docs/shared';
import request from 'supertest';
import { AppModule } from './app.module';

describe('health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });
  });

  it('loads @collab-docs/shared and its ESM-only jose dependency', async () => {
    await expect(jwtRoundTrip('user-1')).resolves.toBe('user-1');
  });
});
