-- CreateEnum
CREATE TYPE "MonitoringKind" AS ENUM ('ATS_BOARD', 'CAREER_PAGE', 'WEBSITE');

-- CreateEnum
CREATE TYPE "CheckTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "WebsiteCheckOutcome" AS ENUM ('OK', 'FAILED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_JOB', 'JOB_CLOSED', 'JOB_CHANGED', 'WEBSITE_CHANGED');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "first_missed_at" TIMESTAMP(3),
ADD COLUMN     "last_missed_check_id" UUID,
ADD COLUMN     "missed_checks" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "job_checks" ADD COLUMN     "jobs_missing" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pending_confirmation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "schedule_id" UUID,
ADD COLUMN     "trigger" "CheckTrigger" NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "monitoring_schedules" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "job_source_id" UUID,
    "kind" "MonitoringKind" NOT NULL,
    "scope_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "interval_minutes" INTEGER NOT NULL,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "last_run_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "last_outcome" TEXT,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "last_error_message" TEXT,
    "last_error_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "monitoring_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_checks" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "schedule_id" UUID,
    "url" TEXT NOT NULL,
    "outcome" "WebsiteCheckOutcome" NOT NULL,
    "http_status" INTEGER,
    "final_url" TEXT,
    "final_domain" TEXT,
    "content_hash" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "change_kind" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "website_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "delivered_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monitoring_schedules_scope_key_key" ON "monitoring_schedules"("scope_key");

-- CreateIndex
CREATE INDEX "monitoring_schedules_enabled_next_run_at_idx" ON "monitoring_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE INDEX "monitoring_schedules_workspace_id_company_id_idx" ON "monitoring_schedules"("workspace_id", "company_id");

-- CreateIndex
CREATE INDEX "website_checks_company_id_started_at_idx" ON "website_checks"("company_id", "started_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_workspace_id_read_at_id_idx" ON "notifications"("user_id", "workspace_id", "read_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_workspace_id_user_id_dedupe_key_key" ON "notifications"("workspace_id", "user_id", "dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_workspace_id_user_id_type_key" ON "notification_preferences"("workspace_id", "user_id", "type");

-- AddForeignKey
ALTER TABLE "monitoring_schedules" ADD CONSTRAINT "monitoring_schedules_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_schedules" ADD CONSTRAINT "monitoring_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "monitoring_schedules" ADD CONSTRAINT "monitoring_schedules_job_source_id_fkey" FOREIGN KEY ("job_source_id") REFERENCES "job_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_checks" ADD CONSTRAINT "website_checks_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_checks" ADD CONSTRAINT "website_checks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

