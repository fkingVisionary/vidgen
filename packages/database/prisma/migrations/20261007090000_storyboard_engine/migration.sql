-- Storyboard Engine V1: versioned storyboards timed against a pinned voice assembly, with visual beats, shots linked
-- to narration words, claims and continuity subjects, append-only decisions, and the visual style profile library;
-- the STORYBOARD_APPROVED milestone and the STORYBOARD_PREVIEW side job.
-- Hand-written and additive: new types, tables and nullable columns. No column or row is dropped. The one type change,
-- storyboards.status from ArtifactStatus to StoryboardStatus, is a total cast (every ArtifactStatus value is a
-- StoryboardStatus value), so every existing row keeps its status. The new enum values are not used in this migration.

-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'STORYBOARD_APPROVED' AFTER 'STORYBOARD_REVIEW';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'STORYBOARD_PREVIEW' AFTER 'VISUAL_PLAN';

-- CreateEnum
CREATE TYPE "StoryboardStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "VisualTreatment" AS ENUM ('CINEMATIC_RECONSTRUCTION', 'GENERATED_STILL', 'ARCHIVAL_IMAGE', 'ARCHIVAL_VIDEO', 'DOCUMENT_ANIMATION', 'MAP_ANIMATION', 'DATA_VISUALIZATION', 'TIMELINE', 'DIAGRAM', 'INFOGRAPHIC', 'PORTRAIT', 'CHARACTER_VISUAL', 'ENVIRONMENT', 'PRODUCT_OBJECT', 'SCREEN_CAPTURE', 'NEWS_FOOTAGE', 'ABSTRACT_METAPHOR', 'TEXT_ON_SCREEN', 'TRANSITION', 'MOTION_GRAPHIC');

-- CreateEnum
CREATE TYPE "ProductionMethod" AS ENUM ('GENERATIVE_VIDEO', 'IMAGE_TO_VIDEO', 'GENERATIVE_IMAGE', 'STILL_MOTION', 'DETERMINISTIC_GRAPHIC', 'MAP_RENDER', 'DOCUMENT_MOTION', 'ARCHIVAL_SOURCING', 'STOCK_SOURCING', 'SCREEN_RECORDING', 'MOTION_DESIGN', 'EDIT_TIME');

-- CreateEnum
CREATE TYPE "TimingRelation" AS ENUM ('TIMED_TO_NARRATION', 'LEAD_IN', 'TAIL_OUT', 'BRIDGE');

-- CreateEnum
CREATE TYPE "ContinuityKind" AS ENUM ('CHARACTER', 'ENVIRONMENT', 'LOCATION', 'BUILDING', 'VEHICLE', 'OBJECT', 'PRODUCT', 'DOCUMENT', 'MAP', 'OTHER');

-- CreateEnum
CREATE TYPE "StoryboardScope" AS ENUM ('FULL', 'PARTIAL');

-- CreateEnum
CREATE TYPE "StoryboardDecisionKind" AS ENUM ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'CLEARED');

-- CreateEnum
CREATE TYPE "ShotClaimRole" AS ENUM ('DEPICTS', 'SHOWS_SOURCE', 'DATA', 'CONTEXT', 'PERIOD_BASIS');

-- AlterTable: storyboards.status ArtifactStatus → StoryboardStatus, cast in place (a total cast; never dropped and re-added)
ALTER TABLE "storyboards" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "storyboards" ALTER COLUMN "status" TYPE "StoryboardStatus" USING ("status"::text::"StoryboardStatus");
ALTER TABLE "storyboards" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "storyboards" ADD COLUMN     "story_id" UUID,
ADD COLUMN     "language_version_id" UUID,
ADD COLUMN     "voice_run_id" UUID,
ADD COLUMN     "voice_assembly_id" UUID,
ADD COLUMN     "assembly_version" INTEGER,
ADD COLUMN     "narration_fingerprint" TEXT,
ADD COLUMN     "visual_profile_id" UUID,
ADD COLUMN     "engine_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "scope" "StoryboardScope" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "revision_of_id" UUID,
ADD COLUMN     "job_id" UUID,
ADD COLUMN     "content" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "qa" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "qa_passed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "runtime_ms" INTEGER,
ADD COLUMN     "beat_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shot_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "estimated_cost_usd" DECIMAL(14,6),
ADD COLUMN     "cost_basis" TEXT,
ADD COLUMN     "unpriced_shot_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "decided_by" TEXT,
ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "created_by" TEXT;

-- AlterTable: the deprecated visual_type becomes optional (a storyboard shot has a treatment instead)
ALTER TABLE "shots" ALTER COLUMN "visual_type" DROP NOT NULL,
ADD COLUMN     "beat_id" UUID,
ADD COLUMN     "shot_key" TEXT,
ADD COLUMN     "start_ms" INTEGER,
ADD COLUMN     "end_ms" INTEGER,
ADD COLUMN     "timing_relation" "TimingRelation",
ADD COLUMN     "timing" JSONB,
ADD COLUMN     "treatment" "VisualTreatment",
ADD COLUMN     "production_method" "ProductionMethod",
ADD COLUMN     "info_class" "ScriptBlockClass",
ADD COLUMN     "asset_requirement" JSONB,
ADD COLUMN     "evidence" JSONB,
ADD COLUMN     "cost_estimate" JSONB,
ADD COLUMN     "estimated_cost_usd" DECIMAL(14,6),
ADD COLUMN     "cost_basis" "CostBasis",
ADD COLUMN     "content_hash" TEXT;

-- CreateTable
CREATE TABLE "visual_beats" (
    "id" UUID NOT NULL,
    "storyboard_id" UUID NOT NULL,
    "beat_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "scene_id" UUID NOT NULL,
    "sequence_number" INTEGER,
    "arch_beat_ids" TEXT[],
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "treatment" "VisualTreatment" NOT NULL,
    "info_class" "ScriptBlockClass" NOT NULL,
    "content" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_beats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_beat_blocks" (
    "beat_id" UUID NOT NULL,
    "script_block_id" UUID NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "first_word" INTEGER NOT NULL,
    "last_word" INTEGER NOT NULL,

    CONSTRAINT "visual_beat_blocks_pkey" PRIMARY KEY ("beat_id","script_block_id")
);

-- CreateTable
CREATE TABLE "shot_blocks" (
    "shot_id" UUID NOT NULL,
    "script_block_id" UUID NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "first_word" INTEGER NOT NULL,
    "last_word" INTEGER NOT NULL,

    CONSTRAINT "shot_blocks_pkey" PRIMARY KEY ("shot_id","script_block_id")
);

-- CreateTable
CREATE TABLE "visual_beat_claims" (
    "beat_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    CONSTRAINT "visual_beat_claims_pkey" PRIMARY KEY ("beat_id","claim_id")
);

-- CreateTable
CREATE TABLE "shot_claims" (
    "shot_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "role" "ShotClaimRole" NOT NULL,

    CONSTRAINT "shot_claims_pkey" PRIMARY KEY ("shot_id","claim_id","role")
);

-- CreateTable
CREATE TABLE "continuity_subjects" (
    "id" UUID NOT NULL,
    "storyboard_id" UUID NOT NULL,
    "subject_key" TEXT NOT NULL,
    "kind" "ContinuityKind" NOT NULL,
    "cast_id" TEXT,
    "name" TEXT NOT NULL,
    "info_class" "ScriptBlockClass" NOT NULL,
    "spec" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "continuity_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shot_subjects" (
    "shot_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "shot_subjects_pkey" PRIMARY KEY ("shot_id","subject_id")
);

-- CreateTable
CREATE TABLE "storyboard_decisions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "storyboard_id" UUID NOT NULL,
    "shot_id" UUID,
    "decision" "StoryboardDecisionKind" NOT NULL,
    "note" TEXT,
    "decided_by" TEXT,
    "approval_id" UUID,
    "carried_from_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storyboard_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_profile_families" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_profile_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_profiles" (
    "id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "based_on_id" UUID,
    "origin" JSONB NOT NULL,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visual_selections" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "family_id" UUID,
    "pinned_version_id" UUID,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visual_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "storyboards_project_id_status_idx" ON "storyboards"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shots_storyboard_id_shot_key_key" ON "shots"("storyboard_id", "shot_key");

-- CreateIndex
CREATE INDEX "shots_beat_id_idx" ON "shots"("beat_id");

-- CreateIndex
CREATE UNIQUE INDEX "visual_beats_storyboard_id_beat_key_key" ON "visual_beats"("storyboard_id", "beat_key");

-- CreateIndex
CREATE INDEX "visual_beats_storyboard_id_sort_order_idx" ON "visual_beats"("storyboard_id", "sort_order");

-- CreateIndex
CREATE INDEX "visual_beat_blocks_script_block_id_idx" ON "visual_beat_blocks"("script_block_id");

-- CreateIndex
CREATE INDEX "shot_blocks_script_block_id_idx" ON "shot_blocks"("script_block_id");

-- CreateIndex
CREATE INDEX "visual_beat_claims_claim_id_idx" ON "visual_beat_claims"("claim_id");

-- CreateIndex
CREATE INDEX "shot_claims_claim_id_idx" ON "shot_claims"("claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "continuity_subjects_storyboard_id_subject_key_key" ON "continuity_subjects"("storyboard_id", "subject_key");

-- CreateIndex
CREATE INDEX "shot_subjects_subject_id_idx" ON "shot_subjects"("subject_id");

-- CreateIndex
CREATE INDEX "storyboard_decisions_storyboard_id_created_at_idx" ON "storyboard_decisions"("storyboard_id", "created_at");

-- CreateIndex
CREATE INDEX "storyboard_decisions_shot_id_created_at_idx" ON "storyboard_decisions"("shot_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "visual_profile_families_name_key" ON "visual_profile_families"("name");

-- CreateIndex
CREATE UNIQUE INDEX "visual_profiles_family_id_version_key" ON "visual_profiles"("family_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "visual_selections_project_id_key" ON "visual_selections"("project_id");

-- CreateIndex
CREATE INDEX "visual_selections_family_id_idx" ON "visual_selections"("family_id");

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "story_architectures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_voice_run_id_fkey" FOREIGN KEY ("voice_run_id") REFERENCES "voice_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_voice_assembly_id_fkey" FOREIGN KEY ("voice_assembly_id") REFERENCES "voice_assemblies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_visual_profile_id_fkey" FOREIGN KEY ("visual_profile_id") REFERENCES "visual_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_revision_of_id_fkey" FOREIGN KEY ("revision_of_id") REFERENCES "storyboards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_beat_id_fkey" FOREIGN KEY ("beat_id") REFERENCES "visual_beats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_beats" ADD CONSTRAINT "visual_beats_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_beats" ADD CONSTRAINT "visual_beats_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_beat_blocks" ADD CONSTRAINT "visual_beat_blocks_beat_id_fkey" FOREIGN KEY ("beat_id") REFERENCES "visual_beats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_beat_blocks" ADD CONSTRAINT "visual_beat_blocks_script_block_id_fkey" FOREIGN KEY ("script_block_id") REFERENCES "script_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_blocks" ADD CONSTRAINT "shot_blocks_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_blocks" ADD CONSTRAINT "shot_blocks_script_block_id_fkey" FOREIGN KEY ("script_block_id") REFERENCES "script_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: a claim cannot be deleted while a storyboard links it. The check is deferred to the end of the
-- transaction (not immediate, as RESTRICT would be): a project's own cascade reaches its claims (through its dossier)
-- before its storyboards, so an immediate check would refuse deleting the project itself.
ALTER TABLE "visual_beat_claims" ADD CONSTRAINT "visual_beat_claims_beat_id_fkey" FOREIGN KEY ("beat_id") REFERENCES "visual_beats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "visual_beat_claims" ADD CONSTRAINT "visual_beat_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "shot_claims" ADD CONSTRAINT "shot_claims_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shot_claims" ADD CONSTRAINT "shot_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "continuity_subjects" ADD CONSTRAINT "continuity_subjects_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_subjects" ADD CONSTRAINT "shot_subjects_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shot_subjects" ADD CONSTRAINT "shot_subjects_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "continuity_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_decisions" ADD CONSTRAINT "storyboard_decisions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_decisions" ADD CONSTRAINT "storyboard_decisions_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_decisions" ADD CONSTRAINT "storyboard_decisions_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_decisions" ADD CONSTRAINT "storyboard_decisions_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboard_decisions" ADD CONSTRAINT "storyboard_decisions_carried_from_id_fkey" FOREIGN KEY ("carried_from_id") REFERENCES "storyboard_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_profiles" ADD CONSTRAINT "visual_profiles_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "visual_profile_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_profiles" ADD CONSTRAINT "visual_profiles_based_on_id_fkey" FOREIGN KEY ("based_on_id") REFERENCES "visual_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_selections" ADD CONSTRAINT "visual_selections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_selections" ADD CONSTRAINT "visual_selections_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "visual_profile_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visual_selections" ADD CONSTRAINT "visual_selections_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "visual_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
