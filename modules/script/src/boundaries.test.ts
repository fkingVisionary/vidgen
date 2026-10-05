import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The script engine tells the approved architecture: it reads the research
 * record and the story architecture and never changes either. A static guard
 * over the script stage, the script API and its read models: no writes to
 * research or story tables (Prisma or raw SQL), and no use of the research
 * module. The integration tests check the same at runtime.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const scriptFiles = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts')
  .map((f) => join(here, f));
const apiFiles = ['apps/api/src/script-views.ts', 'apps/api/src/routes/script.ts'].map((f) => join(root, f));
const files = [...scriptFiles, ...apiFiles].map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));

const PROTECTED_MODELS = ['researchDossier', 'researchClaim', 'claimCitation', 'source', 'sourceDocument', 'storyPack', 'storyCandidate', 'storyCandidateClaim', 'storyArchitecture', 'storyExploration', 'contentOpportunity', 'contentOpportunityClaim'];
const PROTECTED_TABLES = ['research_dossiers', 'research_claims', 'claim_citations', 'sources', 'source_documents', 'story_packs', 'story_candidates', 'story_candidate_claims', 'story_architectures', 'story_explorations', 'content_opportunities', 'content_opportunity_claims'];
const PRISMA_WRITE = new RegExp(`\\.(${PROTECTED_MODELS.join('|')})\\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\\b`);
const SQL_WRITE = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|truncate|alter\\s+table|drop\\s+table)\\s+"?(${PROTECTED_TABLES.join('|')})\\b`, 'i');

describe('the script engine and the research and story records', () => {
  it('scans the script stage and the script API', () => {
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['modules/script/src/stage.ts', 'modules/script/src/editing.ts', 'modules/script/src/store.ts', 'apps/api/src/script-views.ts', 'apps/api/src/routes/script.ts']));
  });

  it('never writes to research or story tables', () => {
    const writes = files.flatMap((f) => f.text.split('\n').flatMap((line, i) => (PRISMA_WRITE.test(line) || SQL_WRITE.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [])));
    expect(writes).toEqual([]);
  });

  it('does not use the research module', () => {
    expect(files.filter((f) => /from ['"]@docengine\/research/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('the guard itself catches a write', () => {
    expect(PRISMA_WRITE.test('await tx.storyArchitecture.update({ where: { id } })')).toBe(true);
    expect(SQL_WRITE.test('DELETE FROM story_architectures WHERE id = $1')).toBe(true);
    expect(PRISMA_WRITE.test('await db.storyArchitecture.findFirst({})')).toBe(false);
  });
});
