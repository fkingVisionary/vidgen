import {
  historicalConfidenceOf,
  historicalStatusOf,
  structuralDurationSec,
  type CandidatePriority,
  type CandidateStatus,
  type HistoricalStatus,
  type MythThread,
  type StoryArchitectureContent,
  type StoryCharacter,
  type StorySequence,
  type StoryType,
} from '@docengine/core';
import type { EvidenceBase } from './evidence.ts';
import { MAX_AUTO_LINKS, caveatClaims, checkFigures, checkPerson, orderedKeys, strongestFirst } from './rules.ts';
import type { ArchitectOutput } from './schemas.ts';
import { WordIndex, nameGrounded, nameTokens, normalize, wordTokens } from './text.ts';

/** A story candidate the editor selected for the documentary. */
export interface SelectedUnit {
  id: string;
  key: string;
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
  viewerQuestion: string;
  mythThread: MythThread | null;
  notes: string | null;
  claimKeys: string[];
  historicalStatus: HistoricalStatus;
  historicalConfidence: number;
  rankScore: number;
  status: CandidateStatus;
  priority: CandidatePriority;
  editorNotes: string | null;
}

export const FINDING_KINDS = [
  'NO_UNIT', // a sequence tells no selected story unit: it would be a new story
  'NO_EVIDENCE', // a sequence cites no claim of the selected units
  'CORE_OUTSIDE_SELECTION', // story evidence that is not a claim of the selected units
  'EVENT_WITHOUT_EVIDENCE', // a key event cites no dossier claim
  'EVENT_OUTSIDE_SELECTION', // a key event rests on a claim outside the selected units
  'CONTEXT_WITHOUT_PURPOSE', // a background claim that does not say what background it provides
  'NO_SOURCES', // no retrieved source behind a sequence's core claims, or behind a context claim
  'UNGROUNDED_PERSON', // a character not in the selected units or their evidence
  'PERSON_OUTSIDE_SELECTION', // a person the dossier knows only outside the selected units
  'UNSUPPORTED_FIGURE', // a figure (years included) not in the selected units' evidence
  'MISSING_CAVEAT', // a disputed/unverified/myth claim without instructions on how to tell it
  'HIGH_PRIORITY_UNUSED', // the editor's HIGH-priority unit left out
  'UNUSED_WITHOUT_REASON', // a selected unit left out without saying why
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Findings that fail the architecture gate if they remain after review. */
export const BLOCKING_FINDINGS: readonly FindingKind[] = FINDING_KINDS.filter((k) => k !== 'UNUSED_WITHOUT_REASON');

export interface ArchitectureFinding {
  kind: FindingKind;
  /** Sequence number, or null for the architecture as a whole. */
  sequence: number | null;
  detail: string;
}

export function describeFinding(f: ArchitectureFinding): string {
  return `${f.sequence ? `Sequence ${f.sequence}: ` : ''}${f.detail}`;
}

export interface BuiltArchitecture {
  content: StoryArchitectureContent;
  notes: string[];
  findings: ArchitectureFinding[];
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Recorded for a selected unit left out without a reason. */
export const NO_REASON = 'No reason given.';

type SequenceText = Pick<StorySequence, 'title' | 'purpose' | 'openingHook' | 'narrativeQuestion' | 'keyEvents' | 'conflict' | 'escalation' | 'reveal' | 'endingBeat' | 'caveats' | 'contextClaims'>;

/** Text of a sequence that can carry facts (checked for figures). */
export function sequenceTexts(s: SequenceText): string[] {
  return [...storyTexts(s), ...s.caveats.map((c) => c.framing)];
}

/** The telling itself (not the caveats, which may attribute a dispute to historians): where a person could be brought in. */
export function storyTexts(s: Omit<SequenceText, 'caveats'>): string[] {
  return [s.title, s.purpose, s.openingHook, s.narrativeQuestion, ...s.keyEvents.map((e) => e.event), s.conflict, s.escalation, s.reveal, s.endingBeat, ...s.contextClaims.map((c) => c.purpose)];
}

/** The selected units' own claims: the only story evidence an architecture may use (dossier order). */
export function coreClaimsOf(units: readonly SelectedUnit[], evidence: EvidenceBase): string[] {
  return orderedKeys(
    units.flatMap((u) => u.claimKeys),
    evidence,
  );
}

const DUTCH_PARTICLES = new Set(['van', 'de', 'der', 'den', 'ten', 'ter', 'het', 'von', "'t"]);

/**
 * People the dossier names (its key figures) who are absent from the selected
 * units' evidence, with the words that would identify them in a text (name
 * words the units' evidence does not contain). Only personal names count:
 * every word capitalised apart from Dutch particles, so institutions such as
 * "Court of Holland" or groups such as "Haarlem florists" are left out.
 */
export function outsidePeople(evidence: EvidenceBase, coreClaims: readonly string[]): { name: string; words: string[] }[] {
  const coreText = new WordIndex(evidence.textFor(coreClaims));
  const coreWords = new Set(wordTokens(evidence.textFor(coreClaims)));
  return evidence.content.keyFigures
    .map((f) => f.name.trim())
    .filter((name) => {
      const parts = name.split(/\s+/);
      return parts.length > 0 && parts.every((p) => DUTCH_PARTICLES.has(p.toLowerCase()) || /^\p{Lu}/u.test(p));
    })
    .filter((name) => !nameGrounded(name, coreText))
    .map((name) => ({ name, words: nameTokens(name).filter((w) => w.length >= 4 && !coreWords.has(w)) }))
    .filter((p) => p.words.length > 0);
}

/** Outside people a sequence's telling mentions. */
export function peopleMentioned(texts: readonly string[], people: readonly { name: string; words: string[] }[]): string[] {
  const words = new Set(wordTokens(texts.join('\n')));
  return people.filter((p) => p.words.some((w) => words.has(w))).map((p) => p.name);
}

/**
 * Turn the architect's output into a StoryArchitectureContent and list what
 * breaks the evidence rules. The selected units' own claims are the only story
 * evidence: key events, people and figures must come from them (a figure or
 * person found in another unit's claim links that claim). Other dossier
 * claims may appear only as labelled context claims with a stated purpose.
 * Whatever breaks these rules becomes a finding for the reviewer to fix and
 * the gate to judge. Sources, historical status and confidence are derived
 * here, never taken from the model.
 */
export function buildArchitecture(raw: ArchitectOutput, evidence: EvidenceBase, units: readonly SelectedUnit[]): BuiltArchitecture {
  const notes: string[] = [];
  const findings: ArchitectureFinding[] = [];
  const unitByKey = new Map(units.map((u) => [u.key, u]));
  const coreClaims = coreClaimsOf(units, evidence);
  const isCore = new Set(coreClaims);
  const outsiders = outsidePeople(evidence, coreClaims);
  const used = new Set<string>();

  const sequences: StorySequence[] = raw.sequences.map((s, i) => {
    const number = i + 1;
    const finding = (kind: FindingKind, detail: string) => findings.push({ kind, sequence: number, detail });

    const candidateKeys: string[] = [];
    for (const k of s.candidateKeys.map((x) => x.trim())) {
      if (!unitByKey.has(k)) notes.push(`Sequence ${number}: ${k} is not a selected unit; ignored`);
      else if (!candidateKeys.includes(k)) candidateKeys.push(k);
    }
    for (const k of candidateKeys) used.add(k);
    if (candidateKeys.length === 0) finding('NO_UNIT', 'tells no selected story unit, so it would be a new story');

    const contextIn = s.contextClaims ?? [];
    const unknown = [...s.claimKeys, ...s.keyEvents.flatMap((e) => e.claimKeys), ...contextIn.map((c) => c.claimKey)].map((k) => k.trim()).filter((k) => !evidence.has(k));
    if (unknown.length) notes.push(`Sequence ${number}: unknown claim keys dropped (${[...new Set(unknown)].join(', ')})`);

    // Context: other dossier claims, background only, each saying what it is for.
    const contextClaims: { claimKey: string; purpose: string }[] = [];
    for (const c of contextIn) {
      const key = c.claimKey.trim();
      if (!evidence.has(key) || contextClaims.some((x) => x.claimKey === key)) continue;
      if (isCore.has(key)) {
        notes.push(`Sequence ${number}: ${key} is a claim of the selected units; counted as story evidence, not context`);
        continue;
      }
      const purpose = clean(c.purpose);
      if (!purpose) finding('CONTEXT_WITHOUT_PURPOSE', `context claim ${key} does not say what background it provides`);
      contextClaims.push({ claimKey: key, purpose });
    }
    const isContext = new Set(contextClaims.map((c) => c.claimKey));

    // Story evidence: what the sequence declares, plus what its key events cite.
    const keys = new Set<string>();
    // Claims the rules link (for a character, person or figure the telling uses), with what each was linked for.
    const linkedFor = new Map<string, string>();
    const addLinked = (k: string, what: string) => {
      if (keys.has(k)) return;
      keys.add(k);
      linkedFor.set(k, what);
    };
    const keyEvents = s.keyEvents
      .map((e) => ({ event: clean(e.event), claimKeys: orderedKeys(e.claimKeys.map((k) => k.trim()), evidence) }))
      .filter((e) => e.event);
    for (const e of keyEvents) {
      if (e.claimKeys.length === 0) finding('EVENT_WITHOUT_EVIDENCE', `the event "${e.event}" cites no dossier claim`);
      const outside = e.claimKeys.filter((k) => !isCore.has(k));
      if (outside.length) finding('EVENT_OUTSIDE_SELECTION', `the event "${e.event}" rests on ${outside.join(', ')}, outside the selected units' claims`);
      for (const k of e.claimKeys) if (!isContext.has(k)) keys.add(k);
    }
    for (const k of orderedKeys(s.claimKeys.map((x) => x.trim()), evidence)) if (!isContext.has(k) || isCore.has(k)) keys.add(k);

    // People: a character of a selected unit (this sequence's own units first), or someone the units' evidence names.
    const characters: string[] = [];
    const ownUnits = candidateKeys.map((k) => unitByKey.get(k)!);
    const findCharacter = (name: string, from: readonly SelectedUnit[]) => from.flatMap((u) => u.characters).find((c) => normalize(c.name) === normalize(name));
    for (const name of s.characters.map(clean).filter(Boolean)) {
      if (characters.includes(name)) continue;
      const known = findCharacter(name, ownUnits) ?? findCharacter(name, units);
      if (known) {
        characters.push(name);
        // One claim grounds a character: none is added if the sequence already cites one of theirs, otherwise
        // their firmest. Linking every claim that names them would pull in unrelated myths and disputes.
        const theirs = known.claimKeys.filter((k) => evidence.has(k));
        if (!theirs.some((k) => keys.has(k))) {
          for (const k of strongestFirst(evidence, theirs).slice(0, MAX_AUTO_LINKS)) {
            addLinked(k, `the character ${name}`);
            notes.push(`Sequence ${number}: linked ${k} (evidence for the character ${name})`);
          }
        }
        continue;
      }
      const check = checkPerson(name, [...keys].filter((k) => isCore.has(k)), evidence, { linkFrom: coreClaims });
      if (!check.grounded) {
        finding('UNGROUNDED_PERSON', `"${name}" is not in the selected units or their evidence`);
        continue;
      }
      for (const k of check.link) addLinked(k, `the name ${name}`);
      if (check.link.length) notes.push(`Sequence ${number}: linked ${check.link.join(', ')} (where the selected units' evidence names ${name})`);
      characters.push(name);
    }

    const draft = {
      title: clean(s.title) || `Sequence ${number}`,
      purpose: clean(s.purpose),
      openingHook: clean(s.openingHook),
      narrativeQuestion: clean(s.narrativeQuestion),
      keyEvents,
      conflict: clean(s.conflict),
      escalation: clean(s.escalation),
      reveal: clean(s.reveal),
      endingBeat: clean(s.endingBeat),
      contextClaims,
      caveats: s.caveats.map((c) => ({ claimKey: c.claimKey.trim(), framing: clean(c.framing) })),
    };

    // Figures, years included, must come from the selected units' evidence; context claims add none.
    const figures = checkFigures(sequenceTexts(draft), [...keys].filter((k) => isCore.has(k)), evidence, { linkFrom: coreClaims, strictYears: true });
    for (const f of figures.unsupported) finding('UNSUPPORTED_FIGURE', `uses the figure ${f}, which is not in the selected units' evidence`);
    for (const link of figures.links) {
      notes.push(`Sequence ${number}: linked ${link.claimKeys.join(', ')} (source of the figure ${link.figure})`);
      for (const k of link.claimKeys) addLinked(k, `the figure ${link.figure}`);
    }
    for (const name of peopleMentioned(storyTexts(draft), outsiders)) {
      finding('PERSON_OUTSIDE_SELECTION', `mentions ${name}, who appears in the dossier but not in the selected units' evidence`);
    }

    const claimKeys = orderedKeys(keys, evidence);
    for (const k of claimKeys.filter((x) => !isCore.has(x))) {
      finding('CORE_OUTSIDE_SELECTION', `uses ${k} as story evidence, but it is not a claim of the selected units (make it a labelled context claim or drop it)`);
    }
    if (!claimKeys.some((k) => isCore.has(k))) finding('NO_EVIDENCE', 'cites no claim of the selected units');
    const contextKeys = contextClaims.map((c) => c.claimKey);
    const allKeys = [...claimKeys, ...contextKeys];
    const caveats = draft.caveats.filter((c, idx, all) => c.framing && allKeys.includes(c.claimKey) && all.findIndex((x) => x.claimKey === c.claimKey) === idx);
    for (const k of caveatClaims(allKeys, evidence)) {
      if (caveats.some((c) => c.claimKey === k)) continue;
      const why = linkedFor.get(k);
      finding(
        'MISSING_CAVEAT',
        `uses ${k} (${evidence.claim(k)!.verdict}) without saying how the narration must present it` +
          (why ? ` (the evidence rules linked it for ${why}: add a caveat for it, or drop ${why})` : ''),
      );
    }
    const sourceIds = evidence.sourcesFor(claimKeys);
    if (claimKeys.length > 0 && sourceIds.length === 0) finding('NO_SOURCES', 'no retrieved source with a verified quote backs its story evidence');
    for (const k of contextKeys) if (evidence.traceableSources(k).length === 0) finding('NO_SOURCES', `context claim ${k} has no retrieved source with a verified quote`);
    const contextSourceIds = evidence.sourcesFor(contextKeys).filter((id) => !sourceIds.includes(id));

    const estimate = Number.isFinite(s.estimatedDurationSec) && s.estimatedDurationSec > 0 ? Math.round(s.estimatedDurationSec) : structuralDurationSec({ ...draft, caveats });
    return {
      number,
      ...draft,
      caveats,
      candidateIds: candidateKeys.map((k) => unitByKey.get(k)!.id),
      candidateKeys,
      characters,
      claimKeys,
      sourceIds,
      contextSourceIds,
      historicalStatus: historicalStatusOf(allKeys.map((k) => evidence.claim(k)!.verdict)),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(allKeys)),
      estimatedDurationSec: estimate,
    };
  });

  const reasons = new Map(raw.unusedCandidates.map((u) => [u.candidateKey.trim(), clean(u.reason)]));
  const unusedCandidates = units
    .filter((u) => !used.has(u.key))
    .map((u) => {
      const reason = reasons.get(u.key) ?? '';
      if (u.priority === 'HIGH') findings.push({ kind: 'HIGH_PRIORITY_UNUSED', sequence: null, detail: `${u.key} "${u.title}" is HIGH priority but no sequence uses it` });
      else if (!reason) findings.push({ kind: 'UNUSED_WITHOUT_REASON', sequence: null, detail: `${u.key} "${u.title}" is not used and no reason is given` });
      return { candidateKey: u.key, reason: reason || NO_REASON };
    });

  return {
    content: {
      premise: clean(raw.premise),
      centralQuestion: clean(raw.centralQuestion),
      narrativeSpine: clean(raw.narrativeSpine),
      resolution: clean(raw.resolution),
      sequences,
      unusedCandidates,
    },
    notes,
    findings,
  };
}

export function blockingCount(findings: readonly ArchitectureFinding[]): number {
  return findings.filter((f) => BLOCKING_FINDINGS.includes(f.kind)).length;
}

/** Total of the sequences' estimated durations. */
export function totalDurationSec(content: StoryArchitectureContent): number {
  return content.sequences.reduce((sum, s) => sum + s.estimatedDurationSec, 0);
}
