import { ArgumentMetadata } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ValidationFailedException } from './exceptions';
import { PaginationQueryDto, ParseUuidPipe, createValidationPipe } from './validation';

class Dto {
  @IsString()
  @Length(2, 5)
  name!: string;
}

const body: ArgumentMetadata = { type: 'body', metatype: Dto };

describe('validation', () => {
  const pipe = createValidationPipe();

  it('rejects properties that are not in the DTO', async () => {
    await expect(pipe.transform({ name: 'ok', admin: true }, body)).rejects.toBeInstanceOf(
      ValidationFailedException,
    );
  });

  it('reports every failing field', async () => {
    const error = await pipe
      .transform({ name: 'x' }, body)
      .catch((e: ValidationFailedException) => e);
    expect(error).toBeInstanceOf(ValidationFailedException);
    expect((error as ValidationFailedException).details).toEqual([
      { field: 'name', messages: [expect.stringContaining('longer than')] },
    ]);
  });

  it('transforms plain objects into DTO instances', async () => {
    expect(await pipe.transform({ name: 'ok' }, body)).toBeInstanceOf(Dto);
  });

  it('coerces pagination query strings and applies defaults', async () => {
    const meta: ArgumentMetadata = { type: 'query', metatype: PaginationQueryDto };
    expect(await pipe.transform({ page: '3', pageSize: '10' }, meta)).toMatchObject({
      page: 3,
      pageSize: 10,
    });
    expect(await pipe.transform({}, meta)).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('ParseUuidPipe throws VALIDATION_FAILED', async () => {
    const uuidPipe = new ParseUuidPipe();
    await expect(uuidPipe.transform('nope', { type: 'param' })).rejects.toBeInstanceOf(
      ValidationFailedException,
    );
    await expect(
      uuidPipe.transform('0190b1c2-0000-7000-8000-000000000001', { type: 'param' }),
    ).resolves.toBe('0190b1c2-0000-7000-8000-000000000001');
  });
});
