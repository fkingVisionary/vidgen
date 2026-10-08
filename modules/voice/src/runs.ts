import { createHash } from 'node:crypto';
import { AssemblyEntry, ChunkPauses, ChunkSpan, NarrationAlignment, VoiceQaFinding, type ChunkBoundary, type ChunkPerformance, type Pronunciation, type PronunciationMethod, type PronunciationStatus, type PronunciationTermKind, type VoiceGenerationStatus } from '@docengine/core';
import type { Database, Prisma, Tx, VoiceChunk, VoiceGeneration } from '@docengine/database';
import { z } from 'zod';
import { assemble, type AssemblyBlock, type AssemblyChunk } from './assembly.ts';
import { proposeEntries, unresolvedIn, type LexiconEntry } from './pronunciation.ts';
import { sentenceSpans, sha256 } from './text.ts';
import type { VoiceScript } from './script.ts';

/**
 * Shared by the voice stage and the voice service: the pronunciation list,
 * neighbouring context, seeds, live QA of a run and its assembly versions.
 */

type Db = Database | Tx;

// ── Stored JSON, read defensively ────────────────────────────────────────────

export const readSpans = (v: unknown): ChunkSpan[] => z.array(ChunkSpan).catch([]).parse(v);
export const readAlignment = (v: unknown): NarrationAlignment | null => NarrationAlignment.nullable().catch(null).parse(v ?? null);
export const readQa = (v: unknown): VoiceQaFinding[] => z.array(VoiceQaFinding).catch([]).parse(v ?? []);
export const readEntries = (v: unknown): AssemblyEntry[] => z.array(AssemblyEntry).catch([]).parse(v ?? []);
export function readPerformance(v: unknown): ChunkPerformance {
  const o = (v ?? {}) as Partial<ChunkPerformance>;
  return {
    pace: o.pace ?? 'NORMAL',
    energy: o.energy ?? 'MEDIUM',
    emotion: o.emotion ?? 'NEUTRAL',
    pauses: ChunkPauses.catch({ before: 'NONE', after: 'NONE', inside: [] }).parse(o.pauses),
  };
}

// ── Pronunciation list ───────────────────────────────────────────────────────

export async function lexicon(db: Db, projectId: string, language: string): Promise<(LexiconEntry & { id: string })[]> {
  const rows = await db.voicePronunciation.findMany({ where: { projectId, language }, orderBy: { term: 'asc' } });
  return rows.map((r) => ({
    id: r.id,
    term: r.term,
    kind: r.kind as PronunciationTermKind,
    method: r.method as PronunciationMethod,
    pronunciation: r.pronunciation,
    status: r.status as PronunciationStatus,
    source: r.source as LexiconEntry['source'],
    hint: r.hint,
    edited: r.updatedBy !== null,
  }));
}

/** Adds what the narration contains and the list does not (pending), from the script's notes and detection; decisions already made are kept. */
export async function syncLexicon(db: Db, projectId: string, language: string, text: string, notes: readonly Pronunciation[]): Promise<void> {
  const existing = new Set((await db.voicePronunciation.findMany({ where: { projectId, language }, select: { term: true } })).map((r) => r.term));
  const fresh = proposeEntries(text, notes, existing);
  if (!fresh.length) return;
  await db.voicePronunciation.createMany({
    data: fresh.map((e) => ({ projectId, language, term: e.term, kind: e.kind, method: e.method, pronunciation: e.pronunciation, status: e.status, source: e.source, hint: e.hint })),
    skipDuplicates: true,
  });
}

export { unresolvedIn };

// ── Context and seeds ────────────────────────────────────────────────────────

/** The last sentences of a text, within `chars` (whole sentences only; empty when none fits). */
export function tailSentences(text: string, chars: number): string | null {
  if (chars <= 0) return null;
  const spans = sentenceSpans(text);
  let out = '';
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = text.slice(spans[i]!.start, spans[i]!.end);
    const next = out ? `${s} ${out}` : s;
    if (next.length > chars) break;
    out = next;
  }
  return out || null;
}

/** The first sentences of a text, within `chars`. */
export function headSentences(text: string, chars: number): string | null {
  if (chars <= 0) return null;
  let out = '';
  for (const span of sentenceSpans(text)) {
    const s = text.slice(span.start, span.end);
    const next = out ? `${out} ${s}` : s;
    if (next.length > chars) break;
    out = next;
  }
  return out || null;
}

/** A seed per chunk text and take number: the same take is reproducible, each regeneration differs. */
export function seedFor(textHash: string, generation: number): number {
  return Number.parseInt(createHash('sha256').update(`${textHash}:${generation}`).digest('hex').slice(0, 8), 16);
}

// ── Takes ────────────────────────────────────────────────────────────────────

/** A take's status as the editor reads it: a current take made before IN_REVIEW existed (GENERATED) is to review. */
export const takeStatus = (g: Pick<VoiceGeneration, 'id' | 'status'>, currentId: string | null): VoiceGenerationStatus => (g.status === 'GENERATED' && g.id === currentId ? 'IN_REVIEW' : g.status);

/** Decided or awaiting a decision: a take with audio a chunk can be heard with. */
const HEARD = new Set<VoiceGenerationStatus>(['IN_REVIEW', 'GENERATED', 'APPROVED', 'REJECTED']);

/** A current take the assembly places: stored audio of a measured length. */
export const usableTake = (g: VoiceGeneration | null): g is VoiceGeneration => !!g && !!g.audioAssetId && !!g.durationMs && HEARD.has(g.status);

// ── Live QA of a run ─────────────────────────────────────────────────────────

export type RunChunk = VoiceChunk & { current: VoiceGeneration | null };

export interface RunQaInput {
  kind: string;
  scriptVersion: number;
  approved: { id: string; version: number } | null;
  scriptId: string;
  chunks: readonly RunChunk[];
  /** Every block key of the run's script version (for completeness). */
  allBlockKeys: readonly string[];
  /** The current text of each block, for stale detection against the approved script (null when the run is of it). */
  approvedBlockText: ReadonlyMap<string, string> | null;
  unresolved: readonly string[];
}

/** QA of a run as it stands: per-take findings of its current takes, and the run-level checks. */
export function runQa(input: RunQaInput): VoiceQaFinding[] {
  const out: VoiceQaFinding[] = [];
  const add = (f: VoiceQaFinding) => out.push(f);
  if (input.approved && input.approved.id !== input.scriptId) {
    add({ kind: 'STALE_SCRIPT', severity: 'BLOCKING', ref: null, detail: `Audio generated from Script v${input.scriptVersion} — current script is v${input.approved.version}` });
  }
  for (const c of input.chunks) {
    const ref = `#${c.chunkIndex + 1}`;
    const take = c.current;
    if (!take) {
      add({ kind: 'GENERATION_FAILED', severity: 'BLOCKING', ref, detail: `Chunk ${c.chunkIndex + 1} has no usable take yet` });
      continue;
    }
    if (take.textHash !== c.textHash) add({ kind: 'STALE_TEXT', severity: 'BLOCKING', ref, detail: `Take ${take.generation} was made from other text than the chunk's (hash mismatch): it is never reused` });
    if (take.status === 'REJECTED') add({ kind: 'TAKE_REJECTED', severity: 'BLOCKING', ref, detail: `The current take (${take.generation}) was rejected: regenerate it or restore an earlier take` });
    else if (take.status === 'IN_REVIEW' || take.status === 'GENERATED') add({ kind: 'TAKE_UNREVIEWED', severity: 'BLOCKING', ref, detail: `Take ${take.generation} is not approved yet` });
    else if (take.status === 'FAILED' || take.status === 'PENDING' || take.status === 'GENERATING') add({ kind: 'GENERATION_FAILED', severity: 'BLOCKING', ref, detail: `Take ${take.generation} is ${take.status.toLowerCase()}` });
    const recorded = readQa(take.qa);
    if (HEARD.has(take.status) && (!take.audioAssetId || !take.durationMs) && !recorded.some((f) => f.kind === 'MISSING_AUDIO')) {
      add({ kind: 'MISSING_AUDIO', severity: 'BLOCKING', ref, detail: `Take ${take.generation} has no stored audio${take.audioAssetId ? ' of a measured length' : ''}: regenerate it` });
    }
    for (const f of recorded) out.push(f);
    if (input.approvedBlockText && staleChunk(c, input.approvedBlockText)) {
      add({ kind: 'STALE_TEXT', severity: 'BLOCKING', ref, detail: `The script's text for chunk ${c.chunkIndex + 1} changed in v${input.approved?.version}` });
    }
  }
  const covered = new Set(input.chunks.flatMap((c) => c.blockKeys));
  const missing = input.allBlockKeys.filter((k) => !covered.has(k));
  if (missing.length) add({ kind: 'INCOMPLETE_NARRATION', severity: 'BLOCKING', ref: null, detail: input.kind === 'FULL' ? `Blocks without narration: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}` : `${input.kind === 'AUDITION' ? 'An audition' : `A ${input.kind.toLowerCase()}`} run narrates ${covered.size} of ${input.allBlockKeys.length} blocks: only a full run can be approved as the narration` });
  if (input.unresolved.length) add({ kind: 'PRONUNCIATION_UNRESOLVED', severity: 'BLOCKING', ref: null, detail: `Pronunciations to decide: ${input.unresolved.join(', ')}` });
  return out;
}

/**
 * Stale: a source block of the chunk reads differently in another script
 * version (or is gone) — compared by the hash of each block's whole text, so
 * any change to a block, not only inside the chunk's own sentences, counts.
 */
export function staleChunk(c: Pick<VoiceChunk, 'blockHashes' | 'blockKeys'>, blockText: ReadonlyMap<string, string>): boolean {
  const hashes = (c.blockHashes ?? {}) as Record<string, string>;
  return c.blockKeys.some((k) => {
    const text = blockText.get(k);
    return text === undefined || !hashes[k] || sha256(text) !== hashes[k];
  });
}

/**
 * The latest assembly against the chunks' current takes: a chunk heard with
 * another take than its current one, or a usable take left out (or no
 * assembly at all), means the assembled narration is not what was reviewed.
 */
export function assemblyMismatch(chunks: readonly RunChunk[], assembly: { version: number; entries: unknown } | null): VoiceQaFinding | null {
  const entries = new Map(readEntries(assembly?.entries).map((e) => [e.chunkId, e.generationId]));
  const off = chunks.filter((c) => (usableTake(c.current) ? c.current.id : undefined) !== entries.get(c.id));
  if (!off.length) return null;
  const refs = off.map((c) => `#${c.chunkIndex + 1}`);
  return {
    kind: 'ASSEMBLY_MISMATCH',
    severity: 'BLOCKING',
    ref: off.length === 1 ? refs[0]! : null,
    detail: assembly
      ? `Assembly v${assembly.version} does not hold the current take of chunk(s) ${refs.join(', ')}: it is rebuilt when a voice job finishes or a take is restored`
      : `Chunk(s) ${refs.join(', ')} have takes but the run has no assembly yet: it is built when a voice job finishes or a take is restored`,
  };
}

// ── Assembly versions ────────────────────────────────────────────────────────

export function assemblyInput(chunks: readonly RunChunk[], script: VoiceScript): { chunks: AssemblyChunk[]; blocks: Map<string, AssemblyBlock> } {
  return {
    chunks: chunks.map((c) => ({
      id: c.id,
      index: c.chunkIndex,
      sectionKey: c.sectionKey,
      blockKeys: c.blockKeys,
      spans: readSpans(c.spans),
      text: c.sourceText,
      boundary: c.boundary as ChunkBoundary,
      pauses: readPerformance(c.performance).pauses,
      take: usableTake(c.current) ? { id: c.current.id, generation: c.current.generation, durationMs: c.current.durationMs!, alignment: readAlignment(c.current.alignment), audioAssetId: c.current.audioAssetId! } : null,
    })),
    blocks: new Map([...script.blocks.values()].map((b) => [b.key, { id: b.id, key: b.key, delivery: b.delivery, visual: b.visual }])),
  };
}

/**
 * A new assembly version when the run's current takes changed (the latest
 * is returned either way). It is to review once every chunk of the run has a
 * take to hear (a draft until then); `complete` says whether it narrates the
 * whole script, which only the VOICE gate needs.
 */
export async function rebuildAssembly(db: Db, runId: string, script: VoiceScript, actor: string): Promise<{ id: string; version: number; changed: boolean } | null> {
  const run = await db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } } } });
  const { chunks, blocks } = assemblyInput(run.chunks, script);
  if (!chunks.some((c) => c.take)) return null;
  const result = assemble(chunks, blocks);
  const latest = await db.voiceAssembly.findFirst({ where: { runId }, orderBy: { version: 'desc' } });
  if (latest && JSON.stringify(readEntries(latest.entries)) === JSON.stringify(readEntries(result.entries))) return { id: latest.id, version: latest.version, changed: false };
  const heard = chunks.every((c) => c.take);
  const covered = new Set(chunks.filter((c) => c.take).flatMap((c) => c.blockKeys));
  // A block split over chunks is narrated only when each of them is: every chunk needs its take.
  const complete = run.kind === 'FULL' && heard && [...script.blocks.keys()].every((k) => covered.has(k));
  if (latest) await db.voiceAssembly.updateMany({ where: { runId, status: { in: ['DRAFT', 'IN_REVIEW'] } }, data: { status: 'SUPERSEDED' } });
  const created = await db.voiceAssembly.create({
    data: {
      runId,
      projectId: run.projectId,
      scriptId: run.scriptId,
      profileId: run.profileId,
      version: (latest?.version ?? 0) + 1,
      status: heard ? 'IN_REVIEW' : 'DRAFT',
      entries: result.entries as unknown as Prisma.InputJsonValue,
      timeline: result.timeline as unknown as Prisma.InputJsonValue,
      totalDurationMs: result.totalDurationMs,
      complete,
      qa: result.findings as unknown as Prisma.InputJsonValue,
      createdBy: actor,
    },
  });
  return { id: created.id, version: created.version, changed: true };
}
