import { Injectable } from '@nestjs/common';
import { Prisma } from '@collab-docs/db';
import {
  SNIPPET_MATCH_END,
  SNIPPET_MATCH_START,
  type SearchPage,
  parseSnippet,
  tokenizeSearchQuery,
} from '@collab-docs/shared';
import { viewableDocumentSql } from '../permissions/document-access-sql';
import { PrismaService } from '../prisma/prisma.service';
import { type SearchCursor, decodeCursor, encodeCursor } from './search-cursor';
import type { SearchQueryDto } from './search.dto';

/**
 * `ts_headline` options. The delimiters are control characters that the index never contains (see
 * `plainSearchText`), so a snippet is split on them and the rest is plain text, never markup.
 */
const HEADLINE_OPTIONS = [
  `StartSel=${SNIPPET_MATCH_START}`,
  `StopSel=${SNIPPET_MATCH_END}`,
  'MaxFragments=2',
  'MaxWords=18',
  'MinWords=8',
  'FragmentDelimiter=" … "',
].join(', ');

/** Characters with a meaning in the `tsquery` syntax; accent folding can in principle produce some of them. */
const TSQUERY_SYNTAX = String.raw`[\s&|!():*<>'\\]`;

interface SearchRow {
  id: string;
  title: string;
  updated_at: Date;
  rank: string;
  headline: string | null;
}

/**
 * Full-text search of one workspace (spec §7). The index holds no permissions: the access rules (resolver, spec §4)
 * are part of this one statement, evaluated when the request is made, so a revoked share or a deleted document
 * stops matching at once, however far the index lags behind.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(userId: string, workspaceId: string, dto: SearchQueryDto): Promise<SearchPage> {
    // the DTO has validated it
    const cursor = dto.cursor === undefined ? null : decodeCursor(dto.cursor);
    const tokens = tokenizeSearchQuery(dto.q);
    if (tokens.length === 0) return { items: [], nextCursor: null };

    const rows = await this.query(userId, workspaceId, tokens, dto.limit + 1, cursor);
    const page = rows.slice(0, dto.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        title: row.title,
        snippet: parseSnippet(row.headline ?? ''),
        updatedAt: row.updated_at.toISOString(),
      })),
      nextCursor:
        rows.length > dto.limit && last ? encodeCursor({ rank: last.rank, id: last.id }) : null,
    };
  }

  private query(
    userId: string,
    workspaceId: string,
    tokens: string[],
    limit: number,
    cursor: SearchCursor | null,
  ): Promise<SearchRow[]> {
    return this.prisma.$queryRaw<SearchRow[]>(
      buildSearchStatement({ userId, workspaceId, tokens, limit, cursor }),
    );
  }
}

/**
 * Every value reaches Postgres as a bound parameter (`Prisma.sql`); nothing is concatenated into the statement.
 * The words go through the same `cd_unaccent` as the indexed text; each becomes a prefix term, all of them are
 * required. Exported for the plan check in the tests.
 */
export function buildSearchStatement(args: {
  userId: string;
  workspaceId: string;
  tokens: string[];
  limit: number;
  cursor: SearchCursor | null;
}): Prisma.Sql {
  const { userId, workspaceId, tokens, limit, cursor } = args;
  const after = cursor
    ? Prisma.sql`WHERE (hits.rank, hits.id) < (${cursor.rank}::float4, ${cursor.id}::uuid)`
    : Prisma.empty;
  const tsquery = searchTsquery(tokens);
  return Prisma.sql`
      WITH hits AS (
        SELECT d.id,
               d.title,
               ts_rank_cd(ds.tsv, ${tsquery}) AS rank,
               GREATEST(d.updated_at, d.content_updated_at) AS updated_at
        FROM document_search ds
        JOIN documents d ON d.id = ds.document_id
        JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = ${userId}::uuid
        WHERE ds.workspace_id = ${workspaceId}::uuid
          AND ds.tsv @@ ${tsquery}
          AND d.workspace_id = ds.workspace_id
          AND ${viewableDocumentSql(Prisma.sql`${userId}::uuid`)}
      ),
      page AS (
        SELECT * FROM hits ${after} ORDER BY hits.rank DESC, hits.id DESC LIMIT ${limit}
      )
      SELECT page.id,
             page.title,
             page.updated_at,
             page.rank::text AS rank,
             ts_headline('cd_headline', ds.body, ${tsquery}, ${HEADLINE_OPTIONS}) AS headline
      FROM page
      JOIN document_search ds ON ds.document_id = page.id
      ORDER BY page.rank DESC, page.id DESC`;
}

/**
 * One prefix term per word, ANDed. The words are bound parameters wrapped in immutable/stable functions only, so
 * Postgres evaluates the whole tsquery while planning (and can use the GIN index with it). A word that folds to
 * nothing makes the query NULL, which matches nothing. Exported for the plan check in the tests.
 */
export function searchTsquery(tokens: string[]): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(
    tokens.map(
      (token) =>
        Prisma.sql`to_tsquery('simple', NULLIF(regexp_replace(cd_unaccent(${token}), ${TSQUERY_SYNTAX}, '', 'g'), '') || ':*')`,
    ),
    ' && ',
  )})`;
}
