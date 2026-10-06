/**
 * The Voice page's browser QA fixture (scripts/ui/voice-ui.sh runs it). MOCK
 * voice and MOCK storage, a fake model for the script: nothing is paid and
 * no key is read. It seeds a throwaway database with a project whose script
 * is approved, narrates it — a direction comparison, and an audition whose
 * chunks have a take still generating and a newer take that failed — checks
 * that the dashboard numbers sentences as the engine does, then serves the
 * API and the built dashboard with the job worker running and prints
 * "READY <json>".
 *
 *   UI_DATABASE_URL=postgres://…/docengine_voice_ui PORT=3102 tsx scripts/ui/voice-fixture.ts
 *
 * WEB_DIST_DIR serves another dashboard build (apps/web/dist by default).
 */
import { buildApp } from '../../apps/api/src/app.ts';
import { createContainer } from '../../apps/api/src/container.ts';
import { parseEnv } from '../../apps/api/src/env.ts';
import { createLogger } from '../../apps/api/src/logger.ts';
import { sentenceSpans as dashboardSentences } from '../../apps/web/src/voice-plan.ts';
import { FakeScriptAI } from '../../modules/script/src/testing.ts';
import { seedFakeDossier } from '../../modules/story/src/testing.ts';
import { chunkSentences } from '../../modules/voice/src/stage.ts';
import { sentenceSpans as engineSentences } from '../../modules/voice/src/text.ts';
import { ALL_MOCK, createProviders } from '../../packages/providers/src/index.ts';

const url = process.env.UI_DATABASE_URL;
if (!url || !/ui/.test(url)) throw new Error('UI_DATABASE_URL must name a throwaway database (its name contains "ui")');
const env = parseEnv({ DATABASE_URL: url, NODE_ENV: 'development', LOG_LEVEL: 'warn', HOST: '127.0.0.1', PORT: process.env.PORT ?? '3102', WORKER_ENABLED: 'true', WORKER_POLL_INTERVAL_MS: '200', WEB_DIST_DIR: process.env.WEB_DIST_DIR });
const ai = new FakeScriptAI();
const c = createContainer(env, createLogger(env, 'voice-ui'), { providers: { ...createProviders(ALL_MOCK), ai } });
const actor = 'ui-check';

// A project with an approved script (the fake model writes it).
const p = await c.projects.createProject({ title: 'UI check — voice', topic: 'SYNTHETIC TEST DATA', targetMinutesMin: 2, targetMinutesMax: 4 }, actor);
await c.db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
await seedFakeDossier(c.db, p.id);
await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, actor);
await c.runner.drain();
const pack = await c.db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, include: { candidates: true } });
const keep = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];
for (const cand of pack.candidates) await c.db.storyCandidate.update({ where: { id: cand.id }, data: { selected: keep.includes(cand.title) } });
ai.architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, actor);
await c.runner.drain();
await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, actor);
await c.projects.generateScript(p.id, {}, actor);
await c.runner.drain();
await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, actor);

// A direction comparison: three runs of the first section, one job.
const comparison = await c.voice.createExperiment(p.id, { scope: { kind: 'SECTION', section: 1 }, name: 'Performance direction', variants: [{ label: 'A plain', strategy: 'PLAIN' }, { label: 'B restrained', strategy: 'RESTRAINED' }, { label: 'C expressive', strategy: 'EXPRESSIVE' }], confirm: true }, actor);
await c.runner.drain();

// An audition whose first chunk has a newer take still generating and whose second has a newer take that failed.
const states = await c.voice.createRun(p.id, { scope: { kind: 'AUDITION', seconds: 40 } }, actor);
await c.runner.drain();
const run = await c.db.voiceRun.findFirstOrThrow({ where: { projectId: p.id, number: states.run }, include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } } } });
for (const [i, status, error] of [
  [0, 'GENERATING', null],
  [1, 'FAILED', 'The voice provider did not answer in time (UI check).'],
] as const) {
  const chunk = run.chunks[i];
  if (!chunk?.current) throw new Error(`The audition has no generated chunk ${i + 1}`);
  const g = chunk.current;
  await c.db.voiceGeneration.create({
    data: { chunkId: chunk.id, runId: run.id, projectId: p.id, generation: g.generation + 1, status, profileId: g.profileId, provider: g.provider, model: g.model, voiceId: g.voiceId, strategy: g.strategy, canonicalText: chunk.sourceText, textHash: chunk.textHash, error, createdBy: actor },
  });
}

// The dashboard numbers a chunk's sentences as the engine counts them for directions.
const chunks = await c.db.voiceChunk.findMany({ where: { run: { projectId: p.id } } });
const blocks = await c.db.scriptBlock.findMany({ where: { script: { projectId: p.id } }, select: { text: true } });
const same = (a: { start: number; end: number }[], b: { start: number; end: number }[]) => a.length === b.length && a.every((s, i) => s.start === b[i]!.start && s.end === b[i]!.end);
const differ = [
  ...chunks.filter((ch) => !same(dashboardSentences(ch.sourceText), chunkSentences(ch))).map((ch) => `chunk ${ch.chunkIndex + 1} of a run: ${JSON.stringify(ch.sourceText.slice(0, 80))}`),
  ...blocks.filter((b) => !same(dashboardSentences(b.text), engineSentences(b.text))).map((b) => `block: ${JSON.stringify(b.text.slice(0, 80))}`),
];
if (differ.length) throw new Error(`The dashboard numbers sentences differently from the engine:\n${differ.join('\n')}`);

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
console.log(`READY ${JSON.stringify({ slug: p.slug, comparison: comparison.runs, states: states.run, sentencesChecked: chunks.length + blocks.length })}`);
