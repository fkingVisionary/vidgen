-- Voice Engine 1.0: versioned voice profiles, voice runs, chunks, takes (generations),
-- assemblies and the pronunciation review list; the VOICE_REVIEW status and VOICE gate.
-- Additive only: no existing table or value is changed or removed.

-- CreateEnum
CREATE TYPE "VoiceRunKind" AS ENUM ('AUDITION', 'SECTION', 'BLOCKS', 'RANGE', 'FULL');

-- CreateEnum
CREATE TYPE "VoiceGenerationStatus" AS ENUM ('PENDING', 'GENERATING', 'GENERATED', 'FAILED', 'REJECTED', 'APPROVED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PerformanceStrategy" AS ENUM ('PLAIN', 'RESTRAINED', 'DIRECTED');

-- CreateEnum
CREATE TYPE "PronunciationStatus" AS ENUM ('PENDING', 'APPROVED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "PronunciationMethod" AS ENUM ('DEFAULT', 'ALIAS', 'IPA', 'CMU');

-- AlterEnum
ALTER TYPE "ApprovalGate" ADD VALUE 'VOICE' AFTER 'SCRIPT';

-- AlterEnum
ALTER TYPE "ProjectStatus" ADD VALUE 'VOICE_REVIEW' AFTER 'VOICE_GENERATING';

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "voice_assembly_id" UUID;

-- CreateTable
CREATE TABLE "voice_profiles" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "output_format" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" "VoiceRunKind" NOT NULL,
    "scope" JSONB NOT NULL,
    "strategy" "PerformanceStrategy" NOT NULL,
    "settings" JSONB NOT NULL,
    "experiment" TEXT,
    "variant" TEXT,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "voice_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_chunks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "scene_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "section_key" TEXT NOT NULL,
    "block_keys" TEXT[],
    "source_block_id" UUID NOT NULL,
    "spans" JSONB NOT NULL,
    "source_text" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "block_hashes" JSONB NOT NULL,
    "words" INTEGER NOT NULL,
    "boundary" TEXT NOT NULL,
    "performance" JSONB NOT NULL,
    "current_generation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_generations" (
    "id" UUID NOT NULL,
    "chunk_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_id" UUID,
    "generation" INTEGER NOT NULL,
    "status" "VoiceGenerationStatus" NOT NULL DEFAULT 'PENDING',
    "profile_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "strategy" "PerformanceStrategy" NOT NULL,
    "canonical_text" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "spoken_text" TEXT,
    "performance_text" TEXT,
    "prepared" JSONB,
    "directions" JSONB,
    "audio_asset_id" UUID,
    "duration_ms" INTEGER,
    "alignment" JSONB,
    "qa" JSONB,
    "provider_call_id" UUID,
    "provider_request_id" TEXT,
    "characters" INTEGER,
    "error" TEXT,
    "note" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "approved_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "voice_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_assemblies" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "entries" JSONB NOT NULL,
    "timeline" JSONB NOT NULL,
    "total_duration_ms" INTEGER NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "qa" JSONB NOT NULL,
    "audio_asset_id" UUID,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_assemblies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_pronunciations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "method" "PronunciationMethod" NOT NULL DEFAULT 'DEFAULT',
    "pronunciation" TEXT,
    "status" "PronunciationStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "hint" TEXT,
    "notes" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "voice_pronunciations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_profiles_name_version_key" ON "voice_profiles"("name", "version");

-- CreateIndex
CREATE INDEX "voice_runs_script_id_idx" ON "voice_runs"("script_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_runs_project_id_number_key" ON "voice_runs"("project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "voice_chunks_current_generation_id_key" ON "voice_chunks"("current_generation_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_chunks_run_id_chunk_index_key" ON "voice_chunks"("run_id", "chunk_index");

-- CreateIndex
CREATE UNIQUE INDEX "voice_generations_audio_asset_id_key" ON "voice_generations"("audio_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_generations_provider_call_id_key" ON "voice_generations"("provider_call_id");

-- CreateIndex
CREATE INDEX "voice_generations_run_id_status_idx" ON "voice_generations"("run_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "voice_generations_chunk_id_generation_key" ON "voice_generations"("chunk_id", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "voice_assemblies_audio_asset_id_key" ON "voice_assemblies"("audio_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_assemblies_run_id_version_key" ON "voice_assemblies"("run_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "voice_pronunciations_project_id_language_term_key" ON "voice_pronunciations"("project_id", "language", "term");

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_voice_assembly_id_fkey" FOREIGN KEY ("voice_assembly_id") REFERENCES "voice_assemblies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_runs" ADD CONSTRAINT "voice_runs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "voice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_chunks" ADD CONSTRAINT "voice_chunks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "voice_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_chunks" ADD CONSTRAINT "voice_chunks_current_generation_id_fkey" FOREIGN KEY ("current_generation_id") REFERENCES "voice_generations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "voice_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "voice_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "voice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_audio_asset_id_fkey" FOREIGN KEY ("audio_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_generations" ADD CONSTRAINT "voice_generations_provider_call_id_fkey" FOREIGN KEY ("provider_call_id") REFERENCES "provider_calls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assemblies" ADD CONSTRAINT "voice_assemblies_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "voice_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assemblies" ADD CONSTRAINT "voice_assemblies_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "voice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_assemblies" ADD CONSTRAINT "voice_assemblies_audio_asset_id_fkey" FOREIGN KEY ("audio_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_pronunciations" ADD CONSTRAINT "voice_pronunciations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
