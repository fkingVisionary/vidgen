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
import { caveatClaims, checkFigures, checkPerson, orderedKeys } from './rules.ts';
import type { ArchitectOutput } from './schemas.ts';
import { normalize } from './text.ts';

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
  'NO_EVIDENCE', // a sequence cites no dossier claim
  'EVENT_WITHOUT_EVIDENCE', // a key event cites no dossier claim
  'NO_SOURCES', // no retrieved source behind a sequence's claims
  'UNGROUNDED_PERSON', // a person not in the evidence
  'UNSUPPORTED_FIGURE', // a figure not in the dossier
  'MISSING_CAVEAT', // a disputed/unverified/myth claim without instructions on how to tell it
  'HIGH_PRIORITY_UNUSED', // the editor's HIGH-priority unit left out
  'UNUSED_WITHOUT_REASON', // a selected unit left out without saying why
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Findings that fail the architecture gate if they remain after review. */
export const BLOCKING_FINDINGS: readonly FindingKind[] = [
  'NO_EVIDENCE',
  'EVENT_WITHOUT_EVIDENCE',
  'NO_SOURCES',
  'UNGROUNDED_PERSON',
  'UNSUPPORTED_FIGURE',
  'MISSING_CAVEAT',
  'HIGH_PRIORITY_UNUSED',
];

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

/** Text of a sequence that can carry facts (checked for figures). */
export function sequenceTexts(s: Pick<StorySequence, 'title' | 'purpose' | 'openingHook' | 'narrativeQuestion' | 'keyEvents' | 'conflict' | 'escalation' | 'reveal' | 'endingBeat' | 'caveats'>): string[] {
  return [s.title, s.purpose, s.openingHook, s.narrativeQuestion, ...s.keyEvents.map((e) => e.event), s.conflict, s.escalation, s.reveal, s.endingBeat, ...s.caveats.map((c) => c.framing)];
}

/**
 * Turn the architect's output into a StoryArchitectureContent and list what
 * breaks the evidence rules. Like mining, it links the claim a figure or
 * person comes from when the dossier has it; everything else becomes a
 * finding for the reviewer to fix and the gate to judge. Sources, historical
 * status and confidence are derived here, never taken from the model.
 */
export function buildArchitecture(raw: ArchitectOutput, evidence: EvidenceBase, units: readonly SelectedUnit[]): BuiltArchitecture {
  const notes: string[] = [];
  const findings: ArchitectureFinding[] = [];
  const unitByKey = new Map(units.map((u) => [u.key, u]));
  const unitClaims = units.flatMap((u) => u.claimKeys);
  const knownCharacters = new Map(units.flatMap((u) => u.characters.map((c) => [normalize(c.name), c] as const)));
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

    const keys = new Set<string>();
    const keyEvents = s.keyEvents
      .map((e) => ({ event: clean(e.event), claimKeys: orderedKeys(e.claimKeys, evidence) }))
      .filter((e) => e.event);
    for (const e of keyEvents) {
      if (e.claimKeys.length === 0) finding('EVENT_WITHOUT_EVIDENCE', `the event "${e.event}" cites no dossier claim`);
      for (const k of e.claimKeys) keys.add(k);
    }
    const unknown = [...s.claimKeys, ...s.keyEvents.flatMap((e) => e.claimKeys)].filter((k) => !evidence.has(k));
    if (unknown.length) notes.push(`Sequence ${number}: unknown claim keys dropped (${[...new Set(unknown)].join(', ')})`);
    for (const k of orderedKeys(s.claimKeys, evidence)) keys.add(k);

    // People: a character of a selected unit, or someone the evidence names.
    const characters: string[] = [];
    for (const name of s.characters.map(clean).filter(Boolean)) {
      if (characters.includes(name)) continue;
      const known = knownCharacters.get(normalize(name));
      if (known) {
        characters.push(name);
        for (const k of known.claimKeys) keys.add(k);
        continue;
      }
      const check = checkPerson(name, [...keys, ...unitClaims], evidence);
      if (!check.grounded) {
        finding('UNGROUNDED_PERSON', `"${name}" is not named in the story units or the evidence`);
        continue;
      }
      for (const k of check.link) keys.add(k);
      if (check.link.length) notes.push(`Sequence ${number}: linked ${check.link.join(', ')} (where the dossier names ${name})`);
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
      caveats: s.caveats.map((c) => ({ claimKey: c.claimKey.trim(), framing: clean(c.framing) })),
    };

    const figures = checkFigures(sequenceTexts(draft), [...keys], evidence);
    for (const f of figures.unsupported) finding('UNSUPPORTED_FIGURE', `uses the figure ${f}, which is not in the dossier`);
    for (const link of figures.links) {
      notes.push(`Sequence ${number}: linked ${link.claimKeys.join(', ')} (source of the figure ${link.figure})`);
      for (const k of link.claimKeys) keys.add(k);
    }

    const claimKeys = orderedKeys(keys, evidence);
    if (claimKeys.length === 0) finding('NO_EVIDENCE', 'cites no dossier claim');
    const caveats = draft.caveats.filter((c, idx, all) => c.framing && claimKeys.includes(c.claimKey) && all.findIndex((x) => x.claimKey === c.claimKey) === idx);
    for (const k of caveatClaims(claimKeys, evidence)) {
      if (!caveats.some((c) => c.claimKey === k)) finding('MISSING_CAVEAT', `uses ${k} (${evidence.claim(k)!.verdict}) without saying how the narration must present it`);
    }
    const sourceIds = evidence.sourcesFor(claimKeys);
    if (claimKeys.length > 0 && sourceIds.length === 0) finding('NO_SOURCES', 'no retrieved source with a verified quote backs its claims');

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
      historicalStatus: historicalStatusOf(claimKeys.map((k) => evidence.claim(k)!.verdict)),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(claimKeys)),
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
