import { ContextSettings, ChunkingSettings, PreparedNarration } from '@docengine/core';
import type { Database, Prisma } from '@docengine/database';
import { z } from 'zod';
import { chunkSeconds } from './chunking.ts';
import { lexicon, readAlignment, readPerformance, unresolvedIn } from './runs.ts';
import { liveRunQa } from './service.ts';

/**
 * What a VOICE job did, read back from the database once its takes are
 * committed: a line per chunk and per run, and one more for a regeneration
 * or a comparison. These lines (and the job's result) are the record of a
 * voice job outside the dashboard — production logs are where an acceptance
 * run is checked — so every figure is what is stored, never what was meant.
 */

/** Measured durations of a run's current takes. */
export interface DurationStats {
  totalMs: number;
  shortestMs: number | null;
  longestMs: number | null;
  meanMs: number | null;
  medianMs: number | null;
}

export function durationStats(ms: readonly number[]): DurationStats {
  if (!ms.length) return { totalMs: 0, shortestMs: null, longestMs: null, meanMs: null, medianMs: null };
  const sorted = [...ms].sort((a, b) => a - b);
  const total = sorted.reduce((n, d) => n + d, 0);
  const mid = Math.floor(sorted.length / 2);
  return {
    totalMs: total,
    shortestMs: sorted[0]!,
    longestMs: sorted.at(-1)!,
    meanMs: Math.round(total / sorted.length),
    medianMs: sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2),
  };
}

/** A take's ledger row: what the request cost and how that is known. */
export interface TakeCost {
  ledgerId: string;
  status: string;
  basis: string | null;
  estimatedUsd: number | null;
  reportedUsd: number | null;
  /** Characters billed: the provider's own figure when `usageSource` is REPORTED, else those sent. */
  characters: number | null;
  usageSource: string | null;
  attempts: number | null;
}

/** What timing a take has: the provider's per-character timestamps and the script words mapped onto them. */
export interface AlignmentFacts {
  source: string;
  characters: number | null;
  words: number;
  unmatchedWords: number;
}

export interface TakeFacts {
  id: string;
  generation: number;
  status: string;
  current: boolean;
  variant: string | null;
  strategy: string;
  /** Exactly what was sent: the spoken text with the provider's performance markup. */
  performanceText: string | null;
  durationMs: number | null;
  alignment: AlignmentFacts | null;
  cost: TakeCost | null;
  requestId: string | null;
  error: string | null;
}

export interface ChunkLine {
  runId: string;
  run: number;
  chunk: number;
  chunkId: string;
  sectionKey: string;
  blockKeys: string[];
  boundary: string;
  /** Spoken words, as the chunk was sized. */
  words: number;
  estimatedSec: number;
  /** Characters sent for the take shown. */
  characters: number | null;
  /** The current take, else the newest. */
  take: TakeFacts | null;
}

export interface RunLine {
  runId: string;
  run: number;
  kind: string;
  experiment: string | null;
  variant: string | null;
  script: { id: string; version: number };
  strategy: string;
  chunking: ChunkingSettings | null;
  context: ContextSettings | null;
  profile: { id: string; name: string; version: number };
  provider: string;
  model: string;
  voiceId: string;
  language: string;
  outputFormat: string;
  chunks: number;
  /** Every take of the run, by status. */
  takes: Record<string, number>;
  regenerations: number;
  /** Takes this job sent (or tried to), and what they cost. */
  job: { takes: number; characters: number; estimatedUsd: number | null };
  /** Every request of the run that reached the ledger. */
  characters: number;
  reportedCharacters: number | null;
  estimatedUsd: number | null;
  reportedUsd: number | null;
  costBases: string[];
  durations: DurationStats;
  withTimestamps: number;
  assembly: { id: string; version: number; status: string; totalDurationMs: number; complete: boolean } | null;
  qa: { blocking: Record<string, number>; warning: Record<string, number> };
  pronunciation: { unresolved: string[]; used: string[] };
  /** Why the run stopped before its takes were all tried (null when it did not). */
  stopped: string | null;
}

const LedgerUsage = z.array(z.object({ unit: z.string(), quantity: z.number() })).catch([]);
const LedgerFacts = z.object({ usageSource: z.string().optional(), attempts: z.number().optional() }).catch({});

type Ledger = { id: string; status: string; costBasis: string | null; estimatedCostUsd: Prisma.Decimal | null; actualCostUsd: Prisma.Decimal | null; usage: Prisma.JsonValue; response: Prisma.JsonValue };
const LEDGER = { select: { id: true, status: true, costBasis: true, estimatedCostUsd: true, actualCostUsd: true, usage: true, response: true } } as const;

function takeCost(call: Ledger | null): TakeCost | null {
  if (!call) return null;
  const facts = LedgerFacts.parse(call.response ?? {});
  const chars = LedgerUsage.parse(call.usage).find((u) => u.unit === 'CHARACTERS');
  return {
    ledgerId: call.id,
    status: call.status,
    basis: call.costBasis,
    estimatedUsd: call.estimatedCostUsd === null ? null : Number(call.estimatedCostUsd),
    reportedUsd: call.actualCostUsd === null ? null : Number(call.actualCostUsd),
    characters: chars?.quantity ?? null,
    usageSource: facts.usageSource ?? null,
    attempts: facts.attempts ?? null,
  };
}

function alignmentFacts(v: unknown): AlignmentFacts | null {
  const a = readAlignment(v);
  return a ? { source: a.source, characters: a.characters?.chars.length ?? null, words: a.words.length, unmatchedWords: a.unmatchedWords } : null;
}

type TakeRow = { id: string; chunkId: string; generation: number; status: string; variant: string | null; strategy: string; performanceText: string | null; durationMs: number | null; alignment: Prisma.JsonValue; providerRequestId: string | null; error: string | null; providerCall: Ledger | null };

function takeFacts(g: TakeRow, currentId: string | null): TakeFacts {
  return {
    id: g.id,
    generation: g.generation,
    status: g.status,
    current: g.id === currentId,
    variant: g.variant,
    strategy: g.strategy,
    performanceText: g.performanceText,
    durationMs: g.durationMs,
    alignment: alignmentFacts(g.alignment),
    cost: takeCost(g.providerCall),
    requestId: g.providerRequestId,
    error: g.error,
  };
}

const usd = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? Math.round(xs.reduce<number>((n, x) => n + (x ?? 0), 0) * 1e6) / 1e6 : null);
const tally = (xs: readonly string[]) => xs.reduce<Record<string, number>>((o, x) => ({ ...o, [x]: (o[x] ?? 0) + 1 }), {});

/** A run as it stands, for the log: the run line and a line per chunk. */
export async function summarizeRun(db: Database, runId: string, jobId: string, stopped: string | null): Promise<{ run: RunLine; chunks: ChunkLine[] }> {
  const run = await db.voiceRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      profile: true,
      script: { select: { version: true } },
      chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } },
      generations: { orderBy: { generation: 'desc' }, include: { providerCall: LEDGER } },
    },
  });
  const settings = (run.settings ?? {}) as { chunking?: unknown; context?: unknown };
  const byId = new Map(run.generations.map((g) => [g.id, g]));
  const current = run.chunks.map((c) => (c.currentGenerationId ? (byId.get(c.currentGenerationId) ?? null) : null));
  const chunks: ChunkLine[] = run.chunks.map((c, i) => {
    const shown = current[i] ?? run.generations.find((g) => g.chunkId === c.id) ?? null;
    return {
      runId: run.id,
      run: run.number,
      chunk: c.chunkIndex + 1,
      chunkId: c.id,
      sectionKey: c.sectionKey,
      blockKeys: c.blockKeys,
      boundary: c.boundary,
      words: c.words,
      estimatedSec: chunkSeconds(c.words, readPerformance(c.performance)),
      characters: shown?.characters ?? null,
      take: shown ? takeFacts(shown, c.currentGenerationId) : null,
    };
  });

  const paid = run.generations.filter((g) => g.providerCall);
  const costs = paid.map((g) => takeCost(g.providerCall)!);
  const reported = costs.filter((c) => c.usageSource === 'REPORTED');
  const ofJob = run.generations.filter((g) => g.jobId === jobId);
  const heard = current.filter((g) => !!g && !!g.audioAssetId && !!g.durationMs);
  const prepared = heard.map((g) => PreparedNarration.safeParse(g!.prepared)).flatMap((p) => (p.success ? [p.data] : []));
  const assembly = await db.voiceAssembly.findFirst({ where: { runId }, orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, totalDurationMs: true, complete: true } });
  const qa = await liveRunQa(db, run);
  const words = await lexicon(db, run.projectId, run.profile.language);

  return {
    chunks,
    run: {
      runId: run.id,
      run: run.number,
      kind: run.kind,
      experiment: run.experiment,
      variant: run.variant,
      script: { id: run.scriptId, version: run.script.version },
      strategy: run.strategy,
      chunking: ChunkingSettings.nullable().catch(null).parse(settings.chunking ?? null),
      context: ContextSettings.nullable().catch(null).parse(settings.context ?? null),
      profile: { id: run.profile.id, name: run.profile.name, version: run.profile.version },
      provider: run.profile.provider,
      model: run.profile.modelId,
      voiceId: run.profile.voiceId,
      language: run.profile.language,
      outputFormat: run.profile.outputFormat,
      chunks: run.chunks.length,
      takes: tally(run.generations.map((g) => g.status)),
      regenerations: run.generations.filter((g) => g.generation > 1).length,
      job: { takes: ofJob.length, characters: ofJob.filter((g) => g.providerCall).reduce((n, g) => n + (g.characters ?? 0), 0), estimatedUsd: usd(ofJob.map((g) => takeCost(g.providerCall)?.estimatedUsd ?? null)) },
      characters: paid.reduce((n, g) => n + (g.characters ?? 0), 0),
      reportedCharacters: reported.length ? reported.reduce((n, c) => n + (c.characters ?? 0), 0) : null,
      estimatedUsd: usd(costs.map((c) => c.estimatedUsd)),
      reportedUsd: usd(costs.map((c) => c.reportedUsd)),
      costBases: [...new Set(costs.map((c) => c.basis).filter((b): b is string => !!b))],
      durations: durationStats(heard.map((g) => g!.durationMs!)),
      withTimestamps: heard.filter((g) => g!.alignment).length,
      assembly,
      qa: { blocking: tally(qa.filter((f) => f.severity === 'BLOCKING').map((f) => f.kind)), warning: tally(qa.filter((f) => f.severity === 'WARNING').map((f) => f.kind)) },
      pronunciation: {
        unresolved: unresolvedIn(run.chunks.map((c) => c.sourceText).join('\n'), words),
        used: [...new Set(prepared.flatMap((p) => [...p.dictionary.map((d) => d.term), ...p.spokenForms.filter((f) => f.kind === 'ALIAS').map((f) => f.display)]))].sort(),
      },
      stopped,
    },
  };
}

// ── Comparisons ──────────────────────────────────────────────────────────────

export interface ComparisonRow {
  variant: string | null;
  run: number;
  strategy: string;
  context: string;
  chunking: string;
  chunks: number;
  totalMs: number;
  meanChunkMs: number | null;
  characters: number;
  estimatedUsd: number | null;
}

export function comparisonRow(r: RunLine): ComparisonRow {
  const c = r.context;
  return {
    variant: r.variant,
    run: r.run,
    strategy: r.strategy,
    context: !c ? 'profile' : c.stitch ? 'stitched' : c.previousChars || c.nextChars ? `previous ${c.previousChars} / next ${c.nextChars} chars` : 'none',
    chunking: r.chunking ? `${r.chunking.minWords}–${r.chunking.maxWords} words` : 'profile',
    chunks: r.chunks,
    totalMs: r.durations.totalMs,
    meanChunkMs: r.durations.meanMs,
    characters: r.characters,
    estimatedUsd: r.estimatedUsd,
  };
}

/** One row as text, for reading the comparison straight from the log. */
export function comparisonText(row: ComparisonRow): string {
  const sec = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
  return [row.variant ?? `run ${row.run}`, row.strategy, `context ${row.context}`, row.chunking, `${row.chunks} chunks`, sec(row.totalMs), `mean ${sec(row.meanChunkMs)}`, `${row.characters} chars`, row.estimatedUsd === null ? 'unpriced' : `$${row.estimatedUsd.toFixed(4)}`].join(' | ');
}

// ── Regenerations ────────────────────────────────────────────────────────────

/** A run's current takes and latest assembly when a job starts. */
export interface RunSnapshot {
  runId: string;
  current: Map<string, { takeId: string; generation: number; durationMs: number | null } | null>;
  assembly: { id: string; version: number; totalDurationMs: number } | null;
}

export async function snapshotRun(db: Database, runId: string): Promise<RunSnapshot> {
  const chunks = await db.voiceChunk.findMany({ where: { runId }, include: { current: { select: { id: true, generation: true, durationMs: true } } } });
  const assembly = await db.voiceAssembly.findFirst({ where: { runId }, orderBy: { version: 'desc' }, select: { id: true, version: true, totalDurationMs: true } });
  return { runId, current: new Map(chunks.map((c) => [c.id, c.current ? { takeId: c.current.id, generation: c.current.generation, durationMs: c.current.durationMs } : null])), assembly };
}

export interface RegenerationLine {
  runId: string;
  run: number;
  chunks: { chunk: number; chunkId: string; previous: { takeId: string; generation: number; durationMs: number | null } | null; takes: TakeFacts[] }[];
  assembly: { before: RunSnapshot['assembly']; after: RunSnapshot['assembly'] };
  /** Chunks this job made takes for. */
  regenerated: number;
  /** Chunks it did not touch, and how many of them kept their current take (the two must be equal). */
  otherChunks: number;
  unchangedOthers: number;
  othersIntact: boolean;
}

/** What a regeneration changed in a run: the chunks it made takes for, against the run as it was when the job started. */
export async function summarizeRegeneration(db: Database, before: RunSnapshot, jobId: string): Promise<RegenerationLine> {
  const run = await db.voiceRun.findUniqueOrThrow({ where: { id: before.runId }, select: { id: true, number: true, chunks: { orderBy: { chunkIndex: 'asc' }, select: { id: true, chunkIndex: true, currentGenerationId: true } } } });
  const takes = await db.voiceGeneration.findMany({ where: { runId: run.id, jobId }, orderBy: { generation: 'asc' }, include: { providerCall: LEDGER } });
  const after = await snapshotRun(db, run.id);
  const touched = run.chunks.filter((c) => takes.some((t) => t.chunkId === c.id));
  const others = run.chunks.filter((c) => !touched.includes(c));
  const unchanged = others.filter((c) => (before.current.get(c.id)?.takeId ?? null) === c.currentGenerationId).length;
  return {
    runId: run.id,
    run: run.number,
    chunks: touched.map((c) => ({ chunk: c.chunkIndex + 1, chunkId: c.id, previous: before.current.get(c.id) ?? null, takes: takes.filter((t) => t.chunkId === c.id).map((t) => takeFacts(t, c.currentGenerationId)) })),
    assembly: { before: before.assembly, after: after.assembly },
    regenerated: touched.length,
    otherChunks: others.length,
    unchangedOthers: unchanged,
    othersIntact: unchanged === others.length,
  };
}
