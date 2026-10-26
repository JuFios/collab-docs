import { ParseUUIDPipe, ValidationPipe, type ValidationError } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import type { ValidationIssue } from '@collab-docs/shared';
import {
  DEFAULT_PAGE_SIZE,
  type IdParam,
  MAX_PAGE_SIZE,
  type PaginationQuery,
} from '@collab-docs/shared';
import { ValidationFailedException } from './exceptions';

function flatten(errors: ValidationError[], prefix = ''): ValidationIssue[] {
  return errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    const own = error.constraints ? [{ field, messages: Object.values(error.constraints) }] : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => new ValidationFailedException(flatten(errors)),
  });
}

/** `ParseUUIDPipe` that reports failures as `VALIDATION_FAILED`. */
export class ParseUuidPipe extends ParseUUIDPipe {
  constructor() {
    super({
      exceptionFactory: (message) =>
        new ValidationFailedException([{ field: 'id', messages: [String(message)] }]),
    });
  }
}

export class PaginationQueryDto implements PaginationQuery {
  @ApiPropertyOptional({ type: Number, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize = DEFAULT_PAGE_SIZE;
}

export class IdParamDto implements IdParam {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  id!: string;
}
