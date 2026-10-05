import { createHash, randomUUID } from 'node:crypto';
import { DirectorMark, type VoiceProfileSettings } from '@docengine/core';
import type { Prisma, VoiceChunk, VoiceGeneration, VoiceProfile, VoiceRun } from '@docengine/database';
import { NonRetryableError, type StageContext, type StageHandler } from '@docengine/pipeline';
import { ProviderError, buildAssetKey, type NarrationResult } from '@docengine/providers';
import { z } from 'zod';
import { alignTake } from './alignment.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';
import { profileConfig } from './profiles.ts';
import { rulesFor } from './pronunciation.ts';
import { takeQa } from './qa.ts';
import { headSentences, lexicon, readPerformance, readSpans, rebuildAssembly, seedFor, tailSentences } from './runs.ts';
import { loadScriptForVoice, type VoiceScript } from './script.ts';
import { sentenceSpans } from './text.ts';

/**
 * The VOICE job: generates the pending takes of one or more voice runs, one
 * small chunk per request. For each take: the derived text is prepared and
 * checked (nothing failing a check is sent), the provider is called through
 * the ledger, the audio is stored, its timestamps are mapped to the script's
 * words, the take is checked, and it becomes its chunk's current take (the
 * one before is superseded, never deleted). Then each run's assembly is
 * rebuilt on the measured clock.
 */

export interface VoiceStageConfig {
  /** Hard ceiling on the characters one job may send. */
  maxCharacters: number;
  /** Takes generated at the same time (1 when stitching). */
  concurrency: number;
}

export const DEFAULT_VOICE_CONFIG: VoiceStageConfig = { maxCharacters: 40_000, concurrency: 2 };

export const VoiceJobInput = z.object({ runIds: z.array(z.string()).min(1), generationIds: z.array(z.string()).optional() });
export type VoiceJobInput = z.infer<typeof VoiceJobInput>;

/** Request stitching only reaches back this far (ElevenLabs: two hours). */
const STITCH_WINDOW_MS = 2 * 60 * 60 * 1000;

type ChunkWithTakes = VoiceChunk & { current: VoiceGeneration | null };
type Take = VoiceGeneration & { chunk: ChunkWithTakes; run: VoiceRun & { profile: VoiceProfile } };

interface Tally {
  generated: number;
  failed: number;
  characters: number;
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
      const runs = await ctx.db.voiceRun.findMany({ where: { id: { in: input.data.runIds }, projectId: ctx.project.id }, include: { profile: true }, orderBy: { number: 'asc' } });
      if (runs.length !== input.data.runIds.length) throw new NonRetryableError('A voice run of this job no longer exists');
      const tally: Tally = { generated: 0, failed: 0, characters: 0 };
      const summaries: Record<string, unknown>[] = [];
      for (const run of runs) {
        if (run.profile.provider !== voice.info.name) throw new NonRetryableError(`Voice run ${run.number} uses a ${run.profile.provider} profile; the configured voice provider is ${voice.info.name}`);
        const script = await loadScriptForVoice(ctx.db, run.scriptId);
        if (!script) throw new NonRetryableError(`The script of voice run ${run.number} no longer exists`);
        await generateRun(ctx, run, script, input.data.generationIds ?? null, cfg, tally);
        const assembly = await rebuildAssembly(ctx.db, run.id, script, 'system');
        summaries.push(await runSummary(ctx, run.id, assembly?.id ?? null));
      }
      if (tally.generated === 0 && tally.failed > 0) throw new NonRetryableError(`No take could be generated (${tally.failed} failed): see each take's error`);
      return { runs: summaries, generated: tally.generated, failed: tally.failed, characters: tally.characters, mock: voice.info.mock };
    },
  };
}

async function generateRun(ctx: StageContext, run: VoiceRun & { profile: VoiceProfile }, script: VoiceScript, only: readonly string[] | null, cfg: VoiceStageConfig, tally: Tally): Promise<void> {
  const { voice } = ctx.providers;
  const chunks = await ctx.db.voiceChunk.findMany({ where: { runId: run.id }, orderBy: { chunkIndex: 'asc' }, include: { current: true } });
  const takes = (await ctx.db.voiceGeneration.findMany({
    where: { runId: run.id, status: { in: ['PENDING', 'GENERATING'] }, ...(only ? { id: { in: [...only] } } : {}) },
    orderBy: [{ createdAt: 'asc' }],
  }))
    .map((g) => ({ ...g, chunk: chunks.find((c) => c.id === g.chunkId)!, run }))
    .sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);
  if (!takes.length) return;
  const settings = run.settings as { context?: { previousChars?: number; nextChars?: number; stitch?: boolean } };
  const context = { previousChars: settings.context?.previousChars ?? 0, nextChars: settings.context?.nextChars ?? 0, stitch: settings.context?.stitch ?? false };
  const stitching = context.stitch && voice.capabilities(run.profile.modelId).stitching;
  const words = await lexicon(ctx.db, run.projectId, run.profile.language);
  await ctx.progress(`Voice run ${run.number}: generating ${takes.length} take(s) with ${run.profile.provider} ${run.profile.modelId}${voice.info.mock ? ' (MOCK)' : ''}`, { run: run.number, takes: takes.length });

  let next = 0;
  let fatal: Error | null = null;
  const worker = async () => {
    while (!fatal && next < takes.length) {
      const take = takes[next++]!;
      if (tally.characters >= cfg.maxCharacters) {
        await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: `Not generated: the job's character ceiling (VOICE_MAX_CHARACTERS=${cfg.maxCharacters}) was reached`, completedAt: new Date() } });
        tally.failed++;
        continue;
      }
      try {
        await generateTake(ctx, take as Take, chunks, script, words, context, stitching, tally);
      } catch (err) {
        if (err instanceof NonRetryableError || (err instanceof ProviderError && isFatal(err))) fatal = err instanceof Error ? err : new Error(String(err));
        else throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: stitching ? 1 : Math.max(1, cfg.concurrency) }, worker));
  if (fatal) throw new NonRetryableError(`Voice run ${run.number} stopped: ${(fatal as Error).message}`);
}

/** Errors no other take would get past: a rejected key, no credits, no access, an unknown voice or model. */
function isFatal(err: ProviderError): boolean {
  return !err.retryable && /HTTP (401|402|403|404)\b/.test(err.message);
}

async function generateTake(
  ctx: StageContext,
  take: Take,
  chunks: readonly ChunkWithTakes[],
  script: VoiceScript,
  words: Awaited<ReturnType<typeof lexicon>>,
  context: { previousChars: number; nextChars: number; stitch: boolean },
  stitching: boolean,
  tally: Tally,
): Promise<void> {
  const { voice, storage } = ctx.providers;
  const { run, chunk } = take;
  const profile = run.profile;
  const config = profileConfig(profile);
  const sentences = chunkSentences(chunk);
  const blocks = new Map<string, TakeBlock>([...script.blocks.values()].map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
  const rules = rulesFor(chunk.sourceText, words);
  const prev = chunks.find((c) => c.chunkIndex === chunk.chunkIndex - 1 && c.sectionKey === chunk.sectionKey);
  const nextChunk = chunks.find((c) => c.chunkIndex === chunk.chunkIndex + 1 && c.sectionKey === chunk.sectionKey);
  const previousText = prev ? tailSentences(prev.sourceText.replace(/\n/g, ' '), context.previousChars) : null;
  const nextText = nextChunk ? headSentences(nextChunk.sourceText.replace(/\n/g, ' '), context.nextChars) : null;
  const directions = z.array(DirectorMark).catch([]).parse(take.directions ?? []);
  const prepared = prepareTake({
    chunk: { text: chunk.sourceText, sentences, performance: readPerformance(chunk.performance) },
    blocks,
    strategy: take.strategy,
    ...(directions.length ? { director: directions } : {}),
    numberStyle: config.numberStyle,
    aliases: rules.aliases,
    phonemes: rules.phonemes,
    provider: voice,
    model: take.model,
    settings: config.settings,
    context: { previousText, nextText },
    seed: seedFor(take.textHash, take.generation),
  });
  const characters = prepared.rendered.text.length;
  await ctx.db.voiceGeneration.update({
    where: { id: take.id },
    data: { status: 'GENERATING', jobId: ctx.job.id, spokenText: prepared.spokenText, performanceText: prepared.rendered.text, prepared: prepared.prepared as unknown as Prisma.InputJsonValue, characters },
  });
  if (!prepared.passed) {
    const failed = prepared.prepared.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label}: ${c.detail}`);
    await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: `Not sent — performance checks failed: ${failed.join('; ')}`, completedAt: new Date() } });
    tally.failed++;
    return;
  }

  // Request stitching: the previous chunk's current take, if recent and from the same model.
  const prevTake = prev ? await ctx.db.voiceChunk.findUnique({ where: { id: prev.id }, include: { current: true } }).then((c) => c?.current ?? null) : null;
  const stitchIds = stitching && prevTake?.providerRequestId && prevTake.model === take.model && prevTake.completedAt && Date.now() - prevTake.completedAt.getTime() < STITCH_WINDOW_MS ? [prevTake.providerRequestId] : undefined;

  const s: VoiceProfileSettings = prepared.prepared.settings;
  let callId: string | null = null;
  let result: NarrationResult;
  try {
    result = await ctx.callProvider(
      'voice',
      'generateNarration',
      () =>
        voice.generateNarration({
          text: prepared.rendered.text,
          language: profile.language,
          settings: { voiceId: take.voiceId, model: take.model, stability: s.stability, similarity: s.similarity, style: s.style, speed: s.speed, speakerBoost: s.speakerBoost },
          withTimestamps: true,
          ...(previousText ? { previousText } : {}),
          ...(nextText ? { nextText } : {}),
          ...(stitchIds ? { previousRequestIds: stitchIds } : {}),
          outputFormat: profile.outputFormat,
          ...(prepared.prepared.seed !== null ? { seed: prepared.prepared.seed } : {}),
          ...(prepared.phonemes.length ? { pronunciations: prepared.phonemes } : {}),
          signal: ctx.signal,
        }),
      {
        request: { run: run.number, chunk: chunk.chunkIndex + 1, take: take.generation, model: take.model, voiceId: take.voiceId, characters, strategy: take.strategy, textHash: take.textHash, context: { previous: previousText?.length ?? 0, next: nextText?.length ?? 0, stitched: !!stitchIds } },
        summarize: (r) => ({ durationMs: r.durationMs, mimeType: r.mimeType, bytes: r.audio.byteLength, timestamps: !!r.characters, requestId: r.requestId ?? null }),
        onRecorded: (id) => {
          callId = id;
        },
      },
    );
  } catch (err) {
    await ctx.db.voiceGeneration.update({ where: { id: take.id }, data: { status: 'FAILED', error: err instanceof Error ? err.message : String(err), providerCallId: callId, completedAt: new Date() } });
    tally.failed++;
    if (err instanceof ProviderError && isFatal(err)) throw err;
    if (err instanceof ProviderError) return; // this take failed; the others go on
    throw err;
  }
  tally.characters += characters;

  const ext = result.mimeType === 'audio/mpeg' ? 'mp3' : 'wav';
  const assetId = randomUUID();
  const key = buildAssetKey({ projectId: ctx.project.id, language: profile.language, kind: 'NARRATION_AUDIO', assetId, ext });
  await storage.put(key, result.audio, { contentType: result.mimeType, metadata: { take: take.id, chunk: String(chunk.chunkIndex + 1), run: String(run.number) } });
  const alignment = alignTake({
    canonical: chunk.sourceText,
    forms: prepared.prepared.spokenForms,
    canonicalSentences: sentences,
    spokenSentences: prepared.spokenSentences,
    rendered: prepared.rendered,
    characters: result.characters,
    mock: voice.info.mock,
  });
  const qa = takeQa({ ref: `#${chunk.chunkIndex + 1}`, canonical: chunk.sourceText, durationMs: result.durationMs, hasAudio: true, alignment, forms: prepared.prepared.spokenForms, spokenText: prepared.spokenText, checks: prepared.prepared.checks, mock: voice.info.mock });

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
    const fresh = await tx.voiceChunk.findUniqueOrThrow({ where: { id: chunk.id }, include: { current: true } });
    if (fresh.current && fresh.current.id !== take.id && (fresh.current.status === 'GENERATED' || fresh.current.status === 'APPROVED')) {
      await tx.voiceGeneration.update({ where: { id: fresh.current.id }, data: { status: 'SUPERSEDED' } });
    }
    await tx.voiceGeneration.update({
      where: { id: take.id },
      data: {
        status: 'GENERATED',
        audioAssetId: assetId,
        durationMs: result.durationMs,
        alignment: (alignment ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        qa: qa as unknown as Prisma.InputJsonValue,
        providerCallId: callId,
        providerRequestId: result.requestId ?? null,
        completedAt: new Date(),
        error: null,
      },
    });
    await tx.voiceChunk.update({ where: { id: chunk.id }, data: { currentGenerationId: take.id } });
  });
  tally.generated++;
  await ctx.progress(`Voice run ${run.number}: chunk ${chunk.chunkIndex + 1} take ${take.generation} — ${(result.durationMs / 1000).toFixed(1)} s, ${characters} characters${alignment ? '' : ', no timestamps'}`, {
    run: run.number,
    chunk: chunk.chunkIndex + 1,
    take: take.generation,
    durationMs: result.durationMs,
    characters,
  });
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

/** What one run produced, for the job result and the log (the numbers the acceptance report needs). */
async function runSummary(ctx: StageContext, runId: string, assemblyId: string | null): Promise<Record<string, unknown>> {
  const run = await ctx.db.voiceRun.findUniqueOrThrow({
    where: { id: runId },
    include: { profile: true, chunks: { include: { current: true } }, generations: { include: { providerCall: { select: { estimatedCostUsd: true, actualCostUsd: true, costBasis: true } } } } },
  });
  const current = run.chunks.map((c) => c.current).filter((g): g is VoiceGeneration => !!g && !!g.durationMs);
  const durations = current.map((g) => g.durationMs!);
  const attempts = run.generations.filter((g) => g.providerCallId);
  const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((n, x) => n + (x ?? 0), 0) * 1e6) / 1e6;
  const assembly = assemblyId ? await ctx.db.voiceAssembly.findUnique({ where: { id: assemblyId }, select: { version: true, totalDurationMs: true } }) : null;
  const summary = {
    run: run.number,
    kind: run.kind,
    experiment: run.experiment,
    variant: run.variant,
    strategy: run.strategy,
    provider: run.profile.provider,
    model: run.profile.modelId,
    voiceId: run.profile.voiceId,
    language: run.profile.language,
    outputFormat: run.profile.outputFormat,
    chunks: run.chunks.length,
    takesGenerated: run.generations.filter((g) => g.status !== 'PENDING' && g.status !== 'FAILED' && g.status !== 'GENERATING').length,
    failures: run.generations.filter((g) => g.status === 'FAILED').length,
    regenerations: run.generations.filter((g) => g.generation > 1).length,
    characters: attempts.reduce((n, g) => n + (g.characters ?? 0), 0),
    estimatedCostUsd: sum(attempts.map((g) => (g.providerCall?.estimatedCostUsd ? Number(g.providerCall.estimatedCostUsd) : null))),
    reportedCostUsd: attempts.some((g) => g.providerCall?.actualCostUsd != null) ? sum(attempts.map((g) => (g.providerCall?.actualCostUsd != null ? Number(g.providerCall.actualCostUsd) : null))) : null,
    costBases: [...new Set(attempts.map((g) => g.providerCall?.costBasis).filter(Boolean))],
    generatedDurationMs: durations.reduce((n, d) => n + d, 0),
    averageChunkMs: durations.length ? Math.round(durations.reduce((n, d) => n + d, 0) / durations.length) : null,
    longestChunkMs: durations.length ? Math.max(...durations) : null,
    shortestChunkMs: durations.length ? Math.min(...durations) : null,
    withTimestamps: current.filter((g) => g.alignment).length,
    assembly: assembly ? { version: assembly.version, durationMs: assembly.totalDurationMs } : null,
  };
  ctx.logger.info(summary, `voice run ${run.number} summary`);
  return summary;
}
