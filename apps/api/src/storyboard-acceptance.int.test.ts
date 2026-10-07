import type { HealthView, JobView, ProjectDetailView, StoryboardInputsView, StoryboardView, VisualProductionView, VisualProfileLibraryView, VisualTreatment } from '@docengine/core';
import { ALL_MOCK, createProviders } from '@docengine/providers';
import { FakeStoryboardAI, fakeBeats, fakeShot } from '@docengine/storyboard/testing';
import { seedFakeDossier } from '@docengine/story/testing';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { VISUAL_GENERATION_HELD, createContainer, type AppContainer } from './container.ts';
import { parseEnv } from './env.ts';

/**
 * The operator's acceptance path for the Storyboard Engine (design §2.18)
 * through the API, on the production wiring with a scripted model, the MOCK
 * voice and the published price catalog: a Tulip-shaped project in
 * VOICE_REVIEW whose opening audition has provider-timed takes still in
 * review; the visual profile chosen; a preview planned once confirmed
 * (STORYBOARD_PREVIEW, the project's status unchanged); v1 inspected
 * against the acceptance criteria — timed on the assembly's clock, every
 * shot linked to its words, blocks, claims and why-chain, varied
 * treatments, an honest forecast, continuity subjects, QA findings, the
 * summary log line; v1 refused while the takes are in review and approved
 * once they are; one shot edited (v2, v1 byte for byte as it was and its
 * approval its own); the approach switched (only the beats it changes are
 * planned again); visual generation held. Nothing is generated, stored or
 * paid for but the scripted planning calls.
 */

const db = useTestDatabase();
let open: { app: FastifyInstance; c: AppContainer }[] = [];

afterEach(async () => {
  for (const { app, c } of open) {
    await app.close();
    await c.close();
  }
  open = [];
});

/** A logged line as JSON (loosely typed: it is checked field by field). */
type Line = Record<string, any>;

// ── The scripted planning calls ──────────────────────────────────────────────

type Brief = Map<string, { cls: string; claims: string[] }>;

/** Each block of a brief, in order, by key: its information class and the claims it lists. */
function blocksOf(prompt: string): Brief {
  const out: Brief = new Map();
  for (const part of prompt.split('### Block ').slice(1)) {
    const head = /^(\S+) · (\S+)/.exec(part);
    if (head) out.set(head[1]!, { cls: head[2]!, claims: [...part.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]!) });
  }
  return out;
}

const blockOf = (id: string) => /^(.*):/.exec(id)?.[1] ?? '';

/** The blocks of a brief whose words a range of cut points covers. */
function covered(brief: Brief, r: { from: string; to: string }): string[] {
  const keys = [...brief.keys()];
  const first = r.from.endsWith(':end') ? keys.indexOf(blockOf(r.from)) + 1 : r.from.includes(':') ? keys.indexOf(blockOf(r.from)) : 0;
  const last = r.to.includes(':') ? keys.indexOf(blockOf(r.to)) : keys.length - 1;
  return keys.slice(Math.max(first, 0), last + 1);
}

/**
 * The treatments each approach gives a beat, by the classes of its words:
 * C (the profile's) and B differ only where the words are reconstruction
 * or an abstract picture, so switching to B plans only those beats again.
 */
function optionsFor(classes: string[], blocks: string[]): Record<'A' | 'B' | 'C', VisualTreatment> {
  const at = (c: VisualTreatment) => ({ A: 'CINEMATIC_RECONSTRUCTION' as VisualTreatment, B: c, C: c });
  if (classes.includes('FRAMING')) return at('TEXT_ON_SCREEN');
  if (classes.includes('FICTION')) return { ...at('CHARACTER_VISUAL'), A: 'CHARACTER_VISUAL' };
  if (classes.includes('RECONSTRUCTION')) return { ...at('CINEMATIC_RECONSTRUCTION'), B: 'DOCUMENT_ANIMATION' };
  if (classes.includes('DOCUMENTED')) return at(blocks[0]!.endsWith('.4') ? 'MAP_ANIMATION' : 'DOCUMENT_ANIMATION');
  if (blocks.length > 1) return { ...at('ABSTRACT_METAPHOR'), B: 'MOTION_GRAPHIC' };
  return at(blocks[0]!.endsWith('.3') ? 'DIAGRAM' : 'MOTION_GRAPHIC');
}

/** The continuity subjects the beats call proposes: the viewer's stand-in, the composite buyer and the room. */
const SUBJECTS = [
  {
    key: 'CS01',
    kind: 'CHARACTER' as const,
    castId: 'pov',
    anonymous: false,
    name: 'You, the newcomer (test)',
    description: "The viewer's stand-in among the traders (test).",
    era: 'Winter of 1636',
    location: 'Haarlem',
    approximateAge: 'about thirty',
    clothing: 'A plain dark wool coat',
    physicalDescription: 'Seen from behind or in part, never full face',
    visualIdentity: { palette: ['umber', 'candle yellow'], silhouette: null, props: [] },
    designDetails: [{ detail: 'A plain wool coat of the period', basis: 'PERIOD_GENERIC' as const, claimKeys: [] }],
    rules: ['Never shown full face'],
    claimKeys: [],
  },
  {
    key: 'CS02',
    kind: 'CHARACTER' as const,
    castId: 'F1',
    anonymous: false,
    name: 'Pieter Graanhout (test)',
    description: 'A typical buyer the records describe, invented for the film (test).',
    era: 'Winter of 1636',
    location: 'Haarlem',
    approximateAge: 'about forty',
    clothing: 'A worn brown doublet',
    physicalDescription: 'Stocky, a short grey beard',
    visualIdentity: { palette: ['brown', 'grey'], silhouette: null, props: ['a coin purse'] },
    designDetails: [],
    rules: ['Labelled as a composite wherever he appears'],
    claimKeys: [],
  },
  {
    key: 'CS03',
    kind: 'ENVIRONMENT' as const,
    castId: null,
    anonymous: false,
    name: 'The tavern room (test)',
    description: 'A crowded, candle-lit tavern room in winter, the same room in every shot (test).',
    era: 'Winter of 1636',
    location: 'Haarlem',
    approximateAge: null,
    clothing: null,
    physicalDescription: null,
    visualIdentity: { palette: ['umber', 'candle yellow'], silhouette: 'Low beams', props: ['long tables'] },
    designDetails: [{ detail: 'Long oak tables and benches', basis: 'PERIOD_GENERIC' as const, claimKeys: [] }],
    rules: ['The same room wherever it appears'],
    claimKeys: [],
  },
];

/**
 * A model that plans the opening as an editor would: one beat per block
 * (the last two blocks one beat, so one shot spans blocks), fictional
 * characters only over reconstruction and fiction, documents and a map over
 * documented words (a block with a clause cut as two shots), drawn or
 * abstract pictures over uncertain words, and a title card over the
 * framing question — a plan with no blocking finding.
 */
function editorAI(): FakeStoryboardAI {
  const ai = new FakeStoryboardAI();
  ai.beats = (prompt) => {
    const out = fakeBeats(prompt);
    const brief = blocksOf(prompt);
    const last = out.beats.pop()!;
    out.beats[out.beats.length - 1] = { ...out.beats.at(-1)!, to: last.to };
    out.beats = out.beats.map((b, i) => {
      const blocks = covered(brief, b);
      const classes = blocks.map((k) => brief.get(k)!.cls);
      const options = optionsFor(classes, blocks);
      const subjectKeys = [...(classes.includes('RECONSTRUCTION') ? ['CS01'] : []), ...(classes.includes('FICTION') ? ['CS02'] : []), 'CS03'];
      return { ...b, title: `Beat ${i + 1} (test)`, subjectKeys, options: { A: { treatment: options.A, concept: 'Reconstructed (test).' }, B: { treatment: options.B, concept: 'Evidence-led (test).' }, C: { treatment: options.C, concept: 'Hybrid (test).' } } };
    });
    out.subjects = SUBJECTS;
    return out;
  };
  ai.shots = (prompt) => {
    const brief = blocksOf(prompt);
    const beats = [...prompt.matchAll(/^- (VB\d{2,4}) "[^"]*" (\S+) → (\S+): plan as ([A-Z_]+)/gm)].map((m) => ({ key: m[1]!, from: m[2]!, to: m[3]!, treatment: m[4]! as VisualTreatment }));
    const shots = beats.flatMap((beat) => {
      const blocks = covered(brief, beat);
      const block = blocks[0]!;
      const claim = brief.get(block)!.claims[0];
      const range = { from: beat.from, to: beat.to };
      const o = { cutIn: 'CONCEPT_CHANGE' as const, cutOut: 'CONCEPT_CHANGE' as const, purpose: `Carries ${block} (test).`, treatment: beat.treatment, environment: { subjectKey: null, description: '' } };
      const room = { subjectKey: 'CS03', description: 'The tavern room (test).' };
      switch (beat.treatment) {
        case 'TEXT_ON_SCREEN':
          return [fakeShot(beat.key, range, { ...o, description: 'The question set in type on a dark ground (test).' })];
        case 'CHARACTER_VISUAL':
          return [fakeShot(beat.key, range, { ...o, description: 'Pieter at the back of the room, counting coins (test).', environment: room, subjects: [{ subjectKey: 'CS02', role: 'PRIMARY', action: 'Counts his coins (test).', interactions: [], likeness: 'PERIOD_GENERIC', speaks: null }] })];
        case 'CINEMATIC_RECONSTRUCTION':
          return [fakeShot(beat.key, range, { ...o, description: 'Over your shoulder, the crowd as the bidding starts (test).', environment: room, subjects: [{ subjectKey: 'CS01', role: 'PRIMARY', action: 'Watches the bidding (test).', interactions: [], likeness: 'NONE', speaks: null }], claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [] })];
        case 'MAP_ANIMATION':
          return [fakeShot(beat.key, range, { ...o, description: 'The trade town on a map of the province (test).', dataSpec: { chartType: 'MAP', title: 'Where the trade was (test)', items: [{ label: 'Haarlem', figure: null, date: null, place: 'Haarlem', claimKey: claim! }], note: '' }, claims: [{ claimKey: claim!, role: 'DEPICTS' }] })];
        case 'DOCUMENT_ANIMATION': {
          const document = { description: 'The record, page by page (test).', claims: claim ? [{ claimKey: claim, role: 'SHOWS_SOURCE' as const }] : [] };
          // A documented block with a clause cut inside it: the room up to the clause, then the record (two shots on one block).
          const clause = brief.get(block)!.cls === 'DOCUMENTED' ? [...prompt.matchAll(new RegExp(`⟦(${block.replace('.', '\\.')}:\\d+) `, 'g'))][0]?.[1] : undefined;
          if (!clause) return [fakeShot(beat.key, range, { ...o, ...document })];
          return [
            fakeShot(beat.key, { from: beat.from, to: clause }, { ...o, treatment: 'ENVIRONMENT', description: 'The tavern room, empty tables (test).', environment: room, claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [] }),
            fakeShot(beat.key, { from: clause, to: beat.to }, { ...o, ...document }),
          ];
        }
        case 'DIAGRAM':
          return [fakeShot(beat.key, range, { ...o, description: 'Arrows between buyer and grower, drawn (test).', uncertaintyDevice: 'LABELLED_LEGEND', overlays: [{ kind: 'CAPTION', text: 'Records suggest; not certain', reason: 'Marks the account as probable (test).', claimKeys: claim ? [claim] : [] }], claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [] })];
        case 'ABSTRACT_METAPHOR':
          return [fakeShot(beat.key, range, { ...o, description: 'Paper blowing across an empty table (test).', claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [] })];
        default:
          return [fakeShot(beat.key, range, { ...o, description: 'Arrows between buyer and grower, drawn (test).', claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [] })];
      }
    });
    return { shots, beats: [] };
  };
  return ai;
}

// ── The project ──────────────────────────────────────────────────────────────

async function start() {
  const lines: Line[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent' });
  const ai = editorAI();
  const c = createContainer(env, logger, { db, providers: { ...createProviders(ALL_MOCK), ai } });
  const app = await buildApp(c);
  open.push({ app, c });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { c, ai, lines, call };
}

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A Tulip-shaped project whose script is approved and whose opening is narrated as an audition, its takes as a provider makes them (word timings, stored audio) and still in review: VOICE_REVIEW. */
async function narrated(s: Awaited<ReturnType<typeof start>>) {
  const { c, ai } = s;
  const p = await c.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, 'editor');
  await c.runner.drain();
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await c.projects.generateScript(p.id, {}, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  const { run: number } = await c.voice.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 60 } }, 'editor');
  await c.runner.drain();
  const run = await db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId: p.id, number } } });
  for (const g of await db.voiceGeneration.findMany({ where: { runId: run.id } })) {
    if (g.alignment) await db.voiceGeneration.update({ where: { id: g.id }, data: { alignment: { ...(g.alignment as object), source: 'PROVIDER' } } });
    if (g.audioAssetId) await db.mediaAsset.update({ where: { id: g.audioAssetId }, data: { isMock: false } });
  }
  return { projectId: p.id, run };
}

/** Everything a version's rows hold but the status columns a later decision may change (the runbook's read-only "v1 intact" check). */
async function snapshot(storyboardId: string) {
  const { status: _s, updatedAt: _u, decidedBy: _b, decidedAt: _a, ...row } = await db.storyboard.findUniqueOrThrow({ where: { id: storyboardId } });
  const shots = await db.shot.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' }, include: { blocks: { orderBy: { scriptBlockId: 'asc' } }, claims: { orderBy: [{ claimId: 'asc' }, { role: 'asc' }] }, subjects: { orderBy: { subjectId: 'asc' } } } });
  const beats = await db.visualBeat.findMany({ where: { storyboardId }, orderBy: { sortOrder: 'asc' }, include: { blocks: { orderBy: { scriptBlockId: 'asc' } }, claims: { orderBy: { claimId: 'asc' } } } });
  const subjects = await db.continuitySubject.findMany({ where: { storyboardId }, orderBy: { subjectKey: 'asc' } });
  return JSON.stringify({ row, shots: shots.map(({ updatedAt: _x, ...rest }) => rest), beats, subjects });
}

describe('storyboard acceptance through the API (scripted model, MOCK voice, published prices)', () => {
  it('plans the narrated opening as a preview, inspects it, approves it on approved takes, edits one shot and switches approach, with visual generation held', async () => {
    const s = await start();
    const { c, call, lines } = s;
    expect((await call('GET', '/api/health')).json<HealthView>().realStages).toEqual(expect.arrayContaining(['VISUAL_PLAN', 'STORYBOARD_PREVIEW']));
    const { projectId, run } = await narrated(s);
    const takes = await db.voiceGeneration.findMany({ where: { runId: run.id, chunk: { currentGenerationId: { not: null } } } });
    expect(takes.length).toBeGreaterThan(1);
    expect(takes.every((t) => t.status === 'IN_REVIEW' && (t.alignment as { source: string; words: unknown[] }).source === 'PROVIDER' && (t.alignment as { words: unknown[] }).words.length > 0)).toBe(true);
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
    const assets = await db.mediaAsset.count();

    // The visual profile: the presets, Cinematic History the library default; chosen for the project.
    const library = (await call('GET', '/api/visual/profiles')).json<VisualProfileLibraryView>();
    const history = library.families.find((f) => f.isDefault)!;
    expect(history).toMatchObject({ name: 'Cinematic History', preset: 'cinematic-history' });
    const chosen = await call('PUT', `/api/projects/${projectId}/visual/selection`, { familyId: history.id, revision: 0 });
    expect(chosen.json<VisualProductionView>()).toMatchObject({ revision: 1, mode: 'FOLLOW', family: { name: 'Cinematic History' } });

    // The plan: a preview of the audition, paid for only once confirmed; the project stays where it is.
    const inputs = (await call('GET', `/api/projects/${projectId}/storyboard/inputs`)).json<StoryboardInputsView>();
    expect(inputs).toMatchObject({ kind: 'PREVIEW', blocked: null, planningCeilingUsd: 5, profile: { revision: 1 } });
    expect((await call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 1 })).statusCode).toBe(400);
    const planned = await call('POST', `/api/projects/${projectId}/storyboard/generate`, { narration: { runId: run.id }, selectionRevision: 1, confirm: true });
    expect(planned.statusCode).toBe(202);
    const { job, assemblyId } = planned.json<{ job: JobView; kind: string; assemblyId: string }>();
    expect(job.type).toBe('STORYBOARD_PREVIEW');
    await c.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED' });
    expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('VOICE_REVIEW');
    const assembly = await db.voiceAssembly.findUniqueOrThrow({ where: { id: assemblyId } });

    // v1, a preview in review on provisional timing.
    const page1 = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>();
    const v1 = page1.storyboard!;
    expect(v1).toMatchObject({ version: 1, status: 'IN_REVIEW', scope: 'PARTIAL', origin: 'GENERATED', narration: { runId: run.id, assemblyId } });
    expect(v1.inputs.narration.approval).toBe('UNREVIEWED');
    expect(v1.inputs.profile.familyName).toBe('Cinematic History');

    // Timing from the audio: beats and shots tile the assembly's clock, every cut at a listed cut point, every narrated word in exactly one shot.
    expect(v1.runtimeMs).toBe(assembly.totalDurationMs);
    for (const lane of [v1.beats, v1.shots]) {
      expect(lane[0]!.startMs).toBe(0);
      expect(lane.at(-1)!.endMs).toBe(assembly.totalDurationMs);
      for (let i = 1; i < lane.length; i++) expect(lane[i]!.startMs).toBe(lane[i - 1]!.endMs);
    }
    const cuts = new Set(v1.cutPoints.map((p) => p.atMs));
    for (const shot of v1.shots.slice(1)) expect(cuts.has(shot.startMs)).toBe(true);
    const words = new Map<string, number>();
    for (const shot of v1.shots) for (const b of shot.narration.blocks) for (let w = b.firstWord; w <= b.lastWord; w++) words.set(`${b.blockKey}:${w}`, (words.get(`${b.blockKey}:${w}`) ?? 0) + 1);
    expect([...words.values()].every((n) => n === 1)).toBe(true);
    expect(new Set(v1.shots.flatMap((sh) => sh.narration.blocks.map((b) => b.blockKey)))).toEqual(new Set((run.scope as { blockKeys: string[] }).blockKeys));
    // Many shots on one block, and one shot across blocks.
    const perBlock = new Map<string, number>();
    for (const shot of v1.shots) for (const b of shot.narration.blocks) perBlock.set(b.blockKey, (perBlock.get(b.blockKey) ?? 0) + 1);
    expect([...perBlock.values()].some((n) => n > 1)).toBe(true);
    expect(v1.shots.some((sh) => sh.narration.blocks.length > 1)).toBe(true);

    // Every shot answers "why is this visual here?": shot → beat → narration → blocks → architecture → claims and sources.
    for (const shot of v1.shots) {
      expect(shot.why).toMatchObject({ shot: { key: shot.key }, beat: { key: shot.beatKey } });
      expect(shot.why.narration.text.length).toBeGreaterThan(0);
      expect(shot.why.blocks.map((b) => b.key)).toEqual(shot.narration.blocks.map((b) => b.blockKey));
      expect(shot.why.architecture.sequence).not.toBeNull();
      expect(shot.assetRequirement).not.toBeNull();
      if (shot.infoClass === 'DOCUMENTED') {
        expect(shot.claims.length).toBeGreaterThan(0);
        expect(shot.why.claims.length).toBeGreaterThan(0);
        expect(shot.why.sources.length).toBeGreaterThan(0);
      }
    }
    expect(v1.evidenceCoverage.factualShots).toBeGreaterThan(0);
    expect(v1.evidenceCoverage).toMatchObject({ traced: v1.evidenceCoverage.factualShots, untraced: [] });

    // Treatments varied, by storytelling need: a title card, reconstructions, characters, records, a map, drawn and abstract pictures.
    const treatments = new Set(v1.shots.map((sh) => sh.treatment));
    expect([...treatments].sort()).toEqual(['ABSTRACT_METAPHOR', 'CHARACTER_VISUAL', 'CINEMATIC_RECONSTRUCTION', 'DIAGRAM', 'DOCUMENT_ANIMATION', 'ENVIRONMENT', 'MAP_ANIMATION', 'MOTION_GRAPHIC', 'TEXT_ON_SCREEN']);
    expect(v1.qa.live.map((f) => f.kind)).not.toContain('TREATMENT_DOMINANT');

    // The forecast: generated pictures priced at published list prices with their sources and dates, records unpriced (never $0), the rollup MIXED.
    expect(v1.costs).toMatchObject({ basis: 'MIXED', unpricedShots: 1, actualCostUsd: null, pricingChanged: false });
    expect(v1.costs.totalUsd).toBeGreaterThan(0);
    for (const shot of v1.shots) {
      const cost = shot.cost!;
      if (cost.basis === 'UNPRICED') expect(cost).toMatchObject({ totalUsd: null, confidence: null });
      else expect(cost.totalUsd).not.toBeNull();
      for (const line of cost.lines) expect(line.rate === null || (line.rate.source.length > 0 && /^\d{4}-\d\d-\d\d$/.test(line.rate.checkedAt))).toBe(true);
    }
    const video = v1.shots.find((sh) => sh.method === 'GENERATIVE_VIDEO')!;
    expect(video.cost).toMatchObject({ basis: 'ESTIMATED', confidence: 'LIST_PRICE' });
    expect(video.cost!.lines.every((l) => /^https:\/\//.test(l.rate!.source))).toBe(true);
    expect(video.cost!.generations).toBeGreaterThan(1);
    expect(v1.shots.find((sh) => sh.cost!.basis === 'UNPRICED')).toMatchObject({ treatment: 'DOCUMENT_ANIMATION', method: 'DOCUMENT_MOTION' });

    // Continuity: the fictional stand-in and the composite each require a continuity asset, and so does the recurring room.
    expect(v1.continuity.map((x) => [x.key, x.kind, x.castId, x.requirement])).toEqual([
      ['CS01', 'CHARACTER', 'pov', 'Requires You continuity asset'],
      ['CS02', 'CHARACTER', 'F1', 'Requires Pieter Graanhout continuity asset'],
      ['CS03', 'ENVIRONMENT', null, 'Requires The tavern room (test) continuity asset'],
    ]);
    expect(v1.continuity.every((x) => x.appearances.length > 0)).toBe(true);

    // QA: nothing blocks; the warnings say what to know (provisional timing, a preview, an unpriced shot); the model's output needed no correction.
    expect(v1.qa.live.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
    expect(v1.qa.live.map((f) => f.kind)).toEqual(expect.arrayContaining(['PROVISIONAL_TIMING', 'SCOPE_PARTIAL', 'COST_UNPRICED']));
    expect(v1.normalization).toEqual([]);

    // The job's summary log line, read back from the database after the save.
    const summary = lines.find((l) => l.jobId === job.id && typeof l.msg === 'string' && l.msg.startsWith('storyboard summary: '))!;
    const fp = (await db.storyboard.findUniqueOrThrow({ where: { id: v1.id } })).narrationFingerprint!;
    expect(summary.msg).toMatch(
      new RegExp(
        [
          `^storyboard summary: v1 PARTIAL run ${run.number} assembly v1 fp=${fp.slice(0, 12)} 0–${(assembly.totalDurationMs / 1000).toFixed(1)} s`,
          `beats ${v1.beats.length}`,
          `shots ${v1.shots.length}`,
          'avg \\d+\\.\\d s',
          'treatments \\{[A-Z_]+: \\d+(, [A-Z_]+: \\d+)*\\}',
          'relations \\{[A-Z_]+: \\d+(, [A-Z_]+: \\d+)*\\}',
          `cost \\$${v1.costs.totalUsd!.toFixed(2)} \\(MIXED, unpriced 1\\)`,
          'QA blocking 0 \\{\\} / warnings \\d+ \\{[A-Z_]+: \\d+(, [A-Z_]+: \\d+)*\\}',
          'normalizations 0',
          `evidence traced ${v1.evidenceCoverage.traced}/${v1.evidenceCoverage.factualShots}`,
          'continuity subjects 3 \\(requires reference: 3\\)',
          `narration takes 0/${takes.length} approved`,
          'model calls 4, \\$\\d+\\.\\d{4} planning spend',
          'project status VOICE_REVIEW \\(unchanged\\)$',
        ].join(' · '),
      ),
    );
    expect(summary).toMatchObject({ version: 1, scope: 'PARTIAL', beats: v1.beats.length, shots: v1.shots.length, costBasis: 'MIXED', blocking: 0, continuitySubjects: 3, referencesRequired: 3, takesApproved: 0, modelCalls: 4, projectStatus: 'VOICE_REVIEW' });
    expect(await db.providerCall.groupBy({ by: ['kind'], where: { jobId: job.id } })).toEqual([{ kind: 'AI' }]);

    // Approval: refused while the takes it is timed against are in review; allowed once they are approved (no spend), at version level only.
    const decide = (id: string, payload: unknown) => call('POST', `/api/storyboards/${id}/decision`, payload);
    const refused = await decide(v1.id, { decision: 'APPROVED', expectedVersion: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(new RegExp(`the narration it is timed against is not approved \\(takes 0/${takes.length} approved\\)`));
    expect((await call('POST', `/api/voice/runs/${run.id}/approve-all`)).statusCode).toBe(200);
    const live = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>().storyboard!;
    expect(live.qa.live.map((f) => f.kind)).not.toContain('PROVISIONAL_TIMING');
    const approved = await decide(v1.id, { decision: 'APPROVED', note: 'The opening reads well (test).', expectedVersion: 1 });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<StoryboardView>()).toMatchObject({ project: { status: 'VOICE_REVIEW' }, storyboard: { version: 1, status: 'APPROVED' } });
    expect(await db.approval.count({ where: { projectId, gate: 'STORYBOARD' } })).toBe(0);
    const intact = await snapshot(v1.id);

    // One shot edited: v2 in review; v1 exactly as it was, still approved, its approval its own.
    const edited = v1.shots[0]!;
    const made = await call('POST', `/api/storyboards/${v1.id}/edits`, { expectedVersion: 1, ops: [{ op: 'updateShot', shotKey: edited.key, patch: { description: 'The question in white type, letter by letter (test).' } }], note: 'A plainer title (test).' });
    expect(made.statusCode).toBe(201);
    const v2 = made.json<StoryboardView>().storyboard!;
    expect(v2).toMatchObject({ version: 2, status: 'IN_REVIEW', origin: 'EDIT', baseVersion: 1, decisions: [] });
    expect(v2.changes!.shots.changed).toEqual([{ shotKey: edited.key, fields: ['description'] }]);
    expect(v2.shots.filter((sh) => sh.contentHash !== v1.shots.find((x) => x.key === sh.key)?.contentHash).map((sh) => sh.key)).toEqual([edited.key]);
    expect(await snapshot(v1.id)).toBe(intact);
    const old = (await call('GET', `/api/projects/${projectId}/storyboard?v=1`)).json<StoryboardView>().storyboard!;
    expect(old).toMatchObject({ status: 'APPROVED', newer: { version: 2, status: 'IN_REVIEW', changedShots: 1 } });
    expect(old.statusNote).toMatch(/; the approval applies to v1: v2 differs in 1 shot\(s\)$/);

    // The approach switched (B, evidence-led): a paid job that plans again only the beats whose treatment B changes; the rest is copied as it was.
    const changing = v2.beats.filter((b) => b.content.options.B.treatment !== b.content.options.C.treatment).map((b) => b.key);
    expect(changing.length).toBeGreaterThan(0);
    expect(changing.length).toBeLessThan(v2.beats.length);
    // The shots it copies are approved on v2 first: their decisions carry to v3, as nothing in them changes.
    for (const shot of v2.shots.filter((sh) => !changing.includes(sh.beatKey))) expect((await call('POST', `/api/shots/${shot.id}/decision`, { decision: 'APPROVED' })).statusCode).toBe(200);
    const calls = await db.providerCall.count({ where: { projectId, kind: 'AI' } });
    const switched = await call('POST', `/api/storyboards/${v2.id}/approach`, { approach: 'B', expectedVersion: 2, confirm: true });
    expect(switched.statusCode).toBe(202);
    await c.runner.drain();
    expect(await db.providerCall.count({ where: { projectId, kind: 'AI' } })).toBeGreaterThan(calls);
    const v3 = (await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>().storyboard!;
    expect(v3).toMatchObject({ version: 3, origin: 'APPROACH', baseVersion: 2, status: 'IN_REVIEW' });
    const kept = (v: typeof v2) => v.shots.filter((sh) => !changing.includes(sh.beatKey)).map((sh) => [sh.key, sh.beatKey, sh.contentHash, sh.startMs, sh.endMs]);
    expect(kept(v3)).toEqual(kept(v2));
    expect(v3.shots.filter((sh) => !changing.includes(sh.beatKey)).every((sh) => sh.review === 'APPROVED' && sh.decision?.carriedFromVersion === 2)).toBe(true);
    const replanned = v3.shots.filter((sh) => changing.includes(sh.beatKey));
    expect(replanned.length).toBeGreaterThan(0);
    const earlier = new Set([...v1.shots, ...v2.shots].map((sh) => sh.key));
    expect(replanned.every((sh) => !earlier.has(sh.key) && sh.review === 'PENDING')).toBe(true);
    expect(replanned.map((sh) => sh.treatment)).toEqual(changing.map((k) => v2.beats.find((b) => b.key === k)!.content.options.B.treatment));
    expect(v3.qa.live.filter((f) => f.severity === 'BLOCKING')).toEqual([]);
    // v1 is still exactly as it was and still the approved one; v2, never approved, is superseded.
    expect(await snapshot(v1.id)).toBe(intact);
    expect((await call('GET', `/api/projects/${projectId}/storyboard`)).json<StoryboardView>().versions.map((v) => [v.version, v.status, v.origin])).toEqual([
      [3, 'IN_REVIEW', 'APPROACH'],
      [2, 'SUPERSEDED', 'EDIT'],
      [1, 'APPROVED', 'GENERATED'],
    ]);

    // The hard stop: visual generation is held; nothing was generated or stored; the project never left VOICE_REVIEW.
    for (const type of ['VISUAL_GENERATION', 'INFOGRAPHIC']) expect((await call('POST', `/api/projects/${projectId}/jobs`, { type })).json()).toMatchObject({ error: 'CONFLICT', message: VISUAL_GENERATION_HELD });
    expect(await db.job.count({ where: { projectId, type: { in: ['VISUAL_GENERATION', 'INFOGRAPHIC'] } } })).toBe(0);
    expect(await db.mediaAsset.count()).toBe(assets);
    expect(await db.providerCall.count({ where: { projectId, kind: { not: 'AI' }, job: { type: { in: ['STORYBOARD_PREVIEW', 'VISUAL_PLAN'] } } } })).toBe(0);
    expect((await call('GET', `/api/projects/${projectId}`)).json<ProjectDetailView>()).toMatchObject({ status: 'VOICE_REVIEW', storyboard: { version: 3, scope: 'PARTIAL', status: 'IN_REVIEW' } });
  });
});
