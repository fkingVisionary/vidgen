-- Voice Engine 1.0 for production: takes awaiting review (IN_REVIEW), the EXPRESSIVE performance
-- strategy, the hash of the exact text sent, and the variant label of an A/B take.
-- Additive only: no existing table or value is changed or removed. The new enum values are not
-- used in this file (PostgreSQL cannot use a value added in the same transaction).

-- AlterEnum
ALTER TYPE "VoiceGenerationStatus" ADD VALUE 'IN_REVIEW' AFTER 'GENERATED';

-- AlterEnum
ALTER TYPE "PerformanceStrategy" ADD VALUE 'EXPRESSIVE' AFTER 'RESTRAINED';

-- AlterTable
ALTER TABLE "voice_generations" ADD COLUMN     "performance_text_hash" TEXT,
ADD COLUMN     "variant" TEXT;
