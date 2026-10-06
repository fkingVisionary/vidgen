import { PreparedNarration, type ChunkingSettings, type ConfigProvenance, type ContextSettings, type PerformanceRules, type ProviderSettingValues, type PronunciationConfig, type VoiceConfigOverrides, type VoiceRunConfig, type VoiceTakeOverride } from '@docengine/core';
import type { Database, VoiceGeneration } from '@docengine/database';
import type { VoiceProvider } from '@docengine/providers';
import { chunkSeconds } from './chunking.ts';
import { describeOverrides, mergeOverrides, profileLabel, runConfig, takeConfig, takeSource, type ConfigProvider, type ProfileRow } from './config.ts';
import { LEDGER, costText, sumReported, takeCost, type LedgerRow, type TakeCost } from './cost.ts';
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

/** The provider a summary reads configurations and prices with. */
type SummaryProvider = ConfigProvider & Pick<VoiceProvider, 'info'>;

/** What timing a take has: the provider's per-character timestamps and the script words mapped onto them. */
export interface AlignmentFacts {
  source: string;
  characters: number | null;
  words: number;
  unmatchedWords: number;
}

/** What a take was made with, for the log: its base, any temporary override, the version, and how it differs from its run. */
export interface TakeConfiguration {
  base: 'RUN' | 'PRODUCTION';
  override: VoiceTakeOverride | null;
  /** "Tulip narrator v2". */
  profile: string;
  source: ReturnType<typeof takeSource>;
  differs: string[];
  reconstructed: boolean;
}

export interface TakeFacts {
  id: string;
  generation: number;
  status: string;
  current: boolean;
  variant: string | null;
  strategy: string;
  configuration: TakeConfiguration;
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
  chunking: ChunkingSettings;
  context: ContextSettings;
  /** The version, its own name, and its family's name as the run recorded it. */
  profile: { familyId: string | null; family: string | null; versionId: string; version: number; name: string };
  /** What the run was made with (reconstructed for a run made before saved profiles). */
  configuration: {
    reconstructed: boolean;
    selection: VoiceRunConfig['selection'];
    projectOverrides: VoiceConfigOverrides;
    runOptions: VoiceConfigOverrides;
    provenance: ConfigProvenance;
    /** "performance expressive, stability 0.4" (the project's and the run's together). */
    overrides: string;
  };
  /** Provider settings (and what the model is sent of them), number style, performance rules and pronunciation rules. */
  effective: { providerSettings: ProviderSettingValues; sent: ProviderSettingValues; ignored: string[]; numberStyle: string; performanceRules: PerformanceRules; pronunciation: PronunciationConfig };
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
  /** Characters sent by every request of the run that reached the ledger (the estimate's basis). */
  characters: number;
  /** The provider's own figures, summed per name (raw, never priced). */
  providerReported: { name: string; total: number; requests: number }[];
  /** "sent 1,577 characters; provider reported 174 (character-cost header)". */
  costText: string;
  /** Estimated from the characters sent. */
  estimatedUsd: number | null;
  reportedUsd: number | null;
  /** Some ledger rows priced the provider's figure (before 2026-10-06) and were re-estimated here. */
  reestimated: boolean;
  costBases: string[];
  durations: DurationStats;
  withTimestamps: number;
  assembly: { id: string; version: number; status: string; totalDurationMs: number; complete: boolean } | null;
  qa: { blocking: Record<string, number>; warning: Record<string, number> };
  pronunciation: { unresolved: string[]; used: string[] };
  /** Why the run stopped before its takes were all tried (null when it did not). */
  stopped: string | null;
}

function alignmentFacts(v: unknown): AlignmentFacts | null {
  const a = readAlignment(v);
  return a ? { source: a.source, characters: a.characters?.chars.length ?? null, words: a.words.length, unmatchedWords: a.unmatchedWords } : null;
}

type TakeRow = VoiceGeneration & { profile: ProfileRow; providerCall: LedgerRow | null };

const TAKE_INCLUDE = { providerCall: LEDGER, profile: { include: { family: true } } } as const;

/** What a take was made with: stored on it, or its run's (a take made before saved profiles). */
export function takeConfiguration(g: Pick<TakeRow, 'config' | 'strategy' | 'profile'>, run: VoiceRunConfig): TakeConfiguration {
  const c = takeConfig(g, run);
  return { base: c.base, override: c.override, profile: profileLabel(c.profile), source: takeSource(c), differs: c.differs, reconstructed: c.reconstructed };
}

function takeFacts(g: TakeRow, currentId: string | null, run: VoiceRunConfig, provider: SummaryProvider): TakeFacts {
  return {
    id: g.id,
    generation: g.generation,
    status: g.status,
    current: g.id === currentId,
    variant: g.variant,
    strategy: g.strategy,
    configuration: takeConfiguration(g, run),
    performanceText: g.performanceText,
    durationMs: g.durationMs,
    alignment: alignmentFacts(g.alignment),
    cost: takeCost(g.providerCall, g.characters, provider),
    requestId: g.providerRequestId,
    error: g.error,
  };
}

const usd = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? Math.round(xs.reduce<number>((n, x) => n + (x ?? 0), 0) * 1e6) / 1e6 : null);
const tally = (xs: readonly string[]) => xs.reduce<Record<string, number>>((o, x) => ({ ...o, [x]: (o[x] ?? 0) + 1 }), {});

/** A run as it stands, for the log: the run line and a line per chunk. */
export async function summarizeRun(db: Database, provider: SummaryProvider, runId: string, jobId: string, stopped: string | null): Promise<{ run: RunLine; chunks: ChunkLine[] }> {
  const run = await db.voiceRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      profile: { include: { family: true } },
      script: { select: { version: true } },
      chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } },
      generations: { orderBy: { generation: 'desc' }, include: TAKE_INCLUDE },
    },
  });
  const config = runConfig(run, provider);
  const { effective } = config;
  const cost = (g: TakeRow) => takeCost(g.providerCall, g.characters, provider);
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
      take: shown ? takeFacts(shown, c.currentGenerationId, config, provider) : null,
    };
  });

  const paid = run.generations.filter((g) => g.providerCall);
  const costs = paid.map((g) => cost(g)!);
  const characters = paid.reduce((n, g) => n + (g.characters ?? 0), 0);
  const reported = sumReported(costs);
  const ofJob = run.generations.filter((g) => g.jobId === jobId);
  const heard = current.filter((g) => !!g && !!g.audioAssetId && !!g.durationMs);
  const prepared = heard.map((g) => PreparedNarration.safeParse(g!.prepared)).flatMap((p) => (p.success ? [p.data] : []));
  const assembly = await db.voiceAssembly.findFirst({ where: { runId }, orderBy: { version: 'desc' }, select: { id: true, version: true, status: true, totalDurationMs: true, complete: true } });
  const qa = await liveRunQa(db, run);
  const words = await lexicon(db, run.projectId, effective.language);

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
      chunking: effective.chunking,
      context: effective.context,
      profile: { familyId: config.profile.familyId, family: config.profile.familyName, versionId: config.profile.versionId, version: config.profile.version, name: config.profile.name },
      configuration: {
        reconstructed: config.reconstructed,
        selection: config.selection,
        projectOverrides: config.projectOverrides,
        runOptions: config.runOptions,
        provenance: config.provenance,
        overrides: describeOverrides(mergeOverrides(config.projectOverrides, config.runOptions)),
      },
      effective: { providerSettings: effective.providerSettings, sent: config.sent, ignored: config.ignored, numberStyle: effective.numberStyle, performanceRules: effective.performanceRules, pronunciation: effective.pronunciation },
      provider: effective.provider,
      model: effective.model,
      voiceId: effective.voiceId,
      language: effective.language,
      outputFormat: effective.outputFormat,
      chunks: run.chunks.length,
      takes: tally(run.generations.map((g) => g.status)),
      regenerations: run.generations.filter((g) => g.generation > 1).length,
      job: { takes: ofJob.length, characters: ofJob.filter((g) => g.providerCall).reduce((n, g) => n + (g.characters ?? 0), 0), estimatedUsd: usd(ofJob.map((g) => cost(g)?.estimatedUsd ?? null)) },
      characters,
      providerReported: reported,
      costText: costText(characters, reported.map((r) => ({ name: r.name, quantity: r.total }))),
      estimatedUsd: usd(costs.map((c) => c.estimatedUsd)),
      reportedUsd: usd(costs.map((c) => c.reportedUsd)),
      reestimated: costs.some((c) => c.reestimated),
      costBases: [...new Set(costs.map((c) => c.basis).filter((b): b is string => !!b))],
      durations: durationStats(heard.map((g) => g!.durationMs!)),
      withTimestamps: heard.filter((g) => g!.alignment).length,
      assembly,
      qa: { blocking: tally(qa.filter((f) => f.severity === 'BLOCKING').map((f) => f.kind)), warning: tally(qa.filter((f) => f.severity === 'WARNING').map((f) => f.kind)) },
      pronunciation: {
        unresolved: unresolvedIn(run.chunks.map((c) => c.sourceText).join('\n'), words, effective.pronunciation.rules),
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
  /** "House narrator v1". */
  profile: string;
  strategy: string;
  context: string;
  chunking: string;
  /** What else the run set over its version beyond strategy, context and chunking ("stability 0.3"; "none"). */
  overrides: string;
  chunks: number;
  totalMs: number;
  meanChunkMs: number | null;
  characters: number;
  estimatedUsd: number | null;
}

export function comparisonRow(r: RunLine): ComparisonRow {
  const c = r.context;
  const { strategy: _s, chunking: _c, context: _x, ...rest } = mergeOverrides(r.configuration.projectOverrides, r.configuration.runOptions);
  return {
    variant: r.variant,
    run: r.run,
    profile: profileLabel({ familyId: r.profile.familyId, familyName: r.profile.family, versionId: r.profile.versionId, version: r.profile.version, name: r.profile.name }),
    strategy: r.strategy,
    context: c.stitch ? 'stitched' : c.previousChars || c.nextChars ? `previous ${c.previousChars} / next ${c.nextChars} chars` : 'none',
    chunking: `${r.chunking.minWords}–${r.chunking.maxWords} words`,
    overrides: describeOverrides(rest),
    chunks: r.chunks,
    totalMs: r.durations.totalMs,
    meanChunkMs: r.durations.meanMs,
    characters: r.characters,
    estimatedUsd: r.estimatedUsd,
  };
}

/** One row as text, for reading the comparison straight from the log (the overrides only when there are any beyond the columns). */
export function comparisonText(row: ComparisonRow): string {
  const sec = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)} s`);
  return [row.variant ?? `run ${row.run}`, row.profile, row.strategy, `context ${row.context}`, row.chunking, ...(row.overrides === 'none' ? [] : [`overrides ${row.overrides}`]), `${row.chunks} chunks`, sec(row.totalMs), `mean ${sec(row.meanChunkMs)}`, `${row.characters} chars`, row.estimatedUsd === null ? 'unpriced' : `$${row.estimatedUsd.toFixed(4)}`].join(' | ');
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
  /** The new takes by what they were made with (`overridden`: with a temporary override, whatever the base). */
  configurations: { run: number; production: number; overridden: number };
  /** The profile versions the new takes used ("Tulip narrator v2"). */
  profiles: string[];
  /** Chunks this job made takes for. */
  regenerated: number;
  /** Chunks it did not touch, and how many of them kept their current take (the two must be equal). */
  otherChunks: number;
  unchangedOthers: number;
  othersIntact: boolean;
}

/** What a regeneration changed in a run: the chunks it made takes for, against the run as it was when the job started. */
export async function summarizeRegeneration(db: Database, provider: SummaryProvider, before: RunSnapshot, jobId: string): Promise<RegenerationLine> {
  const run = await db.voiceRun.findUniqueOrThrow({
    where: { id: before.runId },
    select: { id: true, number: true, config: true, strategy: true, settings: true, profile: { include: { family: true } }, chunks: { orderBy: { chunkIndex: 'asc' }, select: { id: true, chunkIndex: true, currentGenerationId: true } } },
  });
  const config = runConfig(run, provider);
  const takes = await db.voiceGeneration.findMany({ where: { runId: run.id, jobId }, orderBy: { generation: 'asc' }, include: TAKE_INCLUDE });
  const made = takes.map((t) => takeConfiguration(t, config));
  const after = await snapshotRun(db, run.id);
  const touched = run.chunks.filter((c) => takes.some((t) => t.chunkId === c.id));
  const others = run.chunks.filter((c) => !touched.includes(c));
  const unchanged = others.filter((c) => (before.current.get(c.id)?.takeId ?? null) === c.currentGenerationId).length;
  return {
    runId: run.id,
    run: run.number,
    chunks: touched.map((c) => ({ chunk: c.chunkIndex + 1, chunkId: c.id, previous: before.current.get(c.id) ?? null, takes: takes.filter((t) => t.chunkId === c.id).map((t) => takeFacts(t, c.currentGenerationId, config, provider)) })),
    assembly: { before: before.assembly, after: after.assembly },
    configurations: { run: made.filter((m) => m.base === 'RUN').length, production: made.filter((m) => m.base === 'PRODUCTION').length, overridden: made.filter((m) => m.override).length },
    profiles: [...new Set(made.map((m) => m.profile))],
    regenerated: touched.length,
    otherChunks: others.length,
    unchangedOthers: unchanged,
    othersIntact: unchanged === others.length,
  };
}
