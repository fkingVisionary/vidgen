import type { RuntimeTarget, ScriptIssue, ScriptReviewChange, ScriptReviewer } from '@docengine/core';
import { allBlocks, derive, normalizeBlock, parseRef, renumber, type DraftBlock, type ScriptDraft } from './draft.ts';
import { claimLinksLost } from './evidence.ts';
import { checkScript, isBlocking, type ScriptFinding, type ScriptFindingKind } from './rules.ts';
import type { ScriptPatch, WriterBlock } from './schemas.ts';
import type { ScriptScope } from './scope.ts';

/**
 * Granular review: a reviewer's patch is a list of changes, and each change
 * is judged on its own. It is tried on a copy of the script as it stands
 * (with the changes kept so far), the rules run, and it is kept only if it
 * adds no blocking finding — no weaker evidence, class, claim link, fiction
 * or real-person boundary, quotation, uncertainty wording, architecture,
 * sequence or central question. A change that cannot apply (its block is
 * gone, outside the sections the run may change, or it changes nothing) is
 * skipped. One bad change never costs the good ones. The record of every
 * change — what, where, why, what became of it, which rule decided — is
 * saved with the version.
 *
 * The rules prefer slightly weaker prose with correct evidence over better
 * prose that blurs it: a change that improves the writing but breaks an
 * invariant is rejected.
 */

/** What each blocking rule protects: the reason a change that breaks it is rejected. */
export const INVARIANT: Partial<Record<ScriptFindingKind, string>> = {
  CLAIM_OUTSIDE_ARCHITECTURE: 'architecture constraints',
  NOT_IN_ARCHITECTURE: 'architecture constraints',
  BLOCK_WITHOUT_EVIDENCE: 'evidence traceability',
  UNSUPPORTED_FIGURE: 'evidence traceability',
  PERSON_OUTSIDE_ARCHITECTURE: 'architecture constraints',
  PERSON_WITHOUT_EVIDENCE: 'real-person boundaries',
  ASSERTION_UNCITED: 'claim relationships',
  CLAIM_LINK_LOST: 'claim relationships',
  UNKNOWN_NAME: 'evidence traceability',
  CLASS_MISMATCH: 'information-class integrity',
  DOCUMENTED_NOT_ESTABLISHED: 'information-class integrity',
  FRAMING_WITH_FACTS: 'information-class integrity',
  FICTION_NOT_ALLOWED: 'fictional-character boundaries',
  MYTH_AS_FACT: 'uncertainty presentation',
  DISPUTED_AS_FACT: 'uncertainty presentation',
  UNVERIFIED_AS_FACT: 'uncertainty presentation',
  PROBABLE_UNHEDGED: 'uncertainty presentation',
  UNCERTAINTY_UPGRADED: 'uncertainty presentation',
  FICTION_IN_DOCUMENTED: 'fictional-character boundaries',
  FICTION_REAL_INTERACTION: 'fictional-character boundaries',
  FICTION_DOCUMENTED_ACT: 'fictional-character boundaries',
  FICTION_WITH_FACTS: 'fictional-character boundaries',
  UNDECLARED_SPEAKER: 'architecture constraints',
  REAL_PERSON_INVENTED_SPEECH: 'real-person boundaries',
  FICTIONAL_RECORDED_QUOTE: 'recorded-quote integrity',
  UNVERIFIED_RECORDED_QUOTE: 'recorded-quote integrity',
  FABRICATED_QUOTE: 'recorded-quote integrity',
  SEQUENCE_MISSING: 'the approved story sequence',
  CENTRAL_QUESTION_NOT_POSED: 'the central narrative question',
  CENTRAL_QUESTION_ABANDONED: 'the central narrative question',
  RUNTIME_OFF: 'the runtime range',
  OPEN_CRITICAL_FACT_ISSUE: 'factual defensibility',
  DIRECTION_IN_NARRATION: 'the semantic layers (only narration is spoken)',
  NARRATION_FIGURE_CHANGED: 'factual meaning (every figure kept)',
  NARRATION_NAME_CHANGED: 'historical identities',
  NARRATION_KEPT_LINE_LOST: 'the strongest lines',
  NARRATION_QUOTE_TOUCHED: 'recorded-quote integrity',
  NARRATION_HEDGE_DROPPED: 'uncertainty presentation',
  NARRATION_PATTERN_ADDED: 'the house style (no new machine habits)',
  NARRATION_MONEY_UNSOURCED: 'money context from the evidence only',
  NARRATION_LENGTH_DRIFT: 'a polish, not a rewrite',
};

/** One change of a patch, numbered in the reviewer's order: edits, then removals, then insertions. */
export interface ProposedChange {
  id: string;
  reviewer: ScriptReviewer;
  type: 'EDIT' | 'REMOVE' | 'INSERT';
  /** The block as the reviewer saw it ("<sequence>.<n>"); for an insertion, the block it follows ("<sequence>.0": the start of a section). */
  ref: string;
  reason: string;
  edit?: Pick<ScriptPatch['edits'][number], 'text' | 'infoClass' | 'claimKeys' | 'beatIds'>;
  block?: WriterBlock;
}

const PREFIX: Record<ScriptReviewer, string> = { SCRIPT_EDITOR: 'E', FACT_CHECKER: 'F', PERFORMANCE: 'P', NARRATION: 'N' };

export function proposals(patch: ScriptPatch, reviewer: ScriptReviewer): ProposedChange[] {
  let n = 0;
  const id = () => `${PREFIX[reviewer]}${++n}`;
  return [
    ...patch.edits.map((e) => ({ id: id(), reviewer, type: 'EDIT' as const, ref: e.ref.trim(), reason: e.reason.trim(), edit: { text: e.text, infoClass: e.infoClass, claimKeys: e.claimKeys, beatIds: e.beatIds } })),
    ...patch.removals.map((r) => ({ id: id(), reviewer, type: 'REMOVE' as const, ref: r.ref.trim(), reason: r.reason.trim() })),
    ...patch.insertions.map((i) => ({ id: id(), reviewer, type: 'INSERT' as const, ref: i.after.trim(), reason: i.reason.trim(), block: i.block })),
  ];
}

export interface ReviewContext {
  scope: ScriptScope;
  target: RuntimeTarget;
  /** Sections the reviewer may change (a section rewrite reviews only those it rewrote). */
  allowed: ReadonlySet<number>;
  /** The version this run started from: claim links and refrains are kept against it. */
  base: ScriptDraft | null;
  /** Lines kept on purpose by a refinement. */
  kept?: readonly string[];
  /**
   * A reviewer's own invariants, beyond the rules (the narration pass's):
   * findings that reject a change, given the block before and after it. A
   * string skips the change instead (it has nothing to do there).
   */
  guard?: (before: DraftBlock | null, after: DraftBlock | null, change: ProposedChange) => ScriptFinding[] | string;
}

export interface ReviewOutcome {
  draft: ScriptDraft;
  changes: ScriptReviewChange[];
  /** Where each block the reviewer saw is now, by its reference then and now (null when removed). */
  keyMap: Map<string, string | null>;
  /** Notes from the changes that were kept (claims linked or dropped while normalizing them). */
  notes: string[];
}

type Uid = string;
interface Indexed extends DraftBlock {
  uid: Uid;
}

/** The draft with an identity on every block that survives renumbering. */
function withIds(draft: ScriptDraft): ScriptDraft {
  let n = 0;
  return { ...draft, sections: draft.sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, uid: `u${++n}` })) })) };
}
const uidOf = (b: DraftBlock) => (b as Indexed).uid;

function locate(draft: ScriptDraft, uid: Uid): { s: number; i: number; block: DraftBlock } | null {
  for (let s = 0; s < draft.sections.length; s++) {
    const i = draft.sections[s]!.blocks.findIndex((b) => uidOf(b) === uid);
    if (i >= 0) return { s, i, block: draft.sections[s]!.blocks[i]! };
  }
  return null;
}

/** A copy of the draft with one section's blocks replaced (renumbered). */
function withSection(draft: ScriptDraft, s: number, blocks: DraftBlock[]): ScriptDraft {
  return { ...draft, sections: draft.sections.map((x, n) => (n === s ? renumber({ ...x, blocks }) : x)) };
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

type Tried = { draft: ScriptDraft; original: string | null; proposed: string | null; uid: Uid | null } | { skip: string; original: string | null; proposed: string | null };

/** Apply one change to a copy of the draft, or say why it cannot apply. */
function applyChange(work: ScriptDraft, c: ProposedChange, shown: ReadonlyMap<string, Uid>, ctx: ReviewContext, notes: string[]): Tried {
  if (c.type === 'INSERT') {
    const proposed = clean(c.block?.text);
    const r = parseRef(c.ref);
    const s = r ? work.sections.findIndex((x) => x.sequence === r.sequence) : -1;
    if (!r || s < 0) return { skip: `There is no section to insert into at ${c.ref}`, original: null, proposed };
    if (!ctx.allowed.has(r.sequence)) return { skip: `Section ${r.sequence} is not one this run may change`, original: null, proposed };
    let at = 0;
    if (r.index >= 0) {
      const anchor = shown.get(c.ref);
      if (!anchor) return { skip: `There is no block ${c.ref} in the version it reviewed`, original: null, proposed };
      const idx = work.sections[s]!.blocks.findIndex((b) => uidOf(b) === anchor);
      if (idx < 0) return { skip: `The block it follows (${c.ref}) was removed by an earlier change`, original: null, proposed };
      at = idx + 1;
    }
    const fresh = { ...normalizeBlock(c.block!, ctx.scope, notes, `${c.id} (after ${c.ref})`), uid: c.id };
    if (!fresh.text) return { skip: 'The new block is empty', original: null, proposed };
    const blocks = [...work.sections[s]!.blocks];
    blocks.splice(at, 0, fresh);
    return { draft: withSection(work, s, blocks), original: null, proposed: fresh.text, uid: c.id };
  }
  const uid = shown.get(c.ref);
  const proposedText = c.type === 'EDIT' ? clean(c.edit?.text) || null : null;
  if (!uid) return { skip: `There is no block ${c.ref} in the version it reviewed`, original: null, proposed: proposedText };
  const at = locate(work, uid);
  if (!at) return { skip: `Block ${c.ref} was removed by an earlier change`, original: null, proposed: proposedText };
  const sequence = work.sections[at.s]!.sequence;
  const original = at.block.text;
  if (!ctx.allowed.has(sequence)) return { skip: `Section ${sequence} is not one this run may change`, original, proposed: proposedText };
  if (c.type === 'REMOVE') {
    const blocks = work.sections[at.s]!.blocks.filter((_, i) => i !== at.i);
    return { draft: withSection(work, at.s, blocks), original, proposed: null, uid };
  }
  const e = c.edit!;
  const b = at.block;
  const text = clean(e.text) || b.text;
  const infoClass = e.infoClass ?? b.infoClass;
  const claimKeys = e.claimKeys ?? b.claimKeys;
  const beatIds = e.beatIds ?? b.beatIds;
  if (text === b.text && infoClass === b.infoClass && sameList(claimKeys, b.claimKeys) && sameList(beatIds, b.beatIds)) return { skip: 'It changes nothing', original, proposed: text };
  const fresh = normalizeBlock({ text, infoClass, beatIds, claimKeys, speakerId: b.speakerId, speechKind: b.speechKind, visual: b.visual }, ctx.scope, notes, `${c.id} (${c.ref})`);
  const next = derive({ ...fresh, key: b.key, generatedText: fresh.text, delivery: b.delivery, centralQuestion: b.centralQuestion, uid } as Indexed, ctx.scope);
  const blocks = [...work.sections[at.s]!.blocks];
  blocks[at.i] = next;
  return { draft: withSection(work, at.s, blocks), original, proposed: next.text, uid };
}

interface Judged {
  blocking: Map<string, ScriptFinding>;
  all: Map<string, ScriptFinding>;
}

/**
 * The findings of a draft keyed by what they are about: blocking findings by
 * rule, block identity and wording (block numbers aside, which change when
 * blocks move); warnings by rule and place.
 */
function judge(draft: ScriptDraft, ctx: ReviewContext): Judged {
  const uids = new Map(allBlocks(draft).map((b) => [b.key, uidOf(b)]));
  const blocking = new Map<string, ScriptFinding>();
  const all = new Map<string, ScriptFinding>();
  for (const f of checkScript(draft, ctx.scope, { target: ctx.target, previous: ctx.base, kept: ctx.kept })) {
    const where = f.ref === null ? 'script' : (uids.get(f.ref) ?? f.ref);
    const block = f.ref !== null && uids.has(f.ref);
    if (isBlocking(f)) blocking.set(`${f.kind}|${where}|${block ? f.detail.replace(/\b\d+\.\d+\b/g, '#') : ''}`, f);
    all.set(`${f.kind}|${where}`, f);
  }
  return { blocking, all };
}

const unique = <T>(xs: readonly T[]) => [...new Set(xs)];

/** Why a change was rejected, in the words of the invariant it breaks and the rule that found it. */
export function rejection(fs: readonly ScriptFinding[]): string {
  const first = fs[0]!;
  const invariants = unique(fs.map((f) => INVARIANT[f.kind] ?? 'the rules'));
  const more = fs.length > 1 ? ` (and ${fs.length - 1} more: ${unique(fs.slice(1).map((f) => f.kind)).join(', ')})` : '';
  return `Violates ${invariants.join('; ')} — ${first.detail} [${first.kind}]${more}`;
}

/** Judge every change of a reviewer's patch on its own, keep the safe ones, and record what became of each. */
export function reviewPatch(draft: ScriptDraft, patch: ScriptPatch, reviewer: ScriptReviewer, ctx: ReviewContext): ReviewOutcome {
  const initial = withIds(draft);
  const shown = new Map(allBlocks(initial).map((b) => [b.key, uidOf(b)]));
  const changes: ScriptReviewChange[] = [];
  const saved = new Map<string, Uid | null>();
  const notes: string[] = [];
  let work = initial;
  let current = judge(work, ctx);
  const start = current;

  for (const c of proposals(patch, reviewer)) {
    const local: string[] = [];
    const tried = applyChange(work, c, shown, ctx, local);
    const section = parseRef(c.ref)?.sequence ?? null;
    const record = { id: c.id, reviewer, type: c.type, section, ref: c.ref, savedRef: null, originalText: tried.original, proposedText: tried.proposed, reason: c.reason };
    if ('skip' in tried) {
      changes.push({ ...record, status: 'SKIPPED', rulesImpacted: [], rejectionReason: tried.skip });
      continue;
    }
    let guarded: ScriptFinding[] = [];
    if (ctx.guard) {
      const before = c.type === 'INSERT' ? null : (allBlocks(work).find((b) => uidOf(b) === tried.uid) ?? null);
      const now = c.type === 'REMOVE' ? null : (allBlocks(tried.draft).find((b) => uidOf(b) === tried.uid) ?? null);
      const g = ctx.guard(before, now, c);
      if (typeof g === 'string') {
        changes.push({ ...record, status: 'SKIPPED', rulesImpacted: [], rejectionReason: g });
        continue;
      }
      guarded = g;
    }
    const after = judge(tried.draft, ctx);
    // New blocking findings, claim links this change itself dropped, and the reviewer's own invariants.
    const introduced = [...[...after.blocking].filter(([k]) => !current.blocking.has(k)).map(([, f]) => f), ...claimLinksLost(tried.draft, work, ctx.scope), ...guarded];
    if (introduced.length) {
      changes.push({ ...record, status: 'REJECTED', rulesImpacted: unique(introduced.map((f) => f.kind)), rejectionReason: rejection(introduced) });
      continue;
    }
    const resolved = [...current.all].filter(([k]) => !after.all.has(k)).map(([, f]) => `resolves ${f.kind}`);
    const added = [...after.all].filter(([k]) => !current.all.has(k)).map(([, f]) => `adds ${f.kind}${isBlocking(f) ? '' : ' (warning)'}`);
    changes.push({ ...record, status: 'ACCEPTED', rulesImpacted: unique([...resolved, ...added]), rejectionReason: null });
    saved.set(c.id, c.type === 'REMOVE' ? null : tried.uid);
    work = tried.draft;
    current = after;
    notes.push(...local);
  }

  // Final validation: the kept changes together add no blocking finding and lose no claim link.
  const broken = [...[...current.blocking].filter(([k]) => !start.blocking.has(k)).map(([, f]) => f), ...claimLinksLost(work, initial, ctx.scope)];
  if (broken.length && changes.some((c) => c.status === 'ACCEPTED')) {
    for (const c of changes) if (c.status === 'ACCEPTED') Object.assign(c, { status: 'REJECTED', rulesImpacted: unique(broken.map((f) => f.kind)), rejectionReason: `Final validation: the kept changes together — ${rejection(broken)}` });
    work = initial;
    saved.clear();
    notes.length = 0;
  }

  const keyOf = new Map(allBlocks(work).map((b) => [uidOf(b), b.key]));
  for (const c of changes) {
    if (c.status !== 'ACCEPTED') continue;
    const uid = saved.get(c.id);
    c.savedRef = uid ? (keyOf.get(uid) ?? null) : null;
  }
  const keyMap = new Map([...shown].map(([ref, uid]) => [ref, keyOf.get(uid) ?? null]));
  return { draft: work, changes, keyMap, notes };
}

/** Where a reviewer's issue stands after its changes were judged. */
export function issueResolution(ref: string | null, outcome: ReviewOutcome): Pick<ScriptIssue, 'ref' | 'resolution'> {
  if (!ref) return { ref: null, resolution: 'recorded' };
  const now = outcome.keyMap.has(ref) ? outcome.keyMap.get(ref)! : ref;
  const mine = outcome.changes.filter((c) => c.ref === ref && c.type !== 'INSERT');
  const kept = mine.find((c) => c.status === 'ACCEPTED');
  if (kept) return { ref: now, resolution: now === null ? `fixed: the block was removed (${kept.id})` : `fixed by its own change (${kept.id})` };
  const refused = mine.find((c) => c.status === 'REJECTED');
  if (refused) return { ref: now ?? ref, resolution: `open: its change ${refused.id} was rejected — ${refused.rejectionReason}` };
  return { ref: now ?? ref, resolution: 'open: left for the editor' };
}

/** One line for the run's notes: how many of a reviewer's changes were kept, rejected and skipped. */
export function reviewSummary(who: string, changes: readonly ScriptReviewChange[]): string | null {
  if (!changes.length) return null;
  const n = (s: ScriptReviewChange['status']) => changes.filter((c) => c.status === s).length;
  return `${who}: ${n('ACCEPTED')} of ${changes.length} change(s) kept, ${n('REJECTED')} rejected, ${n('SKIPPED')} skipped`;
}
