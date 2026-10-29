import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_QUERY_MAX_LENGTH,
} from '@collab-docs/shared';
import { decodeCursor } from './search-cursor';

/** A cursor ends up in the statement, so only one this module issued is accepted. */
@ValidatorConstraint({ name: 'searchCursor', async: false })
class SearchCursorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && decodeCursor(value) !== null;
  }

  defaultMessage(): string {
    return 'cursor is not valid';
  }
}

export class SearchQueryDto {
  @ApiPropertyOptional({
    maxLength: SEARCH_QUERY_MAX_LENGTH,
    description:
      'Words to look for (at most 8), each matched as the start of a word. Anything but letters and digits separates ' +
      'words. An empty query returns an empty page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_QUERY_MAX_LENGTH)
  q: string = '';

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: SEARCH_MAX_LIMIT,
    default: SEARCH_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  limit: number = SEARCH_DEFAULT_LIMIT;

  @ApiPropertyOptional({
    description: '`nextCursor` of the previous page; valid for the same `q` only.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Validate(SearchCursorConstraint)
  cursor?: string;
}

class SnippetPartResponse {
  @ApiProperty() text!: string;
  @ApiProperty({ description: 'The part matches the query (to be highlighted)' }) match!: boolean;
}

class SearchResultResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: [SnippetPartResponse], description: 'Plain text parts, never markup' })
  snippet!: SnippetPartResponse[];
  @ApiProperty() updatedAt!: string;
}

export class SearchPageResponse {
  @ApiProperty({ type: [SearchResultResponse] }) items!: SearchResultResponse[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Pass as `cursor` to get the next page',
  })
  nextCursor!: string | null;
}
