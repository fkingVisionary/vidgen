import type { ScriptBlockClass } from '@docengine/core';
import { voiceAdapterFor } from '@docengine/providers';
import { sectionDurationSec, type DraftBlock, type ScriptDraft } from './draft.ts';

/**
 * Comparing two script versions, section by section: which block texts are
 * the same, removed or added (a longest-common-subsequence diff over the
 * blocks' words). Read-only.
 */

export interface DiffLine {
  op: 'same' | 'removed' | 'added';
  text: string;
  infoClass: ScriptBlockClass;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

export function diffBlocks(a: readonly DraftBlock[], b: readonly DraftBlock[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = norm(a[i]!.text) === norm(b[j]!.text) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && norm(a[i]!.text) === norm(b[j]!.text)) {
      out.push({ op: 'same', text: b[j]!.text, infoClass: b[j]!.infoClass });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ op: 'added', text: b[j]!.text, infoClass: b[j]!.infoClass });
      j++;
    } else {
      out.push({ op: 'removed', text: a[i]!.text, infoClass: a[i]!.infoClass });
      i++;
    }
  }
  return out;
}

export function compareDrafts(a: ScriptDraft, b: ScriptDraft) {
  const numbers = [...new Set([...a.sections.map((s) => s.sequence), ...b.sections.map((s) => s.sequence)])].sort((x, y) => x - y);
  const sections = numbers.map((n) => {
    const sa = a.sections.find((s) => s.sequence === n);
    const sb = b.sections.find((s) => s.sequence === n);
    const diff = diffBlocks(sa?.blocks ?? [], sb?.blocks ?? []);
    return {
      sequenceNumber: n,
      title: sb?.title ?? sa?.title ?? `Section ${n}`,
      changed: diff.some((d) => d.op !== 'same'),
      durationSec: { a: sa ? sectionDurationSec(sa) : 0, b: sb ? sectionDurationSec(sb) : 0 },
      diff,
    };
  });
  const words = (d: ScriptDraft) => d.sections.reduce((n, s) => n + s.blocks.reduce((m, x) => m + x.wordCount, 0), 0);
  const duration = (d: ScriptDraft) => Math.round(d.sections.reduce((n, s) => n + sectionDurationSec(s), 0) * 10) / 10;
  return { sections, totals: { wordsA: words(a), wordsB: words(b), durationA: duration(a), durationB: duration(b), sectionsChanged: sections.filter((s) => s.changed).length } };
}

/** What the planned voice provider would receive for a version (no audio is generated). */
export function voicePlan(draft: ScriptDraft, provider = 'elevenlabs') {
  return voiceAdapterFor(provider).render(
    draft.sections.map((s) => ({ key: s.key, blocks: s.blocks })),
    draft.pronunciations,
  );
}
