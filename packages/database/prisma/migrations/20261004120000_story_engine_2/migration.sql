-- Story Engine 2.0 and content opportunities.
--
-- Additive only: new enum types, new nullable columns on story_candidates,
-- engine_version (default 1, so every existing pack and architecture stays an
-- engine-1 record), and two new tables. Nothing is renamed, rewritten or
-- dropped, and no research table is changed: content_opportunity_claims only
-- references research_claims, as story_candidate_claims already does.


-- CreateEnum
CREATE TYPE "NarrativeMode" AS ENUM ('IMMERSIVE_RECONSTRUCTION', 'CHARACTER_FOLLOW', 'HISTORICAL_MYSTERY', 'INVESTIGATION', 'COUNTDOWN', 'SURVIVAL', 'CONFLICT', 'RISE_AND_FALL', 'HEIST_OPERATION', 'JOURNEY', 'COURTROOM_DISPUTE', 'DISCOVERY', 'MYTH_VS_RECORD', 'PARALLEL_TIMELINE', 'CAUSE_AND_EFFECT');

-- CreateEnum
CREATE TYPE "ReconstructionLevel" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ContentFormat" AS ENUM ('LONG_FORM', 'SHORT', 'BOTH');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "story_architectures" ADD COLUMN     "engine_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "story_candidates" ADD COLUMN     "central_question" TEXT,
ADD COLUMN     "editor_overrides" JSONB,
ADD COLUMN     "historical_value" DOUBLE PRECISION,
ADD COLUMN     "human_stakes" JSONB,
ADD COLUMN     "narrative_mode" "NarrativeMode",
ADD COLUMN     "pov_strategy" JSONB,
ADD COLUMN     "reconstruction_level" "ReconstructionLevel",
ADD COLUMN     "selection_order" INTEGER,
ADD COLUMN     "story_design" JSONB,
ADD COLUMN     "story_value" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "story_packs" ADD COLUMN     "engine_version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "content_opportunities" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "architecture_id" UUID NOT NULL,
    "dossier_id" UUID NOT NULL,
    "opportunity_key" TEXT NOT NULL,
    "format" "ContentFormat" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'PROPOSED',
    "rank" INTEGER,
    "short_score" DOUBLE PRECISION,
    "title" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "central_question" TEXT NOT NULL,
    "target_duration_sec" INTEGER,
    "independent" BOOLEAN NOT NULL,
    "requires_context" BOOLEAN NOT NULL,
    "historical_status" "HistoricalStatus" NOT NULL,
    "historical_confidence" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "editor_notes" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_opportunity_claims" (
    "opportunity_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    CONSTRAINT "content_opportunity_claims_pkey" PRIMARY KEY ("opportunity_id","claim_id")
);

-- CreateIndex
CREATE INDEX "content_opportunities_project_id_status_idx" ON "content_opportunities"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "content_opportunities_architecture_id_opportunity_key_key" ON "content_opportunities"("architecture_id", "opportunity_key");

-- CreateIndex
CREATE INDEX "content_opportunity_claims_claim_id_idx" ON "content_opportunity_claims"("claim_id");

-- AddForeignKey
ALTER TABLE "content_opportunities" ADD CONSTRAINT "content_opportunities_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_opportunities" ADD CONSTRAINT "content_opportunities_architecture_id_fkey" FOREIGN KEY ("architecture_id") REFERENCES "story_architectures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_opportunities" ADD CONSTRAINT "content_opportunities_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_opportunity_claims" ADD CONSTRAINT "content_opportunity_claims_opportunity_id_fkey" FOREIGN KEY ("opportunity_id") REFERENCES "content_opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_opportunity_claims" ADD CONSTRAINT "content_opportunity_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

