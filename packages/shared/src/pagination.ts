import { z } from 'zod';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const idParamSchema = z.object({ id: z.string().uuid() });
export type IdParam = z.infer<typeof idParamSchema>;

/** Builds the schema of a paginated list response around an item schema. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  });
}

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.record(z.string(), z.enum(['up', 'down'])),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
