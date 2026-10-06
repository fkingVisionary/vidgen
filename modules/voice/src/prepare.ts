import { EARLIER_PERFORMANCE_RULES, type ChunkPerformance, type DirectorMark, type PerformanceRules, type PerformanceStrategy, type PreparedNarration, type ProviderSettingValues, type ScriptBlockClass, type ScriptDelivery, type SpokenForm } from '@docengine/core';
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
  provider: Pick<VoiceProvider, 'render' | 'capabilities' | 'settings' | 'sentSettings'>;
  model: string;
  /** Normalised provider settings (the take's effective `providerSettings`). */
  settings: ProviderSettingValues;
  context: { previousText: string | null; nextText: string | null };
  seed: number | null;
  /** The take's performance rules (default EARLIER_PERFORMANCE_RULES: every existing call is unchanged). */
  rules?: PerformanceRules;
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

/**
 * The chunk's pace on the provider's speed setting (role SPEED), where the
 * model is sent it: the setting times the rules' factor, to 0.01, kept
 * within the setting's range. Null when the model takes no speed.
 */
function pacedSpeed(input: PrepareTakeInput, pace: 'SLOW' | 'FAST', rules: PerformanceRules): { key: string; value: number } | null {
  const d = input.provider.settings.find((s) => s.role === 'SPEED');
  const value = d ? input.settings[d.key] : undefined;
  if (!d || typeof value !== 'number' || !Object.hasOwn(input.provider.sentSettings(input.settings, input.model).sent, d.key)) return null;
  return { key: d.key, value: Math.min(d.max ?? Number.POSITIVE_INFINITY, Math.max(d.min ?? Number.NEGATIVE_INFINITY, Math.round(value * rules.paceSpeed[pace] * 100) / 100)) };
}

export function prepareTake(input: PrepareTakeInput): PreparedTake {
  const { chunk } = input;
  const rules = input.rules ?? EARLIER_PERFORMANCE_RULES;
  const spoken = toSpoken(chunk.text, { style: input.numberStyle, aliases: input.aliases });
  // A sentence never ends inside a spoken form (forms are numbers, dates and terms, sentences end at their punctuation).
  const spokenSentences = chunk.sentences.map((s) => ({ start: canonicalToSpoken(spoken.forms, s.start), end: canonicalToSpoken(spoken.forms, s.end) }));
  const sentences: PreparedSentence[] = chunk.sentences.map((s, i) => {
    const block = input.blocks.get(s.blockKey);
    if (!block) throw new Error(`prepareTake: block ${s.blockKey} is not in the script`);
    return { text: chunk.text.slice(s.start, s.end), blockKey: s.blockKey, delivery: block.delivery, infoClass: block.infoClass, blockStart: i === 0 || chunk.sentences[i - 1]!.blockKey !== s.blockKey };
  });
  const marks = performanceMarks(sentences, input.strategy, chunk.performance.pauses, input.director, rules);
  const pauses = strategyPauses(input.strategy, sentencePauses(sentences.length, chunk.performance.pauses));
  const segments: PerformanceSegment[] = spokenSentences.map((s, i) => {
    const emphasis = sentenceEmphasis(chunk, i, sentences[i]!.delivery, spoken.forms, s.start);
    return { text: spoken.text.slice(s.start, s.end), intent: marks.find((m) => m.sentence === i)?.intent ?? null, pauseAfter: pauses[i]!, ...(emphasis.length ? { emphasis } : {}) };
  });
  const rendered = input.provider.render(segments, input.model);
  const caps = input.provider.capabilities(input.model);

  const unsupported = [...rendered.unsupported];
  // Every setting is kept (what the model is not sent too); only the speed takes the chunk's pace.
  const settings: ProviderSettingValues = { ...input.settings };
  const pace = chunk.performance.pace;
  if (pace !== 'NORMAL') {
    const speed = pacedSpeed(input, pace, rules);
    if (speed) settings[speed.key] = speed.value;
    else if (input.strategy !== 'PLAIN' && !marks.length) unsupported.push(`${pace.toLowerCase()} pace: the model has no speed setting (left to the text)`);
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
    rules,
  });
  const prepared: PreparedNarration = {
    strategy: input.strategy,
    spokenForms: spoken.forms,
    marks,
    pauses: chunk.performance.pauses,
    context: input.context,
    settings,
    sent: input.provider.sentSettings(settings, input.model).sent,
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
