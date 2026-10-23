import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Collab Docs API')
    .setDescription(
      'REST API of the Collab Docs workspace. Document content is edited over WebSocket (CRDT).',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('cd_at', { type: 'apiKey', in: 'cookie', name: 'cd_at' }, 'access-cookie')
    .addCookieAuth('cd_rt', { type: 'apiKey', in: 'cookie', name: 'cd_rt' }, 'refresh-cookie')
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Serves Swagger UI at `/docs` (outside the `/api` prefix) and the raw document at `/docs/json`. */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/json' });
  return document;
}
