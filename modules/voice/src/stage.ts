import { createHash, randomUUID } from 'node:crypto';
import { DirectorMark, type VoiceQaFinding, type VoiceTakeConfig } from '@docengine/core';
import type { Prisma, VoiceChunk, VoiceGeneration, VoiceGenerationStatus, VoiceRun } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError, buildAssetKey, type NarrationResult, type PutOptions, type StorageProvider } from '@docengine/providers';
import { z } from 'zod';
import { alignTake } from './alignment.ts';
import { describeOverrides, profileLabel, runConfig, takeConfig, takeSource, type ProfileRow } from './config.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';
import { rulesFor } from './pronunciation.ts';
import { takeQa } from './qa.ts';
import { headSentences, lexicon, readPerformance, readSpans, rebuildAssembly, seedFor, tailSentences } from './runs.ts';
import { approvedScript, loadScriptForVoice, type VoiceScript } from './script.ts';
import { toSpoken } from './spoken.ts';
import { comparisonRow, comparisonText, snapshotRun, summarizeRegeneration, summarizeRun, type RunLine, type RunSnapshot } from './summary.ts';
import { sentenceSpans, sha256 } from './text.ts';

/**
 * The VOICE job: generates the pending takes of one or more voice runs, one
 * small chunk per request. For each take, with the configuration it records
 * (the run's, the production profile, or a temporary override): the
 * derived text is prepared and checked (nothing failing a check is sent),
 * the provider is called through
 * the ledger, the audio is stored, its timestamps are mapped to the script's
 * words, the take is checked, and it becomes its chunk's current take, to
 * review (the one before is superseded, never deleted; an A/B variant take
 * is kept beside it instead). Then each run's assembly is rebuilt on the
 * measured clock — also when the run stopped — and the job is logged.
 */

export interface VoiceStageConfig {
  /** Hard ceiling on the characters one job may send. */
  maxCharacters: number;
  /** Takes generated at the same time (1 when stitching). */
  concurrency: number;
  /** Wait before storing a take's audio again after a transient failure (times the attempt). */
  storeRetryDelayMs: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceStageConfig = { maxCharacters: 40_000, concurrency: 2, storeRetryDelayMs: 1_000 };

export const VoiceJobInput = z.object({ runIds: z.array(z.string()).min(1), generationIds: z.array(z.string()).optional() });
export type VoiceJobInput = z.infer<typeof VoiceJobInput>;

/** Request stitching only reaches back this far (ElevenLabs: two hours). */
const STITCH_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Attempts at storing a take's audio: it is paid for, so a transient failure is retried here, not by re-running the job (which would buy it again). */
const STORE_ATTEMPTS = 3;

/** HTTP statuses no other request would get past: a rejected key, no credits, no access, an unknown voice, model or bucket. */
const FATAL_STATUS = new Set([401, 402, 403, 404]);

/** A current take of these is superseded by a newer one. */
const SUPERSEDABLE = new Set<VoiceGenerationStatus>(['IN_REVIEW', 'GENERATED', 'APPROVED']);

type ChunkWithTakes = VoiceChunk & { current: VoiceGeneration | null };
type RunRow = VoiceRun & { profile: ProfileRow };
/** A take to generate, with what it is made with (stored on it, or its run's for a take made before saved profiles). */
type Take = VoiceGeneration & { chunk: ChunkWithTakes; run: RunRow; made: VoiceTakeConfig };

interface Tally {
  generated: number;
  failed: number;
  characters: number;
}

/** A regeneration (chosen takes), a comparison (runs of one experiment) or a run. */
type JobKind = 'REGENERATION' | 'EXPERIMENT' | 'RUN';

/** The job was interrupted (a shutdown): the runner hands it back to the queue. */
class Interrupted extends Error {
  constructor() {
    super('Voice job interrupted: untried takes stay pending, and a take caught mid-request is replaced on the next attempt');
    this.name = 'Interrupted';
  }
}

export function createVoiceStage(config: Partial<VoiceStageConfig> = {}): StageHandler {
  const cfg = { ...DEFAULT_VOICE_CONFIG, ...config };
  return {
    type: 'VOICE',
    mock: false,
    async run(ctx) {
      const input = VoiceJobInput.safeParse(ctx.job.input);
      if (!input.success) throw new NonRetryableError(`Invalid voice job input: ${input.error.message}`);
      const { voice, storage } = ctx.providers;
      if (!voice.info.mock && storage.info.mock) {
        throw new NonRetryableError('Real narration needs durable storage: the configured storage is in memory (STORAGE_PROVIDER=mock) and would lose paid audio on restart. Set STORAGE_PROVIDER=s3 with a bucket.');
      }
      const runs = await ctx.db.voiceRun.findMany({ where: { id: { in: input.data.runIds }, projectId: ctx.project.id }, include: { profile: { include: { family: true } } }, orderBy: { number: 'asc' } });
      if (runs.length !== input.data.runIds.length) throw new NonRetryableError('A voice run of this job no longer exists');
      // Narration is made from the approved script only: a job queued or retried after another version was approved stops here.
      const approved = await approvedScript(ctx.db, ctx.project.id);
      for (const run of runs) {
        if (run.profile.provider !== voice.info.name) throw new NonRetryableError(`Voice run ${run.number} uses a ${run.profile.provider} profile; the configured voice provider is ${voice.info.name}`);
        if (!approved || approved.id !== run.scriptId) throw new NonRetryableError(`Voice run ${run.number} was made from a script version that is no longer the approved one: start a new run (stale audio is never reused)`);
      }
      const kind: JobKind = input.data.generationIds ? 'REGENERATION' : runs.length > 1 && runs.every((r) => r.experiment) ? 'EXPERIMENT' : 'RUN';
      const tally: Tally = { generated: 0, failed: 0, characters: 0 };
      const lines: RunLine[] = [];
      let stopped: unknown = null;
      for (const run of runs) {
        const script = await loadScriptForVoice(ctx.db, run.scriptId);
        if (!script) throw new NonRetryableError(`The script of voice run ${run.number} no longer exists`);
        const before = kind === 'REGENERATION' ? await snapshotRun(ctx.db, run.id) : null;
        try {
          await generateRun(ctx, run, script, input.data.generationIds ?? null, cfg, tally);
        } catch (err) {
          stopped = err;
        }
        // Whatever happened, the assembly is rebuilt from the current takes (those made before a stop are kept) and the run is logged.
        try {
          await rebuildAssembly(ctx.db, run.id, script, 'system');
        } catch (err) {
          if (!stopped) throw err;
          ctx.logger.error({ runId: run.id, err: reason(err) }, 'voice run not reassembled after it stopped');
        }
        // The log reads the run back; a failure there never fails a job whose takes are kept (a retry would only fail again).
        try {
          lines.push(await logRun(ctx, run.id, before, stopped));
        } catch (err) {
          ctx.logger.error({ runId: run.id, err: reason(err) }, 'voice run not summarized');
        }
        if (stopped) break;
      }
      if (kind === 'EXPERIMENT') {
        const rows = lines.map(comparisonRow);
        ctx.logger.info({ experiment: runs[0]!.experiment, variants: runs.length, rows, table: rows.map(comparisonText), stopped: stopped ? reason(stopped) : null }, 'voice experiment comparison');
      }
      if (stopped) throw stopped;
      if (tally.generated === 0 && tally.failed > 0) throw new NonRetryableError(`No take could be generated (${tally.failed} failed): see each take's error`);
      return { kind, runs: lines, generated: tally.generated, failed: tally.failed, characters: tally.characters, mock: voice.info.mock };
    },
  };
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The run's lines (each chunk, the run, and what a regeneration changed) on the job's logger. */
async function logRun(ctx: StageContext, runId: string, before: RunSnapshot | null, stopped: unknown): Promise<RunLine> {
  const { run, chunks } = await summarizeRun(ctx.db, ctx.providers.voice, runId, ctx.job.id, stopped ? reason(stopped) : null);
  for (const c of chunks) ctx.logger.info(c, 'voice chunk');
  ctx.logger.info(run, 'voice run summary');
  if (before) ctx.logger.info(await summarizeRegeneration(ctx.db, ctx.providers.voice, before, ctx.job.id), 'voice regeneration summary');
  return run;
}

/** Whether a take's configuration stitches requests (its context asks for it and its model can). */
const stitches = (ctx: StageContext, t: Take) => t.made.effective.context.stitch && ctx.providers.voice.capabilities(t.made.effective.model).stitching;

async function generateRun(ctx: StageContext, run: RunRow, script: VoiceScript, only: readonly string[] | null, cfg: VoiceStageConfig, tally: Tally): Promise<void> {
  const { voice } = ctx.providers;
  const chunks = await ctx.db.voiceChunk.findMany({ where: { runId: run.id }, orderBy: { chunkIndex: 'asc' }, include: { current: true } });
  const open = await openTakes(ctx, run.id, only);
  const config = runConfig(run, voice);
  const takes: Take[] = [];
  for (const g of open) {
    const take = g.status === 'GENERATING' ? await replaceInterrupted(ctx, g) : g;
    takes.push({ ...take, chunk: chunks.find((c) => c.id === take.chunkId)!, run, made: takeConfig(take, config) });
  }
  takes.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
  if (!takes.length) return;
  for (const t of takes) {
    if (t.made.effective.provider !== voice.info.name) throw new NonRetryableError(`Voice run ${run.number}: take ${t.generation} of chunk ${t.chunk.chunkIndex + 1} is made with a ${t.made.effective.provider} profile; the configured voice provider is ${voice.info.name}`);
  }
  // One worker when any take stitches: each then follows the one before it.
  const stitching = takes.some((t) => stitches(ctx, t));
  const words = await lexicon(ctx.db, run.projectId, config.effective.language);
  const models = [...new Set(takes.map((t) => `${t.made.effective.provider} ${t.made.effective.model}`))].join(', ');
  await ctx.progress(`Voice run ${run.number}: generating ${takes.length} take(s) with ${models}${voice.info.mock ? ' (MOCK)' : ''}`, { run: run.number, takes: takes.length });

  let next = 0;
  // The first error stops every worker: a fatal one, an unexpected one, or the job being interrupted.
  let halt: unknown = null;
  const worker = async () => {
    while (!halt && next < takes.length) {
      if (ctx.signal.aborted) {
        halt = new Interrupted();
        break;
      }
      const take = takes[next++]!;
      try {
        if (tally.characters >= cfg.maxCharacters) {
          await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', jobId: ctx.job.id, error: `Not generated: the job's character ceiling (VOICE_MAX_CHARACTERS=${cfg.maxCharacters}) was reached`, completedAt: new Date() } });
          tally.failed++;
          continue;
        }
        await generateTake(ctx, take, chunks, script, words, cfg, tally);
      } catch (err) {
        halt ??= err;
      }
    }
  };
  await Promise.allSettled(Array.from({ length: stitching ? 1 : Math.max(1, cfg.concurrency) }, worker));
  if (ctx.signal.aborted) throw halt instanceof Interrupted ? halt : new Interrupted();
  if (halt instanceof NonRetryableError) throw new NonRetryableError(`Voice run ${run.number} stopped: ${halt.message}`);
  if (halt) throw halt;
}

/**
 * The takes a job generates: every pending take of the run, or the chosen
 * ones — and, for those, a take that replaced one of them after an
 * interruption (a later generation of the same chunk). A take still
 * GENERATING was caught mid-request by an attempt that did not finish.
 */
async function openTakes(ctx: StageContext, runId: string, only: readonly string[] | null): Promise<(VoiceGeneration & { profile: ProfileRow })[]> {
  const chosen = only ? await ctx.db.voiceGeneration.findMany({ where: { runId, id: { in: [...only] } }, select: { chunkId: true, generation: true } }) : null;
  const floor = new Map<string, number>();
  for (const g of chosen ?? []) floor.set(g.chunkId, Math.min(floor.get(g.chunkId) ?? g.generation, g.generation));
  const open = await ctx.db.voiceGeneration.findMany({
    where: { runId, status: { in: ['PENDING', 'GENERATING'] }, ...(chosen ? { chunkId: { in: [...floor.keys()] } } : {}) },
    orderBy: [{ createdAt: 'asc' }],
    include: { profile: { include: { family: true } } },
  });
  return chosen ? open.filter((g) => g.generation >= floor.get(g.chunkId)!) : open;
}

/**
 * A take left GENERATING by an attempt that did not finish: its request may
 * have reached the provider (and been billed), so it is never sent again on
 * the same row. It is closed as FAILED and the chunk's next generation, with
 * the same configuration, strategy, directions, note and variant, takes its
 * place.
 */
async function replaceInterrupted(ctx: StageContext, g: VoiceGeneration): Promise<VoiceGeneration & { profile: ProfileRow }> {
  return ctx.db.$transaction(async (tx) => {
    await tx.voiceGeneration.update({
      where: { id: g.id },
      data: { status: 'FAILED', error: 'Interrupted mid-request: the voice provider may have received (and billed) it — see the ledger. A new take replaces it.', completedAt: new Date() },
    });
    const last = await tx.voiceGeneration.findFirstOrThrow({ where: { chunkId: g.chunkId }, orderBy: { generation: 'desc' }, select: { generation: true } });
    return tx.voiceGeneration.create({
      data: {
        chunkId: g.chunkId,
        runId: g.runId,
        projectId: g.projectId,
        generation: last.generation + 1,
        status: 'PENDING',
        profileId: g.profileId,
        provider: g.provider,
        model: g.model,
        voiceId: g.voiceId,
        strategy: g.strategy,
        ...(g.config !== null ? { config: g.config as Prisma.InputJsonValue } : {}),
        variant: g.variant,
        canonicalText: g.canonicalText,
        textHash: g.textHash,
        ...(g.directions !== null ? { directions: g.directions as Prisma.InputJsonValue } : {}),
        note: g.note,
        createdBy: g.createdBy,
      },
      include: { profile: { include: { family: true } } },
    });
  });
}

/** Errors no other take would get past, by the provider's HTTP status (never by its wording). */
function isFatal(err: ProviderError): boolean {
  return !err.retryable && err.status !== undefined && FATAL_STATUS.has(err.status);
}

async function generateTake(
  ctx: StageContext,
  take: Take,
  chunks: readonly ChunkWithTakes[],
  script: VoiceScript,
  words: Awaited<ReturnType<typeof lexicon>>,
  cfg: VoiceStageConfig,
  tally: Tally,
): Promise<void> {
  const { voice, storage } = ctx.providers;
  const { run, chunk, made } = take;
  const { effective } = made;
  const { context } = effective;
  const sentences = chunkSentences(chunk);
  const blocks = new Map<string, TakeBlock>([...script.blocks.values()].map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  // The project's approved pronunciations, then the profile's own rules for terms the project has not decided.
  const rules = rulesFor(chunk.sourceText, words, effective.pronunciation.rules);
  const prev = chunks.find((c) => c.chunkIndex === chunk.chunkIndex - 1 && c.sectionKey === chunk.sectionKey);
  const nextChunk = chunks.find((c) => c.chunkIndex === chunk.chunkIndex + 1 && c.sectionKey === chunk.sectionKey);
  // Neighbouring narration is heard as it is spoken (figures and approved aliases in words), like the chunk itself.
  const spoken = (text: string) => toSpoken(text.replace(/\n/g, ' '), { style: effective.numberStyle, aliases: rulesFor(text, words, effective.pronunciation.rules).aliases }).text;
  const previousText = prev ? tailSentences(spoken(prev.sourceText), context.previousChars) : null;
  const nextText = nextChunk ? headSentences(spoken(nextChunk.sourceText), context.nextChars) : null;
  const directions = z.array(DirectorMark).catch([]).parse(take.directions ?? []);
  const prepared = prepareTake({
    chunk: { text: chunk.sourceText, sentences, performance: readPerformance(chunk.performance) },
    blocks,
    strategy: effective.strategy,
    ...(directions.length ? { director: directions } : {}),
    numberStyle: effective.numberStyle,
    aliases: rules.aliases,
    phonemes: rules.phonemes,
    provider: voice,
    model: effective.model,
    settings: effective.providerSettings,
    rules: effective.performanceRules,
    context: { previousText, nextText },
    seed: seedFor(take.textHash, take.generation),
  });
  const characters = prepared.rendered.text.length;
  const performanceTextHash = sha256(prepared.rendered.text);
  await ctx.db.voiceGeneration.update({
    where: { id: take.id },
    data: { status: 'GENERATING', jobId: ctx.job.id, spokenText: prepared.spokenText, performanceText: prepared.rendered.text, performanceTextHash, prepared: prepared.prepared as unknown as Prisma.InputJsonValue, characters },
  });
  if (!prepared.passed) {
    const failed = prepared.prepared.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label}: ${c.detail}`);
    await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: `Not sent — performance checks failed: ${failed.join('; ')}`, completedAt: new Date() } });
    tally.failed++;
    return;
  }

  // Request stitching: the previous chunk's current take, if recent and from the same model.
  const prevTake = prev ? await ctx.db.voiceChunk.findUnique({ where: { id: prev.id }, include: { current: true } }).then((c) => c?.current ?? null) : null;
  const stitchIds = stitches(ctx, take) && prevTake?.providerRequestId && prevTake.model === effective.model && prevTake.completedAt && Date.now() - prevTake.completedAt.getTime() < STITCH_WINDOW_MS ? [prevTake.providerRequestId] : undefined;

  let callId: string | null = null;
  let result: NarrationResult;
  try {
    result = await ctx.callProvider(
      'voice',
      'generateNarration',
      () =>
        voice.generateNarration({
          text: prepared.rendered.text,
          language: effective.language,
          // Every setting with the chunk's pace applied; the provider sends what the model takes.
          settings: { voiceId: effective.voiceId, model: effective.model, provider: prepared.prepared.settings },
          withTimestamps: true,
          ...(previousText ? { previousText } : {}),
          ...(nextText ? { nextText } : {}),
          ...(stitchIds ? { previousRequestIds: stitchIds } : {}),
          outputFormat: effective.outputFormat,
          ...(prepared.prepared.seed !== null ? { seed: prepared.prepared.seed } : {}),
          ...(prepared.phonemes.length ? { pronunciations: prepared.phonemes } : {}),
          signal: ctx.signal,
        }),
      {
        request: {
          runId: run.id,
          run: run.number,
          scriptId: run.scriptId,
          scriptVersion: script.version,
          sectionKey: chunk.sectionKey,
          blockKeys: chunk.blockKeys,
          chunkId: chunk.id,
          chunk: chunk.chunkIndex + 1,
          generationId: take.id,
          take: take.generation,
          variant: take.variant,
          model: effective.model,
          voiceId: effective.voiceId,
          characters,
          strategy: effective.strategy,
          profile: { familyId: made.profile.familyId, family: made.profile.familyName, versionId: made.profile.versionId, version: made.profile.version },
          configuration: { base: made.base, override: made.override },
          textHash: take.textHash,
          performanceTextHash,
          jobAttempt: ctx.job.attempts,
          context: { previous: previousText?.length ?? 0, next: nextText?.length ?? 0, stitched: !!stitchIds },
        },
        summarize: (r) => ({ durationMs: r.durationMs, mimeType: r.mimeType, bytes: r.audio.byteLength, timestamps: !!r.characters, requestId: r.requestId ?? null, dictionary: r.dictionary ?? null }),
        onRecorded: (id) => {
          callId = id;
        },
      },
    );
  } catch (err) {
    if (ctx.signal.aborted) {
      // Left GENERATING, linked to its ledger row: the next attempt closes it and makes a new take.
      await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { providerCallId: callId } });
      throw new Interrupted();
    }
    await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: reason(err), providerCallId: callId, completedAt: new Date() } });
    tally.failed++;
    if (err instanceof ProviderError && isFatal(err)) throw new NonRetryableError(`the voice provider answered HTTP ${err.status}, which no other take would get past: ${err.message}`);
    if (err instanceof ProviderError) return; // this take failed; the others go on
    throw err;
  }
  tally.characters += characters;
  const ext = result.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
  const assetId = randomUUID();
  const key = buildAssetKey({ projectId: ctx.project.id, language: effective.language, kind: 'NARRATION_AUDIO', assetId, ext });
  let stored = false;
  let alignment: ReturnType<typeof alignTake>;
  try {
    // Linked before anything else can fail: the take is paid for.
    await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { providerCallId: callId, providerRequestId: result.requestId ?? null } });
    try {
      await store(storage, key, result.audio, { contentType: result.mimeType, metadata: { take: take.id, chunk: String(chunk.chunkIndex + 1), run: String(run.number) } }, cfg.storeRetryDelayMs);
      stored = true;
    } catch (err) {
      const finding: VoiceQaFinding = { kind: 'STORAGE_FAILED', severity: 'BLOCKING', ref: `#${chunk.chunkIndex + 1}`, detail: `Take ${take.generation}'s audio came back but could not be stored (it was paid for): ${reason(err)}` };
      await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: `Storage failed: ${reason(err)}`, qa: [finding] as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
      tally.failed++;
      // Storage that refuses outright refuses every take: stop before paying for more audio that cannot be kept.
      if (!(err instanceof ProviderError && err.retryable)) throw new NonRetryableError(`storage refused the audio${err instanceof ProviderError && err.status ? ` (HTTP ${err.status})` : ''}, so no other take could be kept: ${reason(err)}`);
      return;
    }
    alignment = alignTake({
      canonical: chunk.sourceText,
      forms: prepared.prepared.spokenForms,
      canonicalSentences: sentences,
      spokenSentences: prepared.spokenSentences,
      rendered: prepared.rendered,
      characters: result.characters,
      mock: voice.info.mock,
    });
    await commitTake(ctx, take, result, alignment, prepared, key, assetId);
  } catch (err) {
    if (err instanceof NonRetryableError) throw err;
    // Paid for but not kept (a fault after the audio came back): the take is closed, so no retry of the job buys it again.
    const closed = await ctx.db.voiceGeneration
      .updateMany({ where: { id: take.id, status: 'GENERATING' }, data: { status: 'FAILED', providerCallId: callId, error: `Not kept after the audio came back (paid for; ${stored ? `stored at ${key}` : 'not stored'}): ${reason(err)}`, completedAt: new Date() } })
      .then((r) => r.count === 1, () => false);
    if (!closed) throw err; // still GENERATING: the next attempt closes it and makes a new take
    tally.failed++;
    throw new NonRetryableError(`take ${take.generation} of chunk ${chunk.chunkIndex + 1} came back but could not be kept, and a retry would buy it again: ${reason(err)}`);
  }
  tally.generated++;
  // A take not made with the run's own configuration says so ("production profile Tulip narrator v2", "temporary override: stability 0.3").
  const source = takeSource(made);
  const withWhat = made.base === 'PRODUCTION' ? `production profile ${profileLabel(made.profile)}${made.override ? `, temporary override: ${describeOverrides(made.override)}` : ''}` : source === 'temporary override' && !take.variant ? `temporary override: ${describeOverrides(made.override)}` : null;
  const labels = [take.variant, withWhat].filter(Boolean).join('; ');
  await ctx.progress(`Voice run ${run.number}: chunk ${chunk.chunkIndex + 1} take ${take.generation}${labels ? ` (${labels})` : ''} — ${(result.durationMs / 1000).toFixed(1)} s, ${characters} characters${alignment ? '' : ', no timestamps'}`, {
    run: run.number,
    chunk: chunk.chunkIndex + 1,
    take: take.generation,
    durationMs: result.durationMs,
    characters,
  });
}

/**
 * A stored take's audio becomes a media asset and the take is checked and
 * made its chunk's current take, to review (the one before is superseded);
 * an A/B variant is kept beside the current take instead.
 */
async function commitTake(ctx: StageContext, take: Take, result: NarrationResult, alignment: ReturnType<typeof alignTake>, prepared: ReturnType<typeof prepareTake>, key: string, assetId: string): Promise<void> {
  const { voice } = ctx.providers;
  const { run, chunk } = take;
  const qa = takeQa({ ref: `#${chunk.chunkIndex + 1}`, canonical: chunk.sourceText, durationMs: result.durationMs, hasAudio: true, alignment, forms: prepared.prepared.spokenForms, spokenText: prepared.spokenText, checks: prepared.prepared.checks, mock: voice.info.mock });
  // An A/B variant is kept beside the chunk's current take: the editor chooses.
  const current = !take.variant;

  await ctx.db.$transaction(async (tx) => {
    await tx.mediaAsset.create({
      data: {
        id: assetId,
        projectId: ctx.project.id,
        languageVersionId: run.languageVersionId,
        kind: 'NARRATION_AUDIO',
        storageKey: key,
        mimeType: result.mimeType,
        sizeBytes: BigInt(result.audio.byteLength),
        durationMs: result.durationMs,
        checksumSha256: createHash('sha256').update(result.audio).digest('hex'),
        provider: voice.info.name,
        isMock: voice.info.mock,
        metadata: { runId: run.id, run: run.number, chunk: chunk.chunkIndex + 1, take: take.generation, takeId: take.id, dictionary: result.dictionary ?? null } as Prisma.InputJsonValue,
      },
    });
    if (current) {
      const fresh = await tx.voiceChunk.findUniqueOrThrow({ where: { id: chunk.id }, include: { current: true } });
      if (fresh.current && fresh.current.id !== take.id && SUPERSEDABLE.has(fresh.current.status)) {
        await tx.voiceGeneration.update({ where: { id: fresh.current.id }, data: { status: 'SUPERSEDED' } });
      }
    }
    await tx.voiceGeneration.update({
      where: { id: take.id },
      data: {
        status: current ? 'IN_REVIEW' : 'GENERATED',
        audioAssetId: assetId,
        durationMs: result.durationMs,
        alignment: (alignment ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        qa: qa as unknown as Prisma.InputJsonValue,
        completedAt: new Date(),
        error: null,
      },
    });
    if (current) await tx.voiceChunk.update({ where: { id: chunk.id }, data: { currentGenerationId: take.id } });
  });
}

/** Stores a take's audio, trying again after a transient failure. */
async function store(storage: StorageProvider, key: string, audio: Uint8Array, opts: PutOptions, delayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await storage.put(key, audio, opts);
      return;
    } catch (err) {
      if (!(err instanceof ProviderError && err.retryable) || attempt >= STORE_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** The chunk's sentences (ranges in its canonical text) and the blocks they come from. */
export function chunkSentences(chunk: Pick<VoiceChunk, 'sourceText' | 'spans'>): { start: number; end: number; blockKey: string }[] {
  const out: { start: number; end: number; blockKey: string }[] = [];
  let at = 0;
  for (const span of readSpans(chunk.spans)) {
    const length = span.end - span.start;
    const part = chunk.sourceText.slice(at, at + length);
    for (const s of sentenceSpans(part)) out.push({ start: at + s.start, end: at + s.end, blockKey: span.blockKey });
    at += length + 1;
  }
  return out;
}
