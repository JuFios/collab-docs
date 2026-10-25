-- CRDT storage (spec §5): the update log, the compacted state and the version snapshots.
-- Plain Prisma output; no hand-written objects. `update_hash` + the unique index make a retried flush idempotent,
-- (document_id, id) serves "the tail after the compacted state" in id order.
-- CreateEnum
CREATE TYPE "document_version_kind" AS ENUM ('AUTO', 'MANUAL', 'PRE_RESTORE');

-- CreateTable
CREATE TABLE "document_updates" (
    "id" BIGSERIAL NOT NULL,
    "document_id" UUID NOT NULL,
    "update" BYTEA NOT NULL,
    "update_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_states" (
    "document_id" UUID NOT NULL,
    "state" BYTEA NOT NULL,
    "last_update_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_states_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "state" BYTEA NOT NULL,
    "kind" "document_version_kind" NOT NULL,
    "label" TEXT,
    "title" TEXT NOT NULL,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_updates_document_id_id_idx" ON "document_updates"("document_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_updates_document_id_update_hash_key" ON "document_updates"("document_id", "update_hash");

-- CreateIndex
CREATE INDEX "document_versions_document_id_created_at_idx" ON "document_versions"("document_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "document_updates" ADD CONSTRAINT "document_updates_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_states" ADD CONSTRAINT "document_states_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

