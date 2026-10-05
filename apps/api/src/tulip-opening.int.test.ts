import { ScriptContent, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers } from '@docengine/pipeline';
import { ALL_MOCK, MockVoiceProvider, createProviders, type NarrationRequest, type NarrationResult, type ProviderSet } from '@docengine/providers';
import { createScriptStage, loadVersion } from '@docengine/script';
import { FakeScriptAI, fakeNarration, parseScript, type WriterOutput } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { VoiceService, createVoiceStage, voiceGate } from '@docengine/voice';
import { deliveryMark } from '@docengine/writing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { loadScriptEditorial } from './script-views.ts';

/**
 * Writing Engine 2, end to end, on the Tulip opening (Part XXVIII of the
 * brief): research claims → a draft written as before the engine (with the
 * habits the editorial review found in v4) → style retrieval → the Human
 * Narration Pass → editorial QA → a new version, the old one untouched →
 * delivery marks → the Voice Engine, unchanged, narrating the new text with
 * the MOCK voice (no ElevenLabs, no spend). The fake model plays the writer
 * and the narration editor; everything else is the production code.
 */

const db = useTestDatabase();

class Voice extends MockVoiceProvider {
  calls: NarrationRequest[] = [];
  override async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    this.calls.push(req);
    return super.generateNarration(req);
  }
}

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** The brief's own example of screenplay narration, and the line it suggests instead. */
const SCREENPLAY = 'From a corner bench, Thijs watches a thumb wipe a figure away. The table shrugs. He leans closer.';
const BETTER = 'The price on the slate could change with a single stroke. And for the people around the table, that number represented real money.';
/** A strong line that must survive the pass word for word. */
const PROMISE = 'Nobody at this table has seen what he is buying. What changes hands is not a flower. It’s a promise.';
const PRICE = 'Records suggest that Cornelis Proefman refused to accept bulbs he had bought for 1,200 guilders.';

/** The opening as an earlier engine wrote it: the screenplay lines, a fake dramatic beat, a price without context, and one line worth keeping. */
function tulipOpening(out: WriterOutput): WriterOutput {
  const blocks = out.sections.flatMap((s) => s.blocks);
  const fiction = blocks.find((b) => b.infoClass === 'FICTION' && !b.speakerId)!;
  fiction.text = SCREENPLAY;
  const opening = out.sections[0]!.blocks.find((b) => b.infoClass === 'RECONSTRUCTION' && !b.speakerId)!;
  opening.text = `${opening.text} ${PROMISE}`;
  const documented = blocks.find((b) => b.infoClass === 'DOCUMENTED' && !b.speakerId)!;
  documented.text = `${documented.text} And then, everything changed.`;
  const price = blocks.find((b) => b.claimKeys.includes('C008') && b.infoClass === 'UNCERTAIN' && !b.speakerId)!;
  price.text = PRICE;
  return out;
}

function setup() {
  const ai = new FakeScriptAI();
  const voice = new Voice();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai, voice };
  const projects = new ProjectService({ db, gateHooks: { VOICE: voiceGate() } });
  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(db),
    projects,
    providers,
    // The draft is written as before Writing Engine 2 (no narration pass in a draft), like the version under review.
    handlers: { ...createMockStageHandlers(), STORY_MINING: createStoryMiningStage(), STORY_ARCHITECTURE: createStoryArchitectureStage(), SCRIPT: createScriptStage({ narration: ['NARRATION'] }), VOICE: createVoiceStage({ concurrency: 2 }) },
    retryBaseDelayMs: 0,
  });
  const service = new VoiceService({ db, projects, providers, config: { confirmCharacters: 3000, maxCharacters: 40_000 } });
  return { ai, voice, projects, runner, service };
}

describe('the Tulip opening through Writing Engine 2 (fake model, MOCK voice, real database)', () => {
  it('research claims → draft → style retrieval → narration pass → editorial QA → v2 (v1 untouched) → delivery marks → the Voice Engine', async () => {
    const s = setup();
    const run = async (projectId: string, type: JobType) => {
      const job = await s.projects.enqueueJob(projectId, { type }, 'editor');
      await s.runner.drain();
      return db.job.findUniqueOrThrow({ where: { id: job.id } });
    };

    // Research claims: the synthetic Tulip dossier (a price of 1,200 guilders, a craftsman's 300 a year, the disputed 5,500…).
    const p = await s.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
    await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
    await seedFakeDossier(db, p.id);
    expect((await run(p.id, 'STORY_MINING')).status).toBe('SUCCEEDED');
    const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
    await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
    // The fictional companion is Thijs; a craftsman's wage is background evidence of the first sequence.
    s.ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Thijs' }, contextClaims: [{ claimKey: 'C018', purpose: 'what a skilled worker earned (test)' }] };
    expect((await run(p.id, 'STORY_ARCHITECTURE')).status).toBe('SUCCEEDED');
    await s.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');

    // The draft, as the earlier engine wrote it.
    s.ai.writerTransform = tulipOpening;
    await s.projects.generateScript(p.id, {}, 'editor');
    await s.runner.drain();
    const v1 = (await loadVersion(db, p.id, 1))!;
    const v1Text = v1.draft.sections.flatMap((x) => x.blocks.map((b) => [b.key, b.text, b.claimKeys.join(',')]));
    expect(v1Text.some(([, t]) => t === SCREENPLAY)).toBe(true);
    expect(ScriptContent.parse(v1.row.content).narration).toBeUndefined();

    // The Human Narration Pass on v1. The narration editor (fake): the house fixes, and the brief's own better line for the screenplay block.
    s.ai.narrator = (prompt) => {
      const out = fakeNarration(prompt);
      const screenplay = parseScript(prompt).find((b) => b.text === SCREENPLAY)!;
      return { ...out, edits: [...out.edits.filter((e) => e.ref !== screenplay.ref), { ref: screenplay.ref, text: BETTER, reason: 'Screenplay description of what the picture shows; the narration now gives what the picture cannot (test).', fixes: ['VISUAL_SEPARATION'], moneyContext: [], visualNote: SCREENPLAY }] };
    };
    const job = await s.projects.narrateScript(p.id, { baseVersion: 1 }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');

    // Style retrieval: a handful of corpus examples, chosen for the blocks that needed work — never the whole corpus.
    const prompt = s.ai.prompts['script.narrate']![0]!;
    expect(prompt).toContain('# House style — reference examples (style only: they carry no facts; never reuse their names, numbers or events)');
    expect(prompt).toMatch(/^- money context M\d+: 1,200 guilders .*about four years' pay for a skilled craftsman/m);
    const v2 = (await loadVersion(db, p.id, 2))!;
    const content = ScriptContent.parse(v2.row.content);
    const n = content.narration!;
    expect(n.retrieved.length).toBeGreaterThan(0);
    expect(n.retrieved.length).toBeLessThanOrEqual(16);

    // v1 untouched; v2 linked to it.
    expect((await loadVersion(db, p.id, 1))!.draft.sections.flatMap((x) => x.blocks.map((b) => [b.key, b.text, b.claimKeys.join(',')]))).toEqual(v1Text);
    expect(v2.row).toMatchObject({ status: 'IN_REVIEW', revisionOfId: v1.row.id, qualityPassed: true });
    expect(content.provenance).toMatchObject({ origin: 'NARRATION', baseVersion: 1, baseId: v1.row.id });

    // The narration: the screenplay gone to the visual layer, the dramatic beat gone, the price given its meaning from the evidence, the strong line kept.
    const blocks = v2.draft.sections.flatMap((x) => x.blocks);
    const better = blocks.find((b) => b.text === BETTER)!;
    expect(better.visual.note).toContain(SCREENPLAY);
    expect(blocks.some((b) => b.text.includes('And then'))).toBe(false);
    const price = blocks.find((b) => b.text.startsWith(PRICE))!;
    expect(price.text).toBe(`${PRICE} That was about four years' pay for a skilled craftsman.`);
    expect(price.claimKeys).toEqual(expect.arrayContaining(['C008', 'C018']));
    expect(blocks.some((b) => b.text.includes(PROMISE))).toBe(true);
    // Names: Thijs stays Thijs; his pronunciation is a question for the pronunciation list, not guessed.
    const thijs = n.names.find((x) => x.historicalName === 'Thijs')!;
    expect(thijs).toMatchObject({ displayName: 'Thijs', fictional: true });
    expect(thijs.candidate).toBe(true);
    // Money context: source-linked, approximate, with its method.
    const used = n.money.used.map((u) => n.money.contexts.find((c) => c.id === u.contextId)!);
    expect(used).toEqual([expect.objectContaining({ amount: 1200, ratio: 4, sourceClaimKeys: ['C008', 'C018'], verdict: 'PROBABLE', approximate: true })]);

    // Editorial QA ran on the new text; the change report explains every change.
    expect(content.editor).not.toBeNull();
    expect(content.factCheck).not.toBeNull();
    const view = (await loadScriptEditorial(db, p.id, 2))!;
    const r = view.report!;
    expect(r.pairing).toBe('EXACT');
    expect(r.provenance.flags).toEqual([]);
    expect(r.totals).toMatchObject({ rewritten: 3, removed: 0, added: 0, moneyContextAdded: 1, visualDescriptionsRemoved: 1 });
    expect(r.totals.evidencePreserved).toEqual({ kept: r.totals.blocksBefore, of: r.totals.blocksBefore });
    const row = (text: string) => r.blocks.find((b) => b.revised === text)!;
    expect(row(BETTER)).toMatchObject({ status: 'REWRITTEN', original: SCREENPLAY, visualDuplicationRemoved: true, evidencePreserved: true, changedBy: ['NARRATION'] });
    expect(row(BETTER).reasons[0]).toMatch(/Screenplay description/);
    expect(row(price.text)).toMatchObject({ moneyContext: [n.money.used[0]!.contextId], claimsAdded: ['C018'], uncertaintyPreserved: true });
    expect(r.blocks.find((b) => b.original?.includes('And then'))!.aiPatternsRemoved).toContain('dramatic_transition');
    expect(r.fingerprint.after).toBeLessThan(r.fingerprint.before);

    // Delivery marks: the performance pass marked the new text (the opening of each section, curious first).
    expect(deliveryMark(blocks[0]!.delivery)).toBe('curious');
    expect(view.layers.every((l) => l.leaks.length === 0)).toBe(true);

    // Approve v2, then the Voice Engine — unchanged — narrates the new words.
    await s.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
    const plan = await s.service.plan(p.id, { scope: { kind: 'AUDITION', seconds: 60 } });
    expect(plan.blocked).toBeNull();
    await s.service.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
    await s.runner.drain();
    const chunks = await db.voiceChunk.findMany({ where: { run: { projectId: p.id } }, orderBy: { chunkIndex: 'asc' } });
    expect(chunks.length).toBeGreaterThan(0);
    const spoken = chunks.map((c) => c.sourceText).join(' ');
    expect(spoken).not.toContain('The table shrugs');
    expect(spoken).toContain(PROMISE.slice(0, 40));
    expect(s.voice.calls.length).toBe(chunks.length);
    expect(s.voice.calls.every((c) => !c.text.includes('C0') && !c.text.includes('VISUAL'))).toBe(true);
    expect(await db.voiceRun.findFirstOrThrow({ where: { projectId: p.id } })).toMatchObject({ scriptId: v2.row.id });
  });
});
