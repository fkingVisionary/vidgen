import {
  FICTIONAL_CAST_KINDS,
  PRESENTATION_FOR_VERDICT,
  type ClaimPresentation,
  type ClaimVerdict,
  type InformationClass,
  type Presentation,
  type StoryArchitectureContentV2,
  type StoryBeat,
  type StoryCastMember,
  type StorySequenceV2,
} from '@docengine/core';
import { nameTokens, outsidePeople, wordTokens, type EvidenceBase } from '@docengine/story/shared';

/**
 * What a script may tell: the approved architecture and the evidence it
 * cites. The script engine does not reinterpret the dossier — a claim the
 * architecture does not cite is outside the script's evidence boundary.
 */
export interface ScriptScope {
  architectureId: string;
  architectureVersion: number;
  architecture: StoryArchitectureContentV2;
  evidence: EvidenceBase;
  /** Every claim the architecture cites (story evidence, background, cast, presentation, visuals), dossier order. */
  claims: string[];
  claimSet: ReadonlySet<string>;
  sequences: ReadonlyMap<number, StorySequenceV2>;
  beats: ReadonlyMap<string, { beat: StoryBeat; sequence: number }>;
  cast: ReadonlyMap<string, CastInfo>;
  /** How each claim that is not ESTABLISHED must be presented (the architecture's instruction, or the default for its verdict). */
  presentation: ReadonlyMap<string, { verdict: ClaimVerdict; presentation: Presentation; instruction: string }>;
  /** Dossier people the architecture does not cite: never named in the script. */
  outsiders: { name: string; words: string[] }[];
  /** Words the evidence and the declared cast know (for unknown names). */
  known: { has(word: string): boolean };
}

export interface CastInfo {
  member: StoryCastMember;
  fictional: boolean;
  /** Words that identify them in a text ("you"/"your" for the viewer's POV). */
  tokens: string[];
}

/**
 * The words that identify a cast member in narration: any word of their name
 * (writers use first names as often as surnames), or "you"/"your" for the
 * viewer's POV. Groups and roles ("the florists") are identified by their last word.
 */
export function castTokens(m: StoryCastMember): string[] {
  if (m.kind === 'POV_PROXY') return ['you', 'your'];
  const t = nameTokens(m.name).filter((w) => w.length >= 3);
  if (m.kind === 'REAL_GROUP' || m.kind === 'REAL_ROLE') return t.length ? [t.at(-1)!] : [];
  return t;
}

/** Default wording instruction per presentation, when the architecture gave none for a claim. */
const DEFAULT_INSTRUCTION: Record<Presentation, string> = {
  STATE: 'State it.',
  HEDGE: 'Word it as probable: "records suggest", "it appears", "probably".',
  PRESENT_AS_DISPUTED: 'Say that it is disputed and by whom, if known.',
  PRESENT_AS_UNCONFIRMED: 'Say that it cannot be confirmed.',
  INVESTIGATE_AS_MYTH: 'Tell it as the popular story, then test it against the record.',
};

export function buildScope(args: { architectureId: string; architectureVersion: number; architecture: StoryArchitectureContentV2; evidence: EvidenceBase }): ScriptScope {
  const { architecture: a, evidence } = args;
  const cited = new Set<string>();
  const add = (keys: readonly string[]) => keys.forEach((k) => evidence.has(k) && cited.add(k));
  for (const m of a.cast) add(m.claimKeys);
  const beats = new Map<string, { beat: StoryBeat; sequence: number }>();
  const instructions = new Map<string, ClaimPresentation>();
  for (const s of a.sequences) {
    add(s.claimKeys);
    add(s.contextClaims.map((c) => c.claimKey));
    add(s.visual.mustShow.flatMap((m) => m.claimKeys));
    for (const p of s.presentation) {
      add([p.claimKey]);
      if (!instructions.has(p.claimKey)) instructions.set(p.claimKey, p);
    }
    for (const b of s.beats) {
      add(b.claimKeys);
      add(b.speech.flatMap((x) => (x.claimKey ? [x.claimKey] : [])));
      beats.set(b.id, { beat: b, sequence: s.number });
    }
  }
  const claims = [...evidence.claims.keys()].filter((k) => cited.has(k));
  const presentation = new Map<string, { verdict: ClaimVerdict; presentation: Presentation; instruction: string }>();
  for (const key of claims) {
    const verdict = evidence.claim(key)!.verdict;
    if (verdict === 'ESTABLISHED') continue;
    const given = instructions.get(key);
    const kind = PRESENTATION_FOR_VERDICT[verdict];
    presentation.set(key, { verdict, presentation: kind, instruction: given && given.presentation === kind ? given.instruction : DEFAULT_INSTRUCTION[kind] });
  }
  const cast = new Map<string, CastInfo>(a.cast.map((m) => [m.id, { member: m, fictional: FICTIONAL_CAST_KINDS.includes(m.kind), tokens: castTokens(m) }]));
  const castWords = new Set(a.cast.flatMap((m) => wordTokens(m.name)));
  const dossierWords = evidence.dossierWords();
  return {
    ...args,
    claims,
    claimSet: new Set(claims),
    sequences: new Map(a.sequences.map((s) => [s.number, s])),
    beats,
    cast,
    presentation,
    outsiders: outsidePeople(evidence, claims),
    known: { has: (w: string) => castWords.has(w) || dossierWords.has(w) },
  };
}

/** The information classes of the beats a block realises. */
export function beatClasses(scope: ScriptScope, beatIds: readonly string[]): Set<InformationClass> {
  return new Set(beatIds.flatMap((id) => {
    const b = scope.beats.get(id);
    return b ? [b.beat.basis] : [];
  }));
}

export const fictionalCast = (scope: ScriptScope) => [...scope.cast.values()].filter((c) => c.fictional);
export const realCast = (scope: ScriptScope) => [...scope.cast.values()].filter((c) => !c.fictional);
