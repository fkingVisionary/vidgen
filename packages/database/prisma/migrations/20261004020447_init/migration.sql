-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('IDEA', 'RESEARCHING', 'RESEARCH_REVIEW', 'RESEARCH_COMPLETE', 'STORY_DEVELOPMENT', 'SCRIPT_DRAFT', 'SCRIPT_REVIEW', 'SCRIPT_APPROVED', 'VOICE_GENERATING', 'VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'VISUAL_GENERATING', 'VISUAL_REVIEW', 'EDITING', 'RENDERING', 'QA', 'APPROVED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('RESEARCH', 'STORY', 'SCRIPT', 'VOICE', 'VISUAL_PLAN', 'VISUAL_GENERATION', 'INFOGRAPHIC', 'EDIT', 'RENDER', 'QA', 'PUBLISH');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalGate" AS ENUM ('RESEARCH', 'SCRIPT', 'STORYBOARD', 'VISUAL_ASSETS', 'FINAL_VIDEO');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SourceType" AS ENUM ('PRIMARY', 'ACADEMIC', 'BOOK', 'ARCHIVE', 'REPUTABLE_SECONDARY', 'GENERAL_REFERENCE');

-- CreateEnum
CREATE TYPE "ClaimVerdict" AS ENUM ('ESTABLISHED', 'PROBABLE', 'DISPUTED', 'UNVERIFIED', 'MYTH');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('EVENT', 'DATE', 'ECONOMIC_FIGURE', 'PERSON', 'QUOTE', 'INTERPRETATION', 'CONTEXT');

-- CreateEnum
CREATE TYPE "CitationStance" AS ENUM ('SUPPORTS', 'CONTRADICTS', 'CONTEXT');

-- CreateEnum
CREATE TYPE "VisualType" AS ENUM ('CINEMATIC_RECONSTRUCTION', 'ARCHIVAL_STYLE', 'MAP', 'INFOGRAPHIC', 'DOCUMENT', 'COIN_CLOSEUP', 'ENVIRONMENT', 'CHARACTER', 'MACRO', 'ABSTRACT', 'TEXT', 'CHART');

-- CreateEnum
CREATE TYPE "ShotType" AS ENUM ('EXTREME_WIDE', 'WIDE', 'MEDIUM', 'CLOSE_UP', 'EXTREME_CLOSE_UP', 'MACRO', 'OVERHEAD', 'INSERT');

-- CreateEnum
CREATE TYPE "CameraMotion" AS ENUM ('STATIC', 'PUSH_IN', 'PULL_OUT', 'PAN', 'TILT', 'TRACKING', 'DOLLY', 'CRANE', 'HANDHELD', 'ORBIT');

-- CreateEnum
CREATE TYPE "ShotStatus" AS ENUM ('PLANNED', 'GENERATING', 'GENERATED', 'APPROVED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "InfographicType" AS ENUM ('LINE_CHART', 'BAR_CHART', 'TIMELINE', 'MAP', 'FLOW_DIAGRAM', 'NUMBER_COUNTER', 'COMPARISON', 'PRICE_CHANGE', 'ECONOMIC_CYCLE');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('NARRATION_AUDIO', 'IMAGE', 'VIDEO_CLIP', 'INFOGRAPHIC', 'MUSIC', 'SFX', 'AMBIENCE', 'SUBTITLE', 'RENDER', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "RenderStatus" AS ENUM ('QUEUED', 'RENDERING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('AI', 'RESEARCH', 'VOICE', 'VIDEO', 'STORAGE', 'RENDER', 'PUBLISHING');

-- CreateEnum
CREATE TYPE "ProviderCallStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "LanguageVersionStatus" AS ENUM ('PLANNED', 'IN_PRODUCTION', 'READY', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "working_title" TEXT,
    "topic" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "style" TEXT,
    "target_minutes_min" INTEGER NOT NULL DEFAULT 10,
    "target_minutes_max" INTEGER NOT NULL DEFAULT 15,
    "master_language" TEXT NOT NULL DEFAULT 'en',
    "status" "ProjectStatus" NOT NULL DEFAULT 'IDEA',
    "failed_from_status" "ProjectStatus",
    "phase_seq" INTEGER NOT NULL DEFAULT 0,
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estimated_cost_usd" DECIMAL(14,6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "language_versions" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language" TEXT NOT NULL,
    "status" "LanguageVersionStatus" NOT NULL DEFAULT 'PLANNED',
    "voice_config" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "platform_video_id" TEXT,
    "published_url" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "language_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID,
    "type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "phase_seq" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "input" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID,
    "gate" "ApprovalGate" NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "notes" TEXT,
    "decided_by" TEXT,
    "project_status" "ProjectStatus" NOT NULL,
    "dossier_id" UUID,
    "script_id" UUID,
    "storyboard_id" UUID,
    "render_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_events" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "job_id" UUID,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_calls" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "job_id" UUID,
    "language_version_id" UUID,
    "shot_id" UUID,
    "kind" "ProviderKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "model" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProviderCallStatus" NOT NULL DEFAULT 'PENDING',
    "provider_job_id" TEXT,
    "request" JSONB,
    "response" JSONB,
    "error" TEXT,
    "usage" JSONB NOT NULL DEFAULT '[]',
    "estimated_cost_usd" DECIMAL(14,6),
    "actual_cost_usd" DECIMAL(14,6),
    "output_asset_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,

    CONSTRAINT "provider_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID,
    "kind" "AssetKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "checksum_sha256" TEXT,
    "provider" TEXT,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_type" "SourceType" NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT,
    "publisher" TEXT,
    "published_date" TEXT,
    "url" TEXT,
    "citation" TEXT NOT NULL,
    "reliability_notes" TEXT,
    "notes" TEXT,
    "accessed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_dossiers" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT,
    "content" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_dossiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "research_claims" (
    "id" UUID NOT NULL,
    "dossier_id" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "claim_type" "ClaimType" NOT NULL,
    "verdict" "ClaimVerdict" NOT NULL DEFAULT 'UNVERIFIED',
    "confidence" "ConfidenceLevel" NOT NULL DEFAULT 'LOW',
    "needs_verification" BOOLEAN NOT NULL DEFAULT true,
    "popular_version" TEXT,
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "research_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_citations" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "stance" "CitationStance" NOT NULL DEFAULT 'SUPPORTS',
    "locator" TEXT,
    "quote" TEXT,
    "notes" TEXT,

    CONSTRAINT "claim_citations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_architectures" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "dossier_id" UUID,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "beats" JSONB NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "story_architectures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scripts" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "story_id" UUID,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT,
    "estimated_duration_sec" INTEGER,
    "scores" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenes" (
    "id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "scene_key" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "title" TEXT,
    "emotional_tone" TEXT,
    "visual_intent" TEXT,
    "infographic_opportunity" TEXT,
    "sound_design_opportunity" TEXT,
    "target_duration_sec" DOUBLE PRECISION,

    CONSTRAINT "scenes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scene_narrations" (
    "id" UUID NOT NULL,
    "scene_id" UUID NOT NULL,
    "language_version_id" UUID NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "text" TEXT NOT NULL,
    "word_count" INTEGER NOT NULL,
    "estimated_duration_sec" DOUBLE PRECISION,
    "audio_asset_id" UUID,
    "audio_duration_ms" INTEGER,
    "alignment" JSONB,
    "voice_settings" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scene_narrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storyboards" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "script_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "storyboards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shots" (
    "id" UUID NOT NULL,
    "storyboard_id" UUID NOT NULL,
    "scene_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "narration_anchor" TEXT,
    "visual_type" "VisualType" NOT NULL,
    "shot_type" "ShotType",
    "camera_motion" "CameraMotion",
    "direction" JSONB NOT NULL DEFAULT '{}',
    "generation_prompt" TEXT,
    "negative_prompt" TEXT,
    "status" "ShotStatus" NOT NULL DEFAULT 'PLANNED',
    "selected_asset_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "shots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "infographics" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "scene_id" UUID,
    "infographic_type" "InfographicType" NOT NULL,
    "title" TEXT NOT NULL,
    "spec" JSONB NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "asset_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "infographics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timelines" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID NOT NULL,
    "storyboard_id" UUID,
    "version" INTEGER NOT NULL,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "duration_ms" INTEGER,
    "tracks" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renders" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID NOT NULL,
    "timeline_id" UUID,
    "status" "RenderStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT NOT NULL,
    "is_mock" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "output_asset_id" UUID,
    "duration_ms" INTEGER,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "renders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qa_reports" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID,
    "render_id" UUID,
    "overall_score" INTEGER,
    "has_blocking_errors" BOOLEAN NOT NULL DEFAULT false,
    "findings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qa_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE UNIQUE INDEX "language_versions_project_id_language_key" ON "language_versions"("project_id", "language");

-- CreateIndex
CREATE INDEX "jobs_status_run_after_idx" ON "jobs"("status", "run_after");

-- CreateIndex
CREATE INDEX "jobs_project_id_type_status_idx" ON "jobs"("project_id", "type", "status");

-- CreateIndex
CREATE INDEX "approvals_project_id_created_at_idx" ON "approvals"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "project_events_project_id_created_at_idx" ON "project_events"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "provider_calls_project_id_idx" ON "provider_calls"("project_id");

-- CreateIndex
CREATE INDEX "provider_calls_job_id_idx" ON "provider_calls"("job_id");

-- CreateIndex
CREATE INDEX "provider_calls_provider_provider_job_id_idx" ON "provider_calls"("provider", "provider_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"("storage_key");

-- CreateIndex
CREATE INDEX "media_assets_project_id_kind_idx" ON "media_assets"("project_id", "kind");

-- CreateIndex
CREATE INDEX "sources_project_id_idx" ON "sources"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "research_dossiers_project_id_version_key" ON "research_dossiers"("project_id", "version");

-- CreateIndex
CREATE INDEX "research_claims_dossier_id_idx" ON "research_claims"("dossier_id");

-- CreateIndex
CREATE INDEX "claim_citations_claim_id_idx" ON "claim_citations"("claim_id");

-- CreateIndex
CREATE INDEX "claim_citations_source_id_idx" ON "claim_citations"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "story_architectures_project_id_version_key" ON "story_architectures"("project_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "scripts_project_id_version_key" ON "scripts"("project_id", "version");

-- CreateIndex
CREATE INDEX "scenes_script_id_sort_order_idx" ON "scenes"("script_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "scenes_script_id_scene_key_key" ON "scenes"("script_id", "scene_key");

-- CreateIndex
CREATE UNIQUE INDEX "scene_narrations_audio_asset_id_key" ON "scene_narrations"("audio_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "scene_narrations_scene_id_language_version_id_key" ON "scene_narrations"("scene_id", "language_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "storyboards_project_id_version_key" ON "storyboards"("project_id", "version");

-- CreateIndex
CREATE INDEX "shots_storyboard_id_sort_order_idx" ON "shots"("storyboard_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "timelines_language_version_id_version_key" ON "timelines"("language_version_id", "version");

-- CreateIndex
CREATE INDEX "renders_project_id_idx" ON "renders"("project_id");

-- CreateIndex
CREATE INDEX "qa_reports_project_id_idx" ON "qa_reports"("project_id");

-- AddForeignKey
ALTER TABLE "language_versions" ADD CONSTRAINT "language_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_render_id_fkey" FOREIGN KEY ("render_id") REFERENCES "renders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_shot_id_fkey" FOREIGN KEY ("shot_id") REFERENCES "shots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_output_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_dossiers" ADD CONSTRAINT "research_dossiers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "research_claims" ADD CONSTRAINT "research_claims_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_citations" ADD CONSTRAINT "claim_citations_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "research_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_citations" ADD CONSTRAINT "claim_citations_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_architectures" ADD CONSTRAINT "story_architectures_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "research_dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "story_architectures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_narrations" ADD CONSTRAINT "scene_narrations_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_narrations" ADD CONSTRAINT "scene_narrations_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scene_narrations" ADD CONSTRAINT "scene_narrations_audio_asset_id_fkey" FOREIGN KEY ("audio_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shots" ADD CONSTRAINT "shots_selected_asset_id_fkey" FOREIGN KEY ("selected_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infographics" ADD CONSTRAINT "infographics_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infographics" ADD CONSTRAINT "infographics_scene_id_fkey" FOREIGN KEY ("scene_id") REFERENCES "scenes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "infographics" ADD CONSTRAINT "infographics_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timelines" ADD CONSTRAINT "timelines_storyboard_id_fkey" FOREIGN KEY ("storyboard_id") REFERENCES "storyboards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_timeline_id_fkey" FOREIGN KEY ("timeline_id") REFERENCES "timelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_output_asset_id_fkey" FOREIGN KEY ("output_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qa_reports" ADD CONSTRAINT "qa_reports_render_id_fkey" FOREIGN KEY ("render_id") REFERENCES "renders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
