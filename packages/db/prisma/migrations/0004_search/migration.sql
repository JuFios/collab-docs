-- unaccent() is STABLE (its dictionary can change), which Postgres refuses in a generated column or an index
-- expression. The dictionary is pinned here, so the wrapper is declared IMMUTABLE. Hand-written: Prisma cannot
-- express functions. Queries apply the same function to their tokens.
CREATE FUNCTION "cd_unaccent"(input TEXT) RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    RETURN public.unaccent('public.unaccent'::regdictionary, input);

-- CreateTable
-- "tsv" is GENERATED (hand-written; Prisma declares it as an unsupported type): title weighs more than body.
CREATE TABLE "document_search" (
    "document_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tsv" tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', "cd_unaccent"("title")), 'A') ||
        setweight(to_tsvector('simple', "cd_unaccent"("body")), 'B')
    ) STORED,
    "indexed_revision" BIGINT NOT NULL,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_search_pkey" PRIMARY KEY ("document_id")
);

-- CreateIndex
CREATE INDEX "document_search_tsv_idx" ON "document_search" USING GIN ("tsv");

-- CreateIndex
-- operator class written by hand: trigram matching for the title (typo-tolerant search, not wired up yet)
CREATE INDEX "document_search_title_trgm_idx" ON "document_search" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "document_search_workspace_id_idx" ON "document_search"("workspace_id");

-- AddForeignKey
ALTER TABLE "document_search" ADD CONSTRAINT "document_search_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_search" ADD CONSTRAINT "document_search_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Highlighting only (hand-written). tsv and the query already ignore accents through "cd_unaccent"; ts_headline
-- re-reads the original text with a text search configuration, so it needs the same accent folding as a dictionary
-- (the arrangement the unaccent documentation shows) to mark "café" for the query "cafe".
CREATE TEXT SEARCH CONFIGURATION "cd_headline" (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION "cd_headline"
    ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;
