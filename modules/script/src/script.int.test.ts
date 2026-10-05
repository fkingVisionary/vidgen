import { QualityReport, ScriptContent, runtimeTarget, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, ProviderError, createProviders, type ProviderSet } from '@docengine/providers';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { loadCorpus, textHash } from '@docengine/writing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { compareDrafts, evidenceChanges } from './compare.ts';
import type { ScriptConfig } from './config.ts';
import { ScriptEditing } from './editing.ts';
import { createScriptStage } from './stage.ts';
import { loadVersion } from './store.ts';
import { NARRATION_CHECKLIST, REFINEMENT_CHECKLIST, refineSystemPrompt } from './prompts.ts';
import type { WriterOutput } from './schemas.ts';
import { FakeScriptAI, fakeNarration, parseMoneyContexts, parseNeeds, parseScript } from './testing.ts';

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
async function approvedArchitecture(s: Setup, options: FakeScriptAI['architectOptions'] = {}) {
  const p = await s.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  expect((await run(s, p.id, 'STORY_MINING')).status).toBe('SUCCEEDED');
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  s.ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' }, ...options };
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
const allBlocksOf = (v: Awaited<ReturnType<typeof version>>) => v.draft.sections.flatMap((x) => x.blocks);
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
    // Six model calls — the narration pass among them — all in the ledger against this job, with their (estimated) cost.
    expect(s.ai.calls).toMatchObject({ 'script.plan': 1, 'script.write': 1, 'script.narrate': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });
    const calls = await db.providerCall.findMany({ where: { jobId: job.id } });
    expect(calls.map((c) => c.provider)).toEqual(['fake-ai', 'fake-ai', 'fake-ai', 'fake-ai', 'fake-ai', 'fake-ai']);
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
    // Model calls only for the rewritten section: no plan; one rewrite, one narration pass, one review of each kind, one performance pass.
    const delta = Object.fromEntries(Object.entries(s.ai.calls).map(([k, n]) => [k, n - (callsBefore[k] ?? 0)]).filter(([, n]) => n !== 0));
    expect(delta).toEqual({ 'script.rewrite': 1, 'script.narrate': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });
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

  it('refines the narration of a version into a new one: story, classes and evidence kept, no planner, the checklist answered, the change measured', async () => {
    const s = setup();
    const projectId = await scripted(s);
    // The editor's work on v1: an edit (its hedge kept) and a note; both reach the refinement.
    const target = await blockAt(projectId, 1, '2.1');
    const editedText = target.text.replace('(test)', '(edited, test)');
    await s.editing.editBlock(target.id, { text: editedText }, 'editor');
    await s.editing.reviewSection((await sectionAt(projectId, 1, 4)).id, { editorNotes: 'Too much signposting here (test).' }, 'editor');
    const v1 = await snapshot(projectId, 1);
    const callsBefore = { ...s.ai.calls };

    const job = await s.projects.refineScript(projectId, { baseVersion: 1, instructions: 'Protect the opening line; less signposting (test).' }, 'editor');
    expect(await statusOf(projectId)).toBe('SCRIPT_DRAFT');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(await statusOf(projectId)).toBe('SCRIPT_REVIEW');

    // v1 kept exactly as it was (superseded); v2 is the refinement, under review.
    expect(await snapshot(projectId, 1)).toEqual(v1);
    expect((await version(projectId, 1)).row.status).toBe('SUPERSEDED');
    const before = await version(projectId, 1);
    const v2 = await version(projectId, 2);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: true, revisionOfId: before.row.id, notes: 'Protect the opening line; less signposting (test).' });
    const content = ScriptContent.parse(v2.row.content);
    const first = before.draft.sections[0]!.blocks[0]!.text;
    expect(content.provenance).toMatchObject({ origin: 'REFINEMENT', baseVersion: 1, sections: [1, 2, 3, 4, 5, 6], requestedBy: 'editor', changeLog: { kept: [first] } });
    expect(content.narrator).toEqual(ScriptContent.parse(before.row.content).narrator);
    // The script editor answered the checklist, in order, against v1.
    expect(content.editor!.assessment!.map((a) => a.question)).toEqual([...REFINEMENT_CHECKLIST]);
    expect(content.editor!.assessment!.every((a) => a.answer === 'YES' && a.comparedToPrevious === 'BETTER')).toBe(true);

    // Same story, same evidence: block for block, the same beats, claims, classes and speakers; the narration reworded.
    const shape = (v: typeof v2) => v.draft.sections.map((x) => x.blocks.map((b) => [b.infoClass, b.beatIds.join(','), b.claimKeys.join(','), b.speakerId]));
    expect(shape(v2)).toEqual(shape(before));
    expect(v2.draft.sections[0]!.blocks[0]!.text).toBe(first);
    expect(v2.draft.sections[1]!.blocks[0]!.text).toBe(editedText);
    expect(v2.draft.sections[2]!.blocks.every((b) => b.speakerId !== null || b.text.includes('(refined, test)'))).toBe(true);
    expect(v2.draft.sections.flatMap((x) => x.blocks).find((b) => b.centralQuestion === 'ANSWERED')).toBeDefined();
    // Plans are the base's; every section is new and pending review.
    expect(v2.draft.sections.map((x) => x.plan)).toEqual(before.draft.sections.map((x) => x.plan));
    expect(v2.draft.sections.every((x) => x.reviewStatus === 'PENDING')).toBe(true);

    // Five calls: the refinement, the narration pass, both reviewers, the performance — no planner.
    const delta = Object.fromEntries(Object.entries(s.ai.calls).map(([k, n]) => [k, n - (callsBefore[k] ?? 0)]).filter(([, n]) => n !== 0));
    expect(delta).toEqual({ 'script.refine': 1, 'script.narrate': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });
    const prompt = s.ai.prompts['script.refine']![0]!;
    for (const part of [
      '# Refine the narration of script v1 — every section; its story, order, evidence and information classes stay as they are',
      '# What the reviewers and the checks said about v1 (rank 4)\n## The script editor',
      '## The fact checker (do not reintroduce what it fixed)',
      '## The automated checks (',
      '# Script v1 — the text to refine (each block with its class, beats, claims and speaker)',
      editedText,
      "# The director's instructions (rank 5: they may steer style, emphasis, pacing and creative direction; never parts 1 and 3)\nProtect the opening line; less signposting (test).\nThe director's notes on sections:\n- Section 4: Too much signposting here (test).",
    ])
      expect(prompt).toContain(part);
    // The director speaks last, after the reviewers, the script, the architecture and the evidence.
    expect(prompt.indexOf("# The director's instructions")).toBeGreaterThan(prompt.indexOf('# Evidence: the '));
    expect(prompt.indexOf('# Evidence: the ')).toBeGreaterThan(prompt.indexOf('# What the reviewers and the checks said about v1'));
    expect(prompt).toMatch(/^# The approved story architecture \(v\d+\)$/m);
    expect(prompt).toMatch(/^# Evidence: the \d+ claims the architecture cites/m);
    const editorPrompt = s.ai.prompts['script.edit']!.at(-1)!;
    expect(editorPrompt).toContain('# The version this one was made from (v1) — for comparison only; do not change it');
    expect(editorPrompt).toContain(`# Refinement checklist — answer every question, in this order, for this version against v1\n1. ${REFINEMENT_CHECKLIST[0]}`);
    expect(s.ai.prompts['script.factCheck']!.at(-1)).toContain('This version is a narrative refinement of v1');
    expect(s.ai.prompts['script.factCheck']!.at(-1)).not.toContain('# Refinement checklist');

    // Measured: every section changed, words added (no facts moved), and the job's report says so.
    const cmp = compareDrafts(before.draft, v2.draft);
    expect(cmp.totals.sectionsChanged).toBe(6);
    expect(cmp.totals.wordsRemoved).toBe(0);
    expect(cmp.totals.wordsAdded).toBeGreaterThan(10);
    expect(evidenceChanges(before.draft, v2.draft)).toEqual({ claimsAdded: [], claimsRemoved: [], figuresAdded: [], figuresRemoved: [] });
    const final = await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'desc' } });
    expect(final.message).toMatch(/^Script v2 \(from v1\) saved for review: 6 sections/);
    expect(final.data).toMatchObject({ comparison: { base: { version: 1 }, wordsRemoved: 0, wordsAdded: cmp.totals.wordsAdded, sectionsChanged: 6, evidence: { claimsAdded: [], figuresAdded: [] }, keptLines: [first] } });
    expect((final.data as { comparison: { checklist: string[] } }).comparison.checklist).toHaveLength(13);
    expect(await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'SCRIPT_REVISION_REQUESTED' } })).toMatchObject({ data: { kind: 'REFINEMENT', baseVersion: 1 } });
  });

  it('needs no instructions: an empty director field gets the complete house style, and instructions only add to it', async () => {
    const s = setup();
    const projectId = await scripted(s);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const job = await s.projects.refineScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');

    // The model gets the whole house style in its system prompt, with nothing from the editor.
    const system = s.ai.systems['script.refine']![0]!;
    expect(system).toBe(refineSystemPrompt(runtimeTarget(project)));
    for (const rule of [
      'These instructions are complete.',
      'apply in full whether or not the director adds instructions',
      'HOW THE INSTRUCTIONS RANK',
      'PART 1 — EVIDENCE AND SAFETY (non-overridable)',
      'PART 2 — THE REFINEMENT STYLE (the defaults)',
      'PART 3 — THE STORY IS DECIDED',
      '1. Meta-narration.',
      '2. Protect what is strong.',
      '3. Information through story.',
      '4. No purple prose.',
      '5. Trust the viewer.',
      '6. Rhythm.',
      '7. Silence.',
      '8. Facts with consequences.',
      '9. Earn the turning point.',
      '10. Uncertainty as part of the investigation',
      '11. Legend as discovery.',
      '12. A fictional companion is a lens',
      '13. Cut only what is weak',
      '14. Transitions through consequence',
      '15. Sources as detective work',
      'STORY ECONOMY',
      'Make those cuts first: they cost the story nothing',
      'Slightly over the range is acceptable only when what remains is strong.',
    ])
      expect(system).toContain(rule);
    const prompt = s.ai.prompts['script.refine']![0]!;
    expect(prompt).toContain("# The director's instructions (rank 5: they may steer style, emphasis, pacing and creative direction; never parts 1 and 3)\nNone. Apply the refinement style in full.");
    expect(await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'asc' } })).toMatchObject({ message: expect.stringContaining("the house style, no director's instructions") });

    // The full behaviour: a REFINEMENT version, the checklist answered, kept lines, the same evidence, the gate passed.
    const v2 = await version(projectId, 2);
    const content = ScriptContent.parse(v2.row.content);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: true, notes: null });
    expect(content.provenance).toMatchObject({ origin: 'REFINEMENT', brief: null, changeLog: { kept: [expect.any(String)] } });
    expect(content.editor!.assessment).toHaveLength(REFINEMENT_CHECKLIST.length);
    expect(evidenceChanges((await version(projectId, 1)).draft, v2.draft)).toEqual({ claimsAdded: [], claimsRemoved: [], figuresAdded: [], figuresRemoved: [] });

    // With instructions, the house style is the same, word for word; the instructions come last, as rank 5.
    await s.projects.refineScript(projectId, { baseVersion: 2, instructions: 'Drier humour in the opening (test).' }, 'editor');
    await s.runner.drain();
    expect(s.ai.systems['script.refine']![1]).toBe(system);
    expect(s.ai.prompts['script.refine']![1]!.trimEnd().endsWith("never parts 1 and 3)\nDrier humour in the opening (test).")).toBe(true);
    expect((await version(projectId, 3)).row).toMatchObject({ notes: 'Drier humour in the opening (test).' });
  });

  it('shows the quality rules to the refiner and every reviewer, plans the cuts when a version runs long, and logs the rules for each version', async () => {
    const s = setup();
    const projectId = await scripted(s);
    // A tighter runtime (1:00–2:00), and an editor's addition that takes v1 over it.
    await db.project.update({ where: { id: projectId }, data: { targetMinutesMin: 1, targetMinutesMax: 2 } });
    const longer = (await version(projectId, 1)).draft.sections.flatMap((x) => x.blocks).find((b) => b.infoClass === 'DOCUMENTED' && !b.speakerId && !b.centralQuestion)!;
    await s.editing.editBlock((await blockAt(projectId, 1, longer.key)).id, { text: `${longer.text} It was a long winter for everyone in the town (test).` }, 'editor');

    const job = await s.projects.refineScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    const log = await db.projectEvent.findMany({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'asc' } });
    // The run opens with what the rules find in the version it refines…
    expect(log[1]).toMatchObject({
      message: expect.stringMatching(/^Script quality rules on v1: \d+ words, 2:\d\d \(0:\d\d over the maximum\); .*RETOLD_CONTENT \d+/),
      data: { version: 1, rules: { overMax: expect.any(String), counts: expect.objectContaining({ RETOLD_CONTENT: expect.any(Number) }) } },
    });
    // …the refiner reads them — story-level rules first, a kind found everywhere summarised — with the repetition to keep and where to cut.
    const refine = s.ai.prompts['script.refine']!.at(-1)!;
    expect(refine).toMatch(/## The automated checks \(\d+; the script quality rules among them point at the weak material to cut or rework\)/);
    expect(refine.indexOf('warning RETOLD_CONTENT')).toBeLessThan(refine.indexOf('warning WRITTEN_SYNTAX'));
    expect(refine).toMatch(/- warning WRITTEN_SYNTAX: the same in \d+ more place\(s\): \d\.\d/);
    expect(refine).toContain('## Deliberate repetition in v1 — keep it: it is not redundancy\n- refrain "the record shows what happened next test"');
    expect(refine).toMatch(/## The runtime — v1 runs over its maximum: bring it inside, cutting from this plan first and never what it protects\nThis version runs 2:\d\d, 0:\d\d over the acceptable maximum of 2:00/);
    expect(refine).toContain('Never cut: 1.1 (poses the central question)');
    // …so do the script editor, with the cut plan and the lines kept, and the performance pass; the fact checker gets no cut plan.
    const editor = s.ai.prompts['script.edit']!.at(-1)!;
    expect(editor).toContain('# This version runs over its maximum — where to cut (ranked by the rules): make the cuts the story can afford, in this order, until it fits; never a protected block');
    expect(editor).toContain('Cut or compress first (ranked by the rules):');
    expect(editor).toMatch(/# Lines the refinement says it kept word for word \(1\)\n- "/);
    expect(s.ai.prompts['script.factCheck']!.at(-1)).not.toContain('where to cut');
    expect(s.ai.prompts['script.perform']!.at(-1)).toMatch(/^Runtime budget: the acceptable range is 1:00–2:00; the narration with no pauses or pace changes runs 2:\d\d: it already reaches the maximum, so add no pause and no slower delivery/m);
    // The narration alone passes the maximum: the performance's pauses are given up, each recorded.
    const v2 = await version(projectId, 2);
    const performed = ScriptContent.parse(v2.row.content).reviewChanges!.filter((c) => c.reviewer === 'PERFORMANCE');
    expect(performed.length).toBeGreaterThan(0);
    expect(performed.every((c) => c.status === 'REJECTED' && c.originalText === 'pause before short (transition)' && c.proposedText === 'no timing')).toBe(true);
    expect(QualityReport.parse(v2.row.qualityReport).normalizations).toContainEqual(expect.stringMatching(/^Performance: \d+\.\d s of pauses and slower delivery given up to stay within the 2:00 maximum/));
    // The log closes with the rules on both versions, then the version saved.
    expect(log.at(-2)!.message).toMatch(/^Script quality rules, v1 → v2: \d+ → \d+ words, 2:\d\d → 2:\d\d \(0:\d\d over the maximum\); /);
    expect(Object.keys((log.at(-2)!.data as { rules: object }).rules)).toEqual(['v1', 'v2']);
    expect(log.at(-1)!.message).toMatch(/^Script v2 \(from v1\) saved for review/);

    // Refining v1 again replaces v2: the log covers all three. A change log that misstates the length is corrected by the measurement.
    s.ai.refineTransform = (out) => {
      const words = out.sections.flatMap((x) => x.blocks).reduce((n, b) => n + b.text.split(/\s+/).length, 0);
      return { ...out, changeLog: { ...out.changeLog, summary: `Tighter for the ear: about ${Math.round(words * 0.6)} words now (test).` } };
    };
    const again = await s.projects.refineScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    const log3 = await db.projectEvent.findMany({ where: { projectId, type: 'JOB_PROGRESS', jobId: again.id }, orderBy: { createdAt: 'asc' } });
    expect(log3.at(-2)!.message).toMatch(/^Script quality rules, v1 → v3: /);
    expect(Object.keys((log3.at(-2)!.data as { rules: object }).rules)).toEqual(['v1', 'v2', 'v3']);
    const misstated = expect.stringMatching(/^Length: The writer's change log claims [\d,]+ words; measured: [\d,]+ words, 2:\d\d — the measured length is the one that counts$/);
    expect(QualityReport.parse((await version(projectId, 3)).row.qualityReport).normalizations).toContainEqual(misstated);
    // The job log carries the run's notes too.
    expect((log3.at(-1)!.data as { notes: string[] }).notes).toContainEqual(misstated);
  });

  it('holds a refinement to the same rules, whatever the director asks: a dropped hedge or a new figure stops approval; a skipped section is kept', async () => {
    const s = setup();
    const projectId = await scripted(s);
    s.ai.refineTransform = (out) => {
      // An unsupported figure, a PROBABLE claim with its hedge removed, and section 6 left out.
      out.sections = out.sections.filter((x) => x.sequence !== 6);
      const blocks = out.sections.flatMap((x) => x.blocks);
      const b = blocks.find((x) => x.speakerId === null && x.infoClass === 'DOCUMENTED')!;
      b.text = `${b.text} Some 9,999 people watched (test).`;
      const hedged = blocks.find((x) => /^Records suggest that [a-z]/.test(x.text))!;
      hedged.text = hedged.text.replace('Records suggest that ', '').replace(/^./, (c) => c.toUpperCase());
      return out;
    };
    // The director asks for exactly what the rules forbid; the (fake) model complies; the rules do not move.
    const asked = 'Punchier: drop the hedging and add that 9,999 people watched (test).';
    const job = await s.projects.refineScript(projectId, { baseVersion: 1, instructions: asked }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    expect(s.ai.prompts['script.refine']![0]).toContain(`never parts 1 and 3)\n${asked}`);
    expect(s.ai.systems['script.refine']![0]).toContain('They never override factual integrity, the architecture, the information classes, the integrity of quotations or the boundaries of fictional characters');
    const v2 = await version(projectId, 2);
    // It reaches review — the editor sees what went wrong — but cannot be approved.
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: false, notes: asked });
    const report = QualityReport.parse(v2.row.qualityReport);
    expect(report.checks.find((c) => c.id === 'figures_names')).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('9999 is in no claim of the approved architecture') });
    expect(report.checks.find((c) => c.id === 'uncertainty')).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('is PROBABLE but the narration does not hedge it') });
    expect(report.normalizations).toContain('The refinement returned section 6 empty; it is kept as it was in v1');
    expect(v2.draft.sections[5]!.blocks.map((b) => b.text)).toEqual((await version(projectId, 1)).draft.sections[5]!.blocks.map((b) => b.text));
    expect(evidenceChanges((await version(projectId, 1)).draft, v2.draft).figuresAdded).toEqual(['9999']);
    await expect(s.projects.recordApproval(projectId, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor')).rejects.toThrow(/blocking quality findings/);
    // The version it refined is untouched and can be made current again.
    await s.editing.restore(projectId, { version: 1 }, 'editor');
    expect((await version(projectId, 3)).row).toMatchObject({ status: 'IN_REVIEW', qualityPassed: true });
    // A refinement needs a version that tells the approved architecture.
    await expect(s.projects.refineScript(projectId, { baseVersion: 7 }, 'editor')).rejects.toThrow(/Script v7 not found/);
  });

  it('judges each reviewer change on its own — the safe edit kept, a dropped hedge and a removed question rejected — and tells the fact checker which', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s);
    const why = { score: 7, why: 'Solid (test).' };
    s.ai.editor = (prompt) => {
      const blocks = parseScript(prompt);
      const posed = prompt.split('\n').find((l) => / · POSED Q0/.test(l))!.match(/^\[(\d+\.\d+)\]/)![1]!;
      const plain = blocks.find((b) => b.infoClass === 'DOCUMENTED' && !b.speaker)!;
      const hedged = blocks.find((b) => b.infoClass === 'UNCERTAIN' && !b.speaker && /suggest|probably|likely|disagree|legend|story goes/i.test(b.text))!;
      return {
        verdict: 'Mixed (test).',
        scores: { NARRATIVE_SCORE: why, AUDIO_FLOW_SCORE: why, CLARITY_SCORE: why, EMOTIONAL_SCORE: why, ENDING_SCORE: why },
        issues: [{ ref: hedged.ref, severity: 'MINOR', kind: 'UNNATURAL_SPEECH', note: 'Too hedged (test).' }],
        assessment: [],
        edits: [
          { ref: plain.ref, reason: 'Tighter (test).', text: `${plain.text} Plainly.`, infoClass: null, claimKeys: null, beatIds: null },
          { ref: hedged.ref, reason: 'Say it straight (test).', text: 'It happened exactly like that (test).', infoClass: null, claimKeys: null, beatIds: null },
        ],
        removals: [{ ref: posed, reason: 'The question slows the opening (test).' }],
        insertions: [],
      };
    };
    const job = await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    const v1 = await version(projectId, 1);
    const content = ScriptContent.parse(v1.row.content);
    const editorChanges = content.reviewChanges!.filter((c) => c.reviewer === 'SCRIPT_EDITOR');
    expect(editorChanges.map((c) => `${c.id} ${c.type} ${c.status}`)).toEqual(['E1 EDIT ACCEPTED', 'E2 EDIT REJECTED', 'E3 REMOVE REJECTED']);
    expect(editorChanges[1]!.rejectionReason).toMatch(/^Violates uncertainty presentation — /);
    expect(editorChanges[2]!.rejectionReason).toMatch(/^Violates the central narrative question — No block poses the central question/);
    // The good change survives the bad ones; the bad ones leave no trace in the script.
    expect(allBlocksOf(v1).some((b) => b.text.endsWith(' Plainly.'))).toBe(true);
    expect(allBlocksOf(v1).some((b) => b.text === 'It happened exactly like that (test).')).toBe(false);
    expect(allBlocksOf(v1).find((b) => b.centralQuestion === 'POSED')).toBeDefined();
    expect(v1.row.qualityPassed).toBe(true);
    // The editor's issue on the hedged block says why its fix was not kept.
    expect(content.editor!.issues[0]!.resolution).toMatch(/^open: its change E2 was rejected — Violates uncertainty presentation/);
    // The fact checker saw what became of each change.
    const factPrompt = s.ai.prompts['script.factCheck']!.at(-1)!;
    expect(factPrompt).toContain('# Changes already judged in this run — do not undo an accepted change unless it broke the evidence; do not propose a rejected one again without fixing why it was rejected');
    expect(factPrompt).toMatch(/^- E2 EDIT \d+\.\d+ — REJECTED: Violates uncertainty presentation .*\(Say it straight \(test\)\.\)$/m);
    expect(factPrompt).toMatch(/^- E1 EDIT \d+\.\d+ — ACCEPTED \(Tighter \(test\)\.\)$/m);
    // Measured, not judged: the report counts the changes; the log lists them.
    const report = QualityReport.parse(v1.row.qualityReport);
    expect(report.measurements?.find((m) => m.id === 'review_changes')).toMatchObject({ value: '1 kept, 2 rejected, 0 skipped', detail: 'script editor 1 kept / 2 rejected / 0 skipped' });
    expect(report.judgments?.map((j) => j.id)).toEqual(['script_editor', 'narration_pass', 'fact_checker']);
    expect(report.checks.map((c) => c.id)).not.toContain('script_editor');
    const final = await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'desc' } });
    expect(final.data).toMatchObject({ review: { kept: 1, rejected: 2, skipped: 0 } });
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
      return { verdict: 'One unsupported figure (test).', issues: [{ ref, severity: 'CRITICAL', kind: 'WRONG_NUMBER', note: '7,777 is not in the evidence (test).' }], edits: [{ ref, reason: 'Remove the unsupported figure (test).', text: 'The record shows what happened next (fixed, test).', infoClass: null, claimKeys: null, beatIds: null }], removals: [], insertions: [] };
    };
    await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    const v1 = await version(projectId, 1);
    expect(v1.row.qualityPassed).toBe(true);
    const fact = ScriptContent.parse(v1.row.content).factCheck!;
    expect(fact.issues).toEqual([{ ref: '4.3', severity: 'CRITICAL', kind: 'WRONG_NUMBER', note: '7,777 is not in the evidence (test).', resolution: 'fixed by its own change (F1)' }]);
    expect(QualityReport.parse(v1.row.qualityReport).normalizations).toContain('Fact checker: 1 of 1 change(s) kept, 0 rejected, 0 skipped');
    expect(ScriptContent.parse(v1.row.content).reviewChanges).toEqual([
      expect.objectContaining({ id: 'F1', reviewer: 'FACT_CHECKER', type: 'EDIT', ref: '4.3', savedRef: '4.3', status: 'ACCEPTED', reason: 'Remove the unsupported figure (test).', rulesImpacted: expect.arrayContaining(['resolves UNSUPPORTED_FIGURE']) }),
    ]);

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
    expect(s.ai.calls).toMatchObject({ 'script.plan': 1, 'script.write': 1, 'script.narrate': 1, 'script.edit': 1, 'script.factCheck': 2, 'script.perform': 1 });
    const v1 = await version(projectId, 1);
    expect(ScriptContent.parse(v1.row.content).editor).toBeNull();
    // A reviewer's verdict is a judgment, not a check: recorded as not reviewed, with why.
    const report = QualityReport.parse(v1.row.qualityReport);
    expect(report.checks.find((c) => c.id === 'script_editor')).toBeUndefined();
    expect(report.judgments?.find((j) => j.id === 'script_editor')).toMatchObject({ value: 'not reviewed', detail: '[fake-ai] refused (test)', source: 'script editor (model)' });
    expect(v1.row.stats).toMatchObject({ resumedSteps: ['plan', 'write', 'narrate', 'edit'] });
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

  // ── Writing Engine 2: the Human Narration Pass ──────────────────────────────

  /** A writer with machine habits: a fake dramatic beat in one block, the picture described in another. */
  const theatrical = (out: WriterOutput) => {
    const blocks = out.sections.flatMap((x) => x.blocks);
    const documented = blocks.find((b) => b.infoClass === 'DOCUMENTED' && !b.speakerId)!;
    documented.text = `${documented.text} And then, everything changed.`;
    const scene = blocks.find((b) => b.infoClass === 'RECONSTRUCTION' && !b.speakerId)!;
    scene.text = `He leans closer. The table shrugs. ${scene.text}`;
    return out;
  };

  it('a narration pass makes a new version by targeted edits: the base untouched, the evidence kept, the lineage exact, every change explained — and a second pass changes nothing', async () => {
    // The base is written without the pass (as before Writing Engine 2), with machine habits in it.
    const s = setup({ narration: ['NARRATION'] });
    s.ai.writerTransform = theatrical;
    const projectId = await scripted(s);
    expect(s.ai.calls['script.narrate']).toBeUndefined();
    const v1 = await snapshot(projectId, 1);
    const before = await version(projectId, 1);
    const theatricalKeys = allBlocksOf(before).filter((b) => /And then, everything changed\.|The table shrugs\./.test(b.text)).map((b) => b.key);
    expect(theatricalKeys).toHaveLength(2);
    const callsBefore = { ...s.ai.calls };

    const job = await s.projects.narrateScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');

    // v1 kept exactly as it was; v2 made from it.
    expect(await snapshot(projectId, 1)).toEqual(v1);
    const v2 = await version(projectId, 2);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', revisionOfId: before.row.id });
    const content = ScriptContent.parse(v2.row.content);
    expect(content.provenance).toMatchObject({ origin: 'NARRATION', baseVersion: 1, baseId: before.row.id });
    // No planner, no writer: the pass, both reviewers, the performance.
    const delta = Object.fromEntries(Object.entries(s.ai.calls).map(([k, n]) => [k, n - (callsBefore[k] ?? 0)]).filter(([, n]) => n !== 0));
    expect(delta).toEqual({ 'script.narrate': 1, 'script.edit': 1, 'script.factCheck': 1, 'script.perform': 1 });

    // Only the flagged blocks changed; every block keeps its class, beats, claims and speaker.
    const shape = (v: typeof v2) => v.draft.sections.map((x) => x.blocks.map((b) => [b.key, b.infoClass, b.beatIds.join(','), b.claimKeys.join(','), b.speakerId]));
    expect(shape(v2)).toEqual(shape(before));
    for (const b of allBlocksOf(v2)) {
      const old = allBlocksOf(before).find((x) => x.key === b.key)!;
      if (theatricalKeys.includes(b.key)) expect(b.text).not.toBe(old.text);
      else expect(b.text).toBe(old.text);
    }
    expect(allBlocksOf(v2).some((b) => /And then|shrugs|leans closer/.test(b.text))).toBe(false);
    expect(evidenceChanges(before.draft, v2.draft)).toEqual({ claimsAdded: [], claimsRemoved: [], figuresAdded: [], figuresRemoved: [] });
    // The picture description went to the visual layer.
    const scene = allBlocksOf(v2).find((b) => b.key === theatricalKeys.find((k) => allBlocksOf(before).find((x) => x.key === k)!.text.startsWith('He leans')))!;
    expect(scene.visual.note).toContain('He leans closer. The table shrugs.');

    // The record: what the pass did, lineage block for block, diagnostics before and after.
    const n = content.narration!;
    expect(n).toMatchObject({ engine: 'writing-engine-2', unavailable: null, counts: { flagged: 2, kept: 2, rejected: 0 } });
    expect(n.lineage).toEqual(allBlocksOf(before).map((b) => ({ base: b.key, saved: b.key })));
    expect(n.diagnostics.before!.fingerprint.signals).toBeGreaterThan(n.diagnostics.after.fingerprint.signals);
    expect(n.diagnostics.after.fingerprint.perPattern.visual_description ?? 0).toBe(0);
    expect(n.visualMoved.map((x) => x.ref)).toEqual([scene.key]);
    expect(n.diagnostics.after.rubric.map((r) => r.dimension)).toHaveLength(10);
    // The change ledger: each narration change, why, and where it landed.
    const mine = content.reviewChanges!.filter((c) => c.reviewer === 'NARRATION');
    expect(mine.map((c) => [c.id, c.status, c.savedRef])).toEqual(theatricalKeys.sort().map((k, i) => [`N${i + 1}`, 'ACCEPTED', k]));
    // The script editor answered the narration checklist (the human-writer question first) and saw what the pass changed.
    expect(content.editor!.assessment!.map((a) => a.question)).toEqual([...NARRATION_CHECKLIST]);
    const editorPrompt = s.ai.prompts['script.edit']!.at(-1)!;
    expect(editorPrompt).toContain('# Narration checklist — answer every question, in this order, for this version against v1');
    expect(editorPrompt).toMatch(/^- N1 EDIT \d+\.\d+ — ACCEPTED/m);
    expect(editorPrompt).not.toContain('Lines the writer removed on purpose');
    // Measured and judged, apart.
    const report = QualityReport.parse(v2.row.qualityReport);
    expect(report.judgments?.map((j) => j.id)).toEqual(['script_editor', 'checklist', 'narration_pass', 'fact_checker']);
    expect(report.measurements?.find((m) => m.id === 'ai_fingerprint')?.detail).toMatch(/before the narration pass/);
    // The final log has the change report against v1, with examples: original, revised, why.
    const final = await db.projectEvent.findFirstOrThrow({ where: { projectId, type: 'JOB_PROGRESS', jobId: job.id }, orderBy: { createdAt: 'desc' } });
    const log = final.data as { changeReport: { pairing: string; totals: { rewritten: number; unchanged: number }; examples: { original: string; revised: string; why: string[]; evidencePreserved: boolean; aiPatternsRemoved: string[] }[] } };
    expect(log.changeReport.pairing).toBe('EXACT');
    expect(log.changeReport.totals).toMatchObject({ rewritten: 2, unchanged: allBlocksOf(before).length - 2 });
    expect(log.changeReport.examples.every((e) => e.original && e.revised && e.why.length > 0 && e.evidencePreserved && e.aiPatternsRemoved.length > 0)).toBe(true);

    // A second pass converges: even a narrator that edits every block changes nothing — every block is settled.
    s.ai.narrator = (prompt) => ({ verdict: 'Everything could be better (test).', edits: parseScript(prompt).filter((b) => !b.speaker).map((b) => ({ ref: b.ref, text: `${b.text} Again.`, reason: 'Drift (test).', fixes: ['RHYTHM' as const], moneyContext: [], visualNote: null })), kept: [] });
    await s.projects.narrateScript(projectId, { baseVersion: 2 }, 'editor');
    await s.runner.drain();
    const v3 = await version(projectId, 3);
    expect(allBlocksOf(v3).map((b) => b.text)).toEqual(allBlocksOf(v2).map((b) => b.text));
    const again = ScriptContent.parse(v3.row.content).narration!;
    expect(again.counts).toMatchObject({ flagged: 0, kept: 0 });
    expect(again.counts.settled).toBe(again.counts.proposed);
  });

  it('runs the narration pass in a draft, between the writer and the script editor', async () => {
    const s = setup();
    s.ai.writerTransform = theatrical;
    const projectId = await scripted(s);
    const v1 = await version(projectId, 1);
    const content = ScriptContent.parse(v1.row.content);
    expect(content.provenance.origin).toBe('DRAFT');
    expect(content.narration!.counts).toMatchObject({ flagged: 2, kept: 2 });
    expect(allBlocksOf(v1).some((b) => /And then|shrugs/.test(b.text))).toBe(false);
    // The narration prompt: what the diagnostics found, the lines to keep, money context, names, corpus examples — the house style in the system prompt.
    const prompt = s.ai.prompts['script.narrate']![0]!;
    for (const part of ['# What the diagnostics found — 2 block(s) need work', '# Lines to keep word for word', '# Money context the evidence supports', '# Names, as the evidence spells them', '# The approved story architecture']) expect(prompt).toContain(part);
    expect(s.ai.systems['script.narrate']![0]).toContain('THE HOUSE STYLE');
    // The script editor sees the pass's changes (and must not undo them).
    expect(s.ai.prompts['script.edit']![0]).toContain('# Changes already judged in this run');
  });

  it('fails a narration pass that cannot run, saving no copy of the base — and a retry, once the cause is fixed, runs the pass again', async () => {
    const s = setup();
    const projectId = await scripted(s);
    s.ai.brokenTask = 'script.narrate';
    const job = await s.projects.narrateScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    const done = await db.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe('FAILED');
    expect(done.error).toMatch(/The narration pass could not run/);
    expect(await db.script.count({ where: { projectId } })).toBe(1);
    // The failure is not saved as the pass's result: fixed (a key, the credit, a model id), the retry calls the model again.
    s.ai.brokenTask = null;
    const calls = s.ai.calls['script.narrate']!;
    const retry = await s.projects.retryJob(job.id, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe('SUCCEEDED');
    expect(s.ai.calls['script.narrate']).toBe(calls + 1);
    expect(ScriptContent.parse((await version(projectId, 2)).row.content).provenance).toMatchObject({ origin: 'NARRATION', baseVersion: 1 });
    await expect(s.projects.narrateScript(projectId, { baseVersion: 7 }, 'editor')).rejects.toThrow(/Script v7 not found/);
  });

  it('keeps an earlier pass’s judgment calls on a restored copy of its version: the pass plans exactly what it would on the original', async () => {
    const s = setup({ narration: ['NARRATION'] });
    // Three deliberate contrasts (a judgment call, flagged once there are two; no refrain settles them): two after a fake dramatic beat the pass removes, the third kept on purpose as it is.
    const KEPT = 'It was not a gamble, but a bet on the spring.';
    s.ai.writerTransform = (out) => {
      const [a, b, c] = out.sections.flatMap((x) => x.blocks).filter((x) => x.infoClass === 'DOCUMENTED' && !x.speakerId);
      a!.text = 'And then, the market turned. It was not a trade, but a promise.';
      b!.text = 'But then, the buyers sign contracts, not for flowers, but for bulbs that are still in the ground.';
      c!.text = KEPT;
      return out;
    };
    const projectId = await scripted(s);
    s.ai.narrator = (prompt) => ({ ...fakeNarration(prompt), kept: [KEPT] });
    await s.projects.narrateScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    const v2 = await version(projectId, 2);
    const edited = ScriptContent.parse(v2.row.content).reviewChanges!.filter((c) => c.reviewer === 'NARRATION' && c.status === 'ACCEPTED');
    expect(edited).toHaveLength(2);
    expect(allBlocksOf(v2).filter((b) => /not a trade, but a promise|not for flowers, but for bulbs/.test(b.text)).map((b) => b.key)).toEqual(edited.map((c) => c.savedRef));
    const kept = allBlocksOf(v2).find((b) => b.text === KEPT)!.key;
    expect(parseNeeds(s.ai.prompts['script.narrate']!.at(-1)!).has(kept)).toBe(true);
    expect(ScriptContent.parse(v2.row.content).provenance.changeLog!.kept).toEqual([KEPT]);

    // A pass on v2 leaves the contrasts it kept alone; so does a pass on a restored copy of v2, though the copy has no narration record.
    s.ai.narrator = (prompt) => ({ verdict: 'Everything could be better (test).', edits: parseScript(prompt).filter((b) => !b.speaker).map((b) => ({ ref: b.ref, text: `${b.text} Again.`, reason: 'Drift (test).', fixes: ['RHYTHM' as const], moneyContext: [], visualNote: null })), kept: [] });
    await s.projects.narrateScript(projectId, { baseVersion: 2 }, 'editor');
    await s.runner.drain();
    await s.editing.restore(projectId, { version: 2 }, 'editor');
    const copy = await version(projectId, 4);
    expect(ScriptContent.parse(copy.row.content)).toMatchObject({ provenance: { origin: 'RESTORE', baseVersion: 2 } });
    expect(ScriptContent.parse(copy.row.content).narration).toBeUndefined();
    expect(ScriptContent.parse(copy.row.content).provenance.changeLog).toEqual({ summary: 'Restored from v2', changes: [], kept: [KEPT] });
    await s.projects.narrateScript(projectId, { baseVersion: 4 }, 'editor');
    await s.runner.drain();
    const [onOriginal, onCopy] = s.ai.prompts['script.narrate']!.slice(-2).map(parseNeeds);
    expect(onCopy).toEqual(onOriginal);
    expect([...onCopy!.keys()].some((ref) => ref === kept || edited.some((c) => c.savedRef === ref))).toBe(false);
    expect(allBlocksOf(await version(projectId, 5)).map((b) => b.text)).toEqual(allBlocksOf(copy).map((b) => b.text));
  });

  it('records the corpus examples the pass was given, when a retry reuses its output after the corpus changed', async () => {
    const s = setup({ narration: ['NARRATION'] });
    s.ai.writerTransform = theatrical;
    const projectId = await scripted(s);
    // The script editor is overloaded on every attempt: the job fails after the narration pass.
    const editor = s.ai.editor;
    s.ai.editor = () => {
      throw new ProviderError('fake-ai', 'overloaded (test)', true);
    };
    const job = await s.projects.narrateScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    const sent = s.ai.prompts['script.narrate']!.at(-1)!;
    // Meanwhile a person approves a house example for openings.
    const opening = 'Nobody in the room could say what the paper was worth (test). Everyone agreed it was worth more tomorrow.';
    await db.writingExample.create({
      data: { exampleId: 'house-test-opening', text: opening, textHash: textHash(opening), category: 'hook', quality: 'excellent', traits: ['tension', 'restraint', 'curiosity', 'transition_by_consequence'], strengths: [], weaknesses: [], spokenRhythm: 'Two lines (test).', narrativeFunction: 'Opens the film (test).', whyItWorks: 'It withholds the answer (test).', sourceType: 'house', copyrightSafe: true, approvedForRetrieval: true, status: 'APPROVED', createdBy: 'editor' },
    });
    s.ai.editor = editor;
    const retry = await s.projects.retryJob(job.id, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: retry.id } })).status).toBe('SUCCEEDED');
    // The pass's output was reused (no second call): the record names the corpus and the examples that call was given.
    expect(s.ai.calls['script.narrate']).toBe(1);
    const n = ScriptContent.parse((await version(projectId, 2)).row.content).narration!;
    expect(n.corpusVersion).toBe(loadCorpus().version);
    const texts = new Map(loadCorpus().examples.map((e) => [e.id, e.text.replace(/\s+/g, ' ').trim()]));
    expect(n.retrieved.length).toBeGreaterThan(0);
    expect(n.retrieved.filter((r) => !sent.includes(`"${texts.get(r.id)}"`))).toEqual([]);
    // A new pass is given the house example, and says so.
    await s.projects.narrateScript(projectId, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect(s.ai.prompts['script.narrate']!.at(-1)).toContain(opening);
    expect(ScriptContent.parse((await version(projectId, 3)).row.content).narration!.retrieved.map((r) => r.id)).toContain('house-test-opening');
  });

  it('records where the moved picture description and the retrieved examples’ blocks are in the saved version, after the script editor renumbers', async () => {
    const s = setup();
    s.ai.writerTransform = theatrical;
    const projectId = await scripted(s);
    const first = ScriptContent.parse((await version(projectId, 1)).row.content).narration!;
    expect(first.visualMoved).toHaveLength(1);
    const moved = first.visualMoved[0]!;
    const [section, at] = moved.ref.split('.').map(Number) as [number, number];
    const down = (ref: string) => {
      const [n, i] = ref.split('.').map(Number) as [number, number];
      return n === section && i >= at ? `${n}.${i + 1}` : ref;
    };
    // The same draft again; the script editor inserts a line just before that block, which moves it and the rest of its section down one.
    const editor = s.ai.editor;
    s.ai.editor = (prompt) => ({ ...editor(prompt), insertions: [{ after: `${section}.${at - 1}`, reason: 'A question to turn on (test).', block: { text: 'What were they really buying (test)?', infoClass: 'FRAMING', beatIds: [], claimKeys: [], speakerId: null, speechKind: null, visual: { intent: 'ON_SCREEN_TEXT', mustShow: [], mustAvoid: [], priority: 'NORMAL', note: '' } } }] });
    await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    const v2 = await version(projectId, 2);
    const content = ScriptContent.parse(v2.row.content);
    expect(content.reviewChanges!.find((c) => c.reviewer === 'SCRIPT_EDITOR')).toMatchObject({ type: 'INSERT', status: 'ACCEPTED', savedRef: moved.ref });
    const n = content.narration!;
    expect(n.visualMoved).toEqual([{ ref: down(moved.ref), note: moved.note }]);
    expect(allBlocksOf(v2).find((b) => b.key === n.visualMoved[0]!.ref)!.visual.note).toContain(moved.note);
    expect(n.retrieved.some((r) => r.refs.includes(down(moved.ref)))).toBe(true);
    expect(n.retrieved).toEqual(first.retrieved.map((r) => ({ ...r, refs: r.refs.map(down) })));
  });

  it('records only the money context the saved text still gives: a later reviewer that takes it out takes it out of the record', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s, { contextClaims: [{ claimKey: 'C018', purpose: 'what a skilled worker earned (test)' }] });
    const price = 'Records suggest that Cornelis Proefman refused to accept bulbs he had bought for 1,200 guilders.';
    s.ai.writerTransform = (out) => {
      out.sections.flatMap((x) => x.blocks).find((b) => b.claimKeys.includes('C008') && b.infoClass === 'UNCERTAIN' && !b.speakerId)!.text = price;
      return out;
    };
    // The fact checker puts the bare price back.
    s.ai.factChecker = (prompt) => {
      const b = parseScript(prompt).find((x) => x.text.startsWith(price))!;
      return { verdict: 'The price is enough (test).', issues: [], edits: [{ ref: b.ref, reason: 'The bare price (test).', text: price, infoClass: null, claimKeys: null, beatIds: null }], removals: [], insertions: [] };
    };
    const job = await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    const v1 = await version(projectId, 1);
    const content = ScriptContent.parse(v1.row.content);
    const block = allBlocksOf(v1).find((b) => b.text.startsWith(price))!;
    // The pass gave the price its meaning; the fact checker's change (kept) took it out again.
    expect(content.reviewChanges!.find((c) => c.reviewer === 'NARRATION' && c.savedRef === block.key)).toMatchObject({ status: 'ACCEPTED', proposedText: expect.stringContaining("years' pay") });
    expect(content.reviewChanges!.find((c) => c.reviewer === 'FACT_CHECKER')).toMatchObject({ status: 'ACCEPTED', savedRef: block.key });
    expect(block.text).toBe(price);
    expect(content.narration!.money.used).toEqual([]);
    expect(QualityReport.parse(v1.row.qualityReport).normalizations).toContainEqual(expect.stringMatching(new RegExp(`money context M\\d+ it added at ${block.key.replace('.', '\\.')} is no longer in the saved text`)));
  });

  it('records money context the pass gave in the evidence’s own words, with no word for pay in them, when no later reviewer changed the block', async () => {
    const s = setup();
    const projectId = await approvedArchitecture(s, { contextClaims: [{ claimKey: 'C018', purpose: 'what a house cost (test)' }] });
    // The evidence sets the price beside an asset, not a wage: its context is the evidence's own sentence.
    const house = 'A canal house cost 4,000 guilders.';
    await db.researchClaim.updateMany({ where: { claimKey: 'C018', dossier: { projectId } }, data: { statement: house } });
    await db.claimCitation.updateMany({ where: { claim: { claimKey: 'C018', dossier: { projectId } } }, data: { quote: house } });
    const price = 'Records suggest that Cornelis Proefman refused to accept bulbs he had bought for 1,200 guilders.';
    s.ai.writerTransform = (out) => {
      out.sections.flatMap((x) => x.blocks).find((b) => b.claimKeys.includes('C008') && b.infoClass === 'UNCERTAIN' && !b.speakerId)!.text = price;
      return out;
    };
    let cited = '';
    s.ai.narrator = (prompt) => {
      const b = parseScript(prompt).find((x) => x.text === price)!;
      cited = [...parseMoneyContexts(prompt)].find(([, explanation]) => explanation.includes(house))![0];
      return { verdict: 'The price beside a house (test).', edits: [{ ref: b.ref, text: `${price} ${house}`, reason: 'What the sum meant (test).', fixes: ['CONTEXT'], moneyContext: [cited], visualNote: null }], kept: [] };
    };
    const job = await s.projects.generateScript(projectId, {}, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    const v1 = await version(projectId, 1);
    const content = ScriptContent.parse(v1.row.content);
    const block = allBlocksOf(v1).find((b) => b.text.startsWith(price))!;
    expect(block.text).toBe(`${price} ${house}`);
    expect(content.reviewChanges!.filter((c) => c.savedRef === block.key).map((c) => `${c.reviewer} ${c.status}`)).toEqual(['NARRATION ACCEPTED']);
    expect(content.narration!.money.used).toEqual([{ contextId: cited, ref: block.key }]);
    expect(QualityReport.parse(v1.row.qualityReport).normalizations.filter((n) => n.includes('is no longer in the saved text'))).toEqual([]);
  });
});
