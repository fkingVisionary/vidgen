import type { AiPattern, BlockChange, NarrationRecord, ScriptChangeReport, ScriptReviewChange, ScriptReviewer } from '@docengine/core';
import { extractFigures, nameTokens, normalize, wordTokens } from '@docengine/story/shared';
import { blockPatterns, summarise } from './fingerprints.ts';
import { sentencesOf, type NarrationBlock } from './text.ts';

/**
 * The change report between a version and the one it was made from: block
 * by block, the original, the revision and why (in the reviewers' own words,
 * from the change ledger), with what each change did — evidence kept or not,
 * uncertainty kept or not, money context added, AI patterns removed or added,
 * picture description removed, names still waiting for a pronunciation. Claim
 * coverage between the versions is flagged, never silently lost. Read-only:
 * computed from the two versions whenever it is asked for.
 */

export interface ReportVersion {
  id: string;
  version: number;
  blocks: readonly NarrationBlock[];
}

export interface ReportArgs {
  base: ReportVersion;
  revised: ReportVersion;
  /** The run's own lineage (a narration pass): base block → saved block. Without it, blocks are paired by evidence and wording. */
  lineage: NarrationRecord['lineage'] | null;
  ledger: readonly ScriptReviewChange[];
  narration: NarrationRecord | null;
  /** The uncertainty a block's wording carries (each hedge family, with how often it is said), as the script rules read it. */
  uncertainty: (text: string) => ReadonlyMap<string, number>;
}

/** Wording without case or punctuation — but a decimal point is part of a figure ("1.5" is not "15"). */
const norm = (s: string) => normalize(s).replace(/(\d)\.(?=\d)/g, '$1p').replace(/[^a-z0-9 ]/g, '');
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

function similarity(a: NarrationBlock, b: NarrationBlock): number {
  const wa = new Set(wordTokens(a.text));
  const wb = new Set(wordTokens(b.text));
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const words = wa.size + wb.size - inter ? inter / (wa.size + wb.size - inter) : 0;
  const ca = new Set(a.claimKeys);
  const claims = a.claimKeys.length || b.claimKeys.length ? b.claimKeys.filter((k) => ca.has(k)).length / Math.max(a.claimKeys.length, b.claimKeys.length) : 0.5;
  return 0.6 * words + 0.4 * claims;
}

/** Blocks of one section paired in order (a longest-common-subsequence over similar blocks). */
function align(a: readonly NarrationBlock[], b: readonly NarrationBlock[]): [NarrationBlock | null, NarrationBlock | null][] {
  const n = a.length;
  const m = b.length;
  const sim = a.map((x) => b.map((y) => similarity(x, y)));
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, sim[i]![j]! >= 0.3 ? best[i + 1]![j + 1]! + sim[i]![j]! : -1);
  const out: [NarrationBlock | null, NarrationBlock | null][] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && sim[i]![j]! >= 0.3 && best[i]![j] === best[i + 1]![j + 1]! + sim[i]![j]!) out.push([a[i++]!, b[j++]!]);
    else if (j < m && (i === n || best[i]![j + 1]! >= best[i + 1]![j]!)) out.push([null, b[j++]!]);
    else out.push([a[i++]!, null]);
  }
  return out;
}

function pairs(args: ReportArgs): { pairs: [NarrationBlock | null, NarrationBlock | null][]; exact: boolean } {
  const base = args.base.blocks;
  const revised = args.revised.blocks;
  if (args.lineage?.length) {
    const byKey = new Map(revised.map((b) => [b.key, b]));
    const used = new Set<string>();
    // In script order: a removed block stays where it was (its key may now name the block after it); an added block goes after the revised block before it.
    const out: [NarrationBlock | null, NarrationBlock | null][] = [];
    for (const b of base) {
      const saved = args.lineage.find((l) => l.base === b.key)?.saved ?? null;
      const r = saved ? (byKey.get(saved) ?? null) : null;
      if (r) used.add(r.key);
      out.push([b, r]);
    }
    revised.forEach((r, j) => {
      if (used.has(r.key)) return;
      const prev = revised[j - 1]?.key;
      let at = prev === undefined ? 0 : out.findIndex(([, x]) => x?.key === prev) + 1;
      // …but after the blocks removed from an earlier section: sections stay in order.
      while (at < out.length && !out[at]![1] && out[at]![0]!.section < r.section) at++;
      out.splice(at, 0, [null, r]);
    });
    return { pairs: out, exact: true };
  }
  const sections = [...new Set([...base, ...revised].map((b) => b.section))].sort((x, y) => x - y);
  return { pairs: sections.flatMap((s) => align(base.filter((b) => b.section === s), revised.filter((b) => b.section === s))), exact: false };
}

/** `baseRef` only with an exact pairing: a narration change's ref is a base key only when the pass ran on the base itself; otherwise it numbers a draft in between. */
function reasonsFor(ledger: readonly ScriptReviewChange[], baseRef: string | null, ref: string | null, original: string | null): { reasons: string[]; by: ScriptReviewer[] } {
  const mine = ledger.filter((c) => c.status === 'ACCEPTED' && ((ref && c.savedRef === ref) || (baseRef && c.reviewer === 'NARRATION' && c.ref === baseRef) || (original && c.originalText === original)));
  return { reasons: [...new Set(mine.map((c) => `${c.id}: ${c.reason || 'no reason given'}`))], by: [...new Set(mine.map((c) => c.reviewer))] };
}

export function changeReport(args: ReportArgs): ScriptChangeReport {
  const { pairs: paired, exact } = pairs(args);
  const used = args.narration?.money.used ?? [];
  const candidates = (args.narration?.names ?? []).filter((n) => n.candidate);
  const blocks: BlockChange[] = [];
  let sentencesRemoved = 0;
  let sentencesRewritten = 0;
  let visualRemoved = 0;
  for (const [a, b] of paired) {
    const original = a?.text ?? null;
    const revised = b?.text ?? null;
    const status: BlockChange['status'] = !a ? 'ADDED' : !b ? 'REMOVED' : norm(a.text) === norm(b.text) && sameList(a.claimKeys, b.claimKeys) && a.infoClass === b.infoClass ? 'UNCHANGED' : 'REWRITTEN';
    const why = status === 'UNCHANGED' ? { reasons: [], by: [] } : reasonsFor(args.ledger, exact ? (a?.key ?? null) : null, b?.key ?? null, original);
    const before: AiPattern[] = a && !a.speakerId ? blockPatterns(a) : [];
    const after: AiPattern[] = b && !b.speakerId ? blockPatterns(b) : [];
    const claimsRemoved = a ? a.claimKeys.filter((k) => !(b?.claimKeys ?? []).includes(k)) : [];
    const claimsAdded = b ? b.claimKeys.filter((k) => !(a?.claimKeys ?? []).includes(k)) : [];
    const hedgesA = a ? args.uncertainty(a.text) : new Map<string, number>();
    const hedgesB = b ? args.uncertainty(b.text) : new Map<string, number>();
    const visualGone = before.includes('visual_description') && !after.includes('visual_description');
    if (visualGone) visualRemoved++;
    if (a && status !== 'UNCHANGED') {
      const sa = sentencesOf(a.text).map(norm);
      const sb = new Set(b ? sentencesOf(b.text).map(norm) : []);
      const changed = sa.filter((s) => !sb.has(s)).length;
      const fresh = b ? sentencesOf(b.text).map(norm).filter((s) => !sa.includes(s)).length : 0;
      const removed = Math.max(0, changed - fresh);
      sentencesRemoved += removed;
      sentencesRewritten += changed - removed;
    }
    const words = b ? new Set(wordTokens(b.text)) : new Set<string>();
    blocks.push({
      section: (b ?? a)!.section,
      baseRef: a?.key ?? null,
      ref: b?.key ?? null,
      status,
      original,
      revised,
      reasons: why.reasons,
      changedBy: why.by,
      evidencePreserved: a && b ? claimsRemoved.length === 0 && a.infoClass === b.infoClass : null,
      // Every hedge, not just every family: one of two hedges dropped leaves a claim stated as fact.
      uncertaintyPreserved: a && b ? [...hedgesA].every(([h, n]) => (hedgesB.get(h) ?? 0) >= n) : null,
      claimsRemoved,
      claimsAdded,
      moneyContext: b ? used.filter((u) => u.ref === b.key).map((u) => u.contextId) : [],
      aiPatternsRemoved: before.filter((p) => !after.includes(p)),
      aiPatternsAdded: after.filter((p) => !before.includes(p)),
      visualDuplicationRemoved: visualGone,
      pronunciationCandidates: b ? candidates.filter((n) => nameTokens(n.displayName).some((w) => words.has(w))).map((n) => n.displayName) : [],
    });
  }
  const both = blocks.filter((x) => x.baseRef && x.ref);
  const hedged = both.filter((x) => x.original && [...args.uncertainty(x.original).values()].some((n) => n > 0));
  const before = summarise(args.base.blocks);
  const after = summarise(args.revised.blocks);
  const claims = (bs: readonly NarrationBlock[]) => new Set(bs.flatMap((b) => b.claimKeys));
  const figures = (bs: readonly NarrationBlock[]) => new Set(bs.flatMap((b) => extractFigures(b.text)));
  const minus = (x: Set<string>, y: Set<string>) => [...x].filter((k) => !y.has(k)).sort((p, q) => p.localeCompare(q, 'en', { numeric: true }));
  const [ca, cb, fa, fb] = [claims(args.base.blocks), claims(args.revised.blocks), figures(args.base.blocks), figures(args.revised.blocks)];
  const claimsRemoved = minus(ca, cb);
  const figuresRemoved = minus(fa, fb);
  const flags = [
    ...claimsRemoved.map((k) => `Claim ${k} is no longer cited anywhere in v${args.revised.version}`),
    ...figuresRemoved.map((f) => `The figure ${f} is no longer said in v${args.revised.version}`),
    ...both.filter((x) => x.claimsRemoved.length).map((x) => `${x.baseRef} → ${x.ref}: no longer cites ${x.claimsRemoved.join(', ')}${x.claimsRemoved.every((k) => cb.has(k)) ? ' (still cited elsewhere)' : ''}`),
    ...both.filter((x) => x.uncertaintyPreserved === false).map((x) => `${x.baseRef} → ${x.ref}: a hedge of the original is gone`),
  ];
  return {
    base: { id: args.base.id, version: args.base.version },
    revised: { id: args.revised.id, version: args.revised.version },
    pairing: exact ? 'EXACT' : 'MATCHED',
    totals: {
      blocksBefore: args.base.blocks.length,
      blocksAfter: args.revised.blocks.length,
      unchanged: blocks.filter((x) => x.status === 'UNCHANGED').length,
      rewritten: blocks.filter((x) => x.status === 'REWRITTEN').length,
      removed: blocks.filter((x) => x.status === 'REMOVED').length,
      added: blocks.filter((x) => x.status === 'ADDED').length,
      sentencesRemoved,
      sentencesRewritten,
      moneyContextAdded: used.length,
      pronunciationCandidates: candidates.length,
      visualDescriptionsRemoved: visualRemoved,
      aiSignalsBefore: before.signals,
      aiSignalsAfter: after.signals,
      evidencePreserved: { kept: both.filter((x) => x.evidencePreserved).length, of: both.length },
      uncertaintyPreserved: { kept: hedged.filter((x) => x.uncertaintyPreserved).length, of: hedged.length },
    },
    fingerprint: { before: before.score, after: after.score },
    provenance: { claimsAdded: minus(cb, ca), claimsRemoved, figuresAdded: minus(fb, fa), figuresRemoved, flags },
    blocks,
  };
}
