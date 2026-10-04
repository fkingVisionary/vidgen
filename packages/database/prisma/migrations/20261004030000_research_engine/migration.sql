-- CreateEnum
CREATE TYPE "RetrievalStatus" AS ENUM ('PENDING', 'RETRIEVED', 'FAILED');

-- CreateEnum
CREATE TYPE "ClaimImportance" AS ENUM ('KEY', 'SUPPORTING', 'BACKGROUND');

-- CreateEnum
CREATE TYPE "CitationBasis" AS ENUM ('FULL_TEXT', 'SNIPPET');

-- CreateEnum
CREATE TYPE "CostBasis" AS ENUM ('VENDOR_REPORTED', 'ESTIMATED', 'UNPRICED', 'MOCK');

-- AlterEnum
ALTER TYPE "SourceType" ADD VALUE 'GENERAL_WEB';

-- AlterTable
ALTER TABLE "claim_citations" ADD COLUMN     "basis" "CitationBasis" NOT NULL DEFAULT 'FULL_TEXT',
ADD COLUMN     "evidence_key" TEXT,
ADD COLUMN     "quote_verified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "provider_calls" ADD COLUMN     "cost_basis" "CostBasis",
ADD COLUMN     "cost_note" TEXT,
ADD COLUMN     "provider_request_id" TEXT;

-- AlterTable
ALTER TABLE "research_claims" ADD COLUMN     "category" TEXT,
ADD COLUMN     "claim_key" TEXT NOT NULL,
ADD COLUMN     "importance" "ClaimImportance" NOT NULL DEFAULT 'SUPPORTING';

-- AlterTable
ALTER TABLE "research_dossiers" ADD COLUMN     "job_id" UUID,
ADD COLUMN     "quality_passed" BOOLEAN,
ADD COLUMN     "quality_report" JSONB,
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "sources" ADD COLUMN     "discovered_by" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "domain" TEXT,
ADD COLUMN     "duplicate_of_id" UUID,
ADD COLUMN     "normalized_url" TEXT,
ADD COLUMN     "reliability" "ConfidenceLevel",
ADD COLUMN     "retrieval_error" TEXT,
ADD COLUMN     "retrieval_status" "RetrievalStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "search_score" DOUBLE PRECISION,
ADD COLUMN     "search_snippet" TEXT;

-- CreateTable
CREATE TABLE "source_documents" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "content_format" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analysis" JSONB,
    "analysis_version" TEXT,
    "analyzed_at" TIMESTAMPTZ(3),

    CONSTRAINT "source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_documents_source_id_key" ON "source_documents"("source_id");

-- CreateIndex
CREATE INDEX "source_documents_sha256_idx" ON "source_documents"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "research_claims_dossier_id_claim_key_key" ON "research_claims"("dossier_id", "claim_key");

-- CreateIndex
CREATE UNIQUE INDEX "sources_project_id_normalized_url_key" ON "sources"("project_id", "normalized_url");

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_duplicate_of_id_fkey" FOREIGN KEY ("duplicate_of_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_dossiers" ADD CONSTRAINT "research_dossiers_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

