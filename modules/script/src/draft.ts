import {
  DEFAULT_DELIVERY,
  blockDurationSec,
  spokenWordCount,
  type BlockPresentation,
  type Pronunciation,
  type ScriptBlockContent,
  type ScriptDelivery,
  type ScriptSectionPlan,
  type SectionReviewStatus,
} from '@docengine/core';
import { SECOND_PERSON, checkFigures, orderedKeys, wordTokens } from '@docengine/story/shared';
import type { PerformanceOutput, ScriptPatch, WriterBlock, WriterOutput } from './schemas.ts';
import { fictionalCast, type ScriptScope } from './scope.ts';

/**
 * A script version in memory: sections (one per architecture sequence) of
 * narration blocks. Built from the writer's output, changed by reviewer
 * patches and the performance pass, then checked by the rules and saved.
 * Everything derived — durations, presentation, fiction markers — is
 * recomputed here, never taken from a model.
 */

export interface DraftBlock extends ScriptBlockContent {
  /** Database id, when loaded from a saved version. */
  rowId?: string;
  /** The text as generated (kept when the editor changes it). */
  generatedText: string;
  editedBy: string | null;
  editedAt: string | null;
  /** Poses or answers the central question (tracked with the block through patches and edits). */
  centralQuestion: 'POSED' | 'ANSWERED' | null;
}

export interface DraftSection {
  /** Database id (the scene), when loaded from a saved version. */
  rowId?: string;
  sequence: number;
  /** "SC03" */
  key: string;
  title: string;
  plan: ScriptSectionPlan | null;
  reviewStatus: SectionReviewStatus;
  editorNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** The architecture's estimate for the sequence. */
  targetDurationSec: number | null;
  blocks: DraftBlock[];
  /** Written in this version; false when copied unchanged from the base version. */
  written: boolean;
}

export interface ScriptDraft {
  sections: DraftSection[];
  pronunciations: Pronunciation[];
}

export const sectionKey = (sequence: number) => `SC${String(sequence).padStart(2, '0')}`;
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Fictional devices named in a text: composites by name, the viewer's POV by "you" (only when the architecture has one). */
export function fictionalMentions(text: string, scope: ScriptScope): string[] {
  const words = new Set(wordTokens(text));
  const out: string[] = [];
  for (const c of fictionalCast(scope)) {
    if (c.member.kind === 'POV_PROXY') {
      if (SECOND_PERSON.test(text)) out.push(c.member.id);
    } else if (c.tokens.some((t) => words.has(t))) out.push(c.member.id);
  }
  return out;
}

/** Recompute everything derived from a block's text, class, claims and delivery. */
export function derive(b: DraftBlock, scope: ScriptScope): DraftBlock {
  const speaker = b.speakerId ? scope.cast.get(b.speakerId) : undefined;
  const fictionalDevice = b.infoClass === 'FICTION' || Boolean(speaker?.fictional) || fictionalMentions(b.text, scope).length > 0;
  const presentation: BlockPresentation[] = b.claimKeys.flatMap((k) => {
    const p = scope.presentation.get(k);
    return p ? [{ claimKey: k, ...p }] : [];
  });
  // Emphasis must point at words that are in the text.
  const emphasis = b.delivery.emphasis.filter((e) => e.text.trim() && b.text.includes(e.text.trim())).map((e) => ({ ...e, text: e.text.trim() }));
  const delivery: ScriptDelivery = { ...b.delivery, emphasis };
  return {
    ...b,
    fictionalDevice,
    presentation,
    delivery,
    visual: { ...b.visual, fictional: fictionalDevice },
    wordCount: spokenWordCount(b.text),
    estimatedDurationSec: blockDurationSec(b.text, delivery),
  };
}

/**
 * A block as the writer (or a reviewer) wrote it, normalized: unknown claim
 * keys and beat ids dropped (noted), a figure found in another claim of the
 * architecture links that claim (traceability), visual details keep only
 * claims of the architecture.
 */
export function normalizeBlock(raw: WriterBlock, scope: ScriptScope, notes: string[], at: string): DraftBlock {
  const text = clean(raw.text);
  const claimKeys = orderedKeys(raw.claimKeys.map((k) => k.trim()), scope.evidence);
  const unknownClaims = raw.claimKeys.filter((k) => !scope.evidence.has(k.trim()));
  if (unknownClaims.length) notes.push(`${at}: ${unknownClaims.join(', ')} not in the approved dossier; dropped`);
  const beatIds = [...new Set(raw.beatIds.map((b) => b.trim()))].filter((id) => {
    if (scope.beats.has(id)) return true;
    notes.push(`${at}: beat ${id} is not in the architecture; dropped`);
    return false;
  });
  // A figure the text uses that another architecture claim has: link that claim (the rules judge the rest).
  if (raw.infoClass !== 'FRAMING' && raw.infoClass !== 'FICTION') {
    const figures = checkFigures([text], claimKeys, scope.evidence, { linkFrom: scope.claims, strictYears: true });
    for (const l of figures.links) {
      for (const k of l.claimKeys) if (!claimKeys.includes(k)) claimKeys.push(k);
      notes.push(`${at}: the figure ${l.figure} comes from ${l.claimKeys.join(', ')}; linked`);
    }
  }
  const mustShow = raw.visual.mustShow
    .map((m) => ({ detail: clean(m.detail), claimKeys: m.claimKeys.filter((k) => scope.claimSet.has(k.trim())).map((k) => k.trim()) }))
    .filter((m) => m.detail);
  const speakerId = raw.speakerId && raw.speakerId.trim() ? raw.speakerId.trim() : null;
  const block: DraftBlock = {
    key: '',
    text,
    generatedText: text,
    infoClass: raw.infoClass,
    beatIds,
    claimKeys: orderedKeys(claimKeys, scope.evidence),
    speakerId,
    speechKind: speakerId ? (raw.speechKind ?? null) : null,
    fictionalDevice: false,
    delivery: { ...DEFAULT_DELIVERY },
    visual: { intent: raw.visual.intent, mustShow, mustAvoid: raw.visual.mustAvoid.map(clean).filter(Boolean), priority: raw.visual.priority, fictional: false, note: clean(raw.visual.note) },
    presentation: [],
    wordCount: 0,
    estimatedDurationSec: 0,
    editedBy: null,
    editedAt: null,
    centralQuestion: null,
  };
  return derive(block, scope);
}

/** Give a section's blocks their keys in order ("3.1", "3.2", …). */
export function renumber(section: DraftSection): DraftSection {
  return { ...section, blocks: section.blocks.map((b, i) => ({ ...b, key: `${section.sequence}.${i + 1}` })) };
}

/** A block reference ("3.4") as section and index (0-based), or null. */
export function parseRef(ref: string): { sequence: number; index: number } | null {
  const m = /^\s*(\d+)\.(\d+)\s*$/.exec(ref);
  return m ? { sequence: Number(m[1]), index: Number(m[2]) - 1 } : null;
}

/** Sections of the writer's output, in architecture order; a sequence the writer skipped becomes an empty section. */
export function sectionsFromWriter(
  out: WriterOutput,
  scope: ScriptScope,
  sequences: readonly number[],
  plans: ReadonlyMap<number, ScriptSectionPlan>,
  notes: string[],
): DraftSection[] {
  const seen = new Set<number>();
  const byNumber = new Map<number, WriterOutput['sections'][number]>();
  for (const s of out.sections) {
    if (!sequences.includes(s.sequence)) {
      notes.push(`The writer returned section ${s.sequence}, which was not asked for; ignored`);
      continue;
    }
    if (seen.has(s.sequence)) {
      notes.push(`The writer returned section ${s.sequence} twice; the first kept`);
      continue;
    }
    seen.add(s.sequence);
    byNumber.set(s.sequence, s);
  }
  const sections = sequences.map((n) => {
    const seq = scope.sequences.get(n)!;
    const raw = byNumber.get(n);
    const blocks = (raw?.blocks ?? []).map((b, i) => normalizeBlock(b, scope, notes, `Block ${n}.${i + 1}`)).filter((b) => b.text);
    return renumber({
      sequence: n,
      key: sectionKey(n),
      title: seq.title,
      plan: plans.get(n) ?? null,
      reviewStatus: 'PENDING' as const,
      editorNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      targetDurationSec: seq.estimatedDurationSec,
      blocks,
      written: true,
    });
  });
  // The central question: flagged on the blocks that pose and answer it.
  return markCentralQuestion(sections, out.centralQuestion, notes);
}

export function markCentralQuestion(sections: DraftSection[], refs: { posedIn: string | null; answeredIn: string | null }, notes: string[]): DraftSection[] {
  const mark = (ref: string | null, what: 'POSED' | 'ANSWERED') => {
    if (!ref) return;
    const r = parseRef(ref);
    const s = r && sections.find((x) => x.sequence === r.sequence);
    const b = s && s.blocks[r.index];
    if (!b) {
      notes.push(`The central question is ${what.toLowerCase()} in ${ref}, which is not a block of the script; ignored`);
      return;
    }
    for (const x of sections) for (const y of x.blocks) if (y.centralQuestion === what) y.centralQuestion = null;
    b.centralQuestion = what;
  };
  mark(refs.posedIn, 'POSED');
  mark(refs.answeredIn, 'ANSWERED');
  return sections;
}

/**
 * Apply a reviewer's patch to the sections it may change: edits, removals,
 * then insertions; blocks are renumbered afterwards. A reference that does not
 * resolve, or points outside `allowed`, is skipped with a note.
 */
export function applyPatch(
  draft: ScriptDraft,
  patch: ScriptPatch,
  scope: ScriptScope,
  allowed: ReadonlySet<number>,
  who: string,
  notes: string[],
): { draft: ScriptDraft; changed: number; keyMap: Map<string, string | null> } {
  const sections = draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b })) }));
  let changed = 0;
  const find = (ref: string) => {
    const r = parseRef(ref);
    if (!r) return null;
    const s = sections.find((x) => x.sequence === r.sequence);
    if (!s || !allowed.has(s.sequence)) return null;
    return { section: s, index: r.index, block: s.blocks[r.index] ?? null };
  };
  for (const e of patch.edits) {
    const f = find(e.ref);
    if (!f?.block) {
      notes.push(`${who}: edit of ${e.ref} skipped (no such block it may change)`);
      continue;
    }
    const text = clean(e.text) || f.block.text;
    const raw: WriterBlock = {
      text,
      infoClass: e.infoClass ?? f.block.infoClass,
      beatIds: e.beatIds ?? f.block.beatIds,
      claimKeys: e.claimKeys ?? f.block.claimKeys,
      speakerId: f.block.speakerId,
      speechKind: f.block.speechKind,
      visual: f.block.visual,
    };
    const fresh = normalizeBlock(raw, scope, notes, `${who} ${e.ref}`);
    f.section.blocks[f.index] = derive({ ...fresh, key: f.block.key, generatedText: fresh.text, delivery: f.block.delivery, centralQuestion: f.block.centralQuestion }, scope);
    changed++;
  }
  // Removals by reference to the blocks as they were shown (positions resolved before removing).
  const removals = patch.removals.map((ref) => ({ ref, f: find(ref) })).filter((x) => {
    if (!x.f?.block) notes.push(`${who}: removal of ${x.ref} skipped (no such block it may change)`);
    return Boolean(x.f?.block);
  });
  const doomed = new Set(removals.map((x) => x.f!.block!));
  for (const s of sections) s.blocks = s.blocks.filter((b) => !doomed.has(b));
  changed += doomed.size;
  // Insertions after a block as shown (or "<sequence>.0" for the start of a section).
  for (const ins of patch.insertions) {
    const r = parseRef(ins.after);
    const s = r && sections.find((x) => x.sequence === r.sequence);
    if (!r || !s || !allowed.has(s.sequence)) {
      notes.push(`${who}: insertion after ${ins.after} skipped (no such place it may change)`);
      continue;
    }
    const anchor = r.index < 0 ? null : (draft.sections.find((x) => x.sequence === r.sequence)?.blocks[r.index] ?? null);
    const at = anchor ? s.blocks.findIndex((b) => b.key === anchor.key) + 1 : 0;
    if (anchor && at === 0) {
      notes.push(`${who}: insertion after ${ins.after} skipped (that block was removed)`);
      continue;
    }
    s.blocks.splice(at, 0, normalizeBlock(ins.block, scope, notes, `${who} insertion after ${ins.after}`));
    changed++;
  }
  // Where each block shown to the reviewer ended up ("3.4" → "3.3"; null if removed).
  const keyMap = new Map<string, string | null>();
  for (const b of allBlocks(draft)) keyMap.set(b.key, null);
  for (const s of sections) s.blocks.forEach((b, i) => b.key && keyMap.set(b.key, `${s.sequence}.${i + 1}`));
  return { draft: { ...draft, sections: sections.map(renumber) }, changed, keyMap };
}

/** Apply the performance pass: delivery for the listed blocks (others keep the default), and pronunciation notes. */
export function applyPerformance(draft: ScriptDraft, perf: PerformanceOutput, scope: ScriptScope, allowed: ReadonlySet<number>, notes: string[]): ScriptDraft {
  const sections = draft.sections.map((s) => ({ ...s, blocks: [...s.blocks] }));
  for (const p of perf.blocks) {
    const r = parseRef(p.ref);
    const s = r && sections.find((x) => x.sequence === r.sequence);
    const b = s && allowed.has(s.sequence) ? s.blocks[r.index] : undefined;
    if (!s || !b || !r) {
      notes.push(`Performance: ${p.ref} is not a block it may change; skipped`);
      continue;
    }
    const missing = p.emphasis.filter((e) => !b.text.includes(e.text.trim()));
    if (missing.length) notes.push(`Performance: emphasis on ${missing.map((e) => `"${e.text}"`).join(', ')} in ${p.ref} is not in its text; dropped`);
    s.blocks[r.index] = derive({ ...b, delivery: { pace: p.pace, energy: p.energy, emotion: p.emotion, emphasis: p.emphasis, pauseBefore: p.pauseBefore, pauseAfter: p.pauseAfter } }, scope);
  }
  const pronunciations = mergePronunciations(
    draft.pronunciations,
    perf.pronunciations.map((x) => ({
      term: clean(x.term),
      respelling: clean(x.respelling),
      ipa: x.ipa ? clean(x.ipa) : null,
      language: x.language ? clean(x.language) : null,
      confidence: x.confidence,
      note: clean(x.note),
      needsReview: x.confidence !== 'HIGH',
      source: 'MODEL' as const,
    })),
  );
  return { sections, pronunciations };
}

/** Pronunciations by term: an editor's note is never replaced by a model's. */
export function mergePronunciations(base: readonly Pronunciation[], extra: readonly Pronunciation[]): Pronunciation[] {
  const byTerm = new Map(base.map((p) => [p.term.toLowerCase(), p]));
  for (const p of extra) {
    if (!p.term) continue;
    const old = byTerm.get(p.term.toLowerCase());
    if (old?.source === 'EDITOR') continue;
    byTerm.set(p.term.toLowerCase(), p);
  }
  return [...byTerm.values()].sort((a, b) => a.term.localeCompare(b.term));
}

export const allBlocks = (draft: ScriptDraft) => draft.sections.flatMap((s) => s.blocks);
export const sectionDurationSec = (s: DraftSection) => Math.round(s.blocks.reduce((n, b) => n + b.estimatedDurationSec, 0) * 10) / 10;
export const sectionWords = (s: DraftSection) => s.blocks.reduce((n, b) => n + b.wordCount, 0);
