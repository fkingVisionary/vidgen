import {
  STORY_LIMITS,
  STORY_SCORE_KEYS,
  appealScore,
  historicalConfidenceOf,
  historicalStatusOf,
  rankScore,
  type CandidatePriority,
  type CandidateStatus,
  type HistoricalStatus,
  type MythThread,
  type StoryCharacter,
  type StoryScores,
  type StoryType,
} from '@docengine/core';
import type { EvidenceBase } from './evidence.ts';
import { checkFigures, checkPerson, orderedKeys } from './rules.ts';
import type { CriticAssessment, MinedCandidate, SelectionOutput, SupportVerdict } from './schemas.ts';
import { jaccard, mentionsName, titleSimilarity } from './text.ts';

/** A mined candidate that passed the evidence rules (not yet scored). */
export interface DraftCandidate {
  /** Id within this mining run (M01, M02, …), used with the critic. */
  ref: string;
  title: string;
  hook: string;
  storyType: StoryType;
  characters: StoryCharacter[];
  setting: string;
  timePeriod: string;
  desire: string;
  conflict: string;
  stakes: string;
  escalation: string;
  turningPoint: string;
  payoff: string;
  whyInteresting: string;
  viewerQuestion: string;
  mythThread: MythThread | null;
  /** Every claim the story rests on, in dossier order. */
  claimKeys: string[];
  /** Caveats the telling must respect. */
  notes: string[];
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  sourceIds: string[];
}

export interface ScoredCandidate extends DraftCandidate {
  scores: StoryScores;
  rankScore: number;
  support: SupportVerdict;
}

/** A candidate as it goes into a pack: ranked, keyed, with the editor's fields. */
export interface PackCandidate extends Omit<ScoredCandidate, 'ref' | 'support'> {
  key: string;
  rank: number;
  status: CandidateStatus;
  priority: CandidatePriority;
  editorNotes: string | null;
  aiSelected: boolean;
  aiSelectionReason: string | null;
  /** Set when the editor approved or flagged it in the previous pass. */
  carriedFrom: { packVersion: number; key: string } | null;
}

export interface RemovedCandidate {
  title: string;
  storyType: string;
  reason: string;
  claimKeys: string[];
}

/** A candidate already in the pack or decided by the editor, for duplicate checks. */
export interface KnownCandidate {
  label: string;
  title: string;
  claimKeys: string[];
}

/** Two candidates tell the same story if they rest on (nearly) the same claims, or share most claims and their title. */
export function isDuplicate(a: { title: string; claimKeys: readonly string[] }, b: { title: string; claimKeys: readonly string[] }): boolean {
  const claims = jaccard(new Set(a.claimKeys), new Set(b.claimKeys));
  const title = titleSimilarity(a.title, b.title);
  return claims >= 0.7 || (claims >= 0.5 && title >= 0.4) || title >= 0.85;
}

const NARRATIVE_FIELDS = ['title', 'hook', 'desire', 'conflict', 'stakes', 'turningPoint', 'payoff', 'viewerQuestion'] as const;
const LABEL: Record<(typeof NARRATIVE_FIELDS)[number], string> = {
  title: 'title',
  hook: 'hook',
  desire: 'desire',
  conflict: 'conflict',
  stakes: 'stakes',
  turningPoint: 'turning point',
  payoff: 'payoff',
  viewerQuestion: 'viewer question',
};

/** Text of a candidate that can carry facts (checked for figures). */
export function candidateTexts(c: Omit<DraftCandidate, 'ref' | 'notes' | 'historicalStatus' | 'historicalConfidence' | 'sourceIds' | 'claimKeys'> & { notes?: readonly string[] }): string[] {
  const m = c.mythThread;
  return [
    c.title,
    c.hook,
    c.setting,
    c.timePeriod,
    c.desire,
    c.conflict,
    c.stakes,
    c.escalation,
    c.turningPoint,
    c.payoff,
    c.whyInteresting,
    c.viewerQuestion,
    ...c.characters.map((ch) => ch.role),
    ...(m ? [m.popularStory, m.origin, m.whoSpreadIt, m.whatHappened, m.whyItSurvived] : []),
  ];
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Apply the evidence rules to mined candidates. Repairs what is safe to
 * repair — linking the claim a figure or person comes from — and removes,
 * with the reason, every candidate that:
 *  - cites no dossier claim, or no claim backed by a retrieved source;
 *  - is not a story (no conflict, turning point, payoff, …) or has no characters;
 *  - names a person who is not in the dossier;
 *  - uses a figure that is not in the dossier;
 *  - uses a MYTH claim without telling it as a myth (popular story → origin → who → what happened → why it survived);
 *  - duplicates a candidate already kept, carried over or rejected by the editor.
 */
export function normalizeMined(
  raw: readonly MinedCandidate[],
  evidence: EvidenceBase,
  opts: { firstRef: number; known: readonly KnownCandidate[]; rejected: readonly KnownCandidate[] },
): { kept: DraftCandidate[]; removed: RemovedCandidate[]; notes: string[] } {
  const kept: DraftCandidate[] = [];
  const removed: RemovedCandidate[] = [];
  const notes: string[] = [];

  raw.forEach((m, i) => {
    const ref = `M${String(opts.firstRef + i).padStart(2, '0')}`;
    const title = clean(m.title) || `(untitled ${ref})`;
    const remove = (reason: string, keys: string[] = []) => removed.push({ title, storyType: m.storyType, reason, claimKeys: keys });

    const cited = [...m.claimKeys, ...m.characters.flatMap((c) => c.claimKeys), ...(m.mythThread?.claimKeys ?? [])];
    const unknown = [...new Set(cited.filter((k) => !evidence.has(k)))];
    if (unknown.length) notes.push(`${title}: unknown claim keys dropped (${unknown.join(', ')})`);
    const keys = new Set(orderedKeys(cited, evidence));
    if (keys.size === 0) return remove('cites no claim in the dossier');

    const missing = NARRATIVE_FIELDS.filter((f) => !clean(m[f]));
    if (missing.length) return remove(`not a complete story: no ${missing.map((f) => LABEL[f]).join(', ')}`, [...keys]);

    // People: a named person must be in the evidence. If they are elsewhere in the dossier, link those claims.
    const characters: StoryCharacter[] = [];
    const coreText = [m.title, m.hook, m.desire, m.conflict, m.stakes, m.escalation, m.turningPoint, m.payoff].join(' ');
    let invented: string | null = null;
    for (const ch of m.characters) {
      const name = clean(ch.name);
      if (!name) continue;
      const own = orderedKeys(ch.claimKeys, evidence);
      if (ch.kind === 'NAMED_PERSON') {
        const check = checkPerson(name, [...keys, ...own], evidence);
        if (!check.grounded) {
          if (mentionsName(coreText, name)) {
            invented = name;
            break;
          }
          notes.push(`${title}: character "${name}" dropped (not named in the dossier)`);
          continue;
        }
        if (check.link.length) {
          notes.push(`${title}: linked ${check.link.join(', ')} (where the dossier names ${name})`);
          for (const k of check.link) {
            keys.add(k);
            own.push(k);
          }
        }
      }
      characters.push({ name, kind: ch.kind, role: clean(ch.role) || '—', claimKeys: orderedKeys(own, evidence) });
    }
    if (invented) return remove(`names a person who is not in the dossier: ${invented}`, [...keys]);
    if (characters.length === 0) return remove('has no characters (people, groups or roles) from the evidence', [...keys]);

    const mythThread: MythThread | null = m.mythThread
      ? {
          popularStory: clean(m.mythThread.popularStory),
          origin: clean(m.mythThread.origin),
          whoSpreadIt: clean(m.mythThread.whoSpreadIt),
          whatHappened: clean(m.mythThread.whatHappened),
          whyItSurvived: clean(m.mythThread.whyItSurvived),
          claimKeys: orderedKeys(m.mythThread.claimKeys, evidence),
        }
      : null;

    const draft = {
      title,
      hook: clean(m.hook),
      storyType: m.storyType,
      characters,
      setting: clean(m.setting),
      timePeriod: clean(m.timePeriod),
      desire: clean(m.desire),
      conflict: clean(m.conflict),
      stakes: clean(m.stakes),
      escalation: clean(m.escalation),
      turningPoint: clean(m.turningPoint),
      payoff: clean(m.payoff),
      whyInteresting: clean(m.whyInteresting),
      viewerQuestion: clean(m.viewerQuestion),
      mythThread,
    };

    // Figures must come from the evidence; a figure from another claim links that claim.
    const figures = checkFigures(candidateTexts(draft), [...keys], evidence);
    if (figures.unsupported.length) return remove(`uses figures that are not in the dossier: ${figures.unsupported.join(', ')}`, [...keys]);
    for (const link of figures.links) {
      notes.push(`${title}: linked ${link.claimKeys.join(', ')} (source of the figure ${link.figure})`);
      for (const k of link.claimKeys) keys.add(k);
    }

    const claimKeys = orderedKeys(keys, evidence);
    const verdicts = claimKeys.map((k) => evidence.claim(k)!.verdict);
    if (verdicts.includes('MYTH')) {
      const t = mythThread;
      if (!t || !t.popularStory || !t.origin || !t.whoSpreadIt || !t.whatHappened || !t.whyItSurvived) {
        return remove('uses a MYTH claim without telling it as a myth (popular story, origin, who spread it, what happened, why it survived)', claimKeys);
      }
    }

    const sourceIds = evidence.sourcesFor(claimKeys);
    if (sourceIds.length === 0) return remove('no claim it cites is backed by a retrieved source with a verified quote', claimKeys);

    const duplicateOf = [...opts.known, ...kept.map((k) => ({ label: k.title, title: k.title, claimKeys: k.claimKeys }))].find((k) => isDuplicate({ title, claimKeys }, k));
    if (duplicateOf) return remove(`duplicates "${duplicateOf.label}"`, claimKeys);
    const rejectedLike = opts.rejected.find((k) => isDuplicate({ title, claimKeys }, k));
    if (rejectedLike) return remove(`too close to a candidate the editor rejected ("${rejectedLike.label}")`, claimKeys);

    kept.push({
      ref,
      ...draft,
      claimKeys,
      notes: clean(m.notes) ? [clean(m.notes)] : [],
      historicalStatus: historicalStatusOf(verdicts),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(claimKeys)),
      sourceIds,
    });
  });
  return { kept, removed, notes };
}

const clampScore = (n: number) => Math.min(10, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * Apply the critic's assessments: UNSUPPORTED candidates are removed (with the
 * critic's findings), NEEDS_CAVEAT adds the caveat, scores are clamped to
 * 0–10 and combined into appeal and rank score.
 */
export function applyAssessments(
  drafts: readonly DraftCandidate[],
  assessments: readonly CriticAssessment[],
): { scored: ScoredCandidate[]; removed: RemovedCandidate[]; unassessed: DraftCandidate[] } {
  const byRef = new Map<string, CriticAssessment>();
  for (const a of assessments) if (!byRef.has(a.candidateId.trim())) byRef.set(a.candidateId.trim(), a);
  const scored: ScoredCandidate[] = [];
  const removed: RemovedCandidate[] = [];
  const unassessed: DraftCandidate[] = [];
  for (const d of drafts) {
    const a = byRef.get(d.ref);
    if (!a) {
      unassessed.push(d);
      continue;
    }
    if (a.support === 'UNSUPPORTED') {
      const problems = a.problems.filter((p) => p.trim()).join('; ') || a.rationale;
      removed.push({ title: d.title, storyType: d.storyType, reason: `the critic found statements the evidence does not support: ${problems}`, claimKeys: d.claimKeys });
      continue;
    }
    const components = Object.fromEntries(STORY_SCORE_KEYS.map((k) => [k, clampScore(a[k])])) as Record<(typeof STORY_SCORE_KEYS)[number], number>;
    const appeal = appealScore(components);
    const notes = [...d.notes];
    if (a.support === 'NEEDS_CAVEAT') notes.push(clean(a.caveat) || a.problems.filter((p) => p.trim()).join('; ') || 'The critic asked for a caveat.');
    scored.push({
      ...d,
      notes,
      scores: { ...components, appeal, rationale: clean(a.rationale) },
      rankScore: rankScore(appeal, d.historicalConfidence),
      support: a.support,
    });
  }
  return { scored, removed, unassessed };
}

/** Best first: rank score, then historical confidence, then title. */
export function byRank<T extends { rankScore: number; historicalConfidence: number; title: string }>(a: T, b: T): number {
  return b.rankScore - a.rankScore || b.historicalConfidence - a.historicalConfidence || a.title.localeCompare(b.title);
}

export interface SelectionResult {
  keys: string[];
  reasons: Map<string, string>;
  workingPremise: string;
  rationale: string;
  alternates: string[];
  notes: string[];
}

/**
 * Make the proposed selection valid: only known, non-rejected candidates, no
 * repeats, between the selection limits (topped up from the best-ranked
 * candidates, editor-approved first; or cut to the maximum in the
 * selector's order).
 */
export function normalizeSelection(
  raw: SelectionOutput,
  pool: readonly { key: string; status: CandidateStatus; rankScore: number; historicalConfidence: number; title: string }[],
  limits: { min: number; max: number } = STORY_LIMITS.selection,
): SelectionResult {
  const byKey = new Map(pool.map((c) => [c.key, c]));
  const notes: string[] = [];
  const reasons = new Map<string, string>();
  const keys: string[] = [];
  for (const s of raw.selected) {
    const key = s.candidateKey.trim();
    const c = byKey.get(key);
    if (!c) {
      notes.push(`Selection: unknown candidate ${key} ignored`);
      continue;
    }
    if (c.status === 'REJECTED') {
      notes.push(`Selection: ${key} was rejected by the editor; not selected`);
      continue;
    }
    if (keys.includes(key)) continue;
    keys.push(key);
    reasons.set(key, clean(s.reason));
  }
  if (keys.length > limits.max) {
    notes.push(`Selection: cut to ${limits.max} units (proposed ${keys.length}); dropped ${keys.slice(limits.max).join(', ')}`);
    for (const k of keys.splice(limits.max)) reasons.delete(k);
  }
  if (keys.length < limits.min) {
    const fill = pool
      .filter((c) => c.status !== 'REJECTED' && !keys.includes(c.key))
      .sort((a, b) => Number(b.status === 'APPROVED') - Number(a.status === 'APPROVED') || byRank(a, b))
      .slice(0, limits.min - keys.length);
    for (const c of fill) {
      keys.push(c.key);
      reasons.set(c.key, 'Added by the rules to reach the minimum selection (best ranked).');
    }
    if (fill.length) notes.push(`Selection: added ${fill.map((c) => c.key).join(', ')} to reach the minimum of ${limits.min}`);
  }
  const alternates = [...new Set(raw.alternates.map((a) => a.trim()))].filter((k) => byKey.has(k) && !keys.includes(k) && byKey.get(k)!.status !== 'REJECTED');
  return { keys, reasons, workingPremise: clean(raw.workingPremise), rationale: clean(raw.rationale), alternates, notes };
}
