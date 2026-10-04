import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The story engine reads the approved research record and never changes it.
 * A static guard over the production code of the story stages and the story
 * API: no writes to the research tables (Prisma or raw SQL), and no use of
 * the research module. The integration tests check the same at runtime by
 * comparing the research tables before and after a full story run.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const storyFiles = readdirSync(here)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts')
  .map((f) => join(here, f));
const apiFiles = ['apps/api/src/story-views.ts', 'apps/api/src/routes/story.ts'].map((f) => join(root, f));
const files = [...storyFiles, ...apiFiles].map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }));

const RESEARCH_MODELS = ['researchDossier', 'researchClaim', 'claimCitation', 'source', 'sourceDocument'];
const RESEARCH_TABLES = ['research_dossiers', 'research_claims', 'claim_citations', 'sources', 'source_documents'];
const PRISMA_WRITE = new RegExp(`\\.(${RESEARCH_MODELS.join('|')})\\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\\b`);
const SQL_WRITE = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|truncate|alter\\s+table|drop\\s+table)\\s+"?(${RESEARCH_TABLES.join('|')})\\b`, 'i');

describe('the story engine and the research record', () => {
  it('scans the story stages and the story API', () => {
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['modules/story/src/mining-stage.ts', 'modules/story/src/architecture-stage.ts', 'modules/story/src/opportunities.ts', 'modules/story/src/evidence.ts', 'apps/api/src/story-views.ts']),
    );
  });

  it('never writes to the research tables', () => {
    const writes = files.flatMap((f) => f.text.split('\n').flatMap((line, i) => (PRISMA_WRITE.test(line) || SQL_WRITE.test(line) ? [`${f.path}:${i + 1}: ${line.trim()}`] : [])));
    expect(writes).toEqual([]);
  });

  it('does not use the research module (the Research Engine is independent of story work)', () => {
    expect(files.filter((f) => /from ['"]@docengine\/research/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('the guard itself catches a write', () => {
    expect(PRISMA_WRITE.test('await tx.researchClaim.update({ where: { id } })')).toBe(true);
    expect(SQL_WRITE.test('UPDATE research_claims SET verdict = $1')).toBe(true);
    expect(PRISMA_WRITE.test('await db.researchClaim.findMany({})')).toBe(false);
  });
});
