import { SCRIPT_TIMING, type PauseLength, type PerformanceIntent } from '@docengine/core';
import type { PerformanceSegment, RenderedNarration, VoiceModelCapabilities } from './voice.ts';

/**
 * Rendering a chunk's sentences in a model's markup. Shared by providers
 * whose models take bracketed natural-language directions ("audio tags",
 * e.g. `[reflective, intimate]`) or SSML pauses. Sentence text is inserted
 * verbatim; every piece of markup is recorded by range so the engine can
 * check it before anything is sent.
 *
 * - Directions go immediately before the sentence they colour, as one
 *   bracket of plain words (the emotion, then how it is said); a vocal
 *   action is its own bracket.
 * - Pauses inside a chunk: `[pause]` / `[long pause]` for tag models,
 *   `<break time="…"/>` for SSML models, a line break otherwise — never SSML
 *   for a model that does not take it.
 * - Directions are words only: an intensity above low, and stress on a word
 *   (which a tag model could only give by changing the word, e.g. capitals),
 *   are reported as not expressed rather than dropped silently.
 */

/** The words of a direction, in order: emotion, then delivery. */
export function directionWords(intent: PerformanceIntent): string[] {
  return [intent.emotion, intent.delivery].filter((w): w is string => !!w);
}

const BREAK_SEC: Record<PauseLength, number> = SCRIPT_TIMING.pauseSec;
const MAX_BREAK_SEC = 3;

function pauseMarkup(length: PauseLength, mode: VoiceModelCapabilities['pauses']): { text: string; markup: boolean } {
  if (length === 'NONE' || length === 'MICRO') return { text: ' ', markup: false };
  if (mode === 'TAGS') {
    if (length === 'SHORT') return { text: '\n', markup: false };
    return { text: length === 'LONG' ? '[long pause]' : '[pause]', markup: true };
  }
  if (mode === 'BREAKS') return { text: `<break time="${Math.min(BREAK_SEC[length], MAX_BREAK_SEC).toFixed(1)}s" />`, markup: true };
  return { text: '\n', markup: false };
}

export function renderSegments(segments: readonly PerformanceSegment[], caps: Pick<VoiceModelCapabilities, 'directions' | 'pauses'>): RenderedNarration {
  let text = '';
  const ranges: RenderedNarration['segments'] = [];
  const markup: RenderedNarration['markup'] = [];
  const unsupported: string[] = [];
  const mark = (s: string, kind: 'DIRECTION' | 'PAUSE') => {
    markup.push({ start: text.length, end: text.length + s.length, kind });
    text += s;
  };
  const intense = new Map<string, number[]>();
  segments.forEach((seg, i) => {
    if (seg.intent) {
      const words = directionWords(seg.intent);
      if (caps.directions) {
        if (seg.intent.vocalAction) {
          mark(`[${seg.intent.vocalAction}]`, 'DIRECTION');
          text += ' ';
        }
        if (words.length) {
          mark(`[${words.join(', ')}]`, 'DIRECTION');
          text += ' ';
        }
        if (seg.intent.intensity !== 'LOW' && (words.length || seg.intent.vocalAction)) intense.set(seg.intent.intensity, [...(intense.get(seg.intent.intensity) ?? []), i + 1]);
      } else if (words.length || seg.intent.vocalAction) {
        unsupported.push(`sentence ${i + 1}: direction "${[seg.intent.vocalAction, ...words].filter(Boolean).join(', ')}" (the model takes no directions)`);
      }
    }
    for (const e of seg.emphasis ?? []) unsupported.push(`sentence ${i + 1}: ${e.level.toLowerCase()} stress on "${seg.text.slice(e.start, e.end)}" (not expressed: the words are sent as written)`);
    ranges.push({ start: text.length, end: text.length + seg.text.length });
    text += seg.text;
    if (i < segments.length - 1) {
      const p = pauseMarkup(seg.pauseAfter, caps.pauses);
      if (p.markup) {
        text += ' ';
        mark(p.text, 'PAUSE');
        text += ' ';
      } else text += p.text;
    }
  });
  for (const [level, at] of intense) unsupported.push(`${level.toLowerCase()} intensity on sentence${at.length > 1 ? 's' : ''} ${at.join(', ')} (not expressed: only the direction's words are sent)`);
  return { text, segments: ranges, markup, unsupported };
}

/** The text without its markup (what is spoken), for counts and context fields. */
export function stripMarkup(rendered: Pick<RenderedNarration, 'text' | 'markup'>): string {
  let out = '';
  let at = 0;
  for (const m of [...rendered.markup].sort((a, b) => a.start - b.start)) {
    out += rendered.text.slice(at, m.start);
    at = m.end;
  }
  return (out + rendered.text.slice(at)).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}
