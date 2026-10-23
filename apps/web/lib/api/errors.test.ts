import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { ApiError, parseBody, toApiError } from './errors';

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('toApiError', () => {
  it('maps the platform error format', async () => {
    const error = await toApiError(
      json(
        { statusCode: 403, code: 'PLAN_LIMIT_EXCEEDED', message: 'Limit', correlationId: 'c-1' },
        403,
      ),
    );
    expect(error).toMatchObject({
      status: 403,
      code: 'PLAN_LIMIT_EXCEEDED',
      message: 'Limit',
      correlationId: 'c-1',
    });
  });

  it('exposes validation messages per field', async () => {
    const error = await toApiError(
      json(
        {
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details: [{ field: 'email', messages: ['must be an email'] }],
          correlationId: 'c-2',
        },
        400,
      ),
    );
    expect(error.fieldErrors).toEqual({ email: ['must be an email'] });
  });

  it('survives bodies that are not JSON, keeping the correlation header', async () => {
    const error = await toApiError(
      new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'x-correlation-id': 'c-3' },
      }),
    );
    expect(error).toMatchObject({ status: 502, code: 'INTERNAL_ERROR', correlationId: 'c-3' });
  });
});

describe('parseBody', () => {
  it('returns typed data or throws INVALID_RESPONSE', () => {
    const schema = z.object({ id: z.string() });
    expect(parseBody(schema, { id: 'x' })).toEqual({ id: 'x' });
    expect(() => parseBody(schema, { id: 1 }, 'c-4')).toThrow(ApiError);
    try {
      parseBody(schema, null, 'c-4');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE', correlationId: 'c-4' });
    }
  });
});
