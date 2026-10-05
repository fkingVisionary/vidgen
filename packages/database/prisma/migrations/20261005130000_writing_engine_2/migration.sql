-- Writing Engine 2: house-style examples proposed from approved scripts (candidates until a
-- person approves them). Script versions keep the narration pass's record in scripts.content
-- (JSON, optional). Additive only: no existing table or value is changed or removed.

-- CreateEnum
CREATE TYPE "WritingExampleStatus" AS ENUM ('CANDIDATE', 'APPROVED', 'REJECTED', 'RETIRED');

-- CreateTable
CREATE TABLE "writing_examples" (
    "id" UUID NOT NULL,
    "example_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "project_id" UUID,
    "script_id" UUID,
    "script_version" INTEGER,
    "block_key" TEXT,
    "text" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "quality" TEXT NOT NULL,
    "traits" TEXT[],
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "spoken_rhythm" TEXT NOT NULL,
    "narrative_function" TEXT NOT NULL,
    "why_it_works" TEXT,
    "why_it_fails" TEXT,
    "source_type" TEXT NOT NULL,
    "source_reference" TEXT,
    "copyright_safe" BOOLEAN NOT NULL DEFAULT true,
    "approved_for_retrieval" BOOLEAN NOT NULL DEFAULT false,
    "status" "WritingExampleStatus" NOT NULL DEFAULT 'CANDIDATE',
    "diagnostics" JSONB NOT NULL DEFAULT '{}',
    "created_by" TEXT NOT NULL,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "writing_examples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "writing_examples_example_id_key" ON "writing_examples"("example_id");

-- CreateIndex
CREATE UNIQUE INDEX "writing_examples_text_hash_key" ON "writing_examples"("text_hash");

-- CreateIndex
CREATE INDEX "writing_examples_status_idx" ON "writing_examples"("status");

-- CreateIndex
CREATE INDEX "writing_examples_project_id_idx" ON "writing_examples"("project_id");

-- AddForeignKey
ALTER TABLE "writing_examples" ADD CONSTRAINT "writing_examples_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "writing_examples" ADD CONSTRAINT "writing_examples_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
