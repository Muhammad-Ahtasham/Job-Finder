-- CreateEnum
CREATE TYPE "JobSourceStatus" AS ENUM ('ACTIVE', 'UNSUPPORTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "JobCheckOutcome" AS ENUM ('JOBS', 'NO_OPENINGS', 'INCONCLUSIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERNSHIP', 'TEMPORARY', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WorkplaceType" AS ENUM ('ONSITE', 'REMOTE', 'HYBRID', 'UNKNOWN');

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "active_key" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "career_pages_found" INTEGER NOT NULL DEFAULT 0,
    "sources_checked" INTEGER NOT NULL DEFAULT 0,
    "jobs_found" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "error_message" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_sources" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "board_key" TEXT NOT NULL,
    "board_url" TEXT NOT NULL,
    "region" TEXT,
    "status" "JobSourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "discovered_from_url" TEXT,
    "discovery_confidence" DOUBLE PRECISION,
    "discovery_evidence" TEXT,
    "last_checked_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_outcome" "JobCheckOutcome",
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "department" TEXT,
    "employment_type" "EmploymentType" NOT NULL DEFAULT 'UNKNOWN',
    "workplace_type" "WorkplaceType" NOT NULL DEFAULT 'UNKNOWN',
    "application_url" TEXT,
    "source_url" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "extraction" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'OPEN',
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "last_check_id" UUID,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_checks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "run_id" UUID,
    "outcome" "JobCheckOutcome" NOT NULL,
    "authoritative" BOOLEAN NOT NULL DEFAULT false,
    "jobs_found" INTEGER NOT NULL DEFAULT 0,
    "jobs_created" INTEGER NOT NULL DEFAULT 0,
    "jobs_updated" INTEGER NOT NULL DEFAULT 0,
    "jobs_closed" INTEGER NOT NULL DEFAULT 0,
    "duplicates_skipped" INTEGER NOT NULL DEFAULT 0,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "retryable" BOOLEAN,
    "http_status" INTEGER,
    "evidence" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "job_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_active_key_key" ON "job_runs"("active_key");

-- CreateIndex
CREATE INDEX "job_runs_company_id_created_at_idx" ON "job_runs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "job_runs_status_created_at_idx" ON "job_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "job_sources_workspace_id_idx" ON "job_sources"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_sources_company_id_provider_id_board_key_key" ON "job_sources"("company_id", "provider_id", "board_key");

-- CreateIndex
CREATE INDEX "jobs_company_id_status_idx" ON "jobs"("company_id", "status");

-- CreateIndex
CREATE INDEX "jobs_company_id_fingerprint_idx" ON "jobs"("company_id", "fingerprint");

-- CreateIndex
CREATE INDEX "jobs_workspace_id_status_first_seen_at_idx" ON "jobs"("workspace_id", "status", "first_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_source_id_external_id_key" ON "jobs"("source_id", "external_id");

-- CreateIndex
CREATE INDEX "job_checks_source_id_started_at_idx" ON "job_checks"("source_id", "started_at");

-- CreateIndex
CREATE INDEX "job_checks_company_id_started_at_idx" ON "job_checks"("company_id", "started_at");

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_sources" ADD CONSTRAINT "job_sources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_checks" ADD CONSTRAINT "job_checks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

