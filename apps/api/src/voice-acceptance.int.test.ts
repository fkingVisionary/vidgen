import { VOICE_ACCEPTANCE_EXPERIMENT, type HealthView, type JobView, type VoicePlanView, type VoiceProductionView, type VoiceProfileHistoryView, type VoiceRunView, type VoiceView } from '@docengine/core';
import { Prisma } from '@docengine/database';
import { ALL_MOCK, ElevenLabsVoiceProvider, MockStorageProvider, audioMetadata, createProviders, type ProviderSet } from '@docengine/providers';
import { FakeScriptAI } from '@docengine/script/testing';
import { seedFakeDossier } from '@docengine/story/testing';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { buildApp } from './app.ts';
import { createContainer, type AppContainer } from './container.ts';
import { parseEnv } from './env.ts';

/**
 * The operator's acceptance path (brief §32, §37–§42; additions §4–§6)
 * through the API, on the production wiring: plan the opening audition,
 * queue the acceptance experiment with one confirm, play every variant's
 * assembly, regenerate one chunk — and read the job logs as JSON lines, as
 * Railway receives them: they are the only record of a live run outside the
 * dashboard. First with the MOCK voice and storage, then with the
 * ElevenLabs provider on a fake endpoint (no key, no network, no credits);
 * last, on that endpoint, the step after the acceptance experiment (§41)
 * on a run shaped as production's are (no stored configuration, the earlier
 * ledger rows): the chosen variant saved as the project's voice profile and
 * used, one chunk regenerated with it and one with a temporary override.
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

/** The production container and app with a logger whose JSON lines are kept. */
async function start(providers: Partial<ProviderSet> = {}) {
  const lines: Line[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  const env = parseEnv({ DATABASE_URL: process.env.TEST_DATABASE_URL!, NODE_ENV: 'test', WEB_DIST_DIR: '/nonexistent' });
  const c = createContainer(env, logger, { db, providers: { ...createProviders(ALL_MOCK), ai: new FakeScriptAI(), ...providers } });
  const app = await buildApp(c);
  open.push({ app, c });
  /** The lines with this message, of one job if given. */
  const of = (msg: string, jobId?: string): any[] => lines.filter((l) => l.msg === msg && (!jobId || l.jobId === jobId));
  return { app, c, of, lines };
}

const FRAME_MS = 1152 / 44.1;

/** MPEG-1 layer III frames (128 kbps, 44.1 kHz, mono) lasting at least `ms`. */
function mp3For(ms: number): Uint8Array {
  const frames = Math.ceil(ms / FRAME_MS) + 1;
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0xc4]);
  const out = new Uint8Array(417 * frames);
  for (let i = 0; i < frames; i++) out.set(frame, i * 417);
  return out;
}

/** The fake's character-cost header for a request of this many characters. */
const characterCost = (sent: number) => Math.round(sent * 0.11);
/** "1,577", as the cost text writes a count. */
const count = (n: number) => n.toLocaleString('en-US');

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

/**
 * ElevenLabs as the provider code meets it: the voice and model lookups,
 * pronunciation dictionaries, and text to speech with timestamps that speaks
 * every character in 55 ms, leaves the audio tags out of its alignment (v4
 * may), and reports a character cost of about 0.11 of the characters sent
 * (as v4 did live; its unit is unverified). Every request is kept.
 */
function fakeElevenLabs() {
  const requests: { path: string; body: any }[] = [];
  let n = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ path: url.pathname, body });
    if (init?.method === 'GET' && url.pathname === '/v1/voices/fake-voice') return json({ voice_id: 'fake-voice', name: 'Fake narrator' });
    if (init?.method === 'GET' && url.pathname === '/v1/models') return json([{ model_id: 'eleven_v4' }]);
    if (init?.method === 'GET' && url.pathname === '/v1/pronunciation-dictionaries') return json({ pronunciation_dictionaries: [], has_more: false });
    if (init?.method === 'POST' && url.pathname === '/v1/pronunciation-dictionaries/add-from-rules') return json({ id: 'dict-1', version_id: 'ver-1' });
    if (init?.method === 'POST' && url.pathname === '/v1/text-to-speech/fake-voice/with-timestamps') {
      const chars = [...(body.text as string).replace(/\[[^\]]*\]\s?/g, '')];
      return json(
        {
          audio_base64: Buffer.from(mp3For(chars.length * 55)).toString('base64'),
          alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.055), character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.055) },
        },
        { 'request-id': `req-${++n}`, 'character-cost': String(characterCost(body.text.length)) },
      );
    }
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
  };
  return { fetch, requests };
}

/** In-memory storage that passes for durable (real narration is refused on storage that is not). */
class DurableStorage extends MockStorageProvider {
  override readonly info = { ...new MockStorageProvider().info, name: 'durable-test', mock: false };
}

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];

/** A project whose script is approved (synthetic dossier, fake model). */
async function approvedScript(c: AppContainer): Promise<string> {
  const p = await c.projects.createProject({ ...tulipInput, targetMinutesMin: 2, targetMinutesMax: 4 }, 'test');
  await db.project.update({ where: { id: p.id }, data: { status: 'RESEARCH_COMPLETE', phaseSeq: 2 } });
  await seedFakeDossier(db, p.id);
  await c.projects.enqueueJob(p.id, { type: 'STORY_MINING' }, 'editor');
  await c.runner.drain();
  const pack = await db.storyPack.findFirstOrThrow({ where: { projectId: p.id }, orderBy: { version: 'desc' } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id }, data: { selected: false } });
  await db.storyCandidate.updateMany({ where: { packId: pack.id, title: { in: SIX } }, data: { selected: true } });
  (c.providers.ai as FakeScriptAI).architectOptions = { secondsPerSequence: 30, composite: { name: 'Pieter Graanhout' } };
  await c.projects.enqueueJob(p.id, { type: 'STORY_ARCHITECTURE' }, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'STORY', decision: 'APPROVED' }, 'editor');
  await c.projects.generateScript(p.id, {}, 'editor');
  await c.runner.drain();
  await c.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  return p.id;
}

describe('the voice acceptance path through the API (production wiring, nothing paid)', () => {
  it('MOCK voice: plans the opening audition, runs the acceptance experiment on one confirm, plays every variant, regenerates one chunk, and logs every figure the report needs', async () => {
    const { app, c, of } = await start();
    const id = await approvedScript(c);
    const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    expect(await get<HealthView>('/api/health')).toMatchObject({ storage: 'mock', voice: 'mock' });

    // The opening audition: about 100 s in small chunks, each with its planned seconds.
    const { scope, variants, name } = VOICE_ACCEPTANCE_EXPERIMENT;
    const audition = (await post(`/api/projects/${id}/voice/plan`, { scope })).json<VoicePlanView>();
    expect(audition).toMatchObject({ blocked: null, chunking: { minWords: 20, maxWords: 30 }, estimate: { costBasis: 'MOCK' } });
    expect(audition.estimate.plannedSec).toBeGreaterThanOrEqual(60);
    expect(audition.estimate.plannedSec).toBeLessThanOrEqual(120);
    expect(audition.chunks.length).toBeGreaterThan(4);
    expect(audition.chunks.every((ch) => ch.estimatedSec > 0 && ch.checksPassed)).toBe(true);

    // The acceptance experiment as the dashboard sends it: every variant planned on one profile, then one confirm for the total.
    const profileId = audition.profile.id;
    const plans = await Promise.all(variants.map(async (v) => (await post(`/api/projects/${id}/voice/plan`, { scope, profileId, options: { strategy: v.strategy, chunking: v.chunking, context: v.context } })).json<VoicePlanView>()));
    const total = plans.reduce((n, p) => n + p.estimate.characters, 0);
    expect(plans.every((p) => p.blocked === null)).toBe(true);
    const experiment = { name, scope, profileId, variants: variants.map(({ label, strategy, chunking, context }) => ({ label, strategy, chunking, context })) };
    const unconfirmed = await post(`/api/projects/${id}/voice/experiments`, experiment);
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json<{ message: string }>().message).toBe(`Comparison: ${total} characters (no cost: MOCK voice) across 7 variants — confirm to go ahead`);
    const queued = await post(`/api/projects/${id}/voice/experiments`, { ...experiment, confirm: true });
    expect(queued.statusCode).toBe(202);
    const { job, runs } = queued.json<{ job: JobView; runs: number[] }>();
    expect(runs).toHaveLength(7);
    expect(await db.job.count({ where: { projectId: id, type: 'VOICE' } })).toBe(1);
    await c.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect((await get<VoiceView>(`/api/projects/${id}/voice`)).project.status).toBe('VOICE_REVIEW');

    // Every variant is heard whole: its own assembly, to review, playable (and seekable) from the dashboard.
    const views = new Map<string, VoiceRunView>();
    for (const [i, n] of runs.entries()) {
      const r = (await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!;
      views.set(r.variant!, r);
      expect(r).toMatchObject({ experiment: name, variant: variants[i]!.label, strategy: variants[i]!.strategy, settings: { chunking: variants[i]!.chunking, context: variants[i]!.context } });
      expect(r.chunkCount).toBe(plans[i]!.chunks.length);
      expect(r.chunks.every((ch) => ch.current?.status === 'IN_REVIEW' && ch.current.words.length > 0)).toBe(true);
      expect(r.assembly).toMatchObject({ version: 1, status: 'IN_REVIEW', complete: false });
      expect(r.assembly!.entries.map((e) => e.generationId)).toEqual(r.chunks.map((ch) => ch.current!.id));
      const played = await app.inject({ method: 'GET', url: r.assembly!.audioUrl });
      expect(played.statusCode).toBe(200);
      expect(played.headers['content-type']).toBe('audio/wav');
      expect(Math.abs(audioMetadata(new Uint8Array(played.rawPayload), 'audio/wav').durationMs - r.assembly!.totalDurationMs)).toBeLessThanOrEqual(50);
      expect((await app.inject({ method: 'GET', url: r.assembly!.audioUrl, headers: { range: 'bytes=0-1023' } })).statusCode).toBe(206);
    }

    // The experiment's job logged a line per chunk and per variant, and the comparison.
    const runLines = of('voice run summary', job.id);
    expect(runLines.map((l) => l.variant)).toEqual(variants.map((v) => v.label));
    for (const l of runLines) {
      const r = views.get(l.variant)!;
      expect(l).toMatchObject({
        runId: r.id,
        run: r.number,
        kind: 'AUDITION',
        experiment: name,
        script: { id: expect.any(String), version: 1 },
        strategy: r.strategy,
        chunking: r.settings.chunking,
        context: r.settings.context,
        profile: { versionId: profileId, version: 1, name: 'House narrator', family: 'House narrator' },
        configuration: { reconstructed: false, selection: { mode: 'DEFAULT', revision: 0 }, projectOverrides: {}, runOptions: { strategy: r.strategy, chunking: r.settings.chunking, context: r.settings.context }, overrides: expect.any(String) },
        provider: 'mock',
        model: expect.any(String),
        voiceId: expect.any(String),
        outputFormat: expect.any(String),
        chunks: r.chunkCount,
        takes: { IN_REVIEW: r.chunkCount },
        job: { takes: r.chunkCount, characters: l.characters },
        costBases: ['MOCK'],
        withTimestamps: r.chunkCount,
        assembly: { id: r.assembly!.id, version: 1, status: 'IN_REVIEW', totalDurationMs: r.assembly!.totalDurationMs },
        pronunciation: { unresolved: expect.any(Array), used: expect.any(Array) },
        stopped: null,
      });
      // An audition to review: every take awaits a decision and it is not the whole narration; nothing else blocks.
      expect(l.qa.blocking).toEqual({ TAKE_UNREVIEWED: r.chunkCount, INCOMPLETE_NARRATION: 1 });
      expect(l.characters).toBe(r.chunks.reduce((n, ch) => n + ch.current!.characters!, 0));
      expect(l.durations).toMatchObject({ totalMs: r.chunks.reduce((n, ch) => n + ch.current!.durationMs!, 0), shortestMs: expect.any(Number), longestMs: expect.any(Number), meanMs: expect.any(Number), medianMs: expect.any(Number) });
      const chunkLines = of('voice chunk', job.id).filter((x) => x.runId === r.id);
      expect(chunkLines.map((x) => x.chunk)).toEqual(r.chunks.map((ch) => ch.index + 1));
      for (const [k, x] of chunkLines.entries()) {
        const ch = r.chunks[k]!;
        expect(x).toMatchObject({
          chunkId: ch.id,
          sectionKey: ch.sectionKey,
          blockKeys: ch.blockKeys,
          words: ch.words,
          estimatedSec: expect.any(Number),
          characters: ch.current!.characters,
          take: { id: ch.current!.id, generation: 1, status: 'IN_REVIEW', current: true, durationMs: ch.current!.durationMs, alignment: { source: 'MOCK', characters: expect.any(Number), words: ch.current!.words.length }, cost: { ledgerId: expect.any(String), basis: 'MOCK', estimatedUsd: 0 } },
        });
        expect(x.take).toHaveProperty('requestId');
      }
    }
    const [comparison] = of('voice experiment comparison', job.id);
    expect(comparison.rows.map((row: Line) => [row.variant, row.chunks, row.totalMs])).toEqual(variants.map((v) => [v.label, views.get(v.label)!.chunkCount, views.get(v.label)!.assembly!.entries.reduce((n, e) => n + (e.endMs - e.startMs), 0)]));
    expect(comparison.table).toHaveLength(7);

    // Regenerate one chunk of the house-style run: only that chunk, the earlier take kept, the assembly rebuilt.
    const b = views.get('B restrained')!;
    const chunk = b.chunks[2]!;
    const regenerated = await post(`/api/voice/runs/${b.id}/regenerate`, { chunkIds: [chunk.id] });
    expect(regenerated.statusCode).toBe(202);
    const again = regenerated.json<{ job: JobView; takes: number }>();
    expect(again.takes).toBe(1);
    await c.runner.drain();
    const after = (await get<VoiceView>(`/api/projects/${id}/voice?run=${b.number}`)).run!;
    expect(after.chunks[2]!.generations.map((g) => [g.generation, g.status, g.current])).toEqual([
      [2, 'IN_REVIEW', true],
      [1, 'SUPERSEDED', false],
    ]);
    expect(after.chunks.filter((_, k) => k !== 2).map((ch) => ch.current!.id)).toEqual(b.chunks.filter((_, k) => k !== 2).map((ch) => ch.current!.id));
    expect(after.assemblies.map((a) => a.version)).toEqual([2, 1]);
    expect((await app.inject({ method: 'GET', url: after.assembly!.audioUrl })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: after.assemblies[1]!.audioUrl })).statusCode).toBe(200);

    const [regen] = of('voice regeneration summary', again.job.id);
    const take2 = after.chunks[2]!.current!;
    expect(regen).toMatchObject({
      runId: b.id,
      run: b.number,
      chunks: [
        {
          chunk: 3,
          chunkId: chunk.id,
          previous: { takeId: chunk.current!.id, generation: 1, durationMs: chunk.current!.durationMs },
          takes: [{ id: take2.id, generation: 2, status: 'IN_REVIEW', current: true, durationMs: take2.durationMs, alignment: { words: take2.words.length }, cost: { ledgerId: expect.any(String), basis: 'MOCK' } }],
        },
      ],
      assembly: { before: { id: b.assembly!.id, version: 1, totalDurationMs: b.assembly!.totalDurationMs }, after: { id: after.assembly!.id, version: 2, totalDurationMs: after.assembly!.totalDurationMs } },
      regenerated: 1,
      otherChunks: b.chunkCount - 1,
      unchangedOthers: b.chunkCount - 1,
      othersIntact: true,
    });
    expect(regen.chunks[0].takes[0].cost.ledgerId).not.toBe(of('voice chunk', job.id).find((x) => x.chunkId === chunk.id)!.take.cost.ledgerId);
    expect(of('voice run summary', again.job.id)).toEqual([expect.objectContaining({ runId: b.id, regenerations: 1, takes: { IN_REVIEW: b.chunkCount, SUPERSEDED: 1 }, job: expect.objectContaining({ takes: 1 }), assembly: expect.objectContaining({ version: 2 }) })]);
    expect(of('voice experiment comparison', again.job.id)).toEqual([]);
    expect(await db.job.findUniqueOrThrow({ where: { id: again.job.id } })).toMatchObject({ status: 'SUCCEEDED', result: { kind: 'REGENERATION', generated: 1, failed: 0 } });
  });

  it("ElevenLabs on a fake endpoint: MP3 takes and assemblies, words timed without the audio tags, the estimate from the characters sent with the provider's character cost kept raw beside it, approved phonemes in one dictionary, no key in any log", async () => {
    const eleven = fakeElevenLabs();
    const voice = new ElevenLabsVoiceProvider({ apiKey: 'fake-key-for-tests', voiceId: 'fake-voice', model: 'eleven_v4', outputFormat: 'mp3_44100_128', usdPer1kChars: 0.022, fetch: eleven.fetch });
    const { app, c, of, lines } = await start({ voice, storage: new DurableStorage() });
    const id = await approvedScript(c);
    const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });
    expect(await get<HealthView>('/api/health')).toMatchObject({ storage: 'ok', voice: 'ok' });
    // An approved pronunciation decision: sent as phonemes, never written into the text.
    await db.voicePronunciation.create({ data: { projectId: id, language: 'en', term: 'Pieter', kind: 'NAME', method: 'IPA', pronunciation: 'ˈpitər', status: 'APPROVED', source: 'EDITOR' } });

    const { scope, variants, name } = VOICE_ACCEPTANCE_EXPERIMENT;
    const audition = (await post(`/api/projects/${id}/voice/plan`, { scope })).json<VoicePlanView>();
    expect(audition).toMatchObject({ blocked: null, profile: { provider: 'elevenlabs', modelId: 'eleven_v4', voiceId: 'fake-voice', outputFormat: 'mp3_44100_128' }, estimate: { costBasis: 'ESTIMATED' } });
    const experiment = { name, scope, profileId: audition.profile.id, variants: variants.map(({ label, strategy, chunking, context }) => ({ label, strategy, chunking, context })) };
    expect((await post(`/api/projects/${id}/voice/experiments`, experiment)).json<{ message: string }>().message).toMatch(/^Comparison: \d+ characters \(about \$\d+\.\d\d estimated\) across 7 variants — confirm to go ahead$/);
    const { job, runs } = (await post(`/api/projects/${id}/voice/experiments`, { ...experiment, confirm: true })).json<{ job: JobView; runs: number[] }>();
    await c.runner.drain();
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });

    for (const n of runs) {
      const r = (await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!;
      expect(r.chunks.every((ch) => ch.current?.status === 'IN_REVIEW' && ch.current.mimeType === 'audio/mpeg' && ch.current.alignment === 'PROVIDER' && ch.current.unmatchedWords === 0)).toBe(true);
      const played = await app.inject({ method: 'GET', url: r.assembly!.audioUrl });
      expect(played.headers['content-type']).toBe('audio/mpeg');
      // The joined file keeps to the timeline within a frame, and joining it found no drift.
      expect(Math.abs(audioMetadata(new Uint8Array(played.rawPayload), 'audio/mpeg').durationMs - r.assembly!.totalDurationMs)).toBeLessThanOrEqual(FRAME_MS);
      expect((await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!.assembly!.qa).toEqual([]);
    }

    // What was sent: v4 audio tags (the over-directed reference's [pause] too), never SSML; one dictionary, with exactly the requests that say the term.
    const tts = eleven.requests.filter((r) => r.path.endsWith('/with-timestamps'));
    expect(tts.some((r) => r.body.text.includes('[pause]'))).toBe(true);
    expect(tts.every((r) => !/<break/i.test(r.body.text))).toBe(true);
    expect(eleven.requests.filter((r) => r.path.endsWith('/add-from-rules')).map((r) => r.body.rules)).toEqual([[{ string_to_replace: 'Pieter', type: 'phoneme', phoneme: '/ˈpitər/', alphabet: 'ipa' }]]);
    const withTerm = tts.filter((r) => r.body.text.includes('Pieter'));
    expect(withTerm.length).toBeGreaterThan(0);
    expect(tts.filter((r) => r.body.pronunciation_dictionary_locators)).toEqual(withTerm);
    expect(withTerm.every((r) => JSON.stringify(r.body.pronunciation_dictionary_locators) === JSON.stringify([{ pronunciation_dictionary_id: 'dict-1', version_id: 'ver-1' }]))).toBe(true);

    // The log: the characters sent, costed as an estimate at the configured rate (an upper bound); the provider's
    // character cost (about 0.11 of them, unit unverified) kept raw beside it and never priced; request ids, timings, the term used.
    // Pinned on purpose: this was usageSource REPORTED with the header's figure priced; the brief makes the characters sent the basis.
    const chunkLines = of('voice chunk', job.id);
    expect(chunkLines).toHaveLength(tts.length);
    expect(chunkLines.every((x) => x.take.cost.basis === 'ESTIMATED' && x.take.cost.usageSource === 'COUNTED' && x.take.cost.attempts === 1 && x.take.cost.characters === x.characters && !x.take.cost.reestimated && /^req-\d+$/.test(x.take.requestId) && x.take.alignment.source === 'PROVIDER')).toBe(true);
    for (const x of chunkLines) {
      expect(x.take.cost.reported).toEqual([{ name: 'character-cost', quantity: characterCost(x.characters) }]);
      expect(x.take.cost.estimatedUsd).toBeCloseTo((x.characters * 0.022) / 1000, 6);
      expect(x.take.configuration).toEqual({ base: 'RUN', override: null, profile: 'House narrator v1', source: 'run configuration', differs: [], reconstructed: false });
    }
    for (const l of of('voice run summary', job.id)) {
      const mine = chunkLines.filter((x) => x.runId === l.runId);
      const reported = mine.reduce((n, x) => n + characterCost(x.characters), 0);
      expect(l).toMatchObject({ provider: 'elevenlabs', model: 'eleven_v4', voiceId: 'fake-voice', outputFormat: 'mp3_44100_128', costBases: ['ESTIMATED'], reestimated: false, pronunciation: { unresolved: [], used: ['Pieter'] }, stopped: null });
      expect(l.providerReported).toEqual([{ name: 'character-cost', total: reported, requests: mine.length }]);
      expect(l.costText).toBe(`sent ${count(l.characters)} characters; provider reported ${count(reported)} (character-cost header)`);
      expect(l.estimatedUsd).toBeCloseTo((l.characters * 0.022) / 1000, 5);
      expect(l).not.toHaveProperty('reportedCharacters');
      // The Voice page says the same: the characters sent, the provider's figure beside them, the estimate from what was sent.
      const r = (await get<VoiceView>(`/api/projects/${id}/voice?run=${l.run}`)).run!;
      expect(r).toMatchObject({ characters: l.characters, cost: { basis: 'ESTIMATED', reported: [{ name: 'character-cost', quantity: reported }], reestimated: false } });
      expect(r.cost.totalUsd).toBeCloseTo((l.characters * 0.022) / 1000, 5);
      expect(r.chunks[0]!.current!.cost).toMatchObject({ basis: 'ESTIMATED', characters: r.chunks[0]!.current!.characters, reported: [{ name: 'character-cost', quantity: characterCost(r.chunks[0]!.current!.characters!) }], reestimated: false, note: expect.stringMatching(/sent \(the estimate's basis: an upper bound\); ElevenLabs reported \d+ \(character-cost header; its unit is unverified, so it is not priced\)$/) });
    }

    // A ledger row written before 2026-10-06 (the provider's figure priced, REPORTED: production's seven runs) reads re-estimated
    // from the characters sent, the figure kept raw beside it and the row's own note kept; the row itself is not rewritten.
    const first = (await get<VoiceView>(`/api/projects/${id}/voice?run=${runs[0]}`)).run!;
    const take = first.chunks[0]!.current!;
    const { providerCallId } = await db.voiceGeneration.findUniqueOrThrow({ where: { id: take.id }, select: { providerCallId: true } });
    const figure = characterCost(take.characters!);
    const earlier = { usage: [{ unit: 'CHARACTERS', quantity: figure }], response: { usageSource: 'REPORTED', attempts: 1 }, estimatedCostUsd: (figure * 0.022) / 1000, costNote: `${figure} characters reported by ElevenLabs` };
    await db.providerCall.update({ where: { id: providerCallId! }, data: earlier });
    const reread = (await get<VoiceView>(`/api/projects/${id}/voice?run=${runs[0]}`)).run!;
    expect(reread.chunks[0]!.current!.cost).toMatchObject({
      basis: 'ESTIMATED',
      characters: take.characters,
      reported: [{ name: 'character-cost', quantity: figure }],
      reestimated: true,
      note: `Re-estimated from the ${take.characters} characters sent: the ledger row (before 2026-10-06) priced the provider's own figure (${figure} characters reported by ElevenLabs)`,
    });
    expect(reread.chunks[0]!.current!.cost!.estimatedUsd).toBeCloseTo((take.characters! * 0.022) / 1000, 6);
    expect(reread.cost).toMatchObject({ reestimated: true, reported: first.cost.reported });
    expect(reread.cost.totalUsd).toBeCloseTo(first.cost.totalUsd, 5);
    expect(await db.providerCall.findUniqueOrThrow({ where: { id: providerCallId! }, select: { usage: true, costNote: true } })).toEqual({ usage: earlier.usage, costNote: earlier.costNote });
    expect(JSON.stringify(lines)).not.toContain('fake-key-for-tests');
  });

  it("§41 after the acceptance experiment (fake ElevenLabs): the chosen variant, read as production's run 3 is (made before saved profiles, costed by the earlier ledger), saved as the project's profile and used; one chunk regenerated with it exactly as the run made it and one with a temporary override, each logged with its profile, base, override and cost; a later edit of the profile leaves the run as it was", async () => {
    const eleven = fakeElevenLabs();
    const voice = new ElevenLabsVoiceProvider({ apiKey: 'fake-key-for-tests', voiceId: 'fake-voice', model: 'eleven_v4', outputFormat: 'mp3_44100_128', usdPer1kChars: 0.022, fetch: eleven.fetch });
    const { app, c, of, lines } = await start({ voice, storage: new DurableStorage() });
    const id = await approvedScript(c);
    const project = await db.project.findUniqueOrThrow({ where: { id } });
    const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

    // The acceptance experiment as the dashboard runs it.
    const { scope, variants, name } = VOICE_ACCEPTANCE_EXPERIMENT;
    const audition = (await post(`/api/projects/${id}/voice/plan`, { scope })).json<VoicePlanView>();
    const experiment = { name, scope, profileId: audition.profile.id, selectionRevision: audition.configuration.selectionRevision, variants: variants.map(({ label, strategy, chunking, context }) => ({ label, strategy, chunking, context })), confirm: true };
    const { runs } = (await post(`/api/projects/${id}/voice/experiments`, experiment)).json<{ job: JobView; runs: number[] }>();
    await c.runner.drain();
    const n = runs[variants.findIndex((v) => v.label === 'C expressive')]!;
    // Run C as production's run 3 is after the migration: made before saved profiles (no configuration on the run or its
    // takes) and costed by the earlier ledger (the provider's figure priced, REPORTED).
    const runId = (await db.voiceRun.findFirstOrThrow({ where: { projectId: id, number: n }, select: { id: true } })).id;
    await db.voiceRun.update({ where: { id: runId }, data: { config: Prisma.DbNull } });
    await db.voiceGeneration.updateMany({ where: { runId }, data: { config: Prisma.DbNull } });
    let figures = 0;
    for (const g of await db.voiceGeneration.findMany({ where: { runId }, select: { characters: true, providerCallId: true } })) {
      const figure = characterCost(g.characters!);
      figures += figure;
      await db.providerCall.update({ where: { id: g.providerCallId! }, data: { usage: [{ unit: 'CHARACTERS', quantity: figure }], response: { usageSource: 'REPORTED', attempts: 1 }, estimatedCostUsd: (figure * 0.022) / 1000, costNote: `${figure} character(s) reported by ElevenLabs (character-cost)` } });
    }
    const before = (await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!;
    expect(before).toMatchObject({ variant: 'C expressive', configuration: { reconstructed: true, selection: null, profile: { name: 'House narrator', version: 1 }, runOptions: { strategy: 'EXPRESSIVE' } } });
    expect(before.cost).toMatchObject({ basis: 'ESTIMATED', reported: [{ name: 'character-cost', quantity: figures }], reestimated: true });
    expect(before.cost.totalUsd).toBeCloseTo((before.characters * 0.022) / 1000, 5);

    // "Save this run's configuration as a voice profile", a name, "Use for this project": the project's profile, not the library default.
    const saved = await post(`/api/voice/runs/${before.id}/save-profile`, { name: 'Tulip narrator', use: true });
    expect(saved.statusCode).toBe(201);
    const { profile, production, clearedOverrides } = saved.json<{ profile: VoiceProfileHistoryView; production: VoiceProductionView; clearedOverrides: object | null }>();
    expect(clearedOverrides).toBeNull();
    expect(profile).toMatchObject({ name: 'Tulip narrator', isDefault: false, provider: 'elevenlabs', language: 'en', versions: 1 });
    expect(profile.current).toMatchObject({ version: 1, origin: { kind: 'RUN', run: n, project: project.slug, experiment: name, variant: 'C expressive', reconstructed: true }, notes: `Saved from voice run ${n} of ${project.slug} (${name} — C expressive)` });
    expect(production).toMatchObject({ language: 'en', mode: 'FOLLOW', revision: 1, family: { id: profile.id, name: 'Tulip narrator', isDefault: false }, overrides: {}, problem: null });
    expect(production.effective).toMatchObject({
      provider: 'elevenlabs',
      model: 'eleven_v4',
      voiceId: 'fake-voice',
      outputFormat: 'mp3_44100_128',
      language: 'en',
      strategy: 'EXPRESSIVE',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      numberStyle: 'UK',
    });
    expect(production.effective).toEqual(before.configuration.effective);
    // Eleven v4 is sent stability and similarity only; the rest are kept in the profile, not sent.
    expect(production.sent).toEqual({ stability: 0.5, similarity: 0.75 });
    expect(production.ignored.sort()).toEqual(['speakerBoost', 'speed', 'style']);
    // The library default is still the house profile: another documentary is not touched.
    const library = await get<{ families: { name: string; isDefault: boolean }[] }>('/api/voice/profiles');
    expect(library.families.filter((f) => f.isDefault).map((f) => f.name)).toEqual(['House narrator']);

    // Regenerate one chunk with the production profile, and another with a temporary override (stability 0.3).
    const [one, two] = [before.chunks[1]!, before.chunks[2]!];
    const asked = eleven.requests.length;
    const withProduction = await post(`/api/voice/runs/${before.id}/regenerate`, { chunkIds: [one.id], configuration: 'PRODUCTION', selectionRevision: production.revision });
    expect(withProduction.statusCode).toBe(202);
    const job1 = withProduction.json<{ job: JobView }>().job;
    await c.runner.drain();
    const withOverride = await post(`/api/voice/runs/${before.id}/regenerate`, { chunkIds: [two.id], override: { providerSettings: { stability: 0.3 } } });
    expect(withOverride.statusCode).toBe(202);
    const job2 = withOverride.json<{ job: JobView }>().job;
    await c.runner.drain();
    const sent = eleven.requests.slice(asked).filter((r) => r.path.endsWith('/with-timestamps'));
    expect(sent.map((r) => r.body.voice_settings)).toEqual([
      { stability: 0.5, similarity_boost: 0.75 },
      { stability: 0.3, similarity_boost: 0.75 },
    ]);

    const after = (await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!;
    expect(after.chunks[1]!.current).toMatchObject({ generation: 2, status: 'IN_REVIEW', profile: { familyId: profile.id, familyName: 'Tulip narrator', version: 1 }, configuration: { base: 'PRODUCTION', override: null, profile: { familyName: 'Tulip narrator', version: 1 }, differs: [], identityDiffers: false } });
    expect(after.chunks[2]!.current).toMatchObject({ generation: 2, status: 'IN_REVIEW', profile: { name: 'House narrator', version: 1 }, configuration: { base: 'RUN', override: { providerSettings: { stability: 0.3 } }, differs: ['stability: 0.3 (run: 0.5)'], identityDiffers: true } });
    expect(after.qa.filter((f) => f.kind === 'CONFIGURATION_DIFFERS')).toEqual([expect.objectContaining({ severity: 'WARNING', ref: '#3', detail: expect.stringContaining('a temporary override: stability: 0.3 (run: 0.5)') })]);
    expect(after.configuration).toEqual(before.configuration);
    // Saved from run C and used as it is, the production profile makes the chunk as run C made it.
    expect(after.chunks[1]!.current!.performanceText).toBe(before.chunks[1]!.current!.performanceText);
    expect(after.chunks[1]!.current!.prepared!.settings).toEqual(before.chunks[1]!.current!.prepared!.settings);
    expect(after.chunks.filter((ch) => ch.current!.generation === 1).every((ch) => ch.current!.configuration.reconstructed && ch.current!.cost!.reestimated)).toBe(true);

    // Each regeneration's log names the take's profile, base and override, and its cost from the characters sent.
    for (const [job, base, override, source, take] of [
      [job1, 'PRODUCTION', null, 'production profile', after.chunks[1]!.current!],
      [job2, 'RUN', { providerSettings: { stability: 0.3 } }, 'temporary override', after.chunks[2]!.current!],
    ] as const) {
      const [regen] = of('voice regeneration summary', job.id);
      const t = regen.chunks[0].takes[0];
      expect(t).toMatchObject({ id: take.id, generation: 2, configuration: { base, override, source, profile: base === 'PRODUCTION' ? 'Tulip narrator v1' : 'House narrator v1' } });
      expect(t.cost).toMatchObject({ basis: 'ESTIMATED', usageSource: 'COUNTED', characters: take.characters, reported: [{ name: 'character-cost', quantity: characterCost(take.characters!) }], reestimated: false });
      expect(t.cost.estimatedUsd).toBeCloseTo((take.characters! * 0.022) / 1000, 6);
      expect(regen).toMatchObject({ configurations: { run: base === 'RUN' ? 1 : 0, production: base === 'PRODUCTION' ? 1 : 0, overridden: override ? 1 : 0 }, profiles: [base === 'PRODUCTION' ? 'Tulip narrator v1' : 'House narrator v1'], othersIntact: true });
      const [summary] = of('voice run summary', job.id);
      expect(summary).toMatchObject({ runId: before.id, profile: { family: 'House narrator', version: 1 }, configuration: { reconstructed: true }, reestimated: true });
      expect(summary.costText).toMatch(/^sent [\d,]+ characters; provider reported [\d,]+ \(character-cost header\)$/);
    }

    // A later edit of the profile is a new version: production follows it, run C and its takes keep what they were made with.
    const takes = after.chunks.map((ch) => ch.generations.map((g) => g.configuration));
    const edited = await post(`/api/voice/profiles/${profile.id}/versions`, { expectedCurrent: profile.current!.id, fields: { providerSettings: { stability: 0.6 } } });
    expect(edited.json<VoiceProfileHistoryView>().current).toMatchObject({ version: 2, changes: ['stability: 0.5 → 0.6'] });
    expect((await get<VoiceProductionView>(`/api/projects/${id}/voice/selection`)).profile).toMatchObject({ version: 2 });
    const later = (await get<VoiceView>(`/api/projects/${id}/voice?run=${n}`)).run!;
    expect(later.configuration).toEqual(before.configuration);
    expect(later.chunks.map((ch) => ch.generations.map((g) => g.configuration))).toEqual(takes);
    expect(JSON.stringify(lines)).not.toContain('fake-key-for-tests');
  });
});
