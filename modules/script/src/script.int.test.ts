import { QualityReport, ScriptContent, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, createProviders, type ProviderSet } from '@docengine/providers';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { compareDrafts } from './compare.ts';
import type { ScriptConfig } from './config.ts';
import { ScriptEditing } from './editing.ts';
import { createScriptStage } from './stage.ts';
import { loadVersion } from './store.ts';
import { FakeScriptAI } from './testing.ts';

const db = useTestDatabase();

function setup(cfg: Partial<ScriptConfig> = {}) {
  const ai = new FakeScriptAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai };
  const projects = new ProjectService({ db });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    handlers: { ...createMockStageHandlers(), STORY_MINING: createStoryMiningStage(), STORY_ARCHITECTURE: createStoryArchitectureStage(), SCRIPT: createScriptStage(cfg) },
    retryBaseDelayMs: 0,
  });
  return { ai, projects, runner, editing: new ScriptEditing(db) };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

async function run(s: Setup, projectId: string, type: JobType, input?: Record<string, unknown>) {
  const job = await s.projects.enqueueJob(projectId, { type, ...(input ? { input } : {}) }, 'editor');
  await s.runner.drain();
  return db.job.findUniqueOrThrow({ where: { id: job.id } });
}
const statusOf = async (id: string) => (await db.project.findUniqueOrThrow({ where: { id } })).status;

/** A project with an approved Story Engine 2.0 architecture (synthetic dossier; a fictional composite in sequence 1). */
async function approvedArchitecture(s: Setup) {
  const p = await s.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  expect((await run(s, p.id, 'STORY_MINING')).status).toBe('SUCCEEDED');
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  s.ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  expect((await run(s, p.id, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
  await s.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  expect(await statusOf(p.id)).toBe('STORY_APPROVED');
  return p.id;
}

async function scripted(s: Setup) {
  const projectId = await approvedArchitecture(s);
  const job = await s.projects.generateScript(projectId, {}, 'editor');
  await s.runner.drain();
  expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
  return projectId;
}

const version = async (projectId: string, v: number) => (await loadVersion(db, projectId, v))!;
/** What a version says and how it was edited: compared before and after other versions are made. */
const snapshot = async (projectId: string, v: number) => {
  const x = await version(projectId, v);
  return {
    content: x.row.content,
    qualityReport: x.row.qualityReport,
    sections: x.draft.sections.map((sec) => ({ key: sec.key, status: sec.reviewStatus, notes: sec.editorNotes, blocks: sec.blocks.map((b) => [b.key, b.text, b.generatedText, b.editedBy, b.infoClass, b.claimKeys.join(','), JSON.stringify(b.delivery)]) })),
  };
};
const blockAt = async (projectId: string, v: number, key: string) => (await db.scriptBlock.findFirstOrThrow({ where: { blockKey: key, script: { projectId, version: v } } }));
const sectionAt = async (projectId: string, v: number, n: number) => db.scene.findFirstOrThrow({ where: { sequenceNumber: n, script: { projectId, version: v } } });

describe('script engine (fake AI, real database)', () => {
  it('writes a structured script from the approved architecture — traced, timed, performed — and stops for the editor', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s);
    const research = async () => ({
      claims: await db.researchClaim.findMany({ where: { dossier: { projectId } }, orderBy: { id: 'asc' } }),
      architectures: await db.storyArchitecture.findMany({ where: { projectId }, orderBy: { id: 'asc' }, select: { id: true, status: true, content: true, qualityReport: true } }),
      candidates: await db.storyCandidate.findMany({ where: { projectId }, orderBy: { id: 'asc' } }),
    });
    const before = await research();

    const job = await s.projects.generateScript(projectId, { notes: 'Keep the opening short (test).' }, 'editor');
    expect(await statusOf(projectId)).toBe('SCRIPT_DRAFT');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await statusOf(projectId)).toBe('SCRIPT_REVIEW');

    const v1 = await version(projectId, 1);
    const arch = await db.storyArchitecture.findFirstOrThrow({ where: { projectId, status: 'APPROVED' } });
    expect(v1.row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: true, storyId: arch.id, jobId: job.id, notes: 'Keep the opening short (test).', targetDurationSec: 180 });
    const report = QualityReport.parse(v1.row.qualityReport);
    expect(report.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    const content = ScriptContent.parse(v1.row.content);
    expect(content).toMatchObject({ architecture: { id: arch.id, version: arch.version }, narrator: { persona: 'A calm investigator (test).' }, centralQuestion: { posedIn: '1.1', answeredIn: expect.stringMatching(/^6\.\d+$/) }, provenance: { origin: 'DRAFT', requestedBy: 'editor', sections: [1, 2, 3, 4, 5, 6] } });
    // One section per sequence, a narration in the master language, blocks with their claims as rows.
    const sequences = (arch.content as { sequences: unknown[] }).sequences.length;
    expect(v1.draft.sections).toHaveLength(sequences);
    const scenes = await db.scene.findMany({ where: { scriptId: v1.row.id }, include: { narrations: { include: { languageVersion: true } } } });
    expect(scenes.every((sc) => sc.narrations.length === 1 && sc.narrations[0]!.languageVersion.language === 'en' && sc.narrations[0]!.wordCount > 0)).toBe(true);
    const blocks = v1.draft.sections.flatMap((x) => x.blocks);
    const links = await db.scriptBlockClaim.count({ where: { block: { scriptId: v1.row.id } } });
    expect(links).toBe(blocks.reduce((n, b) => n + b.claimKeys.length, 0));
    expect(blocks.find((b) => b.speakerId === 'F1')).toMatchObject({ infoClass: 'FICTION', speechKind: 'INVENTED', fictionalDevice: true, visual: { fictional: true } });
    expect(v1.draft.sections[1]!.blocks[0]!.delivery.pauseBefore).toEqual({ length: 'SHORT', reason: 'TRANSITION' });
    expect(content.pronunciations.map((p) => [p.term, p.needsReview])).toEqual([
      ['Cornelis Proefman', true],
      ['Pieter Graanhout', true],
    ]);
    // Five model calls, all in the ledger against this job, with their (estimated) cost.
    expect(s.ai.calls).toMatchObject({ 'script.plan': 1, 'script.write': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });
    const calls = await db.providerCall.findMany({ where: { jobId: job.id } });
    expect(calls.map((c) => c.provider)).toEqual(['fake-ai', 'fake-ai', 'fake-ai', 'fake-ai', 'fake-ai']);
    expect(calls.every((c) => c.costBasis === 'ESTIMATED' && Number(c.estimatedCostUsd) > 0)).toBe(true);
    // The writer was told the architecture, the plan and the evidence; never asked to research.
    const writerPrompt = s.ai.prompts['script.write']![0]!;
    expect(writerPrompt).toContain("# The editor's brief for this version (answer it)\nKeep the opening short (test).");
    expect(writerPrompt).toMatch(/^# The approved story architecture \(v\d+\)$/m);
    expect(writerPrompt).toMatch(/^# Evidence: the \d+ claims the architecture cites/m);
    // The research record and the story are untouched.
    expect(await research()).toEqual(before);
    const final = await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'desc' } });
    expect(final.message).toMatch(/^Script v1 saved for review: 6 sections, \d+ words, \d+:\d\d against a target of 3:00 .* — quality gate PASSED$/);
  });

  it('lets the editor edit, reorder and decide sections of the version under review, re-checking the gate each time', async () => {
    const s = setup();
    const projectId = await scripted(s);
    const target = await blockAt(projectId, 1, '5.2');
    // An unsupported number blocks approval; the generated text is kept; the change is on the activity log.
    await s.editing.editBlock(target.id, { text: 'The record shows that 4,321 buyers walked away (test).', delivery: { pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } } }, 'editor');
    let v1 = await version(projectId, 1);
    expect(v1.row.qualityPassed).toBe(false);
    expect(QualityReport.parse(v1.row.qualityReport).checks.find((c) => c.id === 'figures_names')).toMatchObject({ status: 'FAIL', detail: 'Block 5.2: 4321 is in no claim of the approved architecture' });
    const edited = await db.scriptBlock.findUniqueOrThrow({ where: { id: target.id } });
    expect(edited).toMatchObject({ text: 'The record shows that 4,321 buyers walked away (test).', generatedText: target.text, editedBy: 'editor' });
    const event = await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'SCRIPT_EDITED' } });
    expect(event.data).toMatchObject({ actor: 'editor', blockKey: '5.2', before: { text: target.text }, after: { text: 'The record shows that 4,321 buyers walked away (test).' } });
    await expect(s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/Script v1 has blocking quality findings \(Figures, dates and names come from the evidence\)/);

    // Fixed by hand: the gate passes again.
    await s.editing.editBlock(target.id, { text: 'The record shows what happened next (edited, test).' }, 'editor');
    v1 = await version(projectId, 1);
    expect(v1.row.qualityPassed).toBe(true);

    // Reorder a section; keys stay, positions change; a wrong order is refused.
    const sec1 = await sectionAt(projectId, 1, 1);
    const ids = (await db.scriptBlock.findMany({ where: { narration: { sceneId: sec1.id } }, orderBy: { sortOrder: 'asc' } })).map((b) => b.id);
    await s.editing.reorderBlocks(sec1.id, { blockIds: [ids[1]!, ids[0]!, ...ids.slice(2)] }, 'editor');
    const after = await db.scriptBlock.findMany({ where: { narration: { sceneId: sec1.id } }, orderBy: { sortOrder: 'asc' } });
    expect(after.map((b) => b.blockKey).slice(0, 2)).toEqual(['1.2', '1.1']);
    await expect(s.editing.reorderBlocks(sec1.id, { blockIds: ids.slice(1) }, 'editor')).rejects.toThrow(/exactly the blocks of the section/);

    // A rejected section blocks approval until it is approved (or rewritten).
    const sec2 = await sectionAt(projectId, 1, 2);
    await s.editing.reviewSection(sec2.id, { reviewStatus: 'REJECTED', editorNotes: 'Too slow (test).' }, 'editor');
    await expect(s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/rejected section\(s\) 2/);
    await s.editing.reviewSection(sec2.id, { reviewStatus: 'APPROVED' }, 'editor');
    expect(await sectionAt(projectId, 1, 2)).toMatchObject({ reviewStatus: 'APPROVED', reviewedBy: 'editor', editorNotes: 'Too slow (test).' });

    const { approval } = await s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED', notes: 'Ready for voice (test).' }, 'editor');
    expect(approval).toMatchObject({ scriptId: v1.row.id, gate: 'SCRIPT', decision: 'APPROVED' });
    expect(await statusOf(projectId)).toBe('SCRIPT_APPROVED');
    expect((await version(projectId, 1)).row.status).toBe('APPROVED');
    // An approved version is not edited.
    await expect(s.editing.editBlock(target.id, { text: 'Changed (test).' }, 'editor')).rejects.toThrow(/edited while the project is in SCRIPT_REVIEW/);
    // Nothing proceeds to voice automatically.
    expect(await db.job.count({ where: { projectId, type: 'VOICE' } })).toBe(0);
  });

  it('rewrites one section into a new version, copying every other section unchanged with no model calls for them', async () => {
    const s = setup();
    const projectId = await scripted(s);
    // The editor's work on v1: an edit in section 1, section 3 approved, section 2 rejected with a note.
    await s.editing.editBlock((await blockAt(projectId, 1, '1.3')).id, { text: 'The record shows what happened next, plainly (edited, test).' }, 'editor');
    await s.editing.reviewSection((await sectionAt(projectId, 1, 3)).id, { reviewStatus: 'APPROVED' }, 'editor');
    await s.editing.reviewSection((await sectionAt(projectId, 1, 2)).id, { reviewStatus: 'REJECTED', editorNotes: 'More tense, less explanatory (test).' }, 'editor');
    const v1 = await snapshot(projectId, 1);
    const callsBefore = { ...s.ai.calls };

    const job = await s.projects.reviseScript(projectId, { baseVersion: 1, sections: [2], brief: 'Make this section more tense and less explanatory (test).' }, 'editor');
    expect(await statusOf(projectId)).toBe('SCRIPT_DRAFT');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await statusOf(projectId)).toBe('SCRIPT_REVIEW');

    // v1 kept exactly as it was, superseded; v2 under review.
    expect(await snapshot(projectId, 1)).toEqual(v1);
    expect((await version(projectId, 1)).row.status).toBe('SUPERSEDED');
    const v2 = await version(projectId, 2);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', revisionOfId: (await version(projectId, 1)).row.id, notes: 'Make this section more tense and less explanatory (test).' });
    expect(ScriptContent.parse(v2.row.content).provenance).toMatchObject({ origin: 'SECTIONS', baseVersion: 1, sections: [2], requestedBy: 'editor', changeLog: { changes: [{ section: 2 }] } });
    const s2 = await snapshot(projectId, 2);
    // Every section but 2 is a copy: text, the editor's edit, the generated text, decisions.
    for (const i of [0, 2, 3, 4, 5]) expect(s2.sections[i]).toEqual(v1.sections[i]);
    expect(s2.sections[2]!.status).toBe('APPROVED');
    expect(s2.sections[1]!.status).toBe('PENDING');
    expect(s2.sections[1]!.blocks.every((b) => String(b[1]).includes('This time it is told more tightly (test).'))).toBe(true);
    // Model calls only for the rewritten section: no plan; one rewrite, one review of each kind, one performance pass.
    const delta = Object.fromEntries(Object.entries(s.ai.calls).map(([k, n]) => [k, n - (callsBefore[k] ?? 0)]).filter(([, n]) => n !== 0));
    expect(delta).toEqual({ 'script.rewrite': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });
    const prompt = s.ai.prompts['script.rewrite']![0]!;
    expect(prompt).toContain('# Rewrite section 2 of script v1; every other section stays exactly as it is');
    expect(prompt).toContain("The editor's brief: Make this section more tense and less explanatory (test).");
    expect(prompt).toContain('- Section 2 (rejected by the editor): More tense, less explanatory (test).');
    expect(s.ai.prompts['script.edit']!.at(-1)).toContain('— review and change only section 2');
    // Compared, only section 2 changed.
    const cmp = compareDrafts((await version(projectId, 1)).draft, v2.draft);
    expect(cmp.sections.filter((x) => x.changed).map((x) => x.sequenceNumber)).toEqual([2]);
    expect(await db.projectEvent.count({ where: { projectId, type: 'SCRIPT_REVISION_REQUESTED' } })).toBe(1);
  });

  it('rewrites the whole script from a brief (planned again), and restores an earlier version as a new one without model calls', async () => {
    const s = setup();
    const projectId = await scripted(s);
    await s.projects.reviseScript(projectId, { baseVersion: 1, brief: 'The first 90 seconds are too slow: start closer to the collapse (test).' }, 'editor');
    await s.runner.drain();
    const v2 = await version(projectId, 2);
    expect(ScriptContent.parse(v2.row.content).provenance).toMatchObject({ origin: 'REVISION', sections: [1, 2, 3, 4, 5, 6] });
    expect(s.ai.calls['script.plan']).toBe(2);
    expect(s.ai.prompts['script.plan']![1]).toContain('# The current script (v1) — the version to improve');
    expect(s.ai.prompts['script.write']![1]).toContain('The first 90 seconds are too slow: start closer to the collapse (test).');

    const v1 = await snapshot(projectId, 1);
    const calls = JSON.stringify(s.ai.calls);
    await s.editing.restore(projectId, { version: 1 }, 'editor');
    const v3 = await version(projectId, 3);
    expect(v3.row).toMatchObject({ status: 'IN_REVIEW', revisionOfId: (await version(projectId, 1)).row.id, jobId: null });
    expect(ScriptContent.parse(v3.row.content).provenance).toMatchObject({ origin: 'RESTORE', baseVersion: 1, requestedBy: 'editor' });
    expect((await snapshot(projectId, 3)).sections).toEqual(v1.sections);
    expect((await version(projectId, 2)).row.status).toBe('SUPERSEDED');
    expect(JSON.stringify(s.ai.calls)).toBe(calls);
    await expect(s.editing.restore(projectId, { version: 3 }, 'editor')).rejects.toThrow(/already the version under review/);
  });

  it('lets a version with blocking findings reach review, and keeps a fact checker’s fix only when it helps', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s);
    const inject = (out: import('./schemas.ts').WriterOutput) => {
      const b = out.sections[3]!.blocks[2]!;
      b.text = 'The record shows that 7,777 florists gave up (test).';
      return out;
    };
    s.ai.writerTransform = inject;
    // The fact checker fixes the block it was shown.
    s.ai.factChecker = (prompt) => {
      const ref = /^\[(\d+\.\d+)\] .*\n.*7,777/m.exec(prompt)?.[1] ?? '4.3';
      return { verdict: 'One unsupported figure (test).', issues: [{ ref, severity: 'CRITICAL', kind: 'WRONG_NUMBER', note: '7,777 is not in the evidence (test).' }], edits: [{ ref, text: 'The record shows what happened next (fixed, test).', infoClass: null, claimKeys: null, beatIds: null }], removals: [], insertions: [] };
    };
    await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    const v1 = await version(projectId, 1);
    expect(v1.row.qualityPassed).toBe(true);
    const fact = ScriptContent.parse(v1.row.content).factCheck!;
    expect(fact.issues).toEqual([{ ref: '4.3', severity: 'CRITICAL', kind: 'WRONG_NUMBER', note: '7,777 is not in the evidence (test).', resolution: 'fixed by its own edit' }]);
    expect(QualityReport.parse(v1.row.qualityReport).normalizations).toContain('Fact checker: 1 change(s) kept (blocking findings 1 → 0)');

    // Without a fix the version still reaches review, with the gate blocking approval.
    s.ai.factChecker = () => ({ verdict: 'Fine (test).', issues: [], edits: [], removals: [], insertions: [] });
    await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    expect(await statusOf(projectId)).toBe('SCRIPT_REVIEW');
    const v2 = await version(projectId, 2);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: false });
    expect((await version(projectId, 1)).row.status).toBe('SUPERSEDED');
    await expect(s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/blocking quality findings/);
  });

  it('resumes after a transient failure without paying again, and reports an unavailable reviewer without failing', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s);
    s.ai.failNextTask = 'script.factCheck';
    s.ai.brokenTask = 'script.edit';
    const job = await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(s.ai.calls).toMatchObject({ 'script.plan': 1, 'script.write': 1, 'script.edit': 1, 'script.factCheck': 2, 'script.perform': 1 });
    const v1 = await version(projectId, 1);
    expect(ScriptContent.parse(v1.row.content).editor).toBeNull();
    expect(QualityReport.parse(v1.row.qualityReport).checks.find((c) => c.id === 'script_editor')).toMatchObject({ status: 'WARN', detail: '[fake-ai] refused (test)' });
    expect(v1.row.stats).toMatchObject({ resumedSteps: ['plan', 'write', 'edit'] });
  });

  it('approving a newer script supersedes the approved one, and a revision needs the architecture it tells', async () => {
    const s = setup();
    const projectId = await scripted(s);
    await s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
    await s.projects.reviseScript(projectId, { baseVersion: 1, sections: [3], brief: 'Sharper ending for this section (test).' }, 'editor');
    await s.runner.drain();
    expect((await version(projectId, 1)).row.status).toBe('APPROVED');
    await s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
    expect((await db.script.findMany({ where: { projectId }, orderBy: { version: 'asc' } })).map((x) => `v${x.version} ${x.status}`)).toEqual(['v1 SUPERSEDED', 'v2 APPROVED']);
    expect(await db.projectEvent.count({ where: { projectId, type: 'SCRIPT_SUPERSEDED' } })).toBe(1);

    await expect(s.projects.reviseScript(projectId, { baseVersion: 9, brief: 'Anything at all (test).' }, 'editor')).rejects.toThrow(/Script v9 not found/);
    await expect(s.projects.reviseScript(projectId, { baseVersion: 2, sections: [42], brief: 'Anything at all (test).' }, 'editor')).rejects.toThrow(/has no section 42/);
    // A newer approved architecture: the old scripts tell an earlier one.
    const arch = await db.storyArchitecture.findFirstOrThrow({ where: { projectId, status: 'APPROVED' } });
    await db.storyArchitecture.update({ where: { id: arch.id }, data: { status: 'SUPERSEDED' } });
    await db.storyArchitecture.create({ data: { projectId, dossierId: arch.dossierId, packId: arch.packId, version: arch.version + 1, engineVersion: 2, status: 'APPROVED', content: arch.content ?? {}, qualityPassed: true } });
    await expect(s.projects.reviseScript(projectId, { baseVersion: 2, brief: 'Anything at all (test).' }, 'editor')).rejects.toThrow(/tells an architecture that is no longer the approved one/);
  });

  it('refuses a script without an approved Story Engine 2.0 architecture', async () => {
    const s = setup();
    const p = await s.projects.createProject(tulipInput, 'test');
    await expect(s.projects.generateScript(p.id, {}, 'editor')).rejects.toThrow(/A script can be written once the story architecture is approved/);
    await db.project.update({ where: { id: p.id }, data: { status: 'STORY_APPROVED' } });
    await expect(s.projects.generateScript(p.id, {}, 'editor')).rejects.toThrow(/No approved story architecture/);
  });
});
