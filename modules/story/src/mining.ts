import {
  STORY_LIMITS,
  STORY_VALUE_KEYS,
  historicalConfidenceOf,
  historicalStatusOf,
  historicalValue,
  storyAppeal,
  storyValue,
  type CandidatePriority,
  type CandidateStatus,
  type HistoricalStatus,
  type HumanStakes,
  type MythThread,
  type NarrativeMode,
  type PovChoice,
  type ReconstructionLevel,
  type StoryCharacter,
  type StoryDesign,
  type StoryScoresV2,
  type StoryType,
  type StoryValueKey,
} from '@docengine/core';
import type { EvidenceBase } from './evidence.ts';
import { SECOND_PERSON, checkFigures, checkPerson, orderedKeys } from './rules.ts';
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
  // Story Engine 2.0: the human story and how it could be told.
  humanStakes: HumanStakes;
  storyDesign: StoryDesign;
  narrativeMode: NarrativeMode;
  povStrategy: PovChoice;
  centralQuestion: string;
  reconstructionLevel: ReconstructionLevel;
  /** Every claim the story rests on, in dossier order. */
  claimKeys: string[];
  /** Caveats the telling must respect. */
  notes: string[];
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  sourceIds: string[];
}

export interface ScoredCandidate extends DraftCandidate {
  scores: StoryScoresV2;
  /** STORY APPEAL: story value moderated by historical value. */
  rankScore: number;
  storyValue: number;
  historicalValue: number;
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
  const h = c.humanStakes;
  const d = c.storyDesign;
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
    c.centralQuestion,
    c.povStrategy.description,
    h.protagonist,
    h.couldGain,
    h.couldLose,
    h.immediateProblem,
    d.coldOpen.text,
    d.reveal,
    d.visualEnvironment,
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
    const coreText = [m.title, m.hook, m.desire, m.conflict, m.stakes, m.escalation, m.turningPoint, m.payoff, m.protagonist, m.coldOpen.text, m.reveal].join(' ');
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
      ...storyEngine2Fields(m, characters),
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
    // The cold open is labelled honestly: a scene addressed to the viewer is a reconstruction, and only
    // ESTABLISHED claims make documented fact. Relabelling is recorded, never silent.
    const open = draft.storyDesign.coldOpen;
    if (open.basis === 'DOCUMENTED' && SECOND_PERSON.test(open.text)) {
      open.basis = 'RECONSTRUCTION';
      notes.push(`${title}: cold open addressed to the viewer relabelled RECONSTRUCTION`);
    } else if (open.basis === 'DOCUMENTED' && verdicts.some((v) => v !== 'ESTABLISHED')) {
      open.basis = 'UNCERTAIN';
      notes.push(`${title}: cold open relabelled UNCERTAIN (the story rests on claims that are not ESTABLISHED)`);
    }
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

/**
 * The Story Engine 2.0 fields of a mined candidate, cleaned. A human story is
 * found when the protagonist is one of the story's characters (people, groups
 * or roles from the evidence) and something is at stake for them.
 */
function storyEngine2Fields(m: MinedCandidate, characters: readonly StoryCharacter[]) {
  const protagonist = clean(m.protagonist);
  const humanStakes: HumanStakes = {
    protagonist,
    couldGain: clean(m.couldGain),
    couldLose: clean(m.couldLose),
    immediateProblem: clean(m.immediateProblem),
  };
  const isCharacter = protagonist !== '' && characters.some((c) => normalizeName(c.name) === normalizeName(protagonist) || normalizeName(protagonist).includes(normalizeName(c.name)));
  const storyDesign: StoryDesign = {
    coldOpen: { text: clean(m.coldOpen.text), basis: m.coldOpen.basis },
    reveal: clean(m.reveal),
    visualEnvironment: clean(m.visualEnvironment),
    humanStory: isCharacter && (humanStakes.couldGain !== '' || humanStakes.couldLose !== ''),
  };
  return {
    humanStakes,
    storyDesign,
    narrativeMode: m.narrativeMode,
    povStrategy: { type: m.povStrategy.type, description: clean(m.povStrategy.description) },
    centralQuestion: clean(m.centralQuestion),
    reconstructionLevel: m.reconstructionLevel,
  };
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

const clampScore = (n: number) => Math.min(10, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

const HISTORY_SCORED = ['significance', 'relevance', 'uniqueness'] as const;
const KNOWN_DIMENSIONS = new Set<string>([...STORY_VALUE_KEYS, ...HISTORY_SCORED]);

/** Myth/investigation potential only counts for units with disputed, unverified or myth material. */
export function mythApplicable(c: { mythThread: unknown; historicalStatus: HistoricalStatus }): boolean {
  return c.mythThread !== null || c.historicalStatus === 'CONTESTED' || c.historicalStatus === 'UNCERTAIN' || c.historicalStatus === 'MYTH_INVESTIGATION';
}

/** Story Engine 2.0 scores from the critic's raw numbers: story value, historical value and story appeal. */
export function scoresFrom(a: CriticAssessment, c: { historicalConfidence: number; mythThread: unknown; historicalStatus: HistoricalStatus }): StoryScoresV2 {
  const story = Object.fromEntries(STORY_VALUE_KEYS.map((k) => [k, clampScore(a[k])])) as Record<StoryValueKey, number>;
  const applicable = mythApplicable(c);
  const history = { evidenceQuality: c.historicalConfidence, significance: clampScore(a.significance), relevance: clampScore(a.relevance), uniqueness: clampScore(a.uniqueness) };
  const sv = storyValue(story, applicable);
  const hv = historicalValue(history);
  const reasons: StoryScoresV2['reasons'] = [];
  for (const r of a.reasons) {
    const dimension = r.dimension.trim();
    if (KNOWN_DIMENSIONS.has(dimension) && clean(r.reason) && !reasons.some((x) => x.dimension === dimension)) reasons.push({ dimension, reason: clean(r.reason) });
  }
  return { version: 2, story, mythApplicable: applicable, history, storyValue: sv, historicalValue: hv, appeal: storyAppeal(sv, hv), reasons, rationale: clean(a.rationale) };
}

/**
 * Apply the critic's assessments: UNSUPPORTED candidates are removed (with the
 * critic's findings), NEEDS_CAVEAT adds the caveat, scores are clamped to
 * 0–10 and combined into story value, historical value and STORY APPEAL (the
 * rank score).
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
    const scores = scoresFrom(a, d);
    const notes = [...d.notes];
    if (a.support === 'NEEDS_CAVEAT') notes.push(clean(a.caveat) || a.problems.filter((p) => p.trim()).join('; ') || 'The critic asked for a caveat.');
    scored.push({
      ...d,
      notes,
      scores,
      rankScore: scores.appeal,
      storyValue: scores.storyValue,
      historicalValue: scores.historicalValue,
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
  centralQuestion: string;
  narrativeMode: NarrativeMode | null;
  povStrategy: PovChoice | null;
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
  return {
    keys,
    reasons,
    workingPremise: clean(raw.workingPremise),
    rationale: clean(raw.rationale),
    alternates,
    centralQuestion: clean(raw.centralQuestion),
    narrativeMode: raw.narrativeMode ?? null,
    povStrategy: raw.povStrategy ? { type: raw.povStrategy.type, description: clean(raw.povStrategy.description) } : null,
    notes,
  };
}

/** The narrative mode an engine-1 candidate is given when it is carried into an engine-2 pack (the editor can change it). */
export const DEFAULT_MODE_FOR_TYPE: Readonly<Record<StoryType, NarrativeMode>> = {
  CHARACTER: 'CHARACTER_FOLLOW',
  DEAL: 'CAUSE_AND_EFFECT',
  MARKET_EVENT: 'COUNTDOWN',
  FORTUNE: 'RISE_AND_FALL',
  SCAM: 'HEIST_OPERATION',
  CONFLICT: 'CONFLICT',
  REVERSAL: 'CAUSE_AND_EFFECT',
  MYSTERY: 'HISTORICAL_MYSTERY',
  MYTH_ORIGIN: 'MYTH_VS_RECORD',
  DISCOVERY: 'DISCOVERY',
  DISASTER: 'RISE_AND_FALL',
  SOCIAL_PHENOMENON: 'IMMERSIVE_RECONSTRUCTION',
};

/**
 * Engine-2 fields for a candidate carried over from an engine-1 pack, derived
 * only from what that candidate already says (nothing new is asserted). The
 * critic then scores it like any other candidate.
 */
/** The critic's rationale on a carried engine-1 candidate it returned no assessment for. */
export const NOT_SCORED = 'Not scored: the critic returned no assessment for this carried candidate.';

export function legacyStoryFields(c: { storyType: StoryType; characters: readonly StoryCharacter[]; hook: string; setting: string; stakes: string; conflict: string; turningPoint: string; viewerQuestion: string }) {
  const protagonist = c.characters[0]?.name ?? '';
  return {
    humanStakes: { protagonist, couldGain: '', couldLose: c.stakes, immediateProblem: c.conflict } satisfies HumanStakes,
    storyDesign: { coldOpen: { text: c.hook, basis: 'UNCERTAIN' as const }, reveal: c.turningPoint, visualEnvironment: c.setting, humanStory: protagonist !== '' && c.stakes !== '' } satisfies StoryDesign,
    narrativeMode: DEFAULT_MODE_FOR_TYPE[c.storyType],
    povStrategy: { type: 'NARRATOR' as const, description: '' } satisfies PovChoice,
    centralQuestion: c.viewerQuestion,
    reconstructionLevel: 'LOW' as const,
  };
}
