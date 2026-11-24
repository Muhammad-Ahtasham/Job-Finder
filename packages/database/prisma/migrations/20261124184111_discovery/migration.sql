-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('SUCCESS', 'RETRYABLE_ERROR', 'FATAL_ERROR', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FieldStatus" AS ENUM ('MISSING', 'UNVERIFIED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('ACTIVE', 'MERGED');

-- CreateEnum
CREATE TYPE "IdentityType" AS ENUM ('DOMAIN', 'PROVIDER_ID', 'REGISTRATION_NUMBER');

-- CreateEnum
CREATE TYPE "DiscoveryOutcome" AS ENUM ('CREATED', 'MATCHED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'MERGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "search_projects" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "created_by_id" UUID,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'PK',
    "city" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "keywords" TEXT[],
    "target_roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "config" JSONB NOT NULL,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "cancel_requested_at" TIMESTAMP(3),
    "planned_at" TIMESTAMP(3),
    "candidates_found" INTEGER NOT NULL DEFAULT 0,
    "candidates_filtered" INTEGER NOT NULL DEFAULT 0,
    "companies_created" INTEGER NOT NULL DEFAULT 0,
    "companies_matched" INTEGER NOT NULL DEFAULT 0,
    "reviews_created" INTEGER NOT NULL DEFAULT 0,
    "duplicates_skipped" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "search_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_tasks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "query_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "keyword" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "cursor" TEXT,
    "pages_fetched" INTEGER NOT NULL DEFAULT 0,
    "candidates_found" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "last_error_retryable" BOOLEAN,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "discovery_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_task_attempts" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "http_status" INTEGER,
    "retry_after_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "discovery_task_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "name_key" TEXT NOT NULL,
    "core_name" TEXT NOT NULL,
    "name_tokens" TEXT[],
    "core_tokens" TEXT[],
    "country" TEXT NOT NULL,
    "city" TEXT,
    "website" TEXT,
    "domain" TEXT,
    "description" TEXT,
    "website_status" "FieldStatus" NOT NULL DEFAULT 'MISSING',
    "email_status" "FieldStatus" NOT NULL DEFAULT 'MISSING',
    "careers_status" "FieldStatus" NOT NULL DEFAULT 'MISSING',
    "status" "CompanyStatus" NOT NULL DEFAULT 'ACTIVE',
    "merged_into_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_sources" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "external_id" TEXT,
    "source_url" TEXT,
    "raw_name" TEXT NOT NULL,
    "name_confidence" TEXT NOT NULL DEFAULT 'HIGH',
    "matched_keyword" TEXT,
    "raw_data" JSONB,
    "attribution" TEXT,
    "retrieved_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "sightings" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "company_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_locations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "location_key" TEXT NOT NULL,
    "city" TEXT,
    "city_key" TEXT,
    "country" TEXT NOT NULL,
    "address_raw" TEXT,
    "address_tokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "phones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_aliases" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "alias_key" TEXT NOT NULL,
    "source_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_identities" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "type" "IdentityType" NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discovery_results" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "task_id" UUID,
    "company_id" UUID NOT NULL,
    "company_source_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "outcome" "DiscoveryOutcome" NOT NULL,
    "match_score" DOUBLE PRECISION,
    "match_reasons" JSONB NOT NULL DEFAULT '[]',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discovery_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "candidate_company_id" UUID NOT NULL,
    "existing_company_id" UUID NOT NULL,
    "pair_key" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "run_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "search_projects_workspace_id_created_at_idx" ON "search_projects"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_projects_workspace_id_name_key" ON "search_projects"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "search_runs_project_id_created_at_idx" ON "search_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "search_runs_workspace_id_status_idx" ON "search_runs"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "search_runs_status_created_at_idx" ON "search_runs"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "search_runs_project_id_idempotency_key_key" ON "search_runs"("project_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "discovery_tasks_run_id_status_idx" ON "discovery_tasks"("run_id", "status");

-- CreateIndex
CREATE INDEX "discovery_tasks_status_updated_at_idx" ON "discovery_tasks"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_tasks_run_id_provider_id_query_key_key" ON "discovery_tasks"("run_id", "provider_id", "query_key");

-- CreateIndex
CREATE INDEX "discovery_task_attempts_task_id_idx" ON "discovery_task_attempts"("task_id");

-- CreateIndex
CREATE INDEX "companies_workspace_id_status_id_idx" ON "companies"("workspace_id", "status", "id");

-- CreateIndex
CREATE INDEX "companies_workspace_id_name_key_idx" ON "companies"("workspace_id", "name_key");

-- CreateIndex
CREATE INDEX "companies_name_tokens_idx" ON "companies" USING GIN ("name_tokens");

-- CreateIndex
CREATE INDEX "company_sources_company_id_idx" ON "company_sources"("company_id");

-- CreateIndex
CREATE INDEX "company_sources_expires_at_idx" ON "company_sources"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "company_sources_workspace_id_provider_id_source_key_key" ON "company_sources"("workspace_id", "provider_id", "source_key");

-- CreateIndex
CREATE INDEX "company_locations_company_id_idx" ON "company_locations"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_locations_company_id_location_key_key" ON "company_locations"("company_id", "location_key");

-- CreateIndex
CREATE UNIQUE INDEX "company_aliases_company_id_alias_key_key" ON "company_aliases"("company_id", "alias_key");

-- CreateIndex
CREATE INDEX "company_identities_company_id_idx" ON "company_identities"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_identities_workspace_id_type_scope_value_key" ON "company_identities"("workspace_id", "type", "scope", "value");

-- CreateIndex
CREATE INDEX "discovery_results_run_id_id_idx" ON "discovery_results"("run_id", "id");

-- CreateIndex
CREATE INDEX "discovery_results_company_id_idx" ON "discovery_results"("company_id");

-- CreateIndex
CREATE INDEX "discovery_results_workspace_id_idx" ON "discovery_results"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_results_run_id_provider_id_source_key_key" ON "discovery_results"("run_id", "provider_id", "source_key");

-- CreateIndex
CREATE INDEX "match_reviews_workspace_id_status_id_idx" ON "match_reviews"("workspace_id", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "match_reviews_workspace_id_pair_key_key" ON "match_reviews"("workspace_id", "pair_key");

-- AddForeignKey
ALTER TABLE "search_projects" ADD CONSTRAINT "search_projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_projects" ADD CONSTRAINT "search_projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "search_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_runs" ADD CONSTRAINT "search_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_tasks" ADD CONSTRAINT "discovery_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "search_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_task_attempts" ADD CONSTRAINT "discovery_task_attempts_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "discovery_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_sources" ADD CONSTRAINT "company_sources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_locations" ADD CONSTRAINT "company_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_aliases" ADD CONSTRAINT "company_aliases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_identities" ADD CONSTRAINT "company_identities_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "search_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "discovery_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discovery_results" ADD CONSTRAINT "discovery_results_company_source_id_fkey" FOREIGN KEY ("company_source_id") REFERENCES "company_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_candidate_company_id_fkey" FOREIGN KEY ("candidate_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_existing_company_id_fkey" FOREIGN KEY ("existing_company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_reviews" ADD CONSTRAINT "match_reviews_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
