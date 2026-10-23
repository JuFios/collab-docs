import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '../errors';
import { AppException, ValidationFailedException, toErrorResponse } from './exceptions';

const map = (error: unknown) => apiErrorSchema.parse(toErrorResponse(error, 'corr-12345678'));

describe('toErrorResponse', () => {
  it('maps AppException to its catalog code, message and details', () => {
    const body = map(
      new AppException('PLAN_LIMIT_EXCEEDED', 'Limit reached', { details: { limit: 3 } }),
    );
    expect(body).toEqual({
      statusCode: 402,
      code: 'PLAN_LIMIT_EXCEEDED',
      message: 'Limit reached',
      details: { limit: 3 },
      correlationId: 'corr-12345678',
    });
  });

  it('maps validation failures to 400 VALIDATION_FAILED with per-field details', () => {
    const body = map(new ValidationFailedException([{ field: 'name', messages: ['too short'] }]));
    expect(body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_FAILED',
      details: [{ field: 'name', messages: ['too short'] }],
    });
  });

  it('maps Prisma P2002 to 409 CONFLICT and P2025 to 404 NOT_FOUND', () => {
    const unique = Object.assign(new Error('Unique constraint failed on users_email_key'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['email'] },
    });
    expect(map(unique)).toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: { fields: ['email'] },
    });
    expect(map(unique).message).not.toContain('users_email_key');

    const missing = Object.assign(new Error('Record to update not found.'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2025',
    });
    expect(map(missing)).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('maps ThrottlerException to 429 RATE_LIMITED', () => {
    expect(map(new ThrottlerException())).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });

  it('maps plain HttpExceptions by status', () => {
    expect(map(new NotFoundException('nope'))).toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
      message: 'nope',
    });
    expect(map(new BadRequestException('bad'))).toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
    });
  });

  it('maps body-parser style errors', () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });
    expect(map(tooLarge)).toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  it('never leaks the message of unknown or unmapped errors', () => {
    for (const error of [
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
      'a string',
      null,
      Object.assign(new Error('P2034 deadlock on table secrets'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2034',
      }),
    ]) {
      const body = map(error);
      expect(body).toMatchObject({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      });
      expect(JSON.stringify(body)).not.toMatch(/hunter2|ECONNREFUSED|secrets/);
    }
  });

  it('hides messages of 5xx AppExceptions', () => {
    const body = map(new AppException('SERVICE_UNAVAILABLE', 'redis at 10.0.0.3 is down'));
    expect(body.message).toBe('Service unavailable');
  });
});
