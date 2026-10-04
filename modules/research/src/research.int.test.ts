import { ProjectService, PostgresJobQueue, JobRunner, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildDossierReport } from './report.ts';
import { createResearchStage } from './stage.ts';
import { FAKE_CORPUS_GATE, FakeResearchAI, FakeResearchProvider } from './testing.ts';

const db = useTestDatabase();

function setup(gate = FAKE_CORPUS_GATE) {
  const ai = new FakeResearchAI();
  const research = new FakeResearchProvider();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai, research };
  const projects = new ProjectService({ db });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    handlers: { ...createMockStageHandlers(), RESEARCH: createResearchStage({ gate, readConcurrency: 3, searchConcurrency: 3 }) },
    retryBaseDelayMs: 0,
  });
  return { ai, research, projects, runner };
}

async function runResearch(s: ReturnType<typeof setup>, projectId?: string) {
  const id = projectId ?? (await s.projects.createProject(tulipInput, 'test')).id;
  const job = await s.projects.enqueueJob(id, { type: 'RESEARCH' }, 'test');
  await s.runner.drain();
  return { projectId: id, job: await db.job.findUniqueOrThrow({ where: { id: job.id } }) };
}

describe('research stage (fake providers, real database)', () => {
  it('builds a versioned, source-backed dossier and moves the project to RESEARCH_REVIEW', async () => {
    const s = setup();
    const { projectId, job } = await runResearch(s);

    expect(job.status).toBe('SUCCEEDED');
    expect(job.isMock).toBe(false);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('RESEARCH_REVIEW');

    // Discovery: multiple focused searches, deduplicated; social media excluded.
    expect(s.research.searches).toBe(8);
    const sources = await db.source.findMany({ where: { projectId }, include: { document: true } });
    expect(sources).toHaveLength(15);
    expect(sources.some((x) => x.domain === 'instagram.com')).toBe(false);
    expect(sources.find((x) => x.domain === 'broken-site.org')).toMatchObject({ retrievalStatus: 'FAILED', retrievalError: 'Failed to fetch url' });
    expect(sources.find((x) => x.domain === 'paywalled-journal.org')).toMatchObject({ retrievalStatus: 'FAILED' });
    expect(sources.find((x) => x.domain === 'paywalled-journal.org')!.retrievalError).toMatch(/paywall, stub or blocked/);
    const mirror = sources.find((x) => x.domain === 'mirror-site.com')!;
    const jstor = sources.find((x) => x.domain === 'jstor.org')!;
    expect(mirror.duplicateOfId).toBe(jstor.id);
    // Source metadata comes from reading the page, not the domain.
    expect(sources.find((x) => x.domain === 'dbnl.org')).toMatchObject({ sourceType: 'PRIMARY', reliability: 'HIGH' });
    expect(sources.find((x) => x.domain === 'archive.org')).toMatchObject({ sourceType: 'BOOK', author: 'Charles Mackay' });
    expect(jstor.document?.text).toMatch(/never settled in full/);
    expect(jstor.document?.analysisVersion).toMatch(/^research-v1:/);

    // Dossier v1 and its gate.
    const dossier = await db.researchDossier.findFirstOrThrow({ where: { projectId }, include: { claims: { include: { citations: { include: { source: true } } } } } });
    expect(dossier).toMatchObject({ version: 1, status: 'IN_REVIEW', qualityPassed: true, jobId: job.id });
    const report = dossier.qualityReport as { passed: boolean; checks: { id: string; status: string }[]; normalizations: string[]; coherenceIssues: { resolution: string }[] };
    expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(report.normalizations.join('\n')).toMatch(/C012: ESTABLISHED → PROBABLE/);
    expect(report.normalizations.join('\n')).toMatch(/C013: MYTH → UNVERIFIED/);
    expect(report.normalizations.join('\n')).toMatch(/unknown evidence ID "S77.E1"/);
    expect(report.coherenceIssues[0]!.resolution).toMatch(/^Applied: flagged for verification/);

    const byKey = new Map(dossier.claims.map((c) => [c.claimKey, c]));
    expect(dossier.claims).toHaveLength(14);
    expect(Object.fromEntries(['ESTABLISHED', 'PROBABLE', 'DISPUTED', 'UNVERIFIED', 'MYTH'].map((v) => [v, dossier.claims.filter((c) => c.verdict === v).length]))).toEqual({
      ESTABLISHED: 6, PROBABLE: 3, DISPUTED: 1, UNVERIFIED: 2, MYTH: 2, // C012 demoted: one reputable-secondary source is not enough
    });
    // A myth records the popular version and both sides.
    const myth = byKey.get('C003')!;
    expect(myth).toMatchObject({ verdict: 'MYTH', importance: 'KEY', popularVersion: 'Mackay (1841): commerce suffered a severe shock' });
    expect(myth.citations.filter((c) => c.stance === 'SUPPORTS').map((c) => c.source.domain).sort()).toEqual(['archive.org', 'tulip-facts-blog.com']);
    expect(myth.citations.filter((c) => c.stance === 'CONTRADICTS').map((c) => c.source.domain).sort()).toEqual(['economist.com', 'jstor.org']);
    expect(byKey.get('C005')).toMatchObject({ verdict: 'DISPUTED', needsVerification: true });
    expect(byKey.get('C007')).toMatchObject({ needsVerification: true }); // review fix applied
    // Every stored citation quote was verified against retrieved full text; the fabricated quote never made it.
    const citations = dossier.claims.flatMap((c) => c.citations);
    expect(citations.every((c) => c.basis === 'FULL_TEXT' && c.quoteVerified && c.source.retrievalStatus === 'RETRIEVED')).toBe(true);
    expect(citations.some((c) => c.quote?.includes('invented'))).toBe(false);
    expect(citations.some((c) => c.sourceId === mirror.id)).toBe(false);

    const content = dossier.content as { questions: unknown[]; timeline: unknown[]; myths: unknown[] };
    expect(content.questions).toHaveLength(4);
    expect(content.timeline).toHaveLength(3);
    expect(dossier.stats).toMatchObject({ searches: 8, duplicates: 1, retrievalFailed: 2, evidenceVerified: 22, evidenceRejected: 1, promptVersion: 'research-v1' });

    // Ledger: every provider call recorded with an estimated cost and its basis.
    const calls = await db.providerCall.findMany({ where: { jobId: job.id } });
    const ops = calls.map((c) => `${c.provider}:${c.operation}`);
    expect(ops.filter((o) => o === 'fake-search:search')).toHaveLength(8);
    expect(ops.filter((o) => o === 'fake-search:fetchDocuments')).toHaveLength(3); // 15 sources, batches of 5
    expect(ops.filter((o) => o === 'fake-ai:generateObject')).toHaveLength(4 + 12); // plan, triage, synthesis, review + 12 reads
    expect(calls.every((c) => c.status === 'SUCCEEDED' && c.costBasis === 'ESTIMATED' && c.estimatedCostUsd !== null)).toBe(true);

    // Progress is visible on the activity log.
    const progress = await db.projectEvent.findMany({ where: { projectId, type: 'JOB_PROGRESS' }, orderBy: { createdAt: 'asc' } });
    expect(progress.map((p) => p.message.split(':')[0])).toEqual(['Research plan', 'Discovery', 'Triage', 'Retrieval', 'Reading', 'Synthesis', 'Research dossier v1 saved']);
    expect(job.result).toMatchObject({ dossierId: dossier.id, version: 1, qualityPassed: true, claims: 14 });

    // The plain-text evidence report reads straight from the database.
    const text = await buildDossierReport(db, dossier.id);
    expect(text).toMatch(/Research dossier v1 — status IN_REVIEW — quality gate PASSED/);
    expect(text).toMatch(/Considered: 15 · retrieved: 13 · failed: 2 · duplicates: 1 · cited: 12/);
    expect(text).toMatch(/MYTH\s+2/);
    expect(text).toMatch(/\[C003\] Tulip mania ruined the Dutch economy\.\n\s+commonly claimed: Mackay/);
    expect(text).toMatch(/fake-ai .*calls .*estimated/);
  });

  it('fails the job, keeps the dossier as DRAFT and fails the project when the quality gate fails', async () => {
    const s = setup({ ...FAKE_CORPUS_GATE, minCitedSources: 50 });
    const { projectId, job } = await runResearch(s);
    expect(job.status).toBe('FAILED');
    expect(job.attempts).toBe(1); // a quality failure is not retried automatically
    expect(job.error).toMatch(/Research quality gate failed: Minimum source count/);
    expect(await db.project.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({ status: 'FAILED', failedFromStatus: 'RESEARCHING' });
    const dossier = await db.researchDossier.findFirstOrThrow({ where: { projectId } });
    expect(dossier).toMatchObject({ status: 'DRAFT', qualityPassed: false });
  });

  it('links the human decision to the dossier, and a re-run creates v2 reusing retrieved and read sources', async () => {
    const s = setup();
    const { projectId } = await runResearch(s);
    expect(s.ai.calls['research.read']).toBe(12);

    // The reviewer rejects v1.
    await s.projects.recordApproval(projectId, { gate: 'RESEARCH', decision: 'REJECTED', notes: 'Need more on prices' }, 'reviewer');
    const v1 = await db.researchDossier.findFirstOrThrow({ where: { projectId, version: 1 } });
    expect(v1.status).toBe('REJECTED');
    expect((await db.approval.findFirstOrThrow({ where: { projectId } })).dossierId).toBe(v1.id);

    // Re-run: retrieved documents are not fetched or read again (only the two earlier failures are retried).
    const fetchedBefore = s.research.fetched.length;
    await runResearch(s, projectId);
    expect(s.research.fetched.slice(fetchedBefore).sort()).toEqual(['https://broken-site.org/tulips', 'https://paywalled-journal.org/abstract']);
    expect(s.ai.calls['research.read']).toBe(12);
    const v2 = await db.researchDossier.findFirstOrThrow({ where: { projectId, version: 2 } });
    expect(v2).toMatchObject({ status: 'IN_REVIEW', qualityPassed: true });
    expect(v2.stats).toMatchObject({ readFromCache: 12, retrievedFromCache: 13 });
    expect(await db.source.count({ where: { projectId } })).toBe(15); // sources are shared across versions, not duplicated

    await s.projects.recordApproval(projectId, { gate: 'RESEARCH', decision: 'APPROVED' }, 'reviewer');
    expect((await db.researchDossier.findUniqueOrThrow({ where: { id: v2.id } })).status).toBe('APPROVED');
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('RESEARCH_COMPLETE');
    expect((await db.researchDossier.findUniqueOrThrow({ where: { id: v1.id } })).status).toBe('REJECTED');
  });
});
