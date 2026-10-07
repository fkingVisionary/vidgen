import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from './testing.ts';

/**
 * The saved-profiles migration (20261006120000) against production-shaped
 * rows: a throwaway database migrated to the release before it, filled like
 * production (House narrator v1 and the acceptance experiment's seven runs),
 * then this migration. It must only add: every existing value stays as it
 * was, and the backfill gives each name, provider and language a family.
 */

if (existsSync('.env')) process.loadEnvFile('.env');

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const MIGRATION = '20261006120000_voice_saved_profiles';
/** The last migration production had before this one. */
const BEFORE = '20261006090000_voice_v4_production';

const base = new URL(assertTestDatabaseUrl(process.env.TEST_DATABASE_URL));
const throwaway = new URL(base.toString());
throwaway.pathname = `/${base.pathname.slice(1)}_saved_profiles_${process.pid}`;
const url = assertTestDatabaseUrl(throwaway.toString());
const dbName = throwaway.pathname.slice(1);

const id = (n: number) => `01a10ecc-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = id(1);
const LANGUAGE_VERSION = id(2);
const SCRIPT = id(3);
const HOUSE = id(10);
const ARCHIVE_V1 = id(11);
const ARCHIVE_V2 = id(12);
const TWO_EN = id(13);
const TWO_ES = id(14);
const run = (n: number) => id(100 + n);
const chunk = (n: number) => id(200 + n);
const take = (n: number) => id(300 + n);

/** The voice settings and config every profile had before saved profiles (the earlier shape). */
const SETTINGS = { stability: 0.5, similarity: 0.75, style: 0, speakerBoost: true, speed: 1 };
const HOUSE_CHUNKING = { minWords: 20, maxWords: 30 };
const HOUSE_CONTEXT = { previousChars: 200, nextChars: 120, stitch: false };
const earlierConfig = (settings: Record<string, unknown> = SETTINGS) => ({ settings, strategy: 'RESTRAINED', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT, numberStyle: 'UK' });

/** The acceptance experiment as production ran it (runs 1–7, all with House narrator v1). */
const RUNS = [
  { label: 'A plain', strategy: 'PLAIN', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT },
  { label: 'B restrained', strategy: 'RESTRAINED', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT },
  { label: 'C expressive', strategy: 'EXPRESSIVE', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT },
  { label: 'D over-directed', strategy: 'DIRECTED', chunking: HOUSE_CHUNKING, context: HOUSE_CONTEXT },
  { label: 'E no context', strategy: 'RESTRAINED', chunking: HOUSE_CHUNKING, context: { previousChars: 0, nextChars: 0, stitch: false } },
  { label: 'F 5–8 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 13, maxWords: 20 }, context: HOUSE_CONTEXT },
  { label: 'G 12–20 s chunks', strategy: 'RESTRAINED', chunking: { minWords: 30, maxWords: 50 }, context: HOUSE_CONTEXT },
] as const;

/** Columns the migration adds to existing tables (left out when comparing what was there). */
const ADDED: Record<string, string[]> = { voice_profiles: ['family_id', 'based_on_id', 'origin'], voice_runs: ['config'], voice_generations: ['config'] };

function psql(args: string[]): string {
  const r = spawnSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`psql could not be run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`psql failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

const migrationFile = (dir: string) => `${MIGRATIONS}${dir}/migration.sql`;

/** A JSON parameter (pg would send an array as a PostgreSQL array). */
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

async function fillLikeProduction(c: pg.Client): Promise<void> {
  await c.query(`INSERT INTO "projects" ("id", "slug", "title", "topic", "updated_at") VALUES ($1, 'tulip-mania', 'Tulip Mania', 'The Dutch tulip bulb market of 1636–37', '2026-10-06T01:00:00Z')`, [PROJECT]);
  await c.query(`INSERT INTO "language_versions" ("id", "project_id", "language", "updated_at") VALUES ($1, $2, 'en', '2026-10-06T01:00:00Z')`, [LANGUAGE_VERSION, PROJECT]);
  await c.query(`INSERT INTO "scripts" ("id", "project_id", "version", "updated_at") VALUES ($1, $2, 5, '2026-10-06T01:00:00Z')`, [SCRIPT, PROJECT]);

  const profile = `INSERT INTO "voice_profiles" ("id", "name", "version", "provider", "voice_id", "model_id", "language", "output_format", "config", "active", "notes", "created_by", "created_at")
    VALUES ($1, $2, $3, 'elevenlabs', $4, 'eleven_v4', $5, 'mp3_44100_128', $6, $7, $8, $9, $10)`;
  // House narrator v1: what activeProfile made at the first plan, active, used by all seven runs.
  await c.query(profile, [HOUSE, 'House narrator', 1, 'voice-house-test', 'en', json(earlierConfig()), true, 'Created from the configured defaults (elevenlabs)', 'system', '2026-10-06T01:20:00Z']);
  // A second name with two versions, neither active.
  await c.query(profile, [ARCHIVE_V1, 'Archive narrator', 1, 'voice-archive-test', 'en', json(earlierConfig({ ...SETTINGS, stability: 0.3 })), false, null, 'editor-a', '2026-10-05T18:00:00Z']);
  await c.query(profile, [ARCHIVE_V2, 'Archive narrator', 2, 'voice-archive-test', 'en', json(earlierConfig({ ...SETTINGS, stability: 0.35 })), false, 'Based on Archive narrator v1', 'editor-b', '2026-10-05T19:00:00Z']);
  // One name for two languages: an older inactive English version, and the Spanish one new Spanish runs used.
  await c.query(profile, [TWO_EN, 'Narrator two', 1, 'voice-two-test', 'en', json(earlierConfig()), false, null, 'editor-a', '2026-10-05T17:00:00Z']);
  await c.query(profile, [TWO_ES, 'Narrator two', 2, 'voice-two-test', 'es', json(earlierConfig()), true, null, 'editor-b', '2026-10-05T21:00:00Z']);

  for (const [i, v] of RUNS.entries()) {
    const n = i + 1;
    await c.query(
      `INSERT INTO "voice_runs" ("id", "project_id", "language_version_id", "script_id", "profile_id", "number", "kind", "scope", "strategy", "settings", "experiment", "variant", "created_by", "created_at", "updated_at")
       VALUES ($1, $2, $3, $4, $5, $6, 'AUDITION', $7, $8::"PerformanceStrategy", $9, 'Acceptance experiment', $10, 'editor', '2026-10-06T01:27:00Z', '2026-10-06T01:29:00Z')`,
      [run(n), PROJECT, LANGUAGE_VERSION, SCRIPT, HOUSE, n, json({ kind: 'AUDITION', seconds: 100, blockKeys: ['SC01-B01'] }), v.strategy, json({ chunking: v.chunking, context: v.context }), v.label],
    );
    const text = 'In 1637 a single bulb changed hands for the price of a house.';
    await c.query(
      `INSERT INTO "voice_chunks" ("id", "run_id", "scene_id", "chunk_index", "section_key", "block_keys", "source_block_id", "spans", "source_text", "text_hash", "block_hashes", "words", "boundary", "performance")
       VALUES ($1, $2, $3, 0, 'SC01', ARRAY['SC01-B01'], $4, $5, $6, 'hash-1', $7, 13, 'SENTENCE', $8)`,
      [chunk(n), run(n), id(400), id(401), json([{ blockId: id(401), blockKey: 'SC01-B01', start: 0, end: text.length }]), text, json({ 'SC01-B01': 'block-hash' }), json({ pace: 'NORMAL', energy: 'MEDIUM', emotion: 'NEUTRAL', pauses: { before: 'NONE', after: 'SHORT', inside: [] } })],
    );
    const prepared = {
      strategy: v.strategy,
      spokenForms: [{ kind: 'YEAR', start: 3, end: 7, display: '1637', spoken: 'sixteen thirty-seven', confidence: 'HIGH' }],
      marks: [],
      pauses: { before: 'NONE', after: 'SHORT', inside: [] },
      context: { previousText: null, nextText: v.context.nextChars ? 'It was a promise.' : null },
      settings: SETTINGS,
      seed: 7,
      dictionary: [],
      unsupported: [],
      checks: [{ id: 'words', label: 'Words unchanged', status: 'PASS', detail: '' }],
    };
    await c.query(
      `INSERT INTO "voice_generations" ("id", "chunk_id", "run_id", "project_id", "generation", "status", "profile_id", "provider", "model", "voice_id", "strategy", "variant", "canonical_text", "text_hash", "spoken_text", "performance_text", "prepared", "characters", "created_by", "created_at", "completed_at")
       VALUES ($1, $2, $3, $4, 1, 'IN_REVIEW', $5, 'elevenlabs', 'eleven_v4', 'voice-house-test', $6::"PerformanceStrategy", NULL, $7, 'hash-1', $8, $8, $9, 184, 'editor', '2026-10-06T01:28:00Z', '2026-10-06T01:28:10Z')`,
      [take(n), chunk(n), run(n), PROJECT, HOUSE, v.strategy, text, text.replace('1637', 'sixteen thirty-seven'), json(prepared)],
    );
    await c.query(`UPDATE "voice_chunks" SET "current_generation_id" = $1 WHERE "id" = $2`, [take(n), chunk(n)]);
  }
}

let admin: pg.Client;
let db: pg.Client;
let before: Record<string, string[]>;
let after: Record<string, string[]>;
let tables: string[];
let tempTableLeft: string;

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
  await fillLikeProduction(db);
  tables = (await db.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
  before = await snapshot(db, tables);

  // The migration, then (same session) whether its temporary table is still there.
  tempTableLeft = psql(['-f', migrationFile(MIGRATION), '-At', '-c', `SELECT to_regclass('pg_temp._voice_profile_family_map') IS NOT NULL`]).trim();
  after = await snapshot(db, tables);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await admin?.end();
});

interface FamilyRow {
  id: string;
  name: string;
  description: string | null;
  is_default: boolean;
  archived_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

describe(`migration ${MIGRATION} on production-shaped rows`, () => {
  it('changes no value that was there: every row of every table, column by column', () => {
    expect(Object.keys(after)).toEqual(tables);
    for (const t of tables) expect(after[t], t).toEqual(before[t]);
    expect(before.voice_profiles).toHaveLength(5);
    expect(before.voice_runs).toHaveLength(7);
    expect(before.voice_generations).toHaveLength(7);
  });

  it('makes one family per name, provider and language, naming a name used for several by provider and language', async () => {
    const { rows } = await db.query<FamilyRow>(`SELECT * FROM "voice_profile_families" ORDER BY "name"`);
    expect(rows.map((f) => [f.name, f.is_default])).toEqual([
      ['Archive narrator', false],
      ['House narrator', true],
      ['Narrator two (elevenlabs, en)', false],
      ['Narrator two (elevenlabs, es)', true],
    ]);
    expect(rows.every((f) => f.description === null && f.archived_at === null)).toBe(true);
    expect(new Set(rows.map((f) => f.id)).size).toBe(4);
  });

  it('makes the family of the newest active version per provider and language the library default (what new runs used)', async () => {
    const { rows } = await db.query<{ provider: string; language: string; defaults: string[] }>(
      `SELECT p."provider", p."language", array_agg(DISTINCT f."name") FILTER (WHERE f."is_default") AS "defaults"
       FROM "voice_profiles" p JOIN "voice_profile_families" f ON f."id" = p."family_id" GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(rows).toEqual([
      { provider: 'elevenlabs', language: 'en', defaults: ['House narrator'] },
      { provider: 'elevenlabs', language: 'es', defaults: ['Narrator two (elevenlabs, es)'] },
    ]);
  });

  it('gives a family the creator of its first version and the times of its first and last', async () => {
    const { rows } = await db.query<FamilyRow>(`SELECT * FROM "voice_profile_families" WHERE "name" IN ('Archive narrator', 'House narrator') ORDER BY "name"`);
    expect(rows.map((f) => [f.created_by, f.created_at.toISOString(), f.updated_at.toISOString()])).toEqual([
      ['editor-a', '2026-10-05T18:00:00.000Z', '2026-10-05T19:00:00.000Z'],
      ['system', '2026-10-06T01:20:00.000Z', '2026-10-06T01:20:00.000Z'],
    ]);
  });

  it('puts every version in its family, keeping its name and number; nothing else is set', async () => {
    const { rows } = await db.query<{ id: string; name: string; version: number; family: string; based_on_id: string | null; origin: unknown }>(
      `SELECT p."id", p."name", p."version", f."name" AS "family", p."based_on_id", p."origin" FROM "voice_profiles" p JOIN "voice_profile_families" f ON f."id" = p."family_id" ORDER BY p."id"`,
    );
    expect(rows.map((r) => [r.id, r.name, r.version, r.family])).toEqual([
      [HOUSE, 'House narrator', 1, 'House narrator'],
      [ARCHIVE_V1, 'Archive narrator', 1, 'Archive narrator'],
      [ARCHIVE_V2, 'Archive narrator', 2, 'Archive narrator'],
      [TWO_EN, 'Narrator two', 1, 'Narrator two (elevenlabs, en)'],
      [TWO_ES, 'Narrator two', 2, 'Narrator two (elevenlabs, es)'],
    ]);
    expect(rows.every((r) => r.based_on_id === null && r.origin === null)).toBe(true);
    expect((await db.query(`SELECT 1 FROM "voice_profiles" WHERE "family_id" IS NULL`)).rowCount).toBe(0);
  });

  it('leaves House narrator v1 exactly as it was: active, the earlier config, used by the seven runs', async () => {
    const { rows } = await db.query<{ active: boolean; config: unknown; runs: string }>(`SELECT p."active", p."config", (SELECT count(*) FROM "voice_runs" r WHERE r."profile_id" = p."id") AS "runs" FROM "voice_profiles" p WHERE p."id" = $1`, [HOUSE]);
    expect(rows[0]).toEqual({ active: true, config: earlierConfig(), runs: '7' });
  });

  it('records no configuration for runs and takes made before it (they are read back reconstructed), and no project choice', async () => {
    expect((await db.query(`SELECT 1 FROM "voice_runs" WHERE "config" IS NOT NULL`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM "voice_generations" WHERE "config" IS NOT NULL`)).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM "voice_selections"`)).rowCount).toBe(0);
  });

  it('keeps (family, version) unique and a family with versions undeletable', async () => {
    const house = (await db.query<{ family_id: string }>(`SELECT "family_id" FROM "voice_profiles" WHERE "id" = $1`, [HOUSE])).rows[0]!.family_id;
    await expect(
      db.query(`INSERT INTO "voice_profiles" ("id", "name", "version", "provider", "voice_id", "model_id", "language", "output_format", "config", "family_id") VALUES ($1, 'Renamed narrator', 1, 'elevenlabs', 'voice-house-test', 'eleven_v4', 'en', 'mp3_44100_128', '{}', $2)`, [id(20), house]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'voice_profiles_family_id_version_key' });
    await expect(db.query(`DELETE FROM "voice_profile_families" WHERE "id" = $1`, [house])).rejects.toMatchObject({ code: '23503' });
  });

  it('drops its temporary mapping table', async () => {
    expect(tempTableLeft).toBe('f');
    expect((await db.query(`SELECT 1 FROM pg_class WHERE "relname" = '_voice_profile_family_map'`)).rowCount).toBe(0);
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
