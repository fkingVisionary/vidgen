import type { ChunkPerformance, DirectorMark, PerformanceStrategy, PreparedNarration, ScriptBlockClass, ScriptDelivery, SpokenForm, VoiceProfileSettings } from '@docengine/core';
import type { PerformanceSegment, PronunciationRule, RenderedNarration, VoiceProvider } from '@docengine/providers';
import { checkTake } from './checks.ts';
import type { ChunkSentence } from './chunking.ts';
import { performanceMarks, sentencePauses, strategyPauses, type PreparedSentence } from './performance.ts';
import { canonicalToSpoken, toSpoken, type AliasRule, type NumberStyle } from './spoken.ts';
import type { TextSpan } from './text.ts';

/**
 * One take's derived representation, from the canonical chunk text: spoken
 * forms → performance directions → the provider's markup → checks. Pure;
 * nothing is sent. The result is stored with the take, so what was sent and
 * how it was derived from the script can always be shown.
 */

export interface TakeChunk {
  text: string;
  sentences: readonly ChunkSentence[];
  performance: ChunkPerformance;
}

export interface TakeBlock {
  delivery: ScriptDelivery;
  infoClass: ScriptBlockClass;
}

export interface PrepareTakeInput {
  chunk: TakeChunk;
  blocks: ReadonlyMap<string, TakeBlock>;
  strategy: PerformanceStrategy;
  director?: readonly DirectorMark[];
  numberStyle: NumberStyle;
  aliases: readonly AliasRule[];
  phonemes: readonly PronunciationRule[];
  provider: Pick<VoiceProvider, 'render' | 'capabilities'>;
  model: string;
  settings: VoiceProfileSettings;
  context: { previousText: string | null; nextText: string | null };
  seed: number | null;
}

export interface PreparedTake {
  spokenText: string;
  /** Each sentence's range in the spoken text. */
  spokenSentences: TextSpan[];
  segments: PerformanceSegment[];
  rendered: RenderedNarration;
  prepared: PreparedNarration;
  /** Phoneme rules to send (empty when the model takes none). */
  phonemes: PronunciationRule[];
  passed: boolean;
}

/** Pace as a speed multiplier, for models that take a speed. */
const PACE_SPEED = { SLOW: 0.94, NORMAL: 1, FAST: 1.06 } as const;

export function prepareTake(input: PrepareTakeInput): PreparedTake {
  const { chunk } = input;
  const spoken = toSpoken(chunk.text, { style: input.numberStyle, aliases: input.aliases });
  // A sentence never ends inside a spoken form (forms are numbers, dates and terms, sentences end at their punctuation).
  const spokenSentences = chunk.sentences.map((s) => ({ start: canonicalToSpoken(spoken.forms, s.start), end: canonicalToSpoken(spoken.forms, s.end) }));
  const sentences: PreparedSentence[] = chunk.sentences.map((s, i) => {
    const block = input.blocks.get(s.blockKey);
    if (!block) throw new Error(`prepareTake: block ${s.blockKey} is not in the script`);
    return { text: chunk.text.slice(s.start, s.end), blockKey: s.blockKey, delivery: block.delivery, infoClass: block.infoClass, blockStart: i === 0 || chunk.sentences[i - 1]!.blockKey !== s.blockKey };
  });
  const marks = performanceMarks(sentences, input.strategy, chunk.performance.pauses, input.director);
  const pauses = strategyPauses(input.strategy, sentencePauses(sentences.length, chunk.performance.pauses));
  const segments: PerformanceSegment[] = spokenSentences.map((s, i) => {
    const emphasis = sentenceEmphasis(chunk, i, sentences[i]!.delivery, spoken.forms, s.start);
    return { text: spoken.text.slice(s.start, s.end), intent: marks.find((m) => m.sentence === i)?.intent ?? null, pauseAfter: pauses[i]!, ...(emphasis.length ? { emphasis } : {}) };
  });
  const rendered = input.provider.render(segments, input.model);
  const caps = input.provider.capabilities(input.model);

  const unsupported = [...rendered.unsupported];
  const settings = { ...input.settings };
  if (chunk.performance.pace !== 'NORMAL') {
    if (caps.settings.speed) settings.speed = Math.min(1.2, Math.max(0.7, Math.round(settings.speed * PACE_SPEED[chunk.performance.pace] * 100) / 100));
    else if (input.strategy !== 'PLAIN' && !marks.length) unsupported.push(`${chunk.performance.pace.toLowerCase()} pace: the model has no speed setting (left to the text)`);
  }
  const phonemes = caps.phonemes ? [...input.phonemes] : [];
  if (!caps.phonemes && input.phonemes.length) unsupported.push(`phoneme pronunciations not applied (the model takes none): ${input.phonemes.map((p) => p.term).join(', ')}`);
  const checks = checkTake({
    canonical: chunk.text,
    forms: spoken.forms,
    spoken: spoken.text,
    spokenSentences,
    rendered: { ...rendered, unsupported },
    marks,
    sentences,
    strategy: input.strategy,
    director: !!input.director?.length,
    caps,
  });
  const prepared: PreparedNarration = {
    strategy: input.strategy,
    spokenForms: spoken.forms,
    marks,
    pauses: chunk.performance.pauses,
    context: input.context,
    settings,
    seed: input.seed,
    dictionary: phonemes.map((p) => ({ term: p.term, method: p.method, pronunciation: p.pronunciation })),
    unsupported,
    checks,
  };
  return { spokenText: spoken.text, spokenSentences, segments, rendered, prepared, phonemes, passed: checks.every((c) => c.status !== 'FAIL') };
}

/** The script's stressed words in one sentence of the chunk, as ranges of the sentence's spoken text (the first occurrence of each; a spoken form is stressed whole). */
function sentenceEmphasis(chunk: TakeChunk, i: number, delivery: ScriptDelivery, forms: readonly SpokenForm[], spokenStart: number): NonNullable<PerformanceSegment['emphasis']> {
  const s = chunk.sentences[i]!;
  const text = chunk.text.slice(s.start, s.end);
  const toEnd = (offset: number) => canonicalToSpoken(forms, forms.find((f) => offset > f.start && offset < f.end)?.end ?? offset);
  const out: NonNullable<PerformanceSegment['emphasis']> = [];
  for (const e of delivery.emphasis) {
    const at = text.indexOf(e.text);
    if (at < 0) continue;
    out.push({ start: canonicalToSpoken(forms, s.start + at) - spokenStart, end: toEnd(s.start + at + e.text.length) - spokenStart, level: e.level });
  }
  return out.sort((a, b) => a.start - b.start);
}
