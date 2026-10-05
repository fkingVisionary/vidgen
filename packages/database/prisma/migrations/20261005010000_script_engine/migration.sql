-- Script Engine 1.0.
--
-- Additive only: the script tables that existed since milestone 1 (scripts,
-- scenes, scene_narrations) gain the columns Script Engine 1.0 writes, and two
-- new tables hold narration blocks (script_blocks) and the approved claims
-- each block rests on (script_block_claims). No existing column or row is
-- changed; research and story tables are untouched.

-- CreateEnum
CREATE TYPE "ScriptBlockClass" AS ENUM ('DOCUMENTED', 'RECONSTRUCTION', 'UNCERTAIN', 'FICTION', 'FRAMING');

-- CreateEnum
CREATE TYPE "SectionReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "scenes" ADD COLUMN     "content" JSONB,
ADD COLUMN     "editor_notes" TEXT,
ADD COLUMN     "review_status" "SectionReviewStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "reviewed_at" TIMESTAMPTZ(3),
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "sequence_number" INTEGER;

-- AlterTable
ALTER TABLE "scripts" ADD COLUMN     "content" JSONB,
ADD COLUMN     "engine_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "job_id" UUID,
ADD COLUMN     "quality_passed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "quality_report" JSONB,
ADD COLUMN     "revision_of_id" UUID,
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "target_duration_sec" INTEGER,
ADD COLUMN     "word_count" INTEGER;

-- CreateTable
CREATE TABLE "script_blocks" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "narration_id" UUID NOT NULL,
    "block_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "generated_text" TEXT NOT NULL,
    "info_class" "ScriptBlockClass" NOT NULL,
    "beat_ids" TEXT[],
    "speaker_id" TEXT,
    "speech_kind" TEXT,
    "fictional_device" BOOLEAN NOT NULL DEFAULT false,
    "delivery" JSONB NOT NULL,
    "visual" JSONB NOT NULL,
    "presentation" JSONB NOT NULL DEFAULT '[]',
    "word_count" INTEGER NOT NULL,
    "estimated_duration_sec" DOUBLE PRECISION NOT NULL,
    "edited_by" TEXT,
    "edited_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "script_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "script_block_claims" (
    "block_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,

    CONSTRAINT "script_block_claims_pkey" PRIMARY KEY ("block_id","claim_id")
);

-- CreateIndex
CREATE INDEX "script_blocks_narration_id_sort_order_idx" ON "script_blocks"("narration_id", "sort_order");

-- CreateIndex
CREATE INDEX "script_blocks_script_id_idx" ON "script_blocks"("script_id");

-- CreateIndex
CREATE UNIQUE INDEX "script_blocks_narration_id_block_key_key" ON "script_blocks"("narration_id", "block_key");

-- CreateIndex
CREATE INDEX "script_block_claims_claim_id_idx" ON "script_block_claims"("claim_id");

-- CreateIndex
CREATE INDEX "scripts_revision_of_id_idx" ON "scripts"("revision_of_id");

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_revision_of_id_fkey" FOREIGN KEY ("revision_of_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script_blocks" ADD CONSTRAINT "script_blocks_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script_blocks" ADD CONSTRAINT "script_blocks_narration_id_fkey" FOREIGN KEY ("narration_id") REFERENCES "scene_narrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script_block_claims" ADD CONSTRAINT "script_block_claims_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "script_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "script_block_claims" ADD CONSTRAINT "script_block_claims_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

