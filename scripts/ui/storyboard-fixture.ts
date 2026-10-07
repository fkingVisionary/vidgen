/**
 * The Storyboard page's browser QA fixture (scripts/ui/storyboard-ui.sh runs
 * it). MOCK voice, MOCK storage and every other provider MOCK, a scripted
 * model for the script and the storyboard's planning calls: nothing is paid,
 * no key is read and no picture is generated. It seeds a throwaway database
 * with two projects whose script is approved and whose opening is narrated
 * as an audition (its takes read as provider-timed audio):
 *
 * - "storyboard": every take approved and a preview storyboard planned (v1)
 *   with no blocking finding: two shots on one block and a shot over a cut
 *   point (to split), a mix of treatments, a recurring place and claims, so
 *   every tab has something to show and the version can be approved;
 * - "plan": takes still to review and no storyboard yet (the page offers to
 *   plan one; the timing would be provisional), and an old failed placeholder
 *   visual generation job, whose retry is held (the hard stop).
 *
 * Then it serves the API and the built dashboard with the job worker
 * running and prints "READY <json>".
 *
 *   UI_DATABASE_URL=postgres://…/docengine_storyboard_ui PORT=3103 tsx scripts/ui/storyboard-fixture.ts
 *
 * WEB_DIST_DIR serves another dashboard build (apps/web/dist by default).
 */
import type { VisualTreatment } from '../../packages/core/src/index.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { createContainer } from '../../apps/api/src/container.ts';
import { parseEnv } from '../../apps/api/src/env.ts';
import { createLogger } from '../../apps/api/src/logger.ts';
import { seedFakeDossier } from '../../modules/story/src/testing.ts';
import { FakeStoryboardAI, cutPointsIn, fakeBeats, fakeShot } from '../../modules/storyboard/src/testing.ts';
import { ALL_MOCK, createProviders } from '../../packages/providers/src/index.ts';

const url = process.env.UI_DATABASE_URL;
if (!url || !/ui/.test(url)) throw new Error('UI_DATABASE_URL must name a throwaway database (its name contains "ui")');
const env = parseEnv({ DATABASE_URL: url, NODE_ENV: 'development', LOG_LEVEL: 'warn', HOST: '127.0.0.1', PORT: process.env.PORT ?? '3103', WORKER_ENABLED: 'true', WORKER_POLL_INTERVAL_MS: '200', WEB_DIST_DIR: process.env.WEB_DIST_DIR });
const ai = new FakeStoryboardAI();
const c = createContainer(env, createLogger(env, 'storyboard-ui'), { providers: { ...createProviders(ALL_MOCK), ai } });
const actor = 'ui-check';

// ── The scripted planning calls ──────────────────────────────────────────────

/** Treatments the scripted shots take in turn: all of them illustrative or drawn, none depicting an event. */
const TURNS: VisualTreatment[] = ['ENVIRONMENT', 'CINEMATIC_RECONSTRUCTION', 'MOTION_GRAPHIC', 'GENERATED_STILL', 'ABSTRACT_METAPHOR', 'TEXT_ON_SCREEN'];
/** The beats proposed last, by the key code gives them (VB01… in clock order), and the cut points of the beats brief in order. */
let proposed = new Map<string, { from: string; to: string }>();
let order: string[] = [];
/** The first beat with a cut point inside its words: planned as two shots (many shots on one block); every other beat is one shot, so one can be split. */
let splitBeat: string | null = null;

ai.beats = (prompt) => {
  const out = fakeBeats(prompt);
  order = cutPointsIn(prompt);
  proposed = new Map(out.beats.map((b, i) => [`VB${String(i + 1).padStart(2, '0')}`, { from: b.from, to: b.to }]));
  out.beats = out.beats.map((b, i) => ({ ...b, title: `Beat ${i + 1} (UI check)`, subjectKeys: ['CS01'], options: { ...b.options, A: { treatment: 'CINEMATIC_RECONSTRUCTION', concept: 'The scene, reconstructed (UI check).' } } }));
  out.subjects = [
    {
      key: 'CS01',
      kind: 'ENVIRONMENT',
      castId: null,
      anonymous: false,
      name: 'The harbour quay (UI check)',
      description: 'A stone quay with moored barges, the same place in every shot (UI check).',
      era: 'Seventeenth century',
      location: 'A harbour town',
      approximateAge: null,
      clothing: null,
      physicalDescription: null,
      visualIdentity: { palette: ['slate', 'umber'], silhouette: 'Low warehouses against the sky', props: ['moored barges'] },
      designDetails: [{ detail: 'Barrels stacked by the warehouse doors', basis: 'PERIOD_GENERIC', claimKeys: [] }],
      rules: ['The same quay wherever it appears'],
      claimKeys: [],
    },
  ];
  return out;
};

/** Each block of a brief, by block key: its information class and the claims it lists. */
function blocksOf(prompt: string): Map<string, { cls: string; claims: string[] }> {
  const out = new Map<string, { cls: string; claims: string[] }>();
  for (const part of prompt.split('### Block ').slice(1)) {
    const head = /^(\S+) · (\S+)/.exec(part);
    if (head) out.set(head[1]!, { cls: head[2]!, claims: [...part.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]!) });
  }
  return out;
}

ai.shots = (prompt) => {
  const blocks = blocksOf(prompt);
  const keys = [...new Set([...prompt.matchAll(/\bVB\d{2,4}\b/g)].map((m) => m[0]))].filter((k) => proposed.has(k));
  let turn = 0;
  const shots = keys.flatMap((k) => {
    const beat = proposed.get(k)!;
    const inner = order.slice(order.indexOf(beat.from) + 1, order.indexOf(beat.to));
    if (inner.length) splitBeat ??= k;
    const ranges = inner.length && splitBeat === k ? [{ from: beat.from, to: inner[Math.floor(inner.length / 2)]! }, { from: inner[Math.floor(inner.length / 2)]!, to: beat.to }] : [beat];
    return ranges.map((r) => {
      // The blocks whose words the shot covers: the one it ends in, and the one it starts in unless it starts at that block's end.
      const keyOf = (id: string) => /^(.*):/.exec(id)?.[1] ?? '';
      const covered = [...new Set([...(r.from.endsWith(':end') ? [] : [keyOf(r.from)]), keyOf(r.to)])].filter((k) => blocks.has(k));
      const block = covered[0] ?? '';
      // Uncertain words get a drawn graphic that depicts nothing, so the version has no blocking finding and can be approved.
      const treatment = covered.some((k) => blocks.get(k)!.cls === 'UNCERTAIN') ? 'MOTION_GRAPHIC' : TURNS[turn++ % TURNS.length]!;
      const claim = covered.map((k) => blocks.get(k)!.claims[0]).find(Boolean);
      return fakeShot(k, r, {
        treatment,
        cutIn: 'CONCEPT_CHANGE',
        cutOut: 'CONCEPT_CHANGE',
        purpose: `Carries ${block || 'the opening'} (UI check).`,
        description: treatment === 'TEXT_ON_SCREEN' ? 'A line of the narration set in type (UI check).' : 'The quay at dusk, barges moored, no one in frame (UI check).',
        environment: { subjectKey: treatment === 'ENVIRONMENT' ? 'CS01' : null, description: 'The harbour quay (UI check).' },
        claims: claim ? [{ claimKey: claim, role: 'CONTEXT' }] : [],
      });
    });
  });
  return { shots, beats: [] };
};

// ── Two projects with an approved script and a narrated opening ──────────────

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

async function narrated(title: string) {
  const p = await c.projects.createProject({ title, topic: 'SYNTHETIC TEST DATA', targetMinutesMin: 2, targetMinutesMax: 4 }, actor);
  await c.db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(c.db, p.id);
  await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, actor);
  await c.runner.drain();
  const pack = await c.db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await c.db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await c.db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, actor);
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, actor);
  await c.projects.generateScript(p.id, {}, actor);
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, actor);
  const { run: number } = await c.voice.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 60 } }, actor);
  await c.runner.drain();
  const run = await c.db.voiceRun.findUniqueOrThrow({ where: { projectId_number: { projectId: p.id, number } } });
  // The takes as a real provider would have made them (provider timings, stored audio that is not mock): the stand-in for paid audio.
  for (const g of await c.db.voiceGeneration.findMany({ where: { runId: run.id } })) {
    if (g.alignment) await c.db.voiceGeneration.update({ where: { id: g.id }, data: { alignment: { ...(g.alignment as object), source: 'PROVIDER' } } });
    if (g.audioAssetId) await c.db.mediaAsset.update({ where: { id: g.audioAssetId }, data: { isMock: false } });
  }
  return { project: p, run };
}

const board = await narrated('UI check — storyboard');
await c.voice.approveAll(board.run.id, actor);
await c.storyboards.generate(board.project.id, { narration: { runId: board.run.id }, selectionRevision: 0, confirm: true }, actor);
await c.runner.drain();
const v1 = await c.db.storyboard.findFirstOrThrow({ where: { projectId: board.project.id }, orderBy: { version: 'desc' } });
if (v1.version !== 1 || v1.status !== 'IN_REVIEW') throw new Error(`The preview was not planned as v1 in review (v${v1.version}, ${v1.status})`);
const live = await c.storyboards.view(board.project.id, 1);
const blocking = live.storyboard!.qa.live.filter((f) => f.severity === 'BLOCKING');

const plan = await narrated('UI check — storyboard to plan');
// A placeholder generation job of the mock pipeline, as production may hold one: never retried while the storyboard is real.
const { phaseSeq } = await c.db.project.findUniqueOrThrow({ where: { id: plan.project.id }, select: { phaseSeq: true } });
const heldJob = await c.db.job.create({ data: { projectId: plan.project.id, type: 'VISUAL_GENERATION', status: 'FAILED', phaseSeq, attempts: 3, isMock: true, error: 'A placeholder run of the mock pipeline (UI check)', completedAt: new Date() } });

const app = await buildApp(c);
await app.listen({ port: env.PORT, host: env.HOST });
c.runner.start();
const stop = async () => {
  await app.close();
  await c.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
console.log(
  `READY ${JSON.stringify({
    slug: board.project.slug,
    planSlug: plan.project.slug,
    heldJob: heldJob.id,
    shots: live.storyboard!.shotCount,
    beats: live.storyboard!.beatCount,
    blocking: blocking.map((f) => `${f.ref ?? ''} ${f.kind}`),
  })}`,
);
