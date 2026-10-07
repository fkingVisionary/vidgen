import { AssemblyEntry, ChunkSpan, NarrationAlignment, NarrationSpine, NarrationTimelineEntry, VoiceQaFinding, narrationFingerprintText } from '@docengine/core';
import type { Database, Tx, VoiceAssembly, VoiceChunk, VoiceGeneration, VoiceRun } from '@docengine/database';
import { z } from 'zod';
import { takeStatus } from './runs.ts';
import { sha256 } from './text.ts';

/**
 * One assembly version as the storyboard reads it (the core NarrationSpine):
 * its entries, the run's chunks with their spans and canonical text, and the
 * takes the entries name — by entry.generationId, never a chunk's current
 * take, which moves when a take is regenerated or restored. Stored JSON is
 * read strictly: what does not parse, or rows that do not belong together,
 * is an error naming the row, never an empty list or a null. Nothing here
 * writes.
 */

type Db = Database | Tx;

/** Stored narration that cannot be read as it is: malformed JSON, or rows that do not belong together. */
export class SpineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpineError';
  }
}

/** Stored JSON read strictly: a value that does not parse is a SpineError saying what it is, never a default. */
export function readStrict<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.length ? i.path.map(String).join('.') : 'value'}: ${i.message}`);
  throw new SpineError(`${what} cannot be read (${issues.join('; ')}${parsed.error.issues.length > 3 ? '; …' : ''})`);
}

/** A run's scope as stored: the VoiceScope asked for, its description, and the block keys it resolved to (in script order). */
export const StoredRunScope = z.object({ blockKeys: z.array(z.string().min(1)) });

/**
 * The narration fingerprint: sha256 hex of the clips and their places. Equal
 * for identical entries whatever the assembly version (a RESTORE can rebuild
 * them); any other take, start, end or gap changes it.
 */
export const narrationFingerprint = (entries: Parameters<typeof narrationFingerprintText>[0]): string => sha256(narrationFingerprintText(entries));

/** The rows a spine is read from. */
export interface SpineRows {
  assembly: Pick<VoiceAssembly, 'id' | 'runId' | 'version' | 'status' | 'complete' | 'totalDurationMs' | 'profileId' | 'scriptId' | 'entries' | 'timeline'>;
  run: Pick<VoiceRun, 'id' | 'number' | 'kind' | 'scope' | 'languageVersionId'>;
  /** Every chunk of the run. */
  chunks: readonly Pick<VoiceChunk, 'id' | 'chunkIndex' | 'sectionKey' | 'spans' | 'sourceText' | 'textHash' | 'currentGenerationId'>[];
  /** At least the takes the entries name (any other is left out). */
  takes: readonly (Pick<VoiceGeneration, 'id' | 'chunkId' | 'generation' | 'status' | 'provider' | 'textHash' | 'durationMs' | 'alignment' | 'audioAssetId' | 'qa'> & { audioAsset: { isMock: boolean } | null })[];
}

const label = (rows: Pick<SpineRows, 'assembly' | 'run'>) => `Assembly v${rows.assembly.version} of voice run ${rows.run.number}`;
const entriesOf = (rows: Pick<SpineRows, 'assembly' | 'run'>) => readStrict(z.array(AssemblyEntry).min(1, 'no clips'), rows.assembly.entries, `${label(rows)}: its clips`);

/**
 * The spine of an assembly from its rows, checked: the clips are the run's
 * chunks in order, each once, and tile the clock from 0 to the assembly's
 * length with their pauses (no gap, no overlap); each entry's take is of its
 * chunk, of the chunk's text (its words are the text's) and of the clip's
 * length.
 */
export function spineOf(rows: SpineRows): NarrationSpine {
  const { assembly, run } = rows;
  const name = label(rows);
  if (assembly.runId !== run.id) throw new SpineError(`${name} belongs to another run`);
  const entries = entriesOf(rows);
  const timeline = readStrict(z.array(NarrationTimelineEntry), assembly.timeline, `${name}: its timeline`);
  const scope = readStrict(StoredRunScope, run.scope, `Voice run ${run.number}: its scope`);

  const chunks = [...rows.chunks]
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((c) => {
      const at = `Chunk ${c.chunkIndex + 1} of voice run ${run.number}`;
      const spans = readStrict(z.array(ChunkSpan).min(1, 'no spans'), c.spans, `${at}: its spans`);
      // The canonical text is the spans verbatim, one line break between blocks: word offsets map back to blocks through them.
      const length = spans.reduce((n, s) => n + s.end - s.start, 0) + spans.length - 1;
      if (spans.some((s) => s.end < s.start) || length !== c.sourceText.length) throw new SpineError(`${at}: its text (${c.sourceText.length} characters) is not its spans (${length})`);
      return { row: c, spine: { id: c.id, index: c.chunkIndex, sectionKey: c.sectionKey, spans, sourceText: c.sourceText } };
    });
  const chunkById = new Map(chunks.map((c) => [c.row.id, c.row]));
  const takeById = new Map(rows.takes.map((t) => [t.id, t]));

  const takes = new Map<string, NarrationSpine['takes'][number]>();
  // Where the narration so far ends (the last clip and its pause), and the last chunk heard.
  let clock = 0;
  let previous = -1;
  for (const e of entries) {
    const at = `${name}, chunk ${e.chunkIndex + 1}`;
    const chunk = chunkById.get(e.chunkId);
    if (!chunk) throw new SpineError(`${at}: the chunk is not in the run`);
    if (chunk.chunkIndex !== e.chunkIndex || chunk.sectionKey !== e.sectionKey) throw new SpineError(`${at}: the run has this chunk as chunk ${chunk.chunkIndex + 1} of section ${chunk.sectionKey}`);
    // A chunk heard twice, or out of order, would put its words on the clock twice or backwards.
    if (chunk.chunkIndex <= previous) throw new SpineError(`${at}: the clip comes after chunk ${previous + 1}'s (clips are in chunk order, each chunk once)`);
    if (e.startMs !== clock) throw new SpineError(`${at}: the clip starts at ${e.startMs} ms, where the narration ${previous < 0 ? 'starts' : 'before it ends'} at ${clock} ms`);
    previous = chunk.chunkIndex;
    clock = e.endMs + e.gapAfterMs;
    const g = takeById.get(e.generationId);
    if (!g) throw new SpineError(`${at}: take ${e.generationId} is missing`);
    if (g.chunkId !== chunk.id) throw new SpineError(`${at}: take ${g.generation} is another chunk's`);
    // Word offsets are in the take's text: a take of other text would put words in the wrong blocks.
    if (g.textHash !== chunk.textHash) throw new SpineError(`${at}: take ${g.generation} was made from other text than the chunk's`);
    if (g.durationMs !== e.endMs - e.startMs) throw new SpineError(`${at}: the clip lasts ${e.endMs - e.startMs} ms in the assembly, take ${g.generation} measures ${g.durationMs ?? 'nothing'}`);
    const alignment = readStrict(NarrationAlignment.nullable(), g.alignment ?? null, `${at}: the word timings of take ${g.generation}`);
    const astray = alignment?.words.find((w) => chunk.sourceText.slice(w.start, w.end) !== w.word);
    if (astray) throw new SpineError(`${at}: the word timings of take ${g.generation} do not fit the chunk's text ("${astray.word}" at characters ${astray.start}–${astray.end})`);
    const qa = readStrict(z.array(VoiceQaFinding), g.qa ?? [], `${at}: the QA of take ${g.generation}`);
    takes.set(g.id, {
      id: g.id,
      chunkId: g.chunkId,
      status: takeStatus(g, chunk.currentGenerationId),
      durationMs: g.durationMs,
      alignment,
      audioAssetId: g.audioAssetId,
      mock: (g.audioAsset?.isMock ?? g.provider === 'mock') || alignment?.source === 'MOCK',
      qaBlocking: qa.some((f) => f.severity === 'BLOCKING'),
    });
  }
  if (assembly.totalDurationMs !== clock) throw new SpineError(`${name}: it lasts ${assembly.totalDurationMs} ms, its clips and pauses ${clock} ms`);

  // Assemblies made before audio files were recorded in them get theirs from the take.
  const asset = (takeId: string, known: string | undefined) => {
    const id = known ?? takes.get(takeId)?.audioAssetId;
    return id ? { audioAssetId: id } : {};
  };
  return readStrict(
    NarrationSpine,
    {
      assembly: {
        id: assembly.id,
        runId: assembly.runId,
        version: assembly.version,
        status: assembly.status,
        complete: assembly.complete,
        totalDurationMs: assembly.totalDurationMs,
        fingerprint: narrationFingerprint(entries),
        profileId: assembly.profileId,
        scriptId: assembly.scriptId,
        languageVersionId: run.languageVersionId,
      },
      run: { id: run.id, number: run.number, kind: run.kind, scopeBlockKeys: scope.blockKeys },
      entries: entries.map((e) => ({ ...e, ...asset(e.generationId, e.audioAssetId) })),
      chunks: chunks.map((c) => c.spine),
      takes: [...takes.values()],
      timeline: timeline.map((t) => ({ ...t, audioChunk: { ...t.audioChunk, ...asset(t.audioChunk.generationId, t.audioChunk.audioAssetId) } })),
    },
    name,
  );
}

/** The spine of one assembly version (an older one too), or null when there is none; throws a SpineError when its rows cannot be read. */
export async function narrationSpine(db: Db, assemblyId: string): Promise<NarrationSpine | null> {
  const assembly = await db.voiceAssembly.findUnique({
    where: { id: assemblyId },
    include: { run: { include: { chunks: { orderBy: { chunkIndex: 'asc' }, select: { id: true, chunkIndex: true, sectionKey: true, spans: true, sourceText: true, textHash: true, currentGenerationId: true } } } } },
  });
  if (!assembly) return null;
  const { run } = assembly;
  const ids = [...new Set(entriesOf({ assembly, run }).map((e) => e.generationId))];
  const takes = await db.voiceGeneration.findMany({
    where: { id: { in: ids } },
    select: { id: true, chunkId: true, generation: true, status: true, provider: true, textHash: true, durationMs: true, alignment: true, audioAssetId: true, qa: true, audioAsset: { select: { isMock: true } } },
  });
  return spineOf({ assembly, run, chunks: run.chunks, takes });
}
