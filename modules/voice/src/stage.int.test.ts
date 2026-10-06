import { VOICE_ACCEPTANCE_EXPERIMENT, VoiceQaFinding, type JobType } from '@docengine/core';
import { JobRunner, PostgresJobQueue, ProjectService, createMockStageHandlers, type JobRunnerOptions, type Logger } from '@docengine/pipeline';
import {
  ALL_MOCK,
  MockStorageProvider,
  MockVoiceProvider,
  ProviderError,
  createProviders,
  type NarrationRequest,
  type NarrationResult,
  type ProviderSet,
  type PutOptions,
  type SignedUrlOptions,
  type StorageProvider,
  type StoredObject,
} from '@docengine/providers';
import type { Database } from '@docengine/database';
import { createScriptStage } from '@docengine/script';
import { FakeScriptAI } from '@docengine/script/testing';
import { createStoryArchitectureStage, createStoryMiningStage } from '@docengine/story';
import { seedFakeDossier } from '@docengine/story/testing';
import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { voiceGate } from './gate.ts';
import { headSentences, tailSentences } from './runs.ts';
import { VoiceService } from './service.ts';
import { createVoiceStage, type VoiceStageConfig } from './stage.ts';
import { sha256 } from './text.ts';

/**
 * The VOICE job's integrity against a real database, with the MOCK voice
 * and memory storage that fail on cue: what a take records and logs, storage
 * failures after a paid request, takes caught mid-request, shutdowns, stops
 * no take would get past, script approval, A/B variants and comparisons.
 * No API key, no network.
 */

const db = useTestDatabase();

/** Every line logged, with the logger's bindings (job id, attempt…). */
class CaptureLogger implements Logger {
  constructor(
    readonly lines: { msg: string; obj: Record<string, unknown> }[] = [],
    private readonly bindings: Record<string, unknown> = {},
  ) {}
  private add(obj: object, msg?: string) {
    this.lines.push({ msg: msg ?? '', obj: { ...this.bindings, ...obj } });
  }
  debug() {}
  info(obj: object, msg?: string) {
    this.add(obj, msg);
  }
  warn(obj: object, msg?: string) {
    this.add(obj, msg);
  }
  error(obj: object, msg?: string) {
    this.add(obj, msg);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new CaptureLogger(this.lines, { ...this.bindings, ...bindings });
  }
  /** The logged objects with this message (loosely typed: they are checked field by field). */
  of(msg: string): any[] {
    return this.lines.filter((l) => l.msg === msg).map((l) => l.obj);
  }
}

/** The MOCK voice with failures on cue and a look at each call. */
class ScriptedVoice extends MockVoiceProvider {
  calls: NarrationRequest[] = [];
  failOn = new Map<number, ProviderError>();
  /** Milliseconds a call takes to answer, by call number. */
  delayOn = new Map<number, number>();
  /** Changes to what a call returns, by call number. */
  alterOn = new Map<number, Partial<NarrationResult>>();
  onCall: ((n: number) => void) | null = null;
  override async generateNarration(req: NarrationRequest): Promise<NarrationResult> {
    this.calls.push(req);
    const n = this.calls.length;
    this.onCall?.(n);
    const delay = this.delayOn.get(n);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const failure = this.failOn.get(n);
    if (failure) throw failure;
    return { ...(await super.generateNarration(req)), ...this.alterOn.get(n) };
  }
}

/** Memory storage whose writes fail on cue. */
class FlakyStorage implements StorageProvider {
  private readonly inner = new MockStorageProvider();
  readonly info = this.inner.info;
  puts: string[] = [];
  failOn = new Map<number, ProviderError>();
  async put(key: string, body: Uint8Array | string, opts: PutOptions): Promise<StoredObject> {
    this.puts.push(key);
    const failure = this.failOn.get(this.puts.length);
    if (failure) throw failure;
    return this.inner.put(key, body, opts);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
  delete(key: string) {
    return this.inner.delete(key);
  }
  list(prefix: string) {
    return this.inner.list(prefix);
  }
  getSignedUrl(key: string, opts?: SignedUrlOptions) {
    return this.inner.getSignedUrl(key, opts);
  }
}

/** The test database with one method of a model failing on cue (`times` times), as a dropped connection would. */
function failing(model: 'voiceRun' | 'voiceGeneration', method: string, when: (args: any) => boolean, times = Number.POSITIVE_INFINITY): Database {
  let left = times;
  const wrap = (target: object) =>
    new Proxy(target, {
      get(m, key) {
        const fn = Reflect.get(m, key) as unknown;
        if (typeof fn !== 'function') return fn;
        if (key !== method) return fn.bind(m);
        return (args: unknown) => {
          if (left <= 0 || !when(args)) return fn.call(m, args);
          left--;
          return Promise.reject(new Error(`connection lost during ${model}.${method}`));
        };
      },
    });
  return new Proxy(db, {
    get(t, key) {
      const v = Reflect.get(t, key) as unknown;
      if (key === model) return wrap(v as object);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function setup(o: { voice?: ScriptedVoice; storage?: StorageProvider; stage?: Partial<VoiceStageConfig>; runnerDb?: Database } = {}) {
  const voice = o.voice ?? new ScriptedVoice();
  const ai = new FakeScriptAI();
  const providers: ProviderSet = { ...createProviders(ALL_MOCK), ai, voice, ...(o.storage ? { storage: o.storage } : {}) };
  const projects = new ProjectService({ db, gateHooks: { VOICE: voiceGate() } });
  const log = new CaptureLogger();
  const newRunner = (extra: Partial<JobRunnerOptions> = {}) =>
    new JobRunner({
      db: o.runnerDb ?? db,
      queue: new PostgresJobQueue(db),
      projects,
      providers,
      logger: log,
      handlers: { ...createMockStageHandlers(), STORY_MINING: createStoryMiningStage(), STORY_ARCHITECTURE: createStoryArchitectureStage(), SCRIPT: createScriptStage(), VOICE: createVoiceStage({ concurrency: 1, storeRetryDelayMs: 0, ...o.stage }) },
      retryBaseDelayMs: 0,
      ...extra,
    });
  const service = new VoiceService({ db, projects, providers, config: { confirmCharacters: 3000, maxCharacters: 40_000 } });
  return { ai, voice, providers, projects, log, newRunner, runner: newRunner(), service };
}
type Setup = ReturnType<typeof setup>;

const SIX = ['The Semper Augustus price', 'The ruin that never happened', 'Proefman in court', 'The tavern colleges', 'Striped tulips', 'The courts step back'];
const AUDITION = { kind: 'AUDITION', seconds: 60 } as const;

async function run(s: Setup, projectId: string, type: JobType) {
  const job = await s.projects.enqueueJob(projectId, { type }, 'editor');
  await s.runner.drain();
  return db.job.findUniqueOrThrow({ where: { id: job.id } });
}

/** A project whose script v1 is approved (synthetic dossier, fake model). */
async function approvedScript(s: Setup): Promise<string> {
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
  await s.projects.generateScript(p.id, {}, 'editor');
  await s.runner.drain();
  await s.projects.recordApproval(p.id, { gate: 'SCRIPT', decision: 'APPROVED' }, 'editor');
  return p.id;
}

const runOf = (projectId: string, number: number) =>
  db.voiceRun.findUniqueOrThrow({
    where: { projectId_number: { projectId, number } },
    include: { script: { select: { version: true } }, chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: { include: { providerCall: true } } } } },
  });
const takesOf = (chunkId: string) => db.voiceGeneration.findMany({ where: { chunkId }, orderBy: { generation: 'asc' } });
const latestAssembly = (runId: string) => db.voiceAssembly.findFirst({ where: { runId }, orderBy: { version: 'desc' } });
const voiceJob = (projectId: string) => db.job.findFirstOrThrow({ where: { projectId, type: 'VOICE' }, orderBy: { createdAt: 'desc' } });

describe('voice stage (MOCK voice, real database)', () => {
  it('makes each new take its chunk’s current take to review, ledgers what was sent, sends context as spoken, and logs the run', async () => {
    const s = setup({ stage: { concurrency: 2 } });
    const projectId = await approvedScript(s);
    // The fixture's narration has no figures: section 2 gets some, as the real script has.
    for (const b of await db.scriptBlock.findMany({ where: { script: { projectId, status: 'APPROVED' }, blockKey: { startsWith: '2.' } } })) {
      await db.scriptBlock.update({ where: { id: b.id }, data: { text: `${b.text} It cost 1,200 guilders in 1637.` } });
    }
    const { run: number } = await s.service.createRun(projectId, { scope: { kind: 'AUDITION', seconds: 300 } }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    const job = await voiceJob(projectId);
    expect(job.status).toBe('SUCCEEDED');

    for (const c of run.chunks) {
      const take = c.current!;
      expect(take).toMatchObject({ status: 'IN_REVIEW', generation: 1, variant: null, jobId: job.id });
      expect(take.performanceTextHash).toBe(sha256(take.performanceText!));
      expect(take.providerCall!.request).toMatchObject({
        runId: run.id,
        scriptId: run.scriptId,
        scriptVersion: run.script.version,
        sectionKey: c.sectionKey,
        blockKeys: c.blockKeys,
        chunkId: c.id,
        chunk: c.chunkIndex + 1,
        generationId: take.id,
        take: 1,
        variant: null,
        textHash: c.textHash,
        performanceTextHash: take.performanceTextHash,
        jobAttempt: 1,
      });
      expect(take.providerCall!.response).toHaveProperty('dictionary', null);
    }

    // Neighbouring context is heard as spoken (figures in words), like the chunk itself: the written neighbours had figures.
    const neighbour = (c: (typeof run.chunks)[number], d: number) => run.chunks.find((x) => x.chunkIndex === c.chunkIndex + d && x.sectionKey === c.sectionKey);
    const written = run.chunks.flatMap((c) => [tailSentences(neighbour(c, -1)?.sourceText.replace(/\n/g, ' ') ?? '', 200), headSentences(neighbour(c, 1)?.sourceText.replace(/\n/g, ' ') ?? '', 120)]);
    expect(written.some((t) => !!t && /\d/.test(t))).toBe(true);
    const heard = s.voice.calls.flatMap((c) => [c.previousText, c.nextText]).filter((t): t is string => !!t);
    expect(heard).toHaveLength(written.filter((t) => !!t).length);
    expect(heard.filter((t) => /\d/.test(t))).toEqual([]);
    expect(heard.some((t) => t.includes('one thousand two hundred guilders in sixteen thirty-seven'))).toBe(true);

    // The log: a line per chunk and one for the run, from what is stored.
    const chunkLines = s.log.of('voice chunk').filter((l) => l.jobId === job.id);
    expect(chunkLines.map((l) => l.chunk)).toEqual(run.chunks.map((c) => c.chunkIndex + 1));
    const first = run.chunks[0]!;
    expect(chunkLines[0]).toMatchObject({
      runId: run.id,
      run: number,
      chunkId: first.id,
      sectionKey: first.sectionKey,
      blockKeys: first.blockKeys,
      words: first.words,
      characters: first.current!.characters,
      take: { id: first.current!.id, generation: 1, status: 'IN_REVIEW', current: true, strategy: 'RESTRAINED', performanceText: first.current!.performanceText, durationMs: first.current!.durationMs, alignment: { source: 'MOCK', unmatchedWords: 0 }, cost: { ledgerId: first.current!.providerCallId, status: 'SUCCEEDED', basis: 'MOCK' } },
    });
    expect(chunkLines[0].estimatedSec).toBeGreaterThan(0);
    expect(chunkLines[0].take.alignment.characters).toBeGreaterThan(0);
    expect(chunkLines[0].take.alignment.words).toBeGreaterThan(0);

    const [summary] = s.log.of('voice run summary').filter((l) => l.jobId === job.id);
    const durations = run.chunks.map((c) => c.current!.durationMs!);
    expect(summary).toMatchObject({
      runId: run.id,
      run: number,
      kind: 'AUDITION',
      experiment: null,
      script: { id: run.scriptId, version: 1 },
      strategy: 'RESTRAINED',
      chunking: { minWords: 20, maxWords: 30 },
      context: { previousChars: 200, nextChars: 120, stitch: false },
      profile: { version: 1 },
      provider: 'mock',
      model: 'mock',
      voiceId: 'mock-narrator-deep',
      outputFormat: 'wav_22050',
      chunks: run.chunks.length,
      job: { takes: run.chunks.length, characters: run.chunks.reduce((n, c) => n + c.current!.characters!, 0) },
      costBases: ['MOCK'],
      withTimestamps: run.chunks.length,
      durations: { totalMs: durations.reduce((n, d) => n + d, 0), shortestMs: Math.min(...durations), longestMs: Math.max(...durations) },
      stopped: null,
    });
    expect(summary.takes).toEqual({ IN_REVIEW: run.chunks.length });
    expect(summary.qa.blocking).toMatchObject({ TAKE_UNREVIEWED: run.chunks.length });
    expect(summary.pronunciation.unresolved).toEqual(expect.any(Array));
    const assembly = await latestAssembly(run.id);
    expect(summary.assembly).toEqual({ id: assembly!.id, version: 1, status: assembly!.status, totalDurationMs: assembly!.totalDurationMs, complete: false });
    expect(job.result).toMatchObject({ kind: 'RUN', runs: [{ runId: run.id, run: number }], generated: run.chunks.length, failed: 0 });
  });

  it('stores paid audio again after a transient storage failure, inside the job', async () => {
    const storage = new FlakyStorage();
    storage.failOn.set(1, new ProviderError('s3', 'PUT projects/x.wav: HTTP 503 SlowDown: Please reduce your request rate', true, { status: 503 }));
    const s = setup({ storage });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    expect((await voiceJob(projectId)).status).toBe('SUCCEEDED');
    // One request per chunk; the first chunk's audio written twice (the same key), not bought twice.
    expect(s.voice.calls).toHaveLength(run.chunks.length);
    expect(storage.puts).toHaveLength(run.chunks.length + 1);
    expect(storage.puts[0]).toBe(storage.puts[1]);
    expect(run.chunks.every((c) => c.current?.status === 'IN_REVIEW')).toBe(true);
  });

  it('fails a take whose audio storage refuses (ledger kept), stops before paying for more, still reassembles, and a retry never sends it again', async () => {
    const storage = new FlakyStorage();
    storage.failOn.set(2, new ProviderError('s3', 'PUT projects/x.wav: HTTP 403 AccessDenied: Access Denied', false, { status: 403 }));
    const s = setup({ storage });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    let run = await runOf(projectId, number);
    expect(run.chunks.length).toBeGreaterThanOrEqual(3);
    const job = await voiceJob(projectId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/Voice run \d+ stopped: storage refused the audio \(HTTP 403\)/);
    expect(s.voice.calls).toHaveLength(2);

    const [, second, ...rest] = run.chunks;
    expect(run.chunks[0]!.current).toMatchObject({ status: 'IN_REVIEW' });
    const [lost] = await takesOf(second!.id);
    expect(lost).toMatchObject({ status: 'FAILED', audioAssetId: null });
    expect(second!.current).toBeNull();
    expect(lost!.error).toMatch(/^Storage failed: .*HTTP 403 AccessDenied/);
    expect(VoiceQaFinding.array().parse(lost!.qa)).toEqual([expect.objectContaining({ kind: 'STORAGE_FAILED', severity: 'BLOCKING', ref: `#2` })]);
    const ledger = await db.providerCall.findUniqueOrThrow({ where: { id: lost!.providerCallId! } });
    expect(ledger).toMatchObject({ status: 'SUCCEEDED', costBasis: 'MOCK' });
    for (const c of rest) expect((await takesOf(c.id)).map((t) => t.status)).toEqual(['PENDING']);
    // Rebuilt after the stop: the take made before it is heard.
    const assembly = await latestAssembly(run.id);
    expect((assembly!.entries as { generationId: string }[]).map((e) => e.generationId)).toEqual([run.chunks[0]!.current!.id]);
    expect(s.log.of('voice run summary').at(-1)).toMatchObject({ runId: run.id, stopped: expect.stringMatching(/storage refused the audio/) });

    // A retry generates what was never tried; the paid-for, lost take is not sent again.
    await s.projects.retryJob(job.id, 'editor');
    await s.runner.drain();
    run = await runOf(projectId, number);
    expect(s.voice.calls).toHaveLength(run.chunks.length);
    expect((await takesOf(second!.id)).map((t) => t.status)).toEqual(['FAILED']);
    expect(rest.every((c) => run.chunks.find((x) => x.id === c.id)!.current?.status === 'IN_REVIEW')).toBe(true);
  });

  it('closes a take whose audio came back but could not be kept, and stops: no retry of the job buys it again', async () => {
    const voice = new ScriptedVoice();
    // Call 2's audio is stored, then its take cannot be committed (a duration the database refuses): a fault after the paid request.
    voice.alterOn.set(2, { durationMs: 2 ** 31 });
    const storage = new FlakyStorage();
    const s = setup({ voice, storage });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    let run = await runOf(projectId, number);
    const job = await voiceJob(projectId);
    expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(job.error).toMatch(/Voice run \d+ stopped: take 1 of chunk 2 came back but could not be kept, and a retry would buy it again/);
    expect(s.voice.calls).toHaveLength(2);

    const [, second, ...rest] = run.chunks;
    const [lost] = await takesOf(second!.id);
    expect(lost).toMatchObject({ status: 'FAILED', audioAssetId: null });
    // The paid audio is where the error says: it can still be recovered by hand.
    expect(lost!.error!.startsWith(`Not kept after the audio came back (paid for; stored at ${storage.puts[1]}): `)).toBe(true);
    expect(await storage.head(storage.puts[1]!)).not.toBeNull();
    expect(await db.providerCall.findUniqueOrThrow({ where: { id: lost!.providerCallId! } })).toMatchObject({ status: 'SUCCEEDED' });
    for (const c of rest) expect((await takesOf(c.id)).map((t) => t.status)).toEqual(['PENDING']);
    expect(((await latestAssembly(run.id))!.entries as { generationId: string }[]).map((e) => e.generationId)).toEqual([run.chunks[0]!.current!.id]);

    await s.projects.retryJob(job.id, 'editor');
    await s.runner.drain();
    run = await runOf(projectId, number);
    expect(s.voice.calls).toHaveLength(run.chunks.length);
    expect((await takesOf(second!.id)).map((t) => t.status)).toEqual(['FAILED']);
    expect(rest.every((c) => run.chunks.find((x) => x.id === c.id)!.current?.status === 'IN_REVIEW')).toBe(true);
  });

  it('closes a take caught mid-request as FAILED and generates the chunk’s next generation in its place, never re-sending the same row', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    const target = run.chunks[1]!;
    const first = target.current!;

    // A regeneration whose take was caught mid-request by an attempt that did not finish.
    const { job } = await s.service.regenerate(run.id, { chunkIds: [target.id] }, 'editor');
    const [, caught] = await takesOf(target.id);
    await db.voiceGeneration.update({ where: { id: caught!.id }, data: { status: 'GENERATING', jobId: job.id } });
    const calls = s.voice.calls.length;
    await s.runner.drain();
    let takes = await takesOf(target.id);
    expect(takes.map((t) => [t.generation, t.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'FAILED'],
      [3, 'IN_REVIEW'],
    ]);
    expect(takes[1]!.error).toMatch(/^Interrupted mid-request/);
    expect(takes[2]).toMatchObject({ strategy: caught!.strategy, variant: caught!.variant, jobId: job.id });
    expect(s.voice.calls.length).toBe(calls + 1);
    expect((await db.voiceChunk.findUniqueOrThrow({ where: { id: target.id } })).currentGenerationId).toBe(takes[2]!.id);

    // What the regeneration changed, against the run as it was.
    const regen = s.log.of('voice regeneration summary').at(-1);
    expect(regen).toMatchObject({
      runId: run.id,
      jobId: job.id,
      regenerated: 1,
      otherChunks: run.chunks.length - 1,
      unchangedOthers: run.chunks.length - 1,
      othersIntact: true,
      assembly: { before: { version: 1 }, after: { version: 2 } },
    });
    expect(regen.chunks).toEqual([
      expect.objectContaining({
        chunk: 2,
        previous: { takeId: first.id, generation: 1, durationMs: first.durationMs },
        takes: [expect.objectContaining({ generation: 2, status: 'FAILED', current: false }), expect.objectContaining({ generation: 3, status: 'IN_REVIEW', current: true, durationMs: takes[2]!.durationMs, alignment: expect.objectContaining({ source: 'MOCK' }) })],
      }),
    ]);

    // Interrupted again after the replacement was made: the job still finds it (a later generation of its chunk).
    const again = await s.service.regenerate(run.id, { chunkIds: [target.id] }, 'editor');
    const listed = (await takesOf(target.id)).at(-1)!;
    await db.voiceGeneration.update({ where: { id: listed.id }, data: { status: 'FAILED', jobId: again.job.id } });
    const replacement = await db.voiceGeneration.create({
      data: { chunkId: target.id, runId: run.id, projectId, generation: listed.generation + 1, status: 'PENDING', profileId: listed.profileId, provider: listed.provider, model: listed.model, voiceId: listed.voiceId, strategy: listed.strategy, canonicalText: listed.canonicalText, textHash: listed.textHash },
    });
    await s.runner.drain();
    takes = await takesOf(target.id);
    expect(takes.find((t) => t.id === replacement.id)).toMatchObject({ status: 'IN_REVIEW' });
    expect(takes.find((t) => t.id === listed.id)).toMatchObject({ status: 'FAILED' });
    expect(s.voice.calls.length).toBe(calls + 2);
  });

  it('hands a job interrupted by a shutdown back to the queue, untried takes pending, and replaces the take caught mid-request', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    const runner = s.newRunner({ pollIntervalMs: 5 });
    // The second request is cut off by the shutdown (as a real provider reports a cancelled request).
    s.voice.failOn.set(2, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: cancelled', false));
    const stopped = new Promise<void>((resolve) => {
      s.voice.onCall = (n) => {
        if (n === 2) void runner.stop().then(resolve);
      };
    });
    runner.start();
    await stopped;

    let run = await runOf(projectId, number);
    const job = await voiceJob(projectId);
    expect(job).toMatchObject({ status: 'QUEUED', attempts: 0 });
    const [one, two, ...rest] = run.chunks;
    expect(one!.current).toMatchObject({ status: 'IN_REVIEW' });
    const [caught] = await takesOf(two!.id);
    expect(caught).toMatchObject({ status: 'GENERATING', jobId: job.id });
    expect(await db.providerCall.findUniqueOrThrow({ where: { id: caught!.providerCallId! } })).toMatchObject({ status: 'FAILED' });
    for (const c of rest) expect((await takesOf(c.id)).map((t) => t.status)).toEqual(['PENDING']);
    expect(((await latestAssembly(run.id))!.entries as unknown[]).length).toBe(1);
    expect(s.log.of('voice run summary').at(-1)).toMatchObject({ stopped: expect.stringMatching(/interrupted/) });

    s.voice.onCall = null;
    await s.newRunner().drain();
    run = await runOf(projectId, number);
    expect((await voiceJob(projectId)).status).toBe('SUCCEEDED');
    expect((await takesOf(two!.id)).map((t) => [t.generation, t.status])).toEqual([
      [1, 'FAILED'],
      [2, 'IN_REVIEW'],
    ]);
    expect(run.chunks.every((c) => c.current?.status === 'IN_REVIEW')).toBe(true);
    expect(s.voice.calls).toHaveLength(run.chunks.length + 1);
  });

  it('stops on an error no take would get past — by the provider’s status, not its wording — and still reassembles the takes made before', async () => {
    const voice = new ScriptedVoice();
    voice.failOn.set(2, new ProviderError('elevenlabs', '/v1/text-to-speech/x/with-timestamps: HTTP 422: text_too_long: too long', false, { status: 422 }));
    voice.failOn.set(4, new ProviderError('elevenlabs', 'invalid_api_key: Invalid API key', false, { status: 401 }));
    const s = setup({ voice });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    expect(run.chunks.length).toBeGreaterThanOrEqual(5);
    const job = await voiceJob(projectId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/Voice run \d+ stopped: the voice provider answered HTTP 401, which no other take would get past: \[elevenlabs\] invalid_api_key/);
    expect(s.voice.calls).toHaveLength(4);
    expect(run.chunks.map((c) => c.current?.status ?? null).slice(0, 4)).toEqual(['IN_REVIEW', null, 'IN_REVIEW', null]);
    expect((await takesOf(run.chunks[4]!.id)).map((t) => t.status)).toEqual(['PENDING']);
    const assembly = await latestAssembly(run.id);
    expect((assembly!.entries as { chunkIndex: number }[]).map((e) => e.chunkIndex)).toEqual([0, 2]);
  });

  it('lets a paid request already in flight finish (and keeps its take) before a stop ends the job', async () => {
    const voice = new ScriptedVoice();
    voice.delayOn.set(1, 500);
    voice.failOn.set(2, new ProviderError('elevenlabs', 'quota_exceeded: no credits left', false, { status: 402 }));
    const s = setup({ voice, stage: { concurrency: 2 } });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    expect((await voiceJob(projectId)).error).toMatch(/stopped: the voice provider answered HTTP 402/);
    expect(s.voice.calls).toHaveLength(2);
    const takes = await db.voiceGeneration.findMany({ where: { runId: run.id } });
    expect(takes.filter((t) => t.status === 'GENERATING')).toEqual([]);
    expect(takes.map((t) => t.status).sort()).toEqual(['FAILED', 'IN_REVIEW', ...Array<string>(run.chunks.length - 2).fill('PENDING')].sort());
    expect(((await latestAssembly(run.id))!.entries as unknown[]).length).toBe(1);
  });

  it('keeps a job whose takes are all committed when its log cannot be read back', async () => {
    // The run summary's read fails every time (the assembly's read of the run does not).
    const s = setup({ runnerDb: failing('voiceRun', 'findUniqueOrThrow', (args: { include?: { generations?: unknown } }) => !!args.include?.generations) });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    const job = await voiceJob(projectId);
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(run.chunks.every((c) => c.current?.status === 'IN_REVIEW')).toBe(true);
    expect((await latestAssembly(run.id))!.version).toBe(1);
    expect(s.log.of('voice run not summarized')).toEqual([expect.objectContaining({ jobId: job.id, runId: run.id, err: expect.stringMatching(/connection lost/) })]);
    expect(s.log.of('voice run summary').filter((l) => l.jobId === job.id)).toEqual([]);
  });

  it('never loses an error raised beside a take: the job is retried and every take is accounted for', async () => {
    // Recording a take that the character ceiling stopped fails once.
    const ceiling = (args: { data?: { error?: unknown } }) => typeof args.data?.error === 'string' && args.data.error.includes('character ceiling');
    const s = setup({ stage: { maxCharacters: 1 }, runnerDb: failing('voiceGeneration', 'update', ceiling, 1) });
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    const job = await voiceJob(projectId);
    expect(job).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    const takes = await db.voiceGeneration.findMany({ where: { runId: run.id } });
    expect(takes.filter((t) => t.status === 'PENDING' || t.status === 'GENERATING')).toEqual([]);
    // One take per attempt fits under a ceiling of one character; the others are recorded as stopped by it.
    expect(takes.filter((t) => t.status === 'IN_REVIEW')).toHaveLength(2);
    expect(takes.filter((t) => t.status === 'FAILED').every((t) => t.error!.includes('character ceiling'))).toBe(true);
  });

  it('refuses a job whose run is of a script version that is no longer the approved one', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await db.script.updateMany({ where: { projectId, status: 'APPROVED' }, data: { status: 'SUPERSEDED' } });
    await s.runner.drain();
    const job = await voiceJob(projectId);
    expect(job.status).toBe('FAILED');
    expect(job.error).toMatch(/no longer the approved one/);
    expect(s.voice.calls).toHaveLength(0);
  });

  it('keeps A/B variant takes beside the chunk’s current take, never making one current by itself', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { run: number } = await s.service.createRun(projectId, { scope: AUDITION }, 'editor');
    await s.runner.drain();
    const run = await runOf(projectId, number);
    const target = run.chunks[0]!;
    const current = target.current!;
    const variant = (generation: number, label: string, strategy: 'PLAIN' | 'DIRECTED') =>
      db.voiceGeneration.create({
        data: { chunkId: target.id, runId: run.id, projectId, generation, status: 'PENDING', variant: label, profileId: current.profileId, provider: current.provider, model: current.model, voiceId: current.voiceId, strategy, canonicalText: current.canonicalText, textHash: current.textHash },
      });
    const a = await variant(2, 'A', 'PLAIN');
    const b = await variant(3, 'B', 'DIRECTED');
    const job = await s.projects.voiceJob(projectId, 'editor', 'A/B (test)', async () => ({ runIds: [run.id], generationIds: [a.id, b.id] }));
    await s.runner.drain();

    expect((await takesOf(target.id)).map((t) => [t.generation, t.status, t.variant])).toEqual([
      [1, 'IN_REVIEW', null],
      [2, 'GENERATED', 'A'],
      [3, 'GENERATED', 'B'],
    ]);
    expect((await db.voiceChunk.findUniqueOrThrow({ where: { id: target.id } })).currentGenerationId).toBe(current.id);
    expect((await latestAssembly(run.id))!.version).toBe(1);
    const regen = s.log.of('voice regeneration summary').find((l) => l.jobId === job.id);
    expect(regen).toMatchObject({ regenerated: 1, othersIntact: true, assembly: { before: { version: 1 }, after: { version: 1 } } });
    expect(regen.chunks[0].takes.map((t: { variant: string; current: boolean }) => [t.variant, t.current])).toEqual([
      ['A', false],
      ['B', false],
    ]);
  });

  it('runs each variant of the acceptance experiment with its own strategy, context and chunking, and logs the comparison', async () => {
    const s = setup();
    const projectId = await approvedScript(s);
    const { runs, job } = await s.service.createExperiment(projectId, { ...VOICE_ACCEPTANCE_EXPERIMENT, confirm: true }, 'editor');
    await s.runner.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    const byLabel = new Map<string, Awaited<ReturnType<typeof runOf>>>();
    for (const n of runs) {
      const r = await runOf(projectId, n);
      byLabel.set(r.variant!, r);
    }
    expect([...byLabel.keys()]).toEqual(VOICE_ACCEPTANCE_EXPERIMENT.variants.map((v) => v.label));
    for (const v of VOICE_ACCEPTANCE_EXPERIMENT.variants) {
      const r = byLabel.get(v.label)!;
      expect(r.chunks.every((c) => c.current?.strategy === v.strategy && (c.current.prepared as { strategy: string }).strategy === v.strategy)).toBe(true);
      const sent = r.chunks.map((c) => (c.current!.providerCall!.request as { context: { previous: number; next: number } }).context);
      if (v.context.previousChars === 0) expect(sent.every((x) => x.previous === 0 && x.next === 0)).toBe(true);
      else expect(sent.some((x) => x.previous > 0)).toBe(true);
    }
    const chunks = (label: string) => byLabel.get(label)!.chunks.length;
    expect(chunks('F 5–8 s chunks')).toBeGreaterThan(chunks('G 12–20 s chunks'));
    expect(chunks('F 5–8 s chunks')).toBeGreaterThanOrEqual(chunks('B restrained'));
    expect(chunks('B restrained')).toBeGreaterThanOrEqual(chunks('G 12–20 s chunks'));

    const lines = s.log.of('voice run summary').filter((l) => l.jobId === job.id);
    expect(lines.map((l) => l.variant)).toEqual([...byLabel.keys()]);
    expect(lines.every((l) => l.experiment === VOICE_ACCEPTANCE_EXPERIMENT.name)).toBe(true);
    const [comparison] = s.log.of('voice experiment comparison').filter((l) => l.jobId === job.id);
    expect(comparison.rows.map((r: { variant: string; strategy: string; context: string; chunking: string }) => [r.variant, r.strategy, r.context, r.chunking])).toEqual([
      ['A plain', 'PLAIN', 'previous 200 / next 120 chars', '20–30 words'],
      ['B restrained', 'RESTRAINED', 'previous 200 / next 120 chars', '20–30 words'],
      ['C expressive', 'EXPRESSIVE', 'previous 200 / next 120 chars', '20–30 words'],
      ['D over-directed', 'DIRECTED', 'previous 200 / next 120 chars', '20–30 words'],
      ['E no context', 'RESTRAINED', 'none', '20–30 words'],
      ['F 5–8 s chunks', 'RESTRAINED', 'previous 200 / next 120 chars', '13–20 words'],
      ['G 12–20 s chunks', 'RESTRAINED', 'previous 200 / next 120 chars', '30–50 words'],
    ]);
    expect(comparison.rows.every((r: { totalMs: number; characters: number }) => r.totalMs > 0 && r.characters > 0)).toBe(true);
    expect(comparison.table).toHaveLength(7);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).result).toMatchObject({ kind: 'EXPERIMENT' });
  });
});
