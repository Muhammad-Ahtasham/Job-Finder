-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED');

-- CreateEnum
CREATE TYPE "PageType" AS ENUM ('HOMEPAGE', 'ABOUT', 'CONTACT', 'CAREERS', 'JOBS', 'TEAM', 'OTHER');

-- CreateEnum
CREATE TYPE "PageFetchStatus" AS ENUM ('DISCOVERED', 'FETCHED', 'BLOCKED_ROBOTS', 'BLOCKED_UNSAFE', 'FAILED');

-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('EMAIL', 'LINKEDIN');

-- CreateEnum
CREATE TYPE "EmailCategory" AS ENUM ('HR', 'CAREERS', 'RECRUITMENT', 'GENERAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ClassifiedBy" AS ENUM ('RULES', 'AI');

-- CreateEnum
CREATE TYPE "CompanyReviewKind" AS ENUM ('WEBSITE');

-- CreateEnum
CREATE TYPE "CompanyReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WebsiteDecision" AS ENUM ('OFFICIAL', 'REJECTED', 'UNCERTAIN');

-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "last_enriched_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "extraction_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "requested_by_id" UUID,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'QUEUED',
    "active_key" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "website_url" TEXT,
    "pages_found" INTEGER NOT NULL DEFAULT 0,
    "contacts_found" INTEGER NOT NULL DEFAULT 0,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error_code" TEXT,
    "error_message" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_pages" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "type" "PageType" NOT NULL,
    "type_confidence" DOUBLE PRECISION NOT NULL,
    "classified_by" "ClassifiedBy" NOT NULL DEFAULT 'RULES',
    "title" TEXT,
    "fetch_status" "PageFetchStatus" NOT NULL,
    "http_status" INTEGER,
    "content_type" TEXT,
    "content_hash" TEXT,
    "error_code" TEXT,
    "discovered_from" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "external" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_run_id" UUID,

    CONSTRAINT "company_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_contacts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "ContactKind" NOT NULL,
    "value" TEXT NOT NULL,
    "category" "EmailCategory",
    "classified_by" "ClassifiedBy" NOT NULL DEFAULT 'RULES',
    "confidence" DOUBLE PRECISION NOT NULL,
    "verification_status" "FieldStatus" NOT NULL,
    "verification_method" TEXT NOT NULL,
    "extraction_method" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "source_page_id" UUID,
    "context" TEXT,
    "domain_match" BOOLEAN,
    "extracted_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "last_run_id" UUID,

    CONSTRAINT "company_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_reviews" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "kind" "CompanyReviewKind" NOT NULL DEFAULT 'WEBSITE',
    "subject_key" TEXT NOT NULL,
    "subject_url" TEXT NOT NULL,
    "decision" "WebsiteDecision" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "CompanyReviewStatus" NOT NULL DEFAULT 'PENDING',
    "decided_manually" BOOLEAN NOT NULL DEFAULT false,
    "run_id" UUID,
    "resolved_by_id" UUID,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "extraction_runs_active_key_key" ON "extraction_runs"("active_key");

-- CreateIndex
CREATE INDEX "extraction_runs_company_id_created_at_idx" ON "extraction_runs"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "extraction_runs_workspace_id_created_at_idx" ON "extraction_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "extraction_runs_status_created_at_idx" ON "extraction_runs"("status", "created_at");

-- CreateIndex
CREATE INDEX "company_pages_company_id_type_idx" ON "company_pages"("company_id", "type");

-- CreateIndex
CREATE INDEX "company_pages_workspace_id_idx" ON "company_pages"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_pages_company_id_url_key" ON "company_pages"("company_id", "url");

-- CreateIndex
CREATE INDEX "company_contacts_company_id_kind_idx" ON "company_contacts"("company_id", "kind");

-- CreateIndex
CREATE INDEX "company_contacts_workspace_id_idx" ON "company_contacts"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_contacts_company_id_kind_value_key" ON "company_contacts"("company_id", "kind", "value");

-- CreateIndex
CREATE INDEX "company_reviews_workspace_id_status_idx" ON "company_reviews"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "company_reviews_company_id_kind_subject_key_key" ON "company_reviews"("company_id", "kind", "subject_key");

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_pages" ADD CONSTRAINT "company_pages_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_pages" ADD CONSTRAINT "company_pages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_contacts" ADD CONSTRAINT "company_contacts_source_page_id_fkey" FOREIGN KEY ("source_page_id") REFERENCES "company_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_reviews" ADD CONSTRAINT "company_reviews_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_reviews" ADD CONSTRAINT "company_reviews_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_reviews" ADD CONSTRAINT "company_reviews_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

