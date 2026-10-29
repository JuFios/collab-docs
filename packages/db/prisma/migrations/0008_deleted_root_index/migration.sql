-- CreateIndex: the trash counts each deletion's documents and restore finds them by `deleted_root_id`; live
-- documents leave it NULL, so only the trash is indexed
CREATE INDEX "documents_deleted_root_id_idx" ON "documents"("deleted_root_id") WHERE "deleted_root_id" IS NOT NULL;
