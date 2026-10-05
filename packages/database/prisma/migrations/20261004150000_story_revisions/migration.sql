-- Editorial revision loop and alternative angles.
--
-- Additive only: a new job type (the STORY_ANGLES side job), three nullable
-- columns on story_architectures (the version a revision revises, and the
-- explored angle it was built on) and a new table for angle explorations.
-- No existing column, row or research table is changed.

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'STORY_ANGLES' AFTER 'STORY_ARCHITECTURE';

-- AlterTable
ALTER TABLE "story_architectures" ADD COLUMN     "angle_key" TEXT,
ADD COLUMN     "exploration_id" UUID,
ADD COLUMN     "revision_of_id" UUID;

-- CreateTable
CREATE TABLE "story_explorations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "pack_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "based_on_architecture_id" UUID,
    "content" JSONB NOT NULL,
    "quality_report" JSONB,
    "quality_passed" BOOLEAN NOT NULL DEFAULT false,
    "stats" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "job_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_explorations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "story_explorations_project_id_version_key" ON "story_explorations"("project_id", "version");

-- CreateIndex
CREATE INDEX "story_architectures_revision_of_id_idx" ON "story_architectures"("revision_of_id");

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_revision_of_id_fkey" FOREIGN KEY ("revision_of_id") REFERENCES "story_architectures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_exploration_id_fkey" FOREIGN KEY ("exploration_id") REFERENCES "story_explorations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_explorations" ADD CONSTRAINT "story_explorations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_explorations" ADD CONSTRAINT "story_explorations_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "story_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_explorations" ADD CONSTRAINT "story_explorations_based_on_architecture_id_fkey" FOREIGN KEY ("based_on_architecture_id") REFERENCES "story_architectures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_explorations" ADD CONSTRAINT "story_explorations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
