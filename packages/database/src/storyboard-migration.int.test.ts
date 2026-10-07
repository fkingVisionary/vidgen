import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_STATUSES } from '@docengine/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from './testing.ts';

/**
 * The storyboard migration (20261007090000) against rows shaped like what an
 * older pipeline could have left: a throwaway database migrated to the
 * release before it, given storyboards in every ArtifactStatus with mock-era
 * shots (a visual type, no treatment), an approval and a timeline naming a
 * storyboard, then this migration. It must only add: every existing value
 * stays as it was (storyboards.status is cast in place), and the new columns,
 * tables, indexes and keys behave as schema.prisma says.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const MIGRATION = '20261007090000_storyboard_engine';
/** The last migration production had before this one. */
const BEFORE = '20261006120000_voice_saved_profiles';

const base = new URL(assertTestDatabaseUrl(process.env.TEST_DATABASE_URL));
const throwaway = new URL(base.toString());
throwaway.pathname = `/${base.pathname.slice(1)}_storyboard_${process.pid}`;
const url = assertTestDatabaseUrl(throwaway.toString());
const dbName = throwaway.pathname.slice(1);

const id = (n: number) => `01a10f00-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const LANGUAGE_VERSION = id(2);
const SCRIPT = id(3);
const SCENE = id(4);
const NARRATION = id(5);
const BLOCK = id(6);
const DOSSIER = id(7);
const CLAIM = id(8);
const OTHER_CLAIM = id(9);
const storyboard = (n: number) => id(100 + n);
const shot = (n: number) => id(200 + n);

/** Columns the migration adds to existing tables (left out when comparing what was there). */
const ADDED: Record<string, string[]> = {
  storyboards: [
    'story_id',
    'language_version_id',
    'voice_run_id',
    'voice_assembly_id',
    'assembly_version',
    'narration_fingerprint',
    'visual_profile_id',
    'engine_version',
    'scope',
    'revision_of_id',
    'job_id',
    'content',
    'qa',
    'qa_passed',
    'runtime_ms',
    'beat_count',
    'shot_count',
    'estimated_cost_usd',
    'cost_basis',
    'unpriced_shot_count',
    'decided_by',
    'decided_at',
    'created_by',
  ],
  shots: ['beat_id', 'shot_key', 'start_ms', 'end_ms', 'timing_relation', 'timing', 'treatment', 'production_method', 'info_class', 'asset_requirement', 'evidence', 'cost_estimate', 'estimated_cost_usd', 'cost_basis', 'content_hash'],
};

const NEW_TABLES = [
  'continuity_subjects',
  'shot_blocks',
  'shot_claims',
  'shot_subjects',
  'storyboard_decisions',
  'visual_beat_blocks',
  'visual_beat_claims',
  'visual_beats',
  'visual_profile_families',
  'visual_profiles',
  'visual_selections',
];

function psql(args: string[]): string {
  const r = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`psql could not be run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

const migrationFile = (dir: string) => `${MIGRATIONS}${dir}/migration.sql`;
const json = (v: unknown) => JSON.stringify(v);

async function connect(target: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: target });
  await c.connect();
  return c;
}

/** Every row of every table, as JSON text in a stable order, without the columns this migration adds. */
async function snapshot(c: pg.Client, tables: readonly string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const minus = (ADDED[t] ?? []).map((col) => ` - '${col}'`).join('');
    const { rows } = await c.query<{ row: string }>(`SELECT (to_jsonb(r)${minus})::text AS "row" FROM "${t}" r ORDER BY 1`);
    out[t] = rows.map((r) => r.row);
  }
  return out;
}

async function fill(c: pg.Client): Promise<void> {
  const at = '2026-10-05T12:00:00Z';
  await c.query(`INSERT INTO "projects" ("id", "slug", "title", "topic", "status", "updated_at") VALUES ($1, 'harbour-fire', 'The Harbour Fire', 'A harbour fire of 1782', 'VISUAL_GENERATING', $2)`, [PROJECT, at]);
  await c.query(`INSERT INTO "language_versions" ("id", "project_id", "language", "updated_at") VALUES ($1, $2, 'en', $3)`, [LANGUAGE_VERSION, PROJECT, at]);
  await c.query(`INSERT INTO "research_dossiers" ("id", "project_id", "version", "status", "updated_at") VALUES ($1, $2, 1, 'APPROVED', $3)`, [DOSSIER, PROJECT, at]);
  for (const [claim, key] of [
    [CLAIM, 'C001'],
    [OTHER_CLAIM, 'C002'],
  ] as const) {
    await c.query(`INSERT INTO "research_claims" ("id", "dossier_id", "claim_key", "statement", "claim_type", "verdict", "updated_at") VALUES ($1, $2, $3, 'The fire began in a tar store.', 'EVENT', 'ESTABLISHED', $4)`, [claim, DOSSIER, key, at]);
  }
  await c.query(`INSERT INTO "scripts" ("id", "project_id", "version", "status", "updated_at") VALUES ($1, $2, 1, 'APPROVED', $3)`, [SCRIPT, PROJECT, at]);
  await c.query(`INSERT INTO "scenes" ("id", "script_id", "scene_key", "sort_order", "sequence_number") VALUES ($1, $2, 'SC01', 0, 1)`, [SCENE, SCRIPT]);
  await c.query(`INSERT INTO "scene_narrations" ("id", "scene_id", "language_version_id", "text", "word_count", "updated_at") VALUES ($1, $2, $3, 'The quay was quiet.', 4, $4)`, [NARRATION, SCENE, LANGUAGE_VERSION, at]);
  await c.query(
    `INSERT INTO "script_blocks" ("id", "script_id", "narration_id", "block_key", "sort_order", "text", "generated_text", "info_class", "beat_ids", "delivery", "visual", "word_count", "estimated_duration_sec", "updated_at")
     VALUES ($1, $2, $3, '1.1', 0, 'The quay was quiet.', 'The quay was quiet.', 'DOCUMENTED', ARRAY['1.1'], '{}', $4, 4, 1.6, $5)`,
    [BLOCK, SCRIPT, NARRATION, json({ intent: 'ENVIRONMENT', mustShow: [], mustAvoid: [], priority: 'NORMAL', fictional: false, note: '' }), at],
  );
  // A storyboard in every ArtifactStatus, each with a mock-era shot (a visual type, a prompt).
  for (const [i, status] of ARTIFACT_STATUSES.entries()) {
    await c.query(`INSERT INTO "storyboards" ("id", "project_id", "script_id", "version", "status", "notes", "updated_at") VALUES ($1, $2, $3, $4, $5::"ArtifactStatus", 'mock plan', $6)`, [storyboard(i), PROJECT, SCRIPT, i + 1, status, at]);
    await c.query(
      `INSERT INTO "shots" ("id", "storyboard_id", "scene_id", "sort_order", "duration_sec", "narration_anchor", "visual_type", "shot_type", "camera_motion", "direction", "generation_prompt", "updated_at")
       VALUES ($1, $2, $3, 0, 5, 'SC01', 'ENVIRONMENT', 'WIDE', 'PAN', $4, 'A quay at dusk', $5)`,
      [shot(i), storyboard(i), SCENE, json({ lens: '35mm' }), at],
    );
  }
  await c.query(`INSERT INTO "approvals" ("id", "project_id", "gate", "decision", "project_status", "storyboard_id") VALUES ($1, $2, 'STORYBOARD', 'APPROVED', 'STORYBOARD_REVIEW', $3)`, [id(300), PROJECT, storyboard(2)]);
  await c.query(`INSERT INTO "timelines" ("id", "project_id", "language_version_id", "storyboard_id", "version", "updated_at") VALUES ($1, $2, $3, $4, 1, $5)`, [id(301), PROJECT, LANGUAGE_VERSION, storyboard(2), at]);
}

let admin: pg.Client;
let db: pg.Client;
let before: Record<string, string[]>;
let after: Record<string, string[]>;
let tables: string[];
let tablesAfter: string[];

beforeAll(async () => {
  admin = await connect(base.toString());
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const earlier = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name <= BEFORE)
    .map((d) => d.name)
    .sort();
  expect(earlier.at(-1)).toBe(BEFORE);
  for (const dir of earlier) psql(['-f', migrationFile(dir)]);

  db = await connect(url);
  await fill(db);
  const listTables = async () => (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
  tables = await listTables();
  before = await snapshot(db, tables);

  psql(['-f', migrationFile(MIGRATION)]);
  after = await snapshot(db, tables);
  tablesAfter = await listTables();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin?.end();
});

const enumValues = async (type: string) => (await db.query<{ v: string }>(`SELECT unnest(enum_range(NULL::"${type}"))::text AS v`)).rows.map((r) => r.v);

describe(`migration ${MIGRATION} on existing rows`, () => {
  it('changes no value that was there: every row of every table, column by column', () => {
    expect(before.storyboards).toHaveLength(ARTIFACT_STATUSES.length);
    expect(before.shots).toHaveLength(ARTIFACT_STATUSES.length);
    for (const t of tables) expect(after[t], t).toEqual(before[t]);
  });

  it('adds only the new tables, and they start empty (presets are made by code, not by the migration)', async () => {
    expect(tablesAfter.filter((t) => !tables.includes(t))).toEqual(NEW_TABLES);
    for (const t of NEW_TABLES) expect((await db.query(`SELECT 1 FROM "${t}"`)).rowCount, t).toBe(0);
  });

  it('casts storyboards.status in place: every ArtifactStatus row keeps its status, now a StoryboardStatus defaulting to DRAFT', async () => {
    const { rows } = await db.query<{ version: number; status: string; type: string }>(`SELECT "version", "status"::text AS "status", pg_typeof("status")::text AS "type" FROM "storyboards" ORDER BY "version"`);
    expect(rows.map((r) => r.status)).toEqual([...ARTIFACT_STATUSES]);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['"StoryboardStatus"']));
    await db.query(`INSERT INTO "storyboards" ("id", "project_id", "script_id", "version", "updated_at") VALUES ($1, $2, $3, 90, now())`, [storyboard(90), PROJECT, SCRIPT]);
    await db.query(`INSERT INTO "storyboards" ("id", "project_id", "script_id", "version", "status", "updated_at") VALUES ($1, $2, $3, 91, 'CHANGES_REQUESTED', now())`, [storyboard(91), PROJECT, SCRIPT]);
    const added = await db.query<{ version: number; status: string }>(`SELECT "version", "status"::text AS "status" FROM "storyboards" WHERE "version" >= 90 ORDER BY 1`);
    expect(added.rows).toEqual([
      { version: 90, status: 'DRAFT' },
      { version: 91, status: 'CHANGES_REQUESTED' },
    ]);
    await db.query(`DELETE FROM "storyboards" WHERE "version" >= 90`);
  });

  it('gives existing storyboards the new columns empty or at their defaults', async () => {
    const { rows } = await db.query(`SELECT * FROM "storyboards" ORDER BY "version"`);
    for (const r of rows) {
      expect(r).toMatchObject({ engine_version: 1, scope: 'FULL', content: {}, qa: [], qa_passed: false, beat_count: 0, shot_count: 0, unpriced_shot_count: 0 });
      for (const col of ['story_id', 'language_version_id', 'voice_run_id', 'voice_assembly_id', 'assembly_version', 'narration_fingerprint', 'visual_profile_id', 'revision_of_id', 'job_id', 'runtime_ms', 'estimated_cost_usd', 'cost_basis', 'decided_by', 'decided_at', 'created_by']) {
        expect(r[col], col).toBeNull();
      }
    }
  });

  it('keeps mock-era shots as they were (new columns null) and makes the deprecated visual type optional', async () => {
    const { rows } = await db.query(`SELECT * FROM "shots" ORDER BY "id"`);
    for (const r of rows) {
      expect(r).toMatchObject({ visual_type: 'ENVIRONMENT', status: 'PLANNED', generation_prompt: 'A quay at dusk' });
      for (const col of ADDED.shots!) expect(r[col], col).toBeNull();
    }
    await db.query(`INSERT INTO "shots" ("id", "storyboard_id", "scene_id", "sort_order", "duration_sec", "updated_at") VALUES ($1, $2, $3, 1, 3, now())`, [shot(90), storyboard(0), SCENE]);
    expect((await db.query(`SELECT "visual_type" FROM "shots" WHERE "id" = $1`, [shot(90)])).rows[0]).toEqual({ visual_type: null });
    await db.query(`DELETE FROM "shots" WHERE "id" = $1`, [shot(90)]);
  });

  it('adds STORYBOARD_APPROVED and STORYBOARD_PREVIEW in pipeline order, usable once committed', async () => {
    const statuses = await enumValues('ProjectStatus');
    expect(statuses.slice(statuses.indexOf('STORYBOARD_REVIEW'), statuses.indexOf('STORYBOARD_REVIEW') + 3)).toEqual(['STORYBOARD_REVIEW', 'STORYBOARD_APPROVED', 'VISUAL_GENERATING']);
    const jobs = await enumValues('JobType');
    expect(jobs.slice(jobs.indexOf('VISUAL_PLAN'), jobs.indexOf('VISUAL_PLAN') + 3)).toEqual(['VISUAL_PLAN', 'STORYBOARD_PREVIEW', 'VISUAL_GENERATION']);
    await db.query(`INSERT INTO "jobs" ("id", "project_id", "type", "phase_seq", "updated_at") VALUES ($1, $2, 'STORYBOARD_PREVIEW', 0, now())`, [id(302), PROJECT]);
    await db.query(`DELETE FROM "jobs" WHERE "id" = $1`, [id(302)]);
    expect(await enumValues('StoryboardStatus')).toEqual(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'SUPERSEDED']);
  });
});

describe('the new storyboard tables', () => {
  const BEAT = id(400);
  const SUBJECT = id(401);
  const FAMILY = id(402);
  const PROFILE = id(403);

  beforeAll(async () => {
    await db.query(`INSERT INTO "visual_profile_families" ("id", "name", "is_default") VALUES ($1, 'Cinematic History', true)`, [FAMILY]);
    await db.query(`INSERT INTO "visual_profiles" ("id", "family_id", "version", "name", "config", "origin") VALUES ($1, $2, 1, 'Cinematic History', '{}', $3)`, [PROFILE, FAMILY, json({ kind: 'PRESET', preset: 'cinematic-history' })]);
    await db.query(`UPDATE "storyboards" SET "visual_profile_id" = $1, "scope" = 'PARTIAL', "status" = 'IN_REVIEW' WHERE "id" = $2`, [PROFILE, storyboard(1)]);
    await db.query(
      `INSERT INTO "visual_beats" ("id", "storyboard_id", "beat_key", "sort_order", "scene_id", "sequence_number", "arch_beat_ids", "start_ms", "end_ms", "treatment", "info_class", "content", "content_hash")
       VALUES ($1, $2, 'VB01', 0, $3, 1, ARRAY['1.1'], 0, 1600, 'ENVIRONMENT', 'DOCUMENTED', '{}', 'hash')`,
      [BEAT, storyboard(1), SCENE],
    );
    await db.query(
      `UPDATE "shots" SET "beat_id" = $1, "shot_key" = 'SH001', "start_ms" = 0, "end_ms" = 1600, "timing_relation" = 'TIMED_TO_NARRATION', "treatment" = 'ENVIRONMENT', "production_method" = 'GENERATIVE_IMAGE', "info_class" = 'DOCUMENTED', "cost_basis" = 'UNPRICED' WHERE "id" = $2`,
      [BEAT, shot(1)],
    );
    await db.query(`INSERT INTO "visual_beat_blocks" ("beat_id", "script_block_id", "start_ms", "end_ms", "first_word", "last_word") VALUES ($1, $2, 0, 1600, 0, 3)`, [BEAT, BLOCK]);
    await db.query(`INSERT INTO "shot_blocks" ("shot_id", "script_block_id", "start_ms", "end_ms", "first_word", "last_word") VALUES ($1, $2, 0, 1600, 0, 3)`, [shot(1), BLOCK]);
    await db.query(`INSERT INTO "visual_beat_claims" ("beat_id", "claim_id") VALUES ($1, $2)`, [BEAT, CLAIM]);
    await db.query(`INSERT INTO "shot_claims" ("shot_id", "claim_id", "role") VALUES ($1, $2, 'DEPICTS'), ($1, $2, 'CONTEXT')`, [shot(1), CLAIM]);
    await db.query(`INSERT INTO "continuity_subjects" ("id", "storyboard_id", "subject_key", "kind", "name", "info_class", "spec", "content_hash") VALUES ($1, $2, 'CS01', 'ENVIRONMENT', 'The quay', 'DOCUMENTED', '{}', 'hash')`, [SUBJECT, storyboard(1)]);
    await db.query(`INSERT INTO "shot_subjects" ("shot_id", "subject_id", "detail") VALUES ($1, $2, '{}')`, [shot(1), SUBJECT]);
    await db.query(`INSERT INTO "storyboard_decisions" ("id", "project_id", "storyboard_id", "shot_id", "decision", "decided_by") VALUES ($1, $2, $3, $4, 'APPROVED', 'editor')`, [id(404), PROJECT, storyboard(1), shot(1)]);
    await db.query(`INSERT INTO "visual_selections" ("id", "project_id", "family_id") VALUES ($1, $2, $3)`, [id(405), PROJECT, FAMILY]);
  });

  it('keeps lineage keys unique within a version: shot, beat and continuity subject keys', async () => {
    await expect(db.query(`UPDATE "shots" SET "shot_key" = 'SH001' WHERE "id" = $1`, [shot(3)])).resolves.toBeDefined();
    await expect(db.query(`UPDATE "shots" SET "storyboard_id" = $1 WHERE "id" = $2`, [storyboard(1), shot(3)])).rejects.toMatchObject({ code: '23505', constraint: 'shots_storyboard_id_shot_key_key' });
    await expect(
      db.query(`INSERT INTO "visual_beats" ("id", "storyboard_id", "beat_key", "sort_order", "scene_id", "start_ms", "end_ms", "treatment", "info_class", "content", "content_hash") VALUES ($1, $2, 'VB01', 1, $3, 0, 1, 'TRANSITION', 'FRAMING', '{}', 'h')`, [id(410), storyboard(1), SCENE]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'visual_beats_storyboard_id_beat_key_key' });
    await expect(
      db.query(`INSERT INTO "continuity_subjects" ("id", "storyboard_id", "subject_key", "kind", "name", "info_class", "spec", "content_hash") VALUES ($1, $2, 'CS01', 'OBJECT', 'x', 'FRAMING', '{}', 'h')`, [id(411), storyboard(1)]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'continuity_subjects_storyboard_id_subject_key_key' });
    // Shots without a key (mock-era rows) do not collide.
    expect((await db.query(`SELECT count(*)::int AS n FROM "shots" WHERE "shot_key" IS NULL`)).rows[0]).toEqual({ n: ARTIFACT_STATUSES.length - 2 });
  });

  it('keeps one visual selection per project and one version number per profile', async () => {
    await expect(db.query(`INSERT INTO "visual_selections" ("id", "project_id") VALUES ($1, $2)`, [id(412), PROJECT])).rejects.toMatchObject({ code: '23505', constraint: 'visual_selections_project_id_key' });
    await expect(db.query(`INSERT INTO "visual_profiles" ("id", "family_id", "version", "name", "config", "origin") VALUES ($1, $2, 1, 'x', '{}', '{}')`, [id(413), FAMILY])).rejects.toMatchObject({
      code: '23505',
      constraint: 'visual_profiles_family_id_version_key',
    });
  });

  it('never deletes a profile version a storyboard was planned with, nor a family with versions', async () => {
    await expect(db.query(`DELETE FROM "visual_profiles" WHERE "id" = $1`, [PROFILE])).rejects.toMatchObject({ code: '23503' });
    await expect(db.query(`DELETE FROM "visual_profile_families" WHERE "id" = $1`, [FAMILY])).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses to delete a claim a storyboard links (checked at commit), and keeps unlinked claims deletable', async () => {
    await expect(db.query(`DELETE FROM "research_claims" WHERE "id" = $1`, [CLAIM])).rejects.toMatchObject({ code: '23503' });
    await db.query('BEGIN');
    await db.query(`DELETE FROM "research_claims" WHERE "id" = $1`, [CLAIM]);
    await expect(db.query('COMMIT')).rejects.toMatchObject({ code: '23503' });
    expect((await db.query(`SELECT 1 FROM "research_claims" WHERE "id" = $1`, [CLAIM])).rowCount).toBe(1);
    expect((await db.query(`SELECT 1 FROM "shot_claims" WHERE "claim_id" = $1`, [CLAIM])).rowCount).toBe(2);
    await db.query(`DELETE FROM "research_claims" WHERE "id" = $1`, [OTHER_CLAIM]);
  });

  it('removes a version with everything in it, and a project with all its storyboards, claims and links', async () => {
    const counts = async () =>
      (
        await db.query<Record<string, number>>(
          `SELECT ${['visual_beats', 'visual_beat_blocks', 'visual_beat_claims', 'shots', 'shot_blocks', 'shot_claims', 'shot_subjects', 'continuity_subjects', 'storyboard_decisions'].map((t) => `(SELECT count(*)::int FROM "${t}") AS "${t}"`).join(', ')}`,
        )
      ).rows[0]!;
    expect(await counts()).toMatchObject({ visual_beats: 1, visual_beat_claims: 1, shot_claims: 2, shot_subjects: 1, storyboard_decisions: 1 });
    await db.query(`DELETE FROM "projects" WHERE "id" = $1`, [PROJECT]);
    expect(Object.values(await counts()).every((n) => n === 0)).toBe(true);
    expect((await db.query(`SELECT 1 FROM "research_claims"`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM "visual_selections"`)).rowCount).toBe(0);
    // Profiles outlive projects.
    expect((await db.query(`SELECT 1 FROM "visual_profiles" WHERE "id" = $1`, [PROFILE])).rowCount).toBe(1);
  });

  it('leaves the database exactly as schema.prisma describes it, with any later migrations applied (Prisma 7 migrate diff: no drift)', () => {
    const later = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name > MIGRATION)
      .map((d) => d.name)
      .sort();
    for (const dir of later) psql(['-f', migrationFile(dir)]);
    const r = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--script', '--exit-code'], {
      cwd: PACKAGE,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  }, 60_000);
});
