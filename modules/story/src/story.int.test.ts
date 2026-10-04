import { ContentOpportunityContent, QualityReport, StoryArchitectureContent, StoryArchitectureContentV2, StoryPackContent, StoryScoresV2, type JobType } from '@docengine/core';
import { Prisma } from '@docengine/database';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { createStoryArchitectureStage } from './architecture-stage.ts';
import type { StoryConfig } from './config.ts';
import { createStoryMiningStage } from './mining-stage.ts';
import { FAKE_INVALID, FAKE_VALID, FakeStoryAI, seedFakeDossier } from './testing.ts';

const db = useTestDatabase();

function setup(cfg: Partial<StoryConfig> = {}) {
  const ai = new FakeStoryAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai };
  const projects = new ProjectService({ db });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    handlers: { ...createMockStageHandlers(), STORY_MINING: createStoryMiningStage(cfg), STORY_ARCHITECTURE: createStoryArchitectureStage(cfg) },
    retryBaseDelayMs: 0,
  });
  return { ai, projects, runner };
}
type Setup = ReturnType<typeof setup>;

/** A project whose research was approved (synthetic dossier v1). */
async function researched(s: Setup) {
  const p = await s.projects.createProject(tulipInput, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  return { projectId: p.id, ...(await seedFakeDossier(db, p.id)) };
}

async function run(s: Setup, projectId: string, type: JobType, input?: Record<string, unknown>) {
  const job = await s.projects.enqueueJob(projectId, { type, ...(input ? { input } : {}) }, 'test');
  await s.runner.drain();
  return db.job.findUniqueOrThrow({ where: { id: job.id } });
}

const statusOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).status;
const latestPack = (projectId: string) =>
  db.storyPack.findFirstOrThrow({
    where: { projectId },
    orderBy: { version: 'desc' },
    include: { candidates: { orderBy: { rank: 'asc' }, include: { claims: { include: { claim: { select: { claimKey: true } } } } } } },
  });
const latestArchitecture = (projectId: string) => db.storyArchitecture.findFirstOrThrow({ where: { projectId }, orderBy: { version: 'desc' } });

/** The editor's selection: exactly these titles. */
async function selectTitles(projectId: string, titles: string[]) {
  const pack = await latestPack(projectId);
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: titles } }, data: { selected: true } });
}

describe('story mining (fake AI, real database)', () => {
  it('mines a ranked, evidence-checked pack with a proposed selection and waits for the editor', async () => {
    const s = setup();
    const { projectId } = await researched(s);
    const job = await run(s, projectId, 'STORY_MINING');

    expect(job).toMatchObject({ status: 'SUCCEEDED', isMock: false, checkpoint: null });
    expect(await statusOf(projectId)).toBe('STORY_SELECTION');
    const pack = await latestPack(projectId);
    expect(pack).toMatchObject({ version: 1, status: 'IN_REVIEW', qualityPassed: true, jobId: job.id });
    expect(pack.candidates).toHaveLength(15);
    expect(pack.candidates.map((c) => c.candidateKey)).toEqual(Array.from({ length: 15 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`));
    const scores = pack.candidates.map((c) => c.rankScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // Every violation was removed, with its reason, and nothing was approved by the AI.
    const content = StoryPackContent.parse(pack.content);
    expect(content.removed.map((r) => r.title).sort()).toEqual(FAKE_INVALID.map((c) => c.title).sort());
    expect(pack.candidates.every((c) => c.status === 'PROPOSED')).toBe(true);

    // The proposal (an unknown key dropped) becomes the starting selection.
    expect(content.selection.candidateKeys).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07']);
    expect(pack.candidates.filter((c) => c.selected).map((c) => c.candidateKey)).toEqual(content.selection.candidateKeys);
    expect(pack.candidates.filter((c) => c.aiSelected)).toHaveLength(7);

    // Evidence links are rows; repaired links and caveats are kept.
    const byTitle = new Map(pack.candidates.map((c) => [c.title, c]));
    expect(byTitle.get('Proefman in court')!.claims.map((x) => x.claim.claimKey).sort()).toEqual(['C008', 'C018']);
    expect(byTitle.get('The Semper Augustus price')).toMatchObject({ historicalStatus: 'CONTESTED', notes: 'Say that no completed sale is documented.' });
    expect(byTitle.get('The sailor and the onion')).toMatchObject({ historicalStatus: 'MYTH_INVESTIGATION' });
    expect(QualityReport.parse(pack.qualityReport).normalizations).toContain('Proefman in court: linked C018 (source of the figure 300)');

    // Three model calls, all in the ledger with their cost.
    expect(s.ai.calls).toEqual({ 'story.mine': 1, 'story.critic': 1, 'story.select': 1 });
    const calls = await db.providerCall.findMany({ where: { jobId: job.id } });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.status === 'SUCCEEDED' && c.costBasis === 'ESTIMATED' && c.estimatedCostUsd!.toNumber() > 0 && c.durationMs !== null)).toBe(true);
    expect(job.result).toMatchObject({ packId: pack.id, candidates: 15, selected: 7, removed: 7, qualityPassed: true });
    const progress = await db.projectEvent.findMany({ where: { jobId: job.id, type: 'JOB_PROGRESS' }, orderBy: { createdAt: 'asc' } });
    expect(progress.at(-1)!.message).toBe('Story pack v1 saved: 15 candidates, 7 proposed for the documentary — quality gate PASSED');
  });

  it('refuses to mine without an approved research dossier', async () => {
    const s = setup();
    const { projectId, dossierId } = await researched(s);
    await db.researchDossier.update({ where: { id: dossierId }, data: { status: 'IN_REVIEW' } });
    const job = await run(s, projectId, 'STORY_MINING');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(job.error).toMatch(/needs an approved research dossier/);
    expect(s.ai.calls).toEqual({});
  });

  it('tops up when the evidence rules leave too few candidates, telling the model what was removed', async () => {
    const s = setup();
    s.ai.mineBatches = [[...FAKE_VALID.slice(0, 10), ...FAKE_INVALID], FAKE_VALID.slice(10)];
    const { projectId } = await researched(s);
    const job = await run(s, projectId, 'STORY_MINING');

    expect(job.status).toBe('SUCCEEDED');
    expect(s.ai.calls).toMatchObject({ 'story.mine': 2, 'story.critic': 2 });
    const topUp = s.ai.prompts['story.mine']![1]!;
    expect(topUp).toMatch(/^Propose 9 story candidates/m);
    expect(topUp).toContain('- The invented merchant: names a person who is not in the dossier: Hendrik Fakename');
    expect(topUp).toContain('Contracts for flowers still in the ground');
    expect((await latestPack(projectId)).candidates).toHaveLength(15);
  });

  it('keeps a failed pack as a DRAFT and re-evaluates it on retry without paying again', async () => {
    const s = setup();
    s.ai.mineBatches = [FAKE_INVALID];
    const { projectId } = await researched(s);
    const job = await run(s, projectId, 'STORY_MINING');

    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    // Only the near-duplicate of a missing original survives: far too few.
    expect(job.error).toMatch(/Story mining quality gate failed: Story candidates \(1 candidate \(expected 15–30/);
    expect(job.checkpoint).not.toBeNull();
    expect(await statusOf(projectId)).toBe('FAILED');
    expect(await latestPack(projectId)).toMatchObject({ version: 1, status: 'DRAFT', qualityPassed: false });
    expect(s.ai.calls).toEqual({ 'story.mine': 2, 'story.critic': 2, 'story.select': 1 });

    const retry = await s.projects.retryJob(job.id, 'test');
    await s.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({ status: 'FAILED' });
    expect(s.ai.calls).toEqual({ 'story.mine': 2, 'story.critic': 2, 'story.select': 1 });
    expect((await latestPack(projectId)).stats).toMatchObject({ resumedSteps: ['mine', 'score', 'topUp', 'topUpScore', 'select'] });
    expect(await db.storyPack.findFirstOrThrow({ where: { projectId, version: 1 } })).toMatchObject({ status: 'SUPERSEDED' });
  });

  it('resumes after a transient failure without repeating completed model calls', async () => {
    const s = setup();
    s.ai.failNextTask = 'story.select';
    const { projectId } = await researched(s);
    const job = await run(s, projectId, 'STORY_MINING');

    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(s.ai.calls).toEqual({ 'story.mine': 1, 'story.critic': 1, 'story.select': 2 });
    expect((await latestPack(projectId)).stats).toMatchObject({ resumedSteps: ['mine', 'score'] });
  });

  it('runs another pass with the editor\'s brief, carrying approved and flagged candidates and excluding rejected ones', async () => {
    const s = setup();
    const { projectId } = await researched(s);
    await run(s, projectId, 'STORY_MINING');
    const v1 = await latestPack(projectId);
    const [approved, rejected, flagged] = [v1.candidates[1]!, v1.candidates[2]!, v1.candidates[4]!];
    await db.storyCandidate.update({ where: { id: approved.id }, data: { status: 'APPROVED', priority: 'HIGH', editorNotes: 'Keep this one' } });
    await db.storyCandidate.update({ where: { id: rejected.id }, data: { status: 'REJECTED', selected: false } });
    await db.storyCandidate.update({ where: { id: flagged.id }, data: { status: 'FLAGGED', editorNotes: 'Check the date' } });

    const job = await s.projects.restartPhase(projectId, 'STORY_MINING', { notes: 'Find more about the courts.' }, 'editor', 'Another mining pass');
    expect(await statusOf(projectId)).toBe('STORY_MINING');
    await s.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(await statusOf(projectId)).toBe('STORY_SELECTION');

    const prompt = s.ai.prompts['story.mine']![1]!;
    expect(prompt).toContain("The editor's brief for this pass (follow it):\nFind more about the courts.");
    expect(prompt).toContain(`Rejected by the editor — do not propose these or close variants:\n- ${rejected.title}`);
    expect(prompt).toContain(`- ${approved.candidateKey}: ${approved.title}`);

    const v2 = await latestPack(projectId);
    expect(v2).toMatchObject({ version: 2, status: 'IN_REVIEW', notes: 'Find more about the courts.' });
    expect((await db.storyPack.findFirstOrThrow({ where: { id: v1.id } })).status).toBe('SUPERSEDED');
    const carried = v2.candidates.filter((c) => c.status !== 'PROPOSED');
    expect(carried.map((c) => [c.title, c.status, c.priority, c.editorNotes]).sort()).toEqual(
      [
        [approved.title, 'APPROVED', 'HIGH', 'Keep this one'],
        [flagged.title, 'FLAGGED', 'NORMAL', 'Check the date'],
      ].sort(),
    );
    expect(v2.candidates.some((c) => c.title === rejected.title)).toBe(false);
    const content = StoryPackContent.parse(v2.content);
    expect(content.removed.map((r) => r.reason)).toContain(`too close to a candidate the editor rejected ("${rejected.title}")`);
    expect(content.carriedOver).toHaveLength(2);
    expect(content.editorNotes).toBe('Find more about the courts.');
  });

  it('carries approved and flagged candidates from an engine-1 pack into a Story Engine 2.0 pass, scored by the engine-2 critic', async () => {
    const s = setup();
    const { projectId } = await researched(s);
    await run(s, projectId, 'STORY_MINING');
    const v1 = await latestPack(projectId);
    // What an engine-1 pack looks like after the additive migration: engine_version 1, v1 scores, the new columns empty.
    await db.storyPack.update({ where: { id: v1.id }, data: { engineVersion: 1 } });
    await db.storyCandidate.updateMany({
      where: { packId: v1.id },
      data: {
        scores: { intrigue: 7, humanDrama: 6, stakes: 7, surprise: 5, escalation: 6, visualPotential: 7, financialStakes: 8, emotionalWeight: 5, appeal: 6.6, rationale: 'Engine-1 scores (test).' },
        narrativeMode: null,
        centralQuestion: null,
        povStrategy: Prisma.DbNull,
        humanStakes: Prisma.DbNull,
        storyDesign: Prisma.DbNull,
        reconstructionLevel: null,
        storyValue: null,
        historicalValue: null,
      },
    });
    const [approved, flagged] = [v1.candidates[0]!, v1.candidates[3]!];
    await db.storyCandidate.update({ where: { id: approved.id }, data: { status: 'APPROVED', priority: 'HIGH', editorNotes: 'Keep this one' } });
    await db.storyCandidate.update({ where: { id: flagged.id }, data: { status: 'FLAGGED' } });

    const job = await s.projects.restartPhase(projectId, 'STORY_MINING', { notes: 'A Story Engine 2.0 pass.' }, 'editor', 'Story Engine 2.0 pass');
    await s.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    // One critic call for the first pass; on this pass one for the carried engine-1 candidates and one for the new ones.
    expect(s.ai.calls['story.critic']).toBe(3);
    expect(s.ai.prompts['story.critic']![1]).toContain(`### K01 — ${approved.title} [`);

    const v2 = await latestPack(projectId);
    expect(v2).toMatchObject({ version: 2, engineVersion: 2, status: 'IN_REVIEW', qualityPassed: true });
    const carried = v2.candidates.filter((c) => c.status !== 'PROPOSED');
    expect(carried.map((c) => [c.title, c.status, c.priority]).sort()).toEqual(
      [
        [approved.title, 'APPROVED', 'HIGH'],
        [flagged.title, 'FLAGGED', 'NORMAL'],
      ].sort(),
    );
    for (const c of carried) {
      expect(StoryScoresV2.parse(c.scores).rationale).toMatch(/^Test assessment of/);
      expect(c.storyValue).toBeGreaterThan(0);
      expect(c.narrativeMode).not.toBeNull();
      expect(c.storyDesign).toMatchObject({ coldOpen: { basis: 'UNCERTAIN' } });
      expect(c.povStrategy).toEqual({ type: 'NARRATOR', description: '' });
    }
    expect(QualityReport.parse(v2.qualityReport).checks.find((c) => c.id === 'carried_scored')).toMatchObject({ status: 'PASS' });
    // The engine-1 pack is kept, superseded, readable.
    expect(await db.storyPack.findUniqueOrThrow({ where: { id: v1.id } })).toMatchObject({ engineVersion: 1, status: 'SUPERSEDED' });
  });
});

describe('story architecture 2.0 (fake AI, real database)', () => {
  async function mined(s: Setup) {
    const r = await researched(s);
    await run(s, r.projectId, 'STORY_MINING');
    return r;
  }
  const keyOf = async (projectId: string, title: string) => (await latestPack(projectId)).candidates.find((c) => c.title === title)!.candidateKey;
  const opportunitiesOf = (architectureId: string) => db.contentOpportunity.findMany({ where: { architectureId }, orderBy: { opportunityKey: 'asc' }, include: { claims: { include: { claim: { select: { claimKey: true } } } } } });

  it('builds a traceable v2 blueprint, identifies content opportunities, then waits for a human approval of each', async () => {
    const s = setup();
    const { projectId, dossierId, claimIds } = await mined(s);
    const pack = await latestPack(projectId);
    await db.storyCandidate.update({ where: { id: pack.candidates[1]!.id }, data: { priority: 'HIGH' } });

    const job = await run(s, projectId, 'STORY_ARCHITECTURE');
    expect(job).toMatchObject({ status: 'SUCCEEDED', checkpoint: null });
    expect(await statusOf(projectId)).toBe('STORY_REVIEW');

    const arch = await latestArchitecture(projectId);
    expect(arch).toMatchObject({ version: 1, engineVersion: 2, status: 'IN_REVIEW', qualityPassed: true, packId: pack.id, dossierId, targetDurationSec: 750, estimatedDurationSec: 840, jobId: job.id });
    const content = StoryArchitectureContentV2.parse(arch.content);
    expect(content.sequences).toHaveLength(7);
    const selectedIds = new Set(pack.candidates.filter((c) => c.selected).map((c) => c.id));
    for (const sq of content.sequences) {
      expect(sq.candidateIds.every((id) => selectedIds.has(id))).toBe(true);
      expect(sq.sourceIds.length).toBeGreaterThan(0);
      expect(sq.claimKeys.length).toBeGreaterThan(0);
      expect(sq.beats.every((b, j) => b.id === `${sq.number}.${j + 1}`)).toBe(true);
      // Every claim a beat cites is in the approved dossier.
      expect(sq.beats.flatMap((b) => b.claimKeys).every((k) => k in claimIds)).toBe(true);
    }
    expect(content.cast[0]).toMatchObject({ id: 'pov', kind: 'POV_PROXY' });
    expect(content.sequences.at(-1)!.continuity.resolves).toContain('Q0');

    // The HIGH-priority unit leads the architect's brief; each reviewer was asked once.
    const prompt = s.ai.prompts['story.architect']![0]!;
    expect(prompt.indexOf(`## ${pack.candidates[1]!.candidateKey} · HIGH priority`)).toBeLessThan(prompt.indexOf(`## ${pack.candidates[0]!.candidateKey} ·`));
    expect(s.ai.calls).toMatchObject({ 'story.architect': 1, 'story.storyEditor': 1, 'story.review': 1, 'story.opportunities': 1 });
    expect(arch.stats).toMatchObject({ engineVersion: 2, revisedByStoryEditor: false, revisedByFactChecker: false, opportunities: { kept: 6, shorts: 5 } });
    const report = QualityReport.parse(arch.qualityReport);
    expect(report.checks.find((c) => c.id === 'story_review')).toMatchObject({ status: 'PASS' });
    expect(report.checks.find((c) => c.id === 'content_opportunities')).toMatchObject({ status: 'PASS', detail: '5 short-form and 1 long-form opportunities, each traced to architecture beats; 2 removed by the rules' });

    // Opportunities: stored with their claim links, traced to the architecture's beats, all PROPOSED.
    const opportunities = await opportunitiesOf(arch.id);
    expect(opportunities.map((o) => `${o.opportunityKey} ${o.format} ${o.rank ?? '-'} ${o.status}`)).toEqual([
      'O01 SHORT 1 PROPOSED',
      'O02 BOTH 2 PROPOSED',
      'O03 SHORT 3 PROPOSED',
      'O04 SHORT 4 PROPOSED',
      'O05 SHORT 5 PROPOSED',
      'O06 LONG_FORM - PROPOSED',
    ]);
    const beats = new Map(content.sequences.flatMap((sq) => sq.beats.map((b) => [b.id, b] as const)));
    for (const o of opportunities) {
      const c = ContentOpportunityContent.parse(o.content);
      expect(o).toMatchObject({ projectId, dossierId });
      expect(c.beatIds.every((id) => beats.has(id))).toBe(true);
      expect(o.claims.map((x) => x.claim.claimKey).sort()).toEqual([...c.claimKeys].sort());
      expect(o.claims.every((x) => x.claimId === claimIds[x.claim.claimKey])).toBe(true);
      const fromBeats = new Set(c.beatIds.flatMap((id) => beats.get(id)!.claimKeys));
      expect(c.claimKeys.every((k) => fromBeats.has(k))).toBe(true);
    }

    // Nothing moves on without a human; the architecture decision does not decide the opportunities.
    const { approval } = await s.projects.recordApproval(projectId, { gate: 'STORY', decision: 'APPROVED', notes: 'Strong opening.' }, 'editor');
    expect(approval).toMatchObject({ storyId: arch.id, dossierId, projectStatus: 'STORY_REVIEW' });
    expect(await statusOf(projectId)).toBe('STORY_APPROVED');
    expect((await latestArchitecture(projectId)).status).toBe('APPROVED');
    expect((await latestPack(projectId)).status).toBe('APPROVED');
    expect((await opportunitiesOf(arch.id)).every((o) => o.status === 'PROPOSED')).toBe(true);
    expect(await db.job.count({ where: { projectId, type: 'SCRIPT' } })).toBe(0);

    // The editor decides each opportunity individually.
    const [first, second] = opportunities;
    expect(await s.projects.editContentOpportunity(first!.id, { status: 'APPROVED', editorNotes: 'Lead short.' }, 'editor')).toMatchObject({ status: 'APPROVED', decidedBy: 'editor', editorNotes: 'Lead short.' });
    expect(await s.projects.editContentOpportunity(second!.id, { status: 'REJECTED' }, 'editor')).toMatchObject({ status: 'REJECTED', decidedBy: 'editor' });
    expect(await s.projects.editContentOpportunity(second!.id, { status: 'PROPOSED' }, 'editor')).toMatchObject({ status: 'PROPOSED', decidedBy: null, decidedAt: null });
    expect(await db.projectEvent.count({ where: { projectId, type: 'OPPORTUNITY_UPDATED' } })).toBe(3);

    // Re-opening the selection makes the pack editable again; the approved architecture stays approved.
    await s.projects.rewind(projectId, { to: 'STORY_SELECTION', reason: 'Try a different cut' }, 'editor');
    expect((await latestPack(projectId)).status).toBe('IN_REVIEW');
    await s.projects.editStoryCandidate(pack.candidates[0]!.id, { selected: false }, 'editor');
    expect((await latestArchitecture(projectId)).status).toBe('APPROVED');

    // A newer architecture supersedes the old one's opportunities: they can no longer be decided.
    await s.projects.editStoryCandidate(pack.candidates[0]!.id, { selected: true }, 'editor');
    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    await expect(s.projects.editContentOpportunity(first!.id, { status: 'REJECTED' }, 'editor')).rejects.toThrow(/belongs to architecture v1, which is no longer the latest/);
  });

  const UNCERTAIN = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips'];

  it('lets the fact checker fix uncertain material told without its presentation', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, UNCERTAIN);
    s.ai.architectOptions = { omitPresentation: true, secondsPerSequence: 150 };
    s.ai.factCheckFixes = true;
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');

    expect(job.status).toBe('SUCCEEDED');
    const arch = await latestArchitecture(projectId);
    expect(arch.stats).toMatchObject({ revisedByFactChecker: true, finalFindings: 0 });
    expect((arch.stats as { draftFindings: number }).draftFindings).toBe(5);
    const report = QualityReport.parse(arch.qualityReport);
    expect(report.coherenceIssues[0]).toMatchObject({ severity: 'CRITICAL', resolution: 'Fixed in the revised architecture' });
    const content = StoryArchitectureContentV2.parse(arch.content);
    const semper = content.sequences.find((sq) => sq.claimKeys.includes('C009'))!;
    expect(semper.presentation).toEqual([{ claimKey: 'C009', presentation: 'PRESENT_AS_DISPUTED', instruction: 'Present it as disputed and give both sides (test). (review fix)' }]);
    expect(semper.historicalStatus).toBe('CONTESTED');
    const ruin = content.sequences.find((sq) => sq.claimKeys.includes('C010'))!;
    expect(ruin.presentation).toEqual([{ claimKey: 'C010', presentation: 'INVESTIGATE_AS_MYTH', instruction: 'Tell it as a legend under investigation (test). (review fix)' }]);
    // Opportunities carry the architecture's presentation for the claims they use.
    for (const o of await opportunitiesOf(arch.id)) {
      const c = ContentOpportunityContent.parse(o.content);
      for (const k of c.claimKeys.filter((x) => ['C009', 'C010'].includes(x))) expect(c.presentation.find((p) => p.claimKey === k)?.instruction).toMatch(/\(review fix\)$/);
    }
  });

  it('fails the gate when uncertain material stays without its presentation, keeping the draft and identifying no opportunities', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, UNCERTAIN);
    s.ai.architectOptions = { omitPresentation: true, secondsPerSequence: 150 };
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');

    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(job.error).toMatch(/Story architecture quality gate failed: Uncertain history keeps its status \(5: Sequence \d: uses C\d{3} \((PROBABLE|DISPUTED|MYTH)\) without saying how the narration must present it/);
    expect(job.error).not.toMatch(/Figures and dates/);
    expect(job.checkpoint).not.toBeNull();
    expect(await statusOf(projectId)).toBe('FAILED');
    const arch = await latestArchitecture(projectId);
    expect(arch).toMatchObject({ status: 'DRAFT', qualityPassed: false, engineVersion: 2 });
    expect(s.ai.calls['story.opportunities']).toBeUndefined();
    expect(await db.contentOpportunity.count({ where: { architectureId: arch.id } })).toBe(0);
  });

  it('re-checks a failed architecture on Retry against the editor\'s current decisions, without paying again', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, NO_DISPUTES);
    const striped = await keyOf(projectId, 'Striped tulips');
    const pack = await latestPack(projectId);
    const stripedId = pack.candidates.find((c) => c.candidateKey === striped)!.id;
    await db.storyCandidate.update({ where: { id: stripedId }, data: { priority: 'HIGH' } });
    // The architect leaves the HIGH-priority unit out.
    s.ai.architectOptions = { secondsPerSequence: 190, transform: (o) => ({ ...o, sequences: o.sequences.filter((sq) => !sq.candidateKeys.includes(striped)) }) };
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');

    expect(job.status).toBe('FAILED');
    expect(job.error).toContain(`HIGH-priority units are used (1: ${striped} "Striped tulips" is HIGH priority but no sequence uses it)`);
    expect(s.ai.calls).toMatchObject({ 'story.architect': 1, 'story.storyEditor': 1, 'story.review': 1 });

    // The editor decides the unit can go after all; Retry re-applies the rules to the saved model output.
    await db.storyCandidate.update({ where: { id: stripedId }, data: { priority: 'NORMAL' } });
    const retry = await s.projects.retryJob(job.id, 'test');
    await s.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: retry.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect(s.ai.calls).toMatchObject({ 'story.architect': 1, 'story.storyEditor': 1, 'story.review': 1, 'story.opportunities': 1 });
    const arch = await latestArchitecture(projectId);
    expect(arch).toMatchObject({ version: 2, status: 'IN_REVIEW', qualityPassed: true });
    expect(arch.stats).toMatchObject({ resumedSteps: ['architect', 'storyReview', 'factCheck'] });
    expect(QualityReport.parse(arch.qualityReport).checks.find((c) => c.id === 'unused_units')).toMatchObject({ status: 'WARN' });
    expect(await statusOf(projectId)).toBe('STORY_REVIEW');
  });

  it('keeps a story editor\'s revision only if the evidence rules find no more problems in it', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, NO_DISPUTES);
    s.ai.architectOptions = { secondsPerSequence: 150 };
    s.ai.storyEditorRevision = (d) => {
      d.sequences[0]!.beats[1]!.description = 'Buyers pay 7,777 guilders for a single bulb (test).';
      return d;
    };
    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    const rejected = await latestArchitecture(projectId);
    expect(rejected.stats).toMatchObject({ revisedByStoryEditor: false });
    expect(QualityReport.parse(rejected.qualityReport).normalizations).toContain("The story editor's revision was discarded: it had 1 evidence problems against 0.");

    await s.projects.recordApproval(projectId, { gate: 'STORY', decision: 'REJECTED', notes: 'Sharper logline.' }, 'editor');
    s.ai.storyEditorRevision = (d) => ({ ...d, logline: 'A trade in promises, until nobody came to pay (story editor).' });
    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    const accepted = await latestArchitecture(projectId);
    expect(accepted.stats).toMatchObject({ revisedByStoryEditor: true });
    expect(StoryArchitectureContentV2.parse(accepted.content).logline).toBe('A trade in promises, until nobody came to pay (story editor).');
  });

  it('reports an unavailable reviewer or opportunities step without failing the job', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, NO_DISPUTES);
    s.ai.architectOptions = { secondsPerSequence: 150 };
    s.ai.brokenTask = 'story.storyEditor';
    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    const report = QualityReport.parse((await latestArchitecture(projectId)).qualityReport);
    expect(report.checks.find((c) => c.id === 'story_review')).toMatchObject({ status: 'WARN', detail: 'Story review unavailable: [fake-ai] refused (test)' });

    await s.projects.recordApproval(projectId, { gate: 'STORY', decision: 'REJECTED', notes: 'Again.' }, 'editor');
    s.ai.brokenTask = 'story.opportunities';
    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    const arch = await latestArchitecture(projectId);
    expect(QualityReport.parse(arch.qualityReport).checks.find((c) => c.id === 'content_opportunities')).toMatchObject({ status: 'WARN', detail: 'Not identified: [fake-ai] refused (test)' });
    expect(await db.contentOpportunity.count({ where: { architectureId: arch.id } })).toBe(0);
  });

  it('fails invented people and a runtime far from the target', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    s.ai.architectOptions = { inventPerson: 'Hendrik Fakename', secondsPerSequence: 30 };
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');

    expect(job.status).toBe('FAILED');
    const report = QualityReport.parse((await latestArchitecture(projectId)).qualityReport);
    const failed = report.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);
    expect(failed).toEqual(['grounded_people', 'runtime']);
  });

  const NO_DISPUTES = ['The tavern colleges', 'Striped tulips', 'Proefman in court', 'The courts step back', 'Prices before the fall'];

  it('gives the architect the selected units\' claims as story evidence and other claims as background only', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, NO_DISPUTES); // units rest on C002, C005, C007, C008, C014, C017, C018, C020
    s.ai.architectOptions = { secondsPerSequence: 150, contextClaims: [{ claimKey: 'C001', purpose: 'How contracts for buried bulbs worked' }] };
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');

    expect(job.status).toBe('SUCCEEDED');
    const prompt = s.ai.prompts['story.architect']![0]!;
    const story = prompt.slice(prompt.indexOf("# Story evidence: the selected units' claims (8)"), prompt.indexOf('# Other claims of the approved dossier'));
    const background = prompt.slice(prompt.indexOf('# Other claims of the approved dossier: background only (12)'));
    expect(story).toMatch(/^C002 \[/m);
    expect(story).not.toMatch(/^C001 \[/m);
    expect(background).toMatch(/^C001 \[ESTABLISHED\] In the winter/m);
    expect(background).not.toMatch(/^C002 \[/m);
    expect(prompt).toContain('Claims that need a presentation entry in every sequence that uses them:');

    const first = StoryArchitectureContentV2.parse((await latestArchitecture(projectId)).content).sequences[0]!;
    expect(first.contextClaims).toEqual([{ claimKey: 'C001', purpose: 'How contracts for buried bulbs worked' }]);
    expect(first.claimKeys).not.toContain('C001');
    expect(first.beats.find((b) => b.claimKeys.includes('C001'))).toMatchObject({ function: 'ORIENTATION' });
    expect(first.contextSourceIds.length).toBeGreaterThan(0);
  });

  it('fails story evidence taken from outside the selection unless the fact checker turns it into labelled background', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, NO_DISPUTES);
    s.ai.architectOptions = { secondsPerSequence: 150, outsideCore: 'C016' };
    const failedJob = await run(s, projectId, 'STORY_ARCHITECTURE');
    expect(failedJob.status).toBe('FAILED');
    expect(failedJob.error).toContain("Story evidence is the selected units' own claims (2: ");
    expect(failedJob.error).toContain("Sequence 1: beat 1.3 rests on C016, outside the selected units' claims (background may only orient)");
    expect(failedJob.error).toContain('Sequence 1: uses C016 as story evidence, but it is not a claim of the selected units');

    // Start over from the selection, this time with a fact checker that fixes it.
    await s.projects.rewind(projectId, { to: 'STORY_SELECTION', reason: 'Try again' }, 'editor');
    s.ai.factCheckFixes = true;
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');
    expect(job.status).toBe('SUCCEEDED');
    const arch = await latestArchitecture(projectId);
    expect(arch.stats).toMatchObject({ revisedByFactChecker: true, finalFindings: 0 });
    const first = StoryArchitectureContentV2.parse(arch.content).sequences[0]!;
    expect(first.claimKeys).not.toContain('C016');
    expect(first.beats.flatMap((b) => b.claimKeys)).not.toContain('C016');
    expect(first.contextClaims).toEqual([{ claimKey: 'C016', purpose: 'Background only: explains the setting (review fix).' }]);
  });

  it('refuses a selection outside 5–10 units', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await selectTitles(projectId, ['The tavern colleges', 'Striped tulips', 'Proefman in court']);
    const job = await run(s, projectId, 'STORY_ARCHITECTURE');
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1, error: 'NonRetryableError: Cannot build the architecture: Select at least 5 story units (3 selected).' });
    expect(s.ai.calls['story.architect']).toBeUndefined();
  });

  it('reworks a rejected architecture with the editor\'s notes and preferences', async () => {
    const s = setup();
    const { projectId } = await mined(s);
    await run(s, projectId, 'STORY_ARCHITECTURE');
    await s.projects.recordApproval(projectId, { gate: 'STORY', decision: 'REJECTED', notes: 'Open with the courts, not the auction.' }, 'editor');
    expect(await statusOf(projectId)).toBe('STORY_SELECTION');
    expect((await latestArchitecture(projectId)).status).toBe('REJECTED');

    const job = await run(s, projectId, 'STORY_ARCHITECTURE', { notes: 'Keep it under 13 minutes.', preferences: { narrativeMode: 'COURTROOM_DISPUTE', povStrategy: { type: 'INVESTIGATOR', description: 'Open the court files.' } } });
    expect(job.status).toBe('SUCCEEDED');
    const prompt = s.ai.prompts['story.architect']![1]!;
    expect(prompt).toContain("The editor's instructions for this version (follow them):\nKeep it under 13 minutes.");
    expect(prompt).toContain("The editor's preferences for the documentary (follow them, or say why not in orderNote):\n- narrative mode: COURTROOM_DISPUTE\n- POV strategy: INVESTIGATOR — Open the court files.");
    expect(prompt).toContain('Previous architecture v1 (REJECTED). The editor\'s decisions on it:\n- REJECTED: Open with the courts, not the auction.');
    expect(prompt).toContain('Central question: Why did a flower trade end in court?');
    expect(await latestArchitecture(projectId)).toMatchObject({ version: 2, status: 'IN_REVIEW', notes: 'Keep it under 13 minutes.' });
    expect(await statusOf(projectId)).toBe('STORY_REVIEW');
  });

  it('reads an engine-1 architecture when reworking it', async () => {
    const s = setup();
    const { projectId, dossierId } = await mined(s);
    const pack = await latestPack(projectId);
    const v1 = StoryArchitectureContent.parse({
      premise: 'An engine-1 premise.',
      centralQuestion: 'Why did it end in court?',
      narrativeSpine: 'Spine.',
      resolution: 'Answer.',
      sequences: [
        { number: 1, title: 'The contracts', purpose: 'Opens.', candidateIds: [pack.candidates[0]!.id], candidateKeys: ['S01'], openingHook: 'Hook.', narrativeQuestion: 'Q?', keyEvents: [{ event: 'E', claimKeys: ['C001'] }], characters: [], conflict: '', escalation: '', reveal: '', endingBeat: '', claimKeys: ['C001'], sourceIds: [], caveats: [], historicalStatus: 'ESTABLISHED', historicalConfidence: 9, estimatedDurationSec: 120 },
      ],
      unusedCandidates: [],
    });
    await db.storyArchitecture.create({ data: { projectId, dossierId, packId: pack.id, version: 1, engineVersion: 1, status: 'REJECTED', content: v1, targetDurationSec: 750, estimatedDurationSec: 120, qualityPassed: true } });

    expect((await run(s, projectId, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    const prompt = s.ai.prompts['story.architect']![0]!;
    expect(prompt).toContain('Previous architecture v1 (REJECTED)');
    expect(prompt).toContain('Premise: An engine-1 premise.\nCentral question: Why did it end in court?\n1. The contracts (S01): Opens.');
    expect(await latestArchitecture(projectId)).toMatchObject({ version: 2, engineVersion: 2 });
    expect(await db.storyArchitecture.findFirstOrThrow({ where: { projectId, version: 1 } })).toMatchObject({ engineVersion: 1, status: 'REJECTED' });
  });
});

describe('the story stages and the research record', () => {
  it('never write to the research tables', async () => {
    const s = setup();
    const { projectId } = await researched(s);
    const snapshot = async () => ({
      dossiers: await db.researchDossier.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
      claims: await db.researchClaim.findMany({ where: { dossier: { projectId } }, orderBy: { id: 'asc' } }),
      citations: await db.claimCitation.findMany({ where: { claim: { dossier: { projectId } } }, orderBy: { id: 'asc' } }),
      sources: await db.source.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    });
    const before = await snapshot();
    await run(s, projectId, 'STORY_MINING');
    await run(s, projectId, 'STORY_ARCHITECTURE');
    await s.projects.recordApproval(projectId, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
    const opportunity = await db.contentOpportunity.findFirstOrThrow({ where: { projectId } });
    await s.projects.editContentOpportunity(opportunity.id, { status: 'APPROVED' }, 'editor');
    expect(await snapshot()).toEqual(before);
    expect(before.claims).toHaveLength(20);
  });
});
