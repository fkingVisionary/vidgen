import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHIVAL_PROVIDER, IN_HOUSE_CARD, MOCK_VISUAL_PROVIDER, PLANNED_PROVIDERS, STOCK_CARD, createVisualCatalog } from '@docengine/providers';
import { describe, expect, it } from 'vitest';

/**
 * The storyboard plans pictures and makes none. A static guard over the
 * storyboard module: no video, image, render, storage, voice or publishing
 * provider is used (the only paid calls are its own planning calls through
 * the AI provider); no write to research, story, script or voice tables, or
 * to media assets (Prisma or raw SQL); the pure core does no I/O and reads no
 * clock; and no vendor the catalog or the registry names appears in the
 * module, its tests, the storyboard contracts, the Prisma schema or the
 * storyboard migration. Configured AI, research and voice vendors are held
 * out of the module by the providers' neutrality test.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const read = (path: string) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') });
const all = readdirSync(here)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => read(join(here, f)));
const files = all.filter((f) => !f.path.endsWith('.test.ts'));

/** The pure core: evaluation over loaded facts, no database, queue or network. */
const PURE = ['draft', 'spine', 'timing', 'inherit', 'rules', 'rhythm', 'route', 'alternatives', 'approaches', 'continuity', 'edits', 'hash', 'stale', 'anachronism', 'schemas', 'normalize', 'plan'].map((f) => `modules/storyboard/src/${f}.ts`);

const MEDIA_SLOTS = ['video', 'render', 'storage', 'voice', 'publishing'];
const MEDIA_METHODS = ['createImage', 'createVideo', 'getGenerationStatus', 'downloadAsset', 'waitForGeneration', 'renderTimeline', 'renderGraphic', 'generateNarration', 'uploadVideo', 'getSignedUrl'];
const PROVIDER_USE = new RegExp(
  [
    `\\bproviders\\??\\.(${MEDIA_SLOTS.join('|')})\\b`,
    `\\bcallProvider\\(\\s*['"](${MEDIA_SLOTS.join('|')})['"]`,
    `\\b(${MEDIA_METHODS.join('|')})\\(`,
    `\\b(VideoProvider|RenderProvider|StorageProvider|VoiceProvider|PublishingProvider)\\b`,
    `\\bstorage\\??\\.(put|get|head|delete|list)\\(`,
  ].join('|'),
);

const PROTECTED_MODELS = [
  ...['researchDossier', 'researchClaim', 'claimCitation', 'source', 'sourceDocument'],
  ...['storyPack', 'storyCandidate', 'storyCandidateClaim', 'storyArchitecture', 'storyExploration', 'contentOpportunity', 'contentOpportunityClaim'],
  ...['script', 'scene', 'sceneNarration', 'scriptBlock', 'scriptBlockClaim'],
  ...['voiceProfileFamily', 'voiceProfile', 'voiceSelection', 'voiceRun', 'voiceChunk', 'voiceGeneration', 'voiceAssembly', 'voicePronunciation'],
  'mediaAsset',
];
const PROTECTED_TABLES = [
  ...['research_dossiers', 'research_claims', 'claim_citations', 'sources', 'source_documents'],
  ...['story_packs', 'story_candidates', 'story_candidate_claims', 'story_architectures', 'story_explorations', 'content_opportunities', 'content_opportunity_claims'],
  ...['scripts', 'scenes', 'scene_narrations', 'script_blocks', 'script_block_claims'],
  ...['voice_profile_families', 'voice_profiles', 'voice_selections', 'voice_runs', 'voice_chunks', 'voice_generations', 'voice_assemblies', 'voice_pronunciations'],
  'media_assets',
];
const PRISMA_WRITE = new RegExp(`\\.(${PROTECTED_MODELS.join('|')})\\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\\b`);
const SQL_WRITE = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|truncate|alter\\s+table|drop\\s+table)\\s+"?(${PROTECTED_TABLES.join('|')})\\b`, 'i');

const IMPURE = /from ['"](@docengine\/(database|pipeline)|node:(fs|fs\/promises|net|http|https|child_process))['"]|\b(fetch|setTimeout|setInterval)\(|\bprocess\.|\bDate\b|Math\.random|randomUUID/;

/** The catalog's vendor cards (each provider and each model's maker) and the vendors the registry plans. */
function vendorNames(): string[] {
  const generic = new Set([IN_HOUSE_CARD.provider, ARCHIVAL_PROVIDER, STOCK_CARD.provider, MOCK_VISUAL_PROVIDER]);
  const names = new Set(Object.values(PLANNED_PROVIDERS).flat());
  for (const card of createVisualCatalog().cards) {
    if (generic.has(card.provider)) continue;
    names.add(card.provider);
    for (const m of card.models) names.add(m.model.split('/')[0]!.replace(/-(video|ai)$/, ''));
  }
  return [...names].sort();
}
const NAMES = vendorNames();
const VENDOR = new RegExp(`\\b(${NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

const lines = (fs: { path: string; text: string }[], re: RegExp) => fs.flatMap((f) => f.text.split('\n').flatMap((line, i) => (re.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [])));

describe('the storyboard makes no media', () => {
  it('scans the whole module, the pure core included', () => {
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining([...PURE, 'modules/storyboard/src/testing.ts']));
  });

  it('uses no video, render, storage, voice or publishing provider', () => {
    expect(lines(files, PROVIDER_USE)).toEqual([]);
  });

  it('never writes to research, story, script or voice tables, or to media assets', () => {
    expect(lines(files, PRISMA_WRITE)).toEqual([]);
    expect(lines(files, SQL_WRITE)).toEqual([]);
  });

  it('keeps the pure core pure: no database, queue, file, network, clock or randomness', () => {
    expect(lines(files.filter((f) => PURE.includes(f.path)), IMPURE)).toEqual([]);
  });

  it('the guards themselves catch a media call, an upstream write and an impure import', () => {
    expect(PROVIDER_USE.test('const t = await ctx.providers.video.createVideo(req);')).toBe(true);
    expect(PROVIDER_USE.test("await ctx.callProvider('render', 'renderGraphic', fn)")).toBe(true);
    expect(PROVIDER_USE.test('await this.deps.providers.storage.put(key, body, opts)')).toBe(true);
    expect(PROVIDER_USE.test("await ctx.callProvider('ai', 'generateObject', fn)")).toBe(false);
    expect(PRISMA_WRITE.test('await tx.voiceAssembly.update({ where: { id } })')).toBe(true);
    expect(PRISMA_WRITE.test('await tx.scriptBlock.deleteMany({})')).toBe(true);
    expect(PRISMA_WRITE.test('await tx.shot.createMany({ data })')).toBe(false);
    expect(SQL_WRITE.test('UPDATE "script_blocks" SET text = $1')).toBe(true);
    expect(SQL_WRITE.test('DELETE FROM shots WHERE storyboard_id = $1')).toBe(false);
    expect(IMPURE.test("import { prisma } from '@docengine/database';")).toBe(true);
    expect(IMPURE.test('const at = Date.now();')).toBe(true);
    expect(IMPURE.test("import { createHash } from 'node:crypto';")).toBe(false);
  });
});

describe('no vendor names', () => {
  const sources = [
    ...all,
    read(join(root, 'packages/core/src/contracts/storyboard.ts')),
    read(join(root, 'packages/core/src/contracts/visual-profile.ts')),
    read(join(root, 'packages/core/src/enums.ts')),
    read(join(root, 'packages/database/prisma/schema.prisma')),
    read(join(root, 'packages/database/prisma/migrations/20261007090000_storyboard_engine/migration.sql')),
  ];

  it('in the module, its tests and fixtures, the storyboard contracts, the schema or the migration', () => {
    expect(lines(sources, VENDOR)).toEqual([]);
  });

  it('the guard takes its names from the catalog and the registry, and passes the acme fixtures', () => {
    expect(NAMES.length).toBeGreaterThan(1);
    expect(NAMES).not.toContain(MOCK_VISUAL_PROVIDER);
    for (const name of NAMES) expect(VENDOR.test(`{ provider: '${name}' }`)).toBe(true);
    expect(VENDOR.test("{ provider: 'acme-video', model: 'acme-v1' }")).toBe(false);
    expect(VENDOR.test('An in-house title card over archival stock')).toBe(false);
  });
});
