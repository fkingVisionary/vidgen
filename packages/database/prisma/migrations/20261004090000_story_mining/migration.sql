-- Milestone 3: story mining + story architecture.
--
-- Enum values are renamed and added in place (not recreated) so existing rows
-- keep their meaning: a project in the old STORY_DEVELOPMENT phase is now in
-- STORY_MINING, and old STORY jobs are STORY_MINING jobs. The architecture's
-- `beats` column becomes `content` (StoryArchitectureContent) with its data.

-- AlterEnum
ALTER TYPE "ProjectStatus" RENAME VALUE 'STORY_DEVELOPMENT' TO 'STORY_MINING';
ALTER TYPE "ProjectStatus" ADD VALUE 'STORY_SELECTION' AFTER 'STORY_MINING';
ALTER TYPE "ProjectStatus" ADD VALUE 'STORY_ARCHITECTING' AFTER 'STORY_SELECTION';
ALTER TYPE "ProjectStatus" ADD VALUE 'STORY_REVIEW' AFTER 'STORY_ARCHITECTING';
ALTER TYPE "ProjectStatus" ADD VALUE 'STORY_APPROVED' AFTER 'STORY_REVIEW';

-- AlterEnum
ALTER TYPE "JobType" RENAME VALUE 'STORY' TO 'STORY_MINING';
ALTER TYPE "JobType" ADD VALUE 'STORY_ARCHITECTURE' AFTER 'STORY_MINING';

-- AlterEnum
ALTER TYPE "ApprovalGate" ADD VALUE 'STORY' AFTER 'RESEARCH';

-- CreateEnum
CREATE TYPE "StoryType" AS ENUM ('CHARACTER', 'DEAL', 'MARKET_EVENT', 'FORTUNE', 'SCAM', 'CONFLICT', 'REVERSAL', 'MYSTERY', 'MYTH_ORIGIN', 'DISCOVERY', 'DISASTER', 'SOCIAL_PHENOMENON');

-- CreateEnum
CREATE TYPE "HistoricalStatus" AS ENUM ('ESTABLISHED', 'PROBABLE', 'CONTESTED', 'UNCERTAIN', 'MYTH_INVESTIGATION');

-- CreateEnum
CREATE TYPE "CandidateStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "CandidatePriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "story_id" UUID;

-- AlterTable
ALTER TABLE "story_architectures" RENAME COLUMN "beats" TO "content";
ALTER TABLE "story_architectures" ADD COLUMN     "estimated_duration_sec" INTEGER,
ADD COLUMN     "job_id" UUID,
ADD COLUMN     "pack_id" UUID,
ADD COLUMN     "quality_passed" BOOLEAN,
ADD COLUMN     "quality_report" JSONB,
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "target_duration_sec" INTEGER;

-- CreateTable
CREATE TABLE "story_packs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "dossier_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL DEFAULT '{}',
    "quality_report" JSONB,
    "quality_passed" BOOLEAN,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "story_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_candidates" (
    "id" UUID NOT NULL,
    "pack_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "dossier_id" UUID NOT NULL,
    "candidate_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "story_type" "StoryType" NOT NULL,
    "characters" JSONB NOT NULL DEFAULT '[]',
    "setting" TEXT NOT NULL,
    "time_period" TEXT NOT NULL,
    "desire" TEXT NOT NULL,
    "conflict" TEXT NOT NULL,
    "stakes" TEXT NOT NULL,
    "escalation" TEXT NOT NULL,
    "turning_point" TEXT NOT NULL,
    "payoff" TEXT NOT NULL,
    "why_interesting" TEXT NOT NULL,
    "viewer_question" TEXT NOT NULL,
    "myth_thread" JSONB,
    "scores" JSONB NOT NULL,
    "historical_status" "HistoricalStatus" NOT NULL,
    "historical_confidence" INTEGER NOT NULL,
    "rank_score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "notes" TEXT,
    "ai_selected" BOOLEAN NOT NULL DEFAULT false,
    "ai_selection_reason" TEXT,
    "status" "CandidateStatus" NOT NULL DEFAULT 'PROPOSED',
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "priority" "CandidatePriority" NOT NULL DEFAULT 'NORMAL',
    "editor_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "story_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_candidate_claims" (
    "candidate_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    CONSTRAINT "story_candidate_claims_pkey" PRIMARY KEY ("candidate_id","claim_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_packs_project_id_version_key" ON "story_packs"("project_id", "version");

-- CreateIndex
CREATE INDEX "story_candidates_pack_id_rank_idx" ON "story_candidates"("pack_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "story_candidates_pack_id_candidate_key_key" ON "story_candidates"("pack_id", "candidate_key");

-- CreateIndex
CREATE INDEX "story_candidate_claims_claim_id_idx" ON "story_candidate_claims"("claim_id");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "story_architectures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_packs" ADD CONSTRAINT "story_packs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_packs" ADD CONSTRAINT "story_packs_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_packs" ADD CONSTRAINT "story_packs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_candidates" ADD CONSTRAINT "story_candidates_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "story_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_candidates" ADD CONSTRAINT "story_candidates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_candidates" ADD CONSTRAINT "story_candidates_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_candidate_claims" ADD CONSTRAINT "story_candidate_claims_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "story_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_candidate_claims" ADD CONSTRAINT "story_candidate_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "story_packs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

