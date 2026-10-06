-- Voice Engine V1, saved voice profiles: profile families with immutable versions, a project's choice of profile
-- per language version with its own overrides, and what each run and take was made with.
-- Additive only: new tables and nullable columns; no existing column, row value or enum changes. The backfill
-- makes one family per existing profile name, provider and language (its versions keep their names and numbers);
-- for each provider and language, the family of the newest active version (the one new runs used) is the library
-- default.

-- AlterTable
ALTER TABLE "voice_generations" ADD COLUMN     "config" JSONB;

-- AlterTable
ALTER TABLE "voice_profiles" ADD COLUMN     "based_on_id" UUID,
ADD COLUMN     "family_id" UUID,
ADD COLUMN     "origin" JSONB;

-- AlterTable
ALTER TABLE "voice_runs" ADD COLUMN     "config" JSONB;

-- CreateTable
CREATE TABLE "voice_profile_families" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_profile_families_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_selections" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "language_version_id" UUID NOT NULL,
    "family_id" UUID,
    "pinned_version_id" UUID,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_selections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_profile_families_name_key" ON "voice_profile_families"("name");

-- CreateIndex
CREATE UNIQUE INDEX "voice_selections_language_version_id_key" ON "voice_selections"("language_version_id");

-- CreateIndex
CREATE INDEX "voice_selections_family_id_idx" ON "voice_selections"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_profiles_family_id_version_key" ON "voice_profiles"("family_id", "version");

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "voice_profile_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_based_on_id_fkey" FOREIGN KEY ("based_on_id") REFERENCES "voice_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_selections" ADD CONSTRAINT "voice_selections_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_selections" ADD CONSTRAINT "voice_selections_language_version_id_fkey" FOREIGN KEY ("language_version_id") REFERENCES "language_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_selections" ADD CONSTRAINT "voice_selections_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "voice_profile_families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_selections" ADD CONSTRAINT "voice_selections_pinned_version_id_fkey" FOREIGN KEY ("pinned_version_id") REFERENCES "voice_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill: one family per name, provider and language; a name used for several gets "(provider, language)" after it.
CREATE TEMP TABLE "_voice_profile_family_map" AS
SELECT gen_random_uuid() AS "id", "name", "provider", "language",
       CASE WHEN count(*) OVER (PARTITION BY "name") > 1 THEN "name" || ' (' || "provider" || ', ' || "language" || ')' ELSE "name" END AS "family_name",
       (array_agg("created_by" ORDER BY "version"))[1] AS "created_by", min("created_at") AS "created_at", max("created_at") AS "updated_at"
FROM "voice_profiles" GROUP BY "name", "provider", "language";

-- The library default per provider and language: the family of the newest active version (what new runs used).
INSERT INTO "voice_profile_families" ("id", "name", "is_default", "created_by", "created_at", "updated_at")
SELECT m."id", m."family_name",
       EXISTS (SELECT 1 FROM (SELECT DISTINCT ON ("provider", "language") "name", "provider", "language" FROM "voice_profiles" WHERE "active" ORDER BY "provider", "language", "created_at" DESC, "id" DESC) d
               WHERE d."name" = m."name" AND d."provider" = m."provider" AND d."language" = m."language"),
       m."created_by", m."created_at", m."updated_at"
FROM "_voice_profile_family_map" m;

UPDATE "voice_profiles" p SET "family_id" = m."id"
FROM "_voice_profile_family_map" m WHERE p."name" = m."name" AND p."provider" = m."provider" AND p."language" = m."language";

DROP TABLE "_voice_profile_family_map";
