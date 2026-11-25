-- CreateEnum
CREATE TYPE "Seniority" AS ENUM ('INTERN', 'JUNIOR', 'MID', 'SENIOR', 'LEAD', 'MANAGER', 'DIRECTOR', 'EXECUTIVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SalaryPeriod" AS ENUM ('HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "AnalysisSource" AS ENUM ('RULES', 'AI');

-- CreateEnum
CREATE TYPE "SkillKind" AS ENUM ('REQUIRED', 'PREFERRED');

-- CreateEnum
CREATE TYPE "RequirementKind" AS ENUM ('EXPERIENCE', 'EDUCATION', 'CERTIFICATION', 'LANGUAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "ObservationKind" AS ENUM ('FIRST_SEEN', 'SEEN', 'CHANGED', 'MISSING', 'STATUS_CHANGED', 'ANALYZED');

-- CreateEnum
CREATE TYPE "ExperienceFit" AS ENUM ('MEETS', 'BELOW', 'ABOVE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LocationFit" AS ENUM ('MATCH', 'PARTIAL', 'MISMATCH', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('ROLE', 'SKILL_MATCHED', 'SKILL_MISSING', 'EXPERIENCE', 'LOCATION', 'WORKPLACE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "JobStatus" ADD VALUE 'UNKNOWN';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "analysis_confidence" DOUBLE PRECISION,
ADD COLUMN     "analysis_hash" TEXT,
ADD COLUMN     "analysis_model" TEXT,
ADD COLUMN     "analysis_prompt_version" TEXT,
ADD COLUMN     "analysis_provider" TEXT,
ADD COLUMN     "analyzed_at" TIMESTAMP(3),
ADD COLUMN     "content_hash" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "max_years_experience" INTEGER,
ADD COLUMN     "min_years_experience" INTEGER,
ADD COLUMN     "normalized_title" TEXT,
ADD COLUMN     "role_category" TEXT,
ADD COLUMN     "salary_currency" TEXT,
ADD COLUMN     "salary_max" INTEGER,
ADD COLUMN     "salary_min" INTEGER,
ADD COLUMN     "salary_period" "SalaryPeriod",
ADD COLUMN     "salary_text" TEXT,
ADD COLUMN     "seniority" "Seniority" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "status_changed_at" TIMESTAMP(3),
ADD COLUMN     "status_reason" TEXT;

-- CreateTable
CREATE TABLE "job_skills" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "skill_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SkillKind" NOT NULL,
    "evidence" TEXT,
    "source" "AnalysisSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_requirements" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "kind" "RequirementKind" NOT NULL,
    "text" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "min_years" INTEGER,
    "max_years" INTEGER,
    "level" TEXT,
    "source" "AnalysisSource" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_observations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "check_id" UUID,
    "kind" "ObservationKind" NOT NULL,
    "from_status" "JobStatus",
    "to_status" "JobStatus",
    "reason" TEXT,
    "changes" JSONB NOT NULL DEFAULT '{}',
    "content_hash" TEXT,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_preferences" (
    "project_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "role_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "skills_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "experience_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    "location_weight" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "years_experience" INTEGER,
    "seniorities" "Seniority"[] DEFAULT ARRAY[]::"Seniority"[],
    "workplace_types" "WorkplaceType"[] DEFAULT ARRAY[]::"WorkplaceType"[],
    "locations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "min_score" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_preferences_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "job_matches" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "role_score" DOUBLE PRECISION,
    "skills_score" DOUBLE PRECISION,
    "experience_score" DOUBLE PRECISION,
    "location_score" DOUBLE PRECISION,
    "matched_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missing_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experience_fit" "ExperienceFit" NOT NULL,
    "location_fit" "LocationFit" NOT NULL,
    "explanation" TEXT NOT NULL,
    "explanation_source" "AnalysisSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "weights" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "semantic_hash" TEXT,
    "semantic_score" DOUBLE PRECISION,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_match_evidence" (
    "id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "kind" "EvidenceKind" NOT NULL,
    "label" TEXT NOT NULL,
    "detail" TEXT,
    "job_text" TEXT,
    "score" DOUBLE PRECISION,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "job_match_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_skills_skill_key_idx" ON "job_skills"("skill_key");

-- CreateIndex
CREATE UNIQUE INDEX "job_skills_job_id_skill_key_key" ON "job_skills"("job_id", "skill_key");

-- CreateIndex
CREATE INDEX "job_requirements_job_id_kind_idx" ON "job_requirements"("job_id", "kind");

-- CreateIndex
CREATE INDEX "job_observations_job_id_id_idx" ON "job_observations"("job_id", "id");

-- CreateIndex
CREATE INDEX "match_preferences_workspace_id_idx" ON "match_preferences"("workspace_id");

-- CreateIndex
CREATE INDEX "job_matches_project_id_score_id_idx" ON "job_matches"("project_id", "score", "id");

-- CreateIndex
CREATE INDEX "job_matches_job_id_idx" ON "job_matches"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "job_matches_project_id_job_id_key" ON "job_matches"("project_id", "job_id");

-- CreateIndex
CREATE INDEX "job_match_evidence_match_id_position_idx" ON "job_match_evidence"("match_id", "position");

-- AddForeignKey
ALTER TABLE "job_skills" ADD CONSTRAINT "job_skills_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_requirements" ADD CONSTRAINT "job_requirements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_observations" ADD CONSTRAINT "job_observations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_observations" ADD CONSTRAINT "job_observations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_preferences" ADD CONSTRAINT "match_preferences_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "search_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_preferences" ADD CONSTRAINT "match_preferences_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "search_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_match_evidence" ADD CONSTRAINT "job_match_evidence_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "job_matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

