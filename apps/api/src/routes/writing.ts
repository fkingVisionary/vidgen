import { WritingExampleDecisionInput } from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import { moneyUses, narrationBlocks, scopeFor, scriptNames, toDraft, SCRIPT_INCLUDE } from '@docengine/script';
import { ExampleDecisionError, candidateLines, decideExample, saveCandidates } from '@docengine/writing';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { findProject } from '../views.ts';
import { loadWritingCorpus, toWritingExampleView } from '../writing-views.ts';

const ProjectVersionParams = z.object({ id: z.string().trim().min(1).max(100), version: z.coerce.number().int().min(1) });
const IdParams = z.object({ id: z.uuid() });

/**
 * The house-style corpus (Writing Engine 2): the style bible, the rubric, the
 * AI-pattern glossary and every example; house-style candidates proposed from
 * an approved script, and a person's decision on each. Nothing enters
 * retrieval without that decision.
 */
export async function writingRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  app.get('/api/writing/corpus', async () => loadWritingCorpus(c.db));

  /** Propose house-style candidates from an approved script version (a person decides on each). */
  app.post('/api/projects/:id/script/versions/:version/house-candidates', async (req) => {
    const { id, version } = ProjectVersionParams.parse(req.params);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    const row = await c.db.script.findUnique({ where: { projectId_version: { projectId: project.id, version } }, include: SCRIPT_INCLUDE });
    if (!row) throw new NotFoundError('Script', `v${version}`);
    if (row.status !== 'APPROVED') throw new ConflictError(`Script v${version} is ${row.status.toLowerCase()}: house-style candidates come from approved scripts only`);
    const { draft } = toDraft(row);
    const scope = row.storyId ? await scopeFor(c.db, row.storyId) : null;
    const proposals = candidateLines(narrationBlocks(draft), {
      moneyRefs: new Set(scope ? moneyUses(draft, scope).map((u) => u.ref) : []),
      firstMentions: new Set(scope ? scriptNames(draft, scope).filter((n) => n.kind === 'PERSON' && n.firstRef).map((n) => n.firstRef!) : []),
    });
    const made = await saveCandidates(c.db, { projectId: project.id, scriptId: row.id, scriptVersion: row.version, proposals, actor: actorOf(req) });
    return { proposed: proposals.length, created: made, corpus: await loadWritingCorpus(c.db) };
  });

  /** Approve (with why it works), reject or retire a house-style example. */
  app.post('/api/writing/examples/:id/decision', async (req) => {
    const { id } = IdParams.parse(req.params);
    const input = WritingExampleDecisionInput.parse(req.body ?? {});
    try {
      return toWritingExampleView(await decideExample(c.db, id, input, actorOf(req)));
    } catch (err) {
      if (err instanceof ExampleDecisionError) throw err.message === 'No such house example' ? new NotFoundError('House example', id) : new ConflictError(err.message);
      throw err;
    }
  });
}
