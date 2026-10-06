import { VoiceProfileRef, type NarrationAlignment, type PerformanceCheck, type SpokenForm, type VoiceQaFinding } from '@docengine/core';
import { z } from 'zod';
import { profileLabel } from './config.ts';
import { unspokenLeft } from './spoken.ts';
import { countWords } from './text.ts';

/**
 * Deterministic voice QA. Per take: audio and timestamps present and
 * complete, a plausible speaking rate, no long silences, spoken forms worth
 * hearing, performance warnings. Per run: failed, rejected or unreviewed
 * takes, takes of other text, missing or duplicated chunks, stale script,
 * unresolved pronunciations, incomplete narration, current takes made with
 * another voice than their run's. BLOCKING findings stop
 * the final (VOICE gate) approval; they never hide a take from review.
 */

/** Documentary narration runs about 130–170 words a minute; far outside means truncated, garbled or padded audio. */
export const RATE_LIMITS = { warnBelow: 100, warnAbove: 200, blockBelow: 70, blockAbove: 260 } as const;
export const SILENCE_LIMITS = { leadingMs: 1200, trailingMs: 1500, insideMs: 2500 } as const;

export interface TakeQaInput {
  ref: string;
  canonical: string;
  durationMs: number | null;
  hasAudio: boolean;
  alignment: NarrationAlignment | null;
  forms: readonly SpokenForm[];
  spokenText: string;
  checks: readonly PerformanceCheck[];
  mock: boolean;
}

export function takeQa(t: TakeQaInput): VoiceQaFinding[] {
  const out: VoiceQaFinding[] = [];
  const add = (kind: VoiceQaFinding['kind'], severity: VoiceQaFinding['severity'], detail: string) => out.push({ kind, severity, ref: t.ref, detail });
  if (!t.hasAudio || !t.durationMs) add('MISSING_AUDIO', 'BLOCKING', 'The take has no stored audio');
  if (t.mock) add('MOCK_AUDIO', 'WARNING', 'MOCK audio (a beep and silence): no speech was synthesised');

  const words = countWords(t.canonical);
  // The rate is of what the voice says: "1637" is two spoken words ("sixteen thirty-seven"), "ƒ3,000" three.
  const spoken = countWords(t.spokenText) || words;
  if (!t.alignment) add('MISSING_ALIGNMENT', 'BLOCKING', 'No timestamps came back: the take cannot be placed on the narration timeline');
  else if (t.alignment.unmatchedWords > 0) {
    const share = t.alignment.unmatchedWords / Math.max(1, words);
    add('ALIGNMENT_INCOMPLETE', share > 0.1 ? 'BLOCKING' : 'WARNING', `${t.alignment.unmatchedWords} of ${words} word(s) have no timestamp${share > 0.1 ? ': words may be missing from the audio' : ''}`);
  }

  if (t.durationMs && t.alignment?.words.length) {
    const first = t.alignment.words[0]!;
    const last = t.alignment.words.at(-1)!;
    const speechMs = Math.max(1, last.endMs - first.startMs);
    const wpm = Math.round((spoken / speechMs) * 60_000);
    if (wpm < RATE_LIMITS.blockBelow || wpm > RATE_LIMITS.blockAbove) add('DURATION_ANOMALY', 'BLOCKING', `${wpm} words a minute over ${(speechMs / 1000).toFixed(1)} s: far outside narration pace — listen for missing, repeated or garbled words`);
    else if (wpm < RATE_LIMITS.warnBelow || wpm > RATE_LIMITS.warnAbove) add('DURATION_ANOMALY', 'WARNING', `${wpm} words a minute: ${wpm < RATE_LIMITS.warnBelow ? 'slow' : 'fast'} for documentary narration`);
    if (first.startMs > SILENCE_LIMITS.leadingMs) add('EXCESSIVE_SILENCE', 'WARNING', `${(first.startMs / 1000).toFixed(1)} s of silence before the first word`);
    const trailing = t.durationMs - last.endMs;
    if (trailing > SILENCE_LIMITS.trailingMs) add('EXCESSIVE_SILENCE', 'WARNING', `${(trailing / 1000).toFixed(1)} s of silence after the last word`);
    for (let i = 1; i < t.alignment.words.length; i++) {
      const gap = t.alignment.words[i]!.startMs - t.alignment.words[i - 1]!.endMs;
      if (gap > SILENCE_LIMITS.insideMs) add('EXCESSIVE_SILENCE', 'WARNING', `${(gap / 1000).toFixed(1)} s of silence before "${t.alignment.words[i]!.word}"`);
    }
  } else if (t.durationMs && spoken) {
    const wpm = Math.round((spoken / t.durationMs) * 60_000);
    if (wpm < RATE_LIMITS.blockBelow || wpm > RATE_LIMITS.blockAbove) add('DURATION_ANOMALY', 'BLOCKING', `${wpm} words a minute (whole clip): far outside narration pace`);
  }

  for (const f of t.forms.filter((x) => x.confidence === 'MEDIUM')) add('SPOKEN_FORM_CHECK', 'WARNING', `"${f.display}" was read as "${f.spoken}" — check it`);
  const left = unspokenLeft(t.spokenText);
  if (left.length) add('SPOKEN_FORM_CHECK', 'WARNING', `left as written (no spoken form): ${left.join(', ')}`);
  for (const c of t.checks.filter((x) => x.status !== 'PASS')) add('PERFORMANCE_CHECK', c.status === 'FAIL' ? 'BLOCKING' : 'WARNING', `${c.label}: ${c.detail}`);
  return out;
}

export const blockingCount = (fs: readonly VoiceQaFinding[]) => fs.filter((f) => f.severity === 'BLOCKING').length;

/** As much of a take's stored configuration (VoiceTakeConfig) as a finding needs; a take made before saved profiles has none. */
const StoredDifference = z.object({ base: z.enum(['RUN', 'PRODUCTION']), override: z.unknown().nullable(), profile: VoiceProfileRef, differs: z.array(z.string()), identityDiffers: z.boolean() });

/**
 * A WARNING per chunk whose current take was made with another voice than
 * its run's (the production profile, or a temporary override of a provider
 * setting), from what the take stored when it was asked for. Performance
 * differences (strategy, context, rules) are per-take choices, not findings.
 */
export function configurationFindings(chunks: readonly { chunkIndex: number; current: { generation: number; config: unknown } | null }[]): VoiceQaFinding[] {
  const out: VoiceQaFinding[] = [];
  for (const c of chunks) {
    const stored = StoredDifference.safeParse(c.current?.config ?? null);
    if (!c.current || !stored.success || !stored.data.identityDiffers) continue;
    const t = stored.data;
    const made = t.base === 'PRODUCTION' ? `the production profile ${profileLabel(t.profile)}${t.override ? ' with a temporary override' : ''}` : 'a temporary override';
    out.push({ kind: 'CONFIGURATION_DIFFERS', severity: 'WARNING', ref: `#${c.chunkIndex + 1}`, detail: `Chunk ${c.chunkIndex + 1}'s take ${c.current.generation} was made with ${made}: ${t.differs.join(', ')}` });
  }
  return out;
}
