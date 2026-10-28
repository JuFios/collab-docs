import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule, getSchemaPath } from '@nestjs/swagger';
import { ErrorResponse } from '@collab-docs/nest';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

const errorBody = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: getSchemaPath(ErrorResponse) } } },
});

/**
 * Every operation can fail with the error body of the global filter, and every secured one with 401. Nest has no
 * document-wide way to declare that (only a decorator per handler), so it is added here instead of repeating the
 * same two decorators on all handlers; a handler that documents a status itself keeps its own description.
 */
function documentErrorResponses(document: OpenAPIObject): void {
  for (const item of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      operation.responses['default'] ??= errorBody('Error; see `code` for the reason');
      if (operation.security?.length) {
        operation.responses['401'] ??= errorBody('UNAUTHENTICATED or TOKEN_EXPIRED');
      }
    }
  }
}

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
  const document = SwaggerModule.createDocument(app, config, { extraModels: [ErrorResponse] });
  documentErrorResponses(document);
  return document;
}

/** Serves Swagger UI at `/docs` (outside the `/api` prefix) and the raw document at `/docs/json`. */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/json' });
  return document;
}
