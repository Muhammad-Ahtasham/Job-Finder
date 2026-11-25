-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('COMPANIES', 'JOBS');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "type" "ExportType" NOT NULL,
    "format" "ExportFormat" NOT NULL,
    "scope" TEXT NOT NULL,
    "project_id" UUID,
    "project_name" TEXT,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "rows_total" INTEGER,
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER,
    "file_name" TEXT,
    "storage_key" TEXT,
    "size_bytes" INTEGER,
    "checksum" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exports_workspace_id_created_at_idx" ON "exports"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "exports_status_created_at_idx" ON "exports"("status", "created_at");

-- CreateIndex
CREATE INDEX "exports_expires_at_idx" ON "exports"("expires_at");

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

