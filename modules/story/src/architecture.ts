import {
  FICTIONAL_CAST_KINDS,
  FICTIONAL_CAST_LIMITS,
  HEDGE_PATTERN,
  PRESENTATION_FOR_VERDICT,
  RECONSTRUCTION_BUDGET,
  historicalConfidenceOf,
  historicalStatusOf,
  informationShares,
  reconstructionLevelOf,
  structuralDurationSecV2,
  type BeatSpeech,
  type CandidatePriority,
  type CandidateStatus,
  type ClaimPresentation,
  type HistoricalStatus,
  type HumanStakes,
  type MythThread,
  type NarrativeMode,
  type PovChoice,
  type StoryArchitectureContentV2,
  type StoryBeat,
  type StoryCastMember,
  type StoryCharacter,
  type StoryDesign,
  type StorySequenceV2,
  type StoryType,
} from '@docengine/core';
import type { EvidenceBase } from './evidence.ts';
import { MAX_AUTO_LINKS, checkFigures, checkPerson, orderedKeys, strongestFirst } from './rules.ts';
import type { ArchitectOutput, ArchitectSequence } from './schemas.ts';
import {
  INTERACTION_VERBS,
  MENTAL_VERBS,
  WordIndex,
  isYear,
  jaccard,
  nameGrounded,
  nameTokens,
  normalize,
  quoteFoundIn,
  quotedPassages,
  subjectVerbObject,
  unknownProperNouns,
  wordTokens,
  extractFigures,
} from './text.ts';

/** A story candidate the editor selected for the documentary. */
export interface SelectedUnit {
  id: string;
  key: string;
  /** The editor's title if set, otherwise the AI's. */
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
  // Story Engine 2.0 (effective values: the editor's override, else the AI's; null for engine-1 candidates)
  narrativeMode: NarrativeMode | null;
  centralQuestion: string | null;
  povStrategy: PovChoice | null;
  humanStakes: HumanStakes | null;
  storyDesign: StoryDesign | null;
  /** The editor's position for this unit in the selection, if the editor ordered it. */
  selectionOrder: number | null;
}

export const FINDING_KINDS = [
  // Evidence boundary
  'NO_UNIT', // a sequence tells no selected story unit: it would be a new story
  'NO_EVIDENCE', // a sequence cites no claim of the selected units
  'UNKNOWN_CLAIM', // a claim key that is not in the approved dossier
  'CORE_OUTSIDE_SELECTION', // story evidence that is not a claim of the selected units
  'BEAT_OUTSIDE_SELECTION', // a beat rests on a claim outside the selected units (other than labelled background in orientation)
  'CONTEXT_WITHOUT_PURPOSE', // a background claim that does not say what background it provides
  'NO_SOURCES', // no retrieved source behind a sequence's story evidence, or behind a context claim
  // Information classes and presentation
  'BEAT_WITHOUT_EVIDENCE', // a documented, reconstructed or uncertain beat that cites no claim
  'DOCUMENTED_NOT_ESTABLISHED', // a beat presented as documented fact rests on claims that are not ESTABLISHED
  'MYTH_NOT_INVESTIGATED', // a MYTH claim outside an UNCERTAIN beat
  'MISSING_PRESENTATION', // a claim that is not ESTABLISHED without its presentation instruction
  'WRONG_PRESENTATION', // a presentation instruction of the wrong kind for the claim's verdict
  'WEAK_HEDGE', // a PROBABLE claim's instruction does not word the hedge
  // People and fiction
  'UNGROUNDED_PERSON', // a real person not in the selected units or their evidence
  'PERSON_OUTSIDE_SELECTION', // a person the dossier knows only outside the selected units
  'CAST_WITHOUT_EVIDENCE', // a real group or role the selected units do not ground
  'UNDECLARED_CHARACTER', // a beat or line of speech uses a cast id that does not exist
  'UNKNOWN_NAME', // a name or place the evidence and the cast do not know
  'FICTION_NAME_COLLISION', // a fictional character named like someone in the dossier
  'COMPOSITE_WITHOUT_BASIS', // a fictional composite without the claims or the reason that justify it
  'FICTION_IN_DOCUMENTED_BEAT', // a fictional character in a beat presented as documented fact
  'FICTION_REAL_INTERACTION', // a fictional character speaking to, touching or trading with a real person
  'INVENTED_SPEECH_REAL_PERSON', // an invented line given to a real person
  'FICTIONAL_RECORDED_QUOTE', // a fictional character given a recorded quotation
  'UNVERIFIED_QUOTE', // a recorded quote that is not a verified quotation of its claim
  'UNVERIFIED_QUOTATION', // words in quotation marks that are neither verified nor a planned invented line
  // Figures, setting, visuals
  'UNSUPPORTED_FIGURE', // a figure (years included) not in the selected units' evidence
  'SETTING_NOT_IN_EVIDENCE', // a place or time of day presented as documented without evidence
  'VISUAL_DETAIL_WITHOUT_EVIDENCE', // a historical detail that must appear, without its claims
  // Editor and structure
  'HIGH_PRIORITY_UNUSED', // the editor's HIGH-priority unit left out
  'CENTRAL_QUESTION_UNANSWERED', // no sequence resolves the central question (Q0)
  // Warnings: the editor decides
  'UNUSED_WITHOUT_REASON', // a selected unit left out without saying why
  'TOO_MANY_FICTIONAL', // more fictional devices than one POV and two composites
  'POSSIBLE_REAL_INTERIORITY', // a real person seems to be given thoughts or feelings
  'RECONSTRUCTION_BUDGET', // reconstruction + fiction over 40% of beats, or fiction over 25%
  'CONTINUITY_BREAK', // something carried into a sequence that no earlier sequence carried out
  'UNRESOLVED_THREAD', // a question or promise opened and never resolved
  'UNKNOWN_THREAD', // a sequence resolves a question nobody opened
  'CHRONOLOGY_UNMARKED', // a jump back in time not marked as a flashback or parallel time
  'MISSING_TRANSITION', // a sequence (not the last) without a bridge into the next
  'NO_HUMAN_ANCHOR', // a sequence with no cast present
  'EXPOSITION_HEAVY', // a sequence dominated by orientation beats
  'BEAT_TOO_LONG', // a beat written as narration rather than described
  'ORDER_CHANGED_WITHOUT_REASON', // the editor's order changed without a note
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Findings that only warn: everything from UNUSED_WITHOUT_REASON on. */
export const WARNING_FINDINGS: readonly FindingKind[] = FINDING_KINDS.slice(FINDING_KINDS.indexOf('UNUSED_WITHOUT_REASON'));

/** Findings that fail the architecture gate if they remain after review. */
export const BLOCKING_FINDINGS: readonly FindingKind[] = FINDING_KINDS.filter((k) => !WARNING_FINDINGS.includes(k));

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
  content: StoryArchitectureContentV2;
  notes: string[];
  findings: ArchitectureFinding[];
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Recorded for a selected unit left out without a reason. */
export const NO_REASON = 'No reason given.';

/** Text of a sequence that can carry facts (checked for figures). mustAvoid lists what must not be shown, so it is left out. */
export function sequenceTexts(s: StorySequenceV2): string[] {
  return [...storyTexts(s), ...s.presentation.map((p) => p.instruction)];
}

/**
 * The telling itself — everything a viewer would see or hear — where a person,
 * place or event could be brought in. Presentation instructions are left out:
 * they may attribute a dispute to historians.
 */
export function storyTexts(s: StorySequenceV2): string[] {
  return [
    s.title,
    s.purpose,
    s.openingHook,
    s.question,
    s.conflict,
    s.escalation,
    s.reveal,
    s.consequence,
    s.endingBeat,
    s.transition,
    ...s.beats.flatMap((b) => [b.description, ...b.speech.map((x) => x.text)]),
    s.setting.location.value,
    s.setting.date.value,
    s.setting.timeOfDay.value,
    s.visual.environment,
    ...s.visual.keyObjects,
    ...s.visual.physicalActions,
    s.visual.emotionalState,
    s.visual.visualMetaphor,
    ...s.visual.mustShow.map((m) => m.detail),
    ...s.visual.shotIdeas,
    ...s.continuity.carriesIn,
    ...s.continuity.carriesOut,
    ...s.continuity.opens.map((o) => o.question),
    ...s.contextClaims.map((c) => c.purpose),
  ];
}

/** The selected units' own claims: the only story evidence an architecture may use (dossier order). */
export function coreClaimsOf(units: readonly SelectedUnit[], evidence: EvidenceBase): string[] {
  return orderedKeys(
    units.flatMap((u) => u.claimKeys),
    evidence,
  );
}

/** Particles that may appear in lower case inside a personal name ("Jan van Goyen", "Leonardo da Vinci"). */
const NAME_PARTICLES = new Set(['van', 'de', 'der', 'den', 'ten', 'ter', 'het', 'von', 'du', 'da', 'di', 'del', 'della', 'la', 'le', 'al', 'el', 'bin', 'ibn', "'t"]);

/**
 * People the dossier names (its key figures) who are absent from the selected
 * units' evidence, with the words that would identify them in a text (name
 * words the units' evidence does not contain). Only personal names count:
 * every word capitalised apart from name particles, so institutions ("Court
 * of Appeal") and groups ("the city's bakers") are left out.
 */
export function outsidePeople(evidence: EvidenceBase, coreClaims: readonly string[]): { name: string; words: string[] }[] {
  const coreText = new WordIndex(evidence.textFor(coreClaims));
  const coreWords = new Set(wordTokens(evidence.textFor(coreClaims)));
  return evidence.content.keyFigures
    .map((f) => f.name.trim())
    .filter((name) => {
      const parts = name.split(/\s+/);
      return parts.length > 0 && parts.every((p) => NAME_PARTICLES.has(p.toLowerCase()) || /^\p{Lu}/u.test(p));
    })
    .filter((name) => !nameGrounded(name, coreText))
    .map((name) => ({ name, words: nameTokens(name).filter((w) => w.length >= 4 && !coreWords.has(w)) }))
    .filter((p) => p.words.length > 0);
}

/** Outside people a text mentions. */
export function peopleMentioned(texts: readonly string[], people: readonly { name: string; words: string[] }[]): string[] {
  const words = new Set(wordTokens(texts.join('\n')));
  return people.filter((p) => p.words.some((w) => words.has(w))).map((p) => p.name);
}

/** Words for a time of day: a documented time of day must be in the evidence. */
const TIME_WORDS = ['morning', 'afternoon', 'evening', 'night', 'dawn', 'dusk', 'noon', 'midday', 'midnight', 'sunrise', 'sunset', 'nightfall', 'daybreak', 'twilight'];

/** A cast member as the rules see it: who is fictional, and the words that identify them in a text. */
interface CastInfo {
  member: StoryCastMember;
  fictional: boolean;
  /** Identifying tokens as subject or object ("you"/"your" for the viewer). */
  tokens: string[];
}

function castTokens(m: StoryCastMember): string[] {
  if (m.kind === 'POV_PROXY') return ['you', 'your'];
  const t = nameTokens(m.name);
  return t.length ? [t.at(-1)!] : [];
}

/** Fuzzy match of two continuity items ("the signed contract" ≈ "a contract"). */
function sameItem(a: string, b: string): boolean {
  const ta = new Set(wordTokens(a).filter((w) => w.length >= 3));
  const tb = new Set(wordTokens(b).filter((w) => w.length >= 3));
  if (ta.size === 0 || tb.size === 0) return false;
  if (jaccard(ta, tb) >= 0.5) return true;
  const longest = (t: Set<string>) => [...t].sort((x, y) => y.length - x.length)[0]!;
  return tb.has(longest(ta)) || ta.has(longest(tb));
}

/**
 * Turn the architect's output into a Story Engine 2.0 architecture and list
 * what breaks the rules. The research dossier is the fact boundary; creative
 * freedom applies to presentation only:
 *
 * - story evidence is the selected units' own claims (other claims only as
 *   labelled background); every beat carries an information class, and the
 *   classes are enforced (documented fact rests on ESTABLISHED claims only;
 *   reconstruction and uncertain history cite their claims; myths are
 *   investigated; every claim that is not ESTABLISHED has its presentation);
 * - fictional devices are declared, named unlike anyone in the dossier,
 *   justified, kept out of documented action and away from real people;
 *   real people get no invented words or actions; quotations are verified;
 * - names, places, figures and dates come from the evidence, wherever they
 *   appear (beats, speech, setting, visuals);
 * - continuity: the central question is answered, threads are tracked.
 *
 * Whatever breaks a rule becomes a finding for the reviewers to fix and the
 * gate to judge. Sources, historical status and confidence, reconstruction
 * shares and beat ids are derived here, never taken from the model.
 */
export function buildArchitecture(raw: ArchitectOutput, evidence: EvidenceBase, units: readonly SelectedUnit[]): BuiltArchitecture {
  const notes: string[] = [];
  const findings: ArchitectureFinding[] = [];
  const unitByKey = new Map(units.map((u) => [u.key, u]));
  const coreClaims = coreClaimsOf(units, evidence);
  const isCore = new Set(coreClaims);
  const outsiders = outsidePeople(evidence, coreClaims);
  const allContext = new Set(raw.sequences.flatMap((s) => s.contextClaims.map((c) => c.claimKey.trim())).filter((k) => evidence.has(k) && !isCore.has(k)));
  const global = (kind: FindingKind, detail: string) => findings.push({ kind, sequence: null, detail });

  // ── Cast ──────────────────────────────────────────────────────────────────
  const cast: StoryCastMember[] = [];
  const castById = new Map<string, CastInfo>();
  const droppedCast = new Set<string>();
  const bare = (name: string) => normalize(name).replace(/^(the|a|an) /, '');
  const unitCharacter = (name: string) => units.flatMap((u) => u.characters).find((c) => bare(c.name) === bare(name));
  for (const m of raw.cast) {
    const id = clean(m.id);
    const name = clean(m.name);
    if (!id || !name || castById.has(id)) {
      if (id && castById.has(id)) notes.push(`Cast: duplicate id ${id} ignored`);
      continue;
    }
    const fictional = FICTIONAL_CAST_KINDS.includes(m.kind);
    const keys = orderedKeys(m.claimKeys.map((k) => k.trim()), evidence);
    const unknown = m.claimKeys.map((k) => k.trim()).filter((k) => k && !evidence.has(k));
    for (const k of unknown) global('UNKNOWN_CLAIM', `the cast member ${name} cites ${k}, which is not in the approved dossier`);
    let claimKeys = keys;
    if (fictional) {
      if (m.kind === 'FICTIONAL_COMPOSITE') {
        const collides = nameTokens(name).length > 0 && (nameGrounded(name, evidence.dossierWords()) || evidence.content.keyFigures.some((f) => normalize(f.name) === normalize(name)));
        if (collides) global('FICTION_NAME_COLLISION', `the fictional composite "${name}" is named like someone in the dossier; a fictional character needs a name nobody in the record has`);
        const basis = keys.filter((k) => isCore.has(k) || allContext.has(k));
        if (basis.length === 0) global('COMPOSITE_WITHOUT_BASIS', `the fictional composite "${name}" cites no claim establishing that people like them existed`);
        if (!clean(m.justification)) global('COMPOSITE_WITHOUT_BASIS', `the fictional composite "${name}" does not say why the device is needed`);
        claimKeys = basis;
      } else {
        claimKeys = [];
      }
    } else {
      const character = unitCharacter(name);
      if (m.kind === 'REAL_PERSON') {
        const check = checkPerson(name, keys.filter((k) => isCore.has(k)), evidence, { linkFrom: coreClaims });
        if (!check.grounded) {
          const elsewhere = nameGrounded(name, evidence.dossierWords());
          if (elsewhere) global('PERSON_OUTSIDE_SELECTION', `the cast lists ${name}, who appears in the dossier but not in the selected units' evidence`);
          else global('UNGROUNDED_PERSON', `"${name}" is not in the selected units or their evidence`);
          droppedCast.add(id);
          continue;
        }
        claimKeys = orderedKeys([...keys.filter((k) => isCore.has(k)), ...check.link, ...(character?.claimKeys ?? [])], evidence);
        if (check.link.length) notes.push(`Cast: linked ${check.link.join(', ')} (where the selected units' evidence names ${name})`);
      } else {
        const grounded = keys.filter((k) => isCore.has(k));
        if (!character && grounded.length === 0) {
          global('CAST_WITHOUT_EVIDENCE', `the ${m.kind === 'REAL_GROUP' ? 'group' : 'role'} "${name}" is not grounded in the selected units' claims`);
          droppedCast.add(id);
          continue;
        }
        claimKeys = orderedKeys([...grounded, ...(character?.claimKeys ?? [])], evidence);
      }
    }
    const member: StoryCastMember = { id, name, kind: m.kind, description: clean(m.description), claimKeys, justification: clean(m.justification) };
    cast.push(member);
    castById.set(id, { member, fictional, tokens: castTokens(member) });
  }
  const povs = cast.filter((m) => m.kind === 'POV_PROXY').length;
  const composites = cast.filter((m) => m.kind === 'FICTIONAL_COMPOSITE').length;
  if (povs > FICTIONAL_CAST_LIMITS.pov || composites > FICTIONAL_CAST_LIMITS.composites) {
    global('TOO_MANY_FICTIONAL', `${povs} POV and ${composites} fictional composites (one POV and up to two composites before a warning)`);
  }
  const realPeople = cast.filter((m) => m.kind === 'REAL_PERSON');
  const realTokens = [...new Set([...realPeople.flatMap(castTokens), ...units.flatMap((u) => u.characters.filter((c) => c.kind === 'NAMED_PERSON').flatMap((c) => nameTokens(c.name).slice(-1)))])];
  const fictionalTokens = [...new Set(cast.filter((m) => FICTIONAL_CAST_KINDS.includes(m.kind)).flatMap(castTokens))];
  // Names a text may use: the dossier's words and the declared cast.
  const castWords = new Set(cast.flatMap((m) => wordTokens(m.name)));
  const knownWords = { has: (w: string) => castWords.has(w) || evidence.dossierWords().has(w) };

  // ── Framing: the logline, thesis and cast descriptions bring in no new names or figures either ──
  const framing = [raw.logline, raw.centralQuestion, raw.centralHumanStakes, raw.thesis, raw.narrativeSpine, raw.resolution, raw.orderNote, raw.povStrategy.description, ...cast.flatMap((m) => [m.description, m.justification])]
    .map(clean)
    .filter(Boolean);
  for (const f of checkFigures(framing, [...coreClaims, ...allContext], evidence, { linkFrom: [], strictYears: true }).unsupported) {
    global('UNSUPPORTED_FIGURE', `the documentary's framing (logline, thesis, cast) uses the figure ${f}, which is not in the evidence it rests on`);
  }
  for (const name of peopleMentioned(framing, outsiders)) global('PERSON_OUTSIDE_SELECTION', `the documentary's framing mentions ${name}, who appears in the dossier but not in the selected units' evidence`);
  for (const name of unknownProperNouns(framing.join('\n'), knownWords)) global('UNKNOWN_NAME', `the documentary's framing names "${name}", which is neither in the evidence nor a declared cast member`);

  // ── Sequences ─────────────────────────────────────────────────────────────
  const used = new Set<string>();
  const allBases: StoryBeat['basis'][] = [];
  const sequences: StorySequenceV2[] = raw.sequences.map((s, i) => buildSequence(s, i + 1));

  function buildSequence(s: ArchitectSequence, number: number): StorySequenceV2 {
    const finding = (kind: FindingKind, detail: string) => findings.push({ kind, sequence: number, detail });

    const candidateKeys: string[] = [];
    for (const k of s.candidateKeys.map((x) => x.trim())) {
      if (!unitByKey.has(k)) notes.push(`Sequence ${number}: ${k} is not a selected unit; ignored`);
      else if (!candidateKeys.includes(k)) candidateKeys.push(k);
    }
    for (const k of candidateKeys) used.add(k);
    if (candidateKeys.length === 0) finding('NO_UNIT', 'tells no selected story unit, so it would be a new story');

    const known = (k: string, where: string) => {
      if (evidence.has(k)) return true;
      if (k) finding('UNKNOWN_CLAIM', `${where} cites ${k}, which is not in the approved dossier`);
      return false;
    };

    // Background: other dossier claims, each saying what it is for.
    const contextClaims: { claimKey: string; purpose: string }[] = [];
    for (const c of s.contextClaims) {
      const key = c.claimKey.trim();
      if (!known(key, 'a context claim') || contextClaims.some((x) => x.claimKey === key)) continue;
      if (isCore.has(key)) {
        notes.push(`Sequence ${number}: ${key} is a claim of the selected units; counted as story evidence, not context`);
        continue;
      }
      const purpose = clean(c.purpose);
      if (!purpose) finding('CONTEXT_WITHOUT_PURPOSE', `context claim ${key} does not say what background it provides`);
      contextClaims.push({ claimKey: key, purpose });
    }
    const isContext = new Set(contextClaims.map((c) => c.claimKey));

    // Story evidence: what the sequence declares, plus what its beats cite; then what the rules link.
    const keys = new Set<string>();
    const linkedFor = new Map<string, string>();
    const addLinked = (k: string, what: string) => {
      if (keys.has(k)) return;
      keys.add(k);
      linkedFor.set(k, what);
    };
    for (const k of s.claimKeys.map((x) => x.trim())) {
      if (!known(k, 'its story evidence')) continue;
      if (isContext.has(k) && !isCore.has(k)) continue;
      keys.add(k);
    }

    // Beats.
    const castIds = new Set<string>();
    const inventedLines: string[] = [];
    const beats: StoryBeat[] = s.beats.map((b, j) => {
      const id = `${number}.${j + 1}`;
      const at = `beat ${id}`;
      const description = clean(b.description);
      const claimKeys = orderedKeys(b.claimKeys.map((k) => k.trim()).filter((k) => known(k, at)), evidence);
      const outside = claimKeys.filter((k) => !isCore.has(k) && !(isContext.has(k) && b.function === 'ORIENTATION'));
      if (outside.length) finding('BEAT_OUTSIDE_SELECTION', `${at} rests on ${outside.join(', ')}, outside the selected units' claims (background may only orient)`);
      for (const k of claimKeys) if (isCore.has(k)) keys.add(k);

      const present: string[] = [];
      const addCast = (cid: string, where: string) => {
        if (present.includes(cid)) return true;
        if (droppedCast.has(cid)) return false;
        if (!castById.has(cid)) {
          finding('UNDECLARED_CHARACTER', `${where} uses the cast id "${cid}", which is not declared in the cast`);
          return false;
        }
        present.push(cid);
        return true;
      };
      for (const cid of b.castIds.map((x) => x.trim()).filter(Boolean)) addCast(cid, at);

      const speech: BeatSpeech[] = [];
      for (const line of b.speech) {
        const speakerId = line.speakerId.trim();
        const text = clean(line.text);
        if (!text || !addCast(speakerId, `a line of speech in ${at}`)) continue;
        const speaker = castById.get(speakerId)!;
        const claimKey = line.claimKey?.trim() || null;
        if (line.kind === 'INVENTED') {
          if (!speaker.fictional) finding('INVENTED_SPEECH_REAL_PERSON', `${at} gives ${speaker.member.name}, a real person, an invented line: "${text}"`);
          if (b.basis === 'DOCUMENTED') finding('FICTION_IN_DOCUMENTED_BEAT', `${at} is presented as documented fact but contains an invented line`);
          inventedLines.push(text);
        } else {
          if (speaker.fictional) finding('FICTIONAL_RECORDED_QUOTE', `${at} gives ${speaker.member.name}, a fictional character, a recorded quotation`);
          const quotes = claimKey && claimKeys.includes(claimKey) ? evidence.verifiedQuotes(claimKey) : [];
          if (!quotes.some((q) => quoteFoundIn(text, q))) {
            finding('UNVERIFIED_QUOTE', `${at}: "${text}" is not a verified quotation of ${claimKey ? (claimKeys.includes(claimKey) ? claimKey : `${claimKey} (not cited by the beat)`) : 'any cited claim'}`);
          }
        }
        speech.push({ speakerId, text, kind: line.kind, claimKey });
      }
      for (const cid of present) castIds.add(cid);

      // Information class.
      const verdicts = claimKeys.map((k) => evidence.claim(k)!.verdict);
      if (b.basis !== 'FICTION' && claimKeys.length === 0) finding('BEAT_WITHOUT_EVIDENCE', `${at} is ${b.basis} but cites no claim`);
      if (b.basis === 'DOCUMENTED' && verdicts.some((v) => v !== 'ESTABLISHED')) {
        finding('DOCUMENTED_NOT_ESTABLISHED', `${at} is presented as documented fact but rests on ${claimKeys.filter((k, x) => verdicts[x] !== 'ESTABLISHED').map((k) => `${k} (${evidence.claim(k)!.verdict})`).join(', ')}: label it UNCERTAIN with its presentation`);
      }
      if (b.basis !== 'UNCERTAIN' && verdicts.includes('MYTH')) finding('MYTH_NOT_INVESTIGATED', `${at} uses a MYTH claim outside an UNCERTAIN beat; myths are told as investigations`);
      const fictionalHere = present.filter((cid) => castById.get(cid)!.fictional);
      if (b.basis === 'DOCUMENTED' && fictionalHere.length) {
        finding('FICTION_IN_DOCUMENTED_BEAT', `${at} is presented as documented fact but involves ${fictionalHere.map((cid) => castById.get(cid)!.member.name).join(', ')}; fictional characters never take part in a documented action`);
      }

      // Fictional characters observe real people; they never speak to, touch or trade with them.
      const texts = [description, ...speech.map((x) => x.text)].join('\n');
      if (subjectVerbObject(texts, fictionalTokens, INTERACTION_VERBS, realTokens) || subjectVerbObject(texts, realTokens, INTERACTION_VERBS, fictionalTokens)) {
        finding('FICTION_REAL_INTERACTION', `${at}: a fictional character and a real person interact ("${description}"); fictional characters may only observe real people`);
      }
      if (subjectVerbObject(texts, realTokens.filter((t) => t !== 'you'), MENTAL_VERBS)) {
        finding('POSSIBLE_REAL_INTERIORITY', `${at} may give a real person thoughts or feelings no source records ("${description}")`);
      }
      if (wordTokens(description).length > 60) finding('BEAT_TOO_LONG', `${at} reads like narration (${wordTokens(description).length} words); describe what happens instead`);
      allBases.push(b.basis);
      return { id, function: b.function, basis: b.basis, description, claimKeys, castIds: present, speech };
    });

    // Real cast present: one claim grounds each (none if the sequence already cites one of theirs).
    for (const cid of castIds) {
      const info = castById.get(cid)!;
      if (info.fictional) continue;
      const theirs = info.member.claimKeys.filter((k) => isCore.has(k));
      if (theirs.some((k) => keys.has(k))) continue;
      for (const k of strongestFirst(evidence, theirs).slice(0, MAX_AUTO_LINKS)) {
        addLinked(k, `the cast member ${info.member.name}`);
        notes.push(`Sequence ${number}: linked ${k} (evidence for ${info.member.name})`);
      }
    }

    const setting = {
      location: { value: clean(s.setting.location.value), basis: s.setting.location.basis },
      date: { value: clean(s.setting.date.value), basis: s.setting.date.basis },
      timeOfDay: { value: clean(s.setting.timeOfDay.value), basis: s.setting.timeOfDay.basis },
    };
    const visual = {
      environment: clean(s.visual.environment),
      keyObjects: s.visual.keyObjects.map(clean).filter(Boolean),
      physicalActions: s.visual.physicalActions.map(clean).filter(Boolean),
      emotionalState: clean(s.visual.emotionalState),
      visualMetaphor: clean(s.visual.visualMetaphor),
      mustShow: s.visual.mustShow
        .map((m) => ({ detail: clean(m.detail), claimKeys: orderedKeys(m.claimKeys.map((k) => k.trim()).filter((k) => known(k, 'a visual detail')), evidence) }))
        .filter((m) => m.detail),
      mustAvoid: s.visual.mustAvoid.map(clean).filter(Boolean),
      shotIdeas: s.visual.shotIdeas.map(clean).filter(Boolean),
    };
    for (const m of visual.mustShow) {
      const inSequence = m.claimKeys.filter((k) => isCore.has(k) || isContext.has(k));
      if (inSequence.length === 0) finding('VISUAL_DETAIL_WITHOUT_EVIDENCE', `the detail "${m.detail}" must appear on screen but cites no claim of this sequence`);
    }

    const draft: StorySequenceV2 = {
      number,
      title: clean(s.title) || `Sequence ${number}`,
      purpose: clean(s.purpose),
      mode: s.mode,
      candidateIds: candidateKeys.map((k) => unitByKey.get(k)!.id),
      candidateKeys,
      openingHook: clean(s.openingHook),
      question: clean(s.question),
      conflict: clean(s.conflict),
      escalation: clean(s.escalation),
      reveal: clean(s.reveal),
      consequence: clean(s.consequence),
      endingBeat: clean(s.endingBeat),
      transition: clean(s.transition),
      beats,
      castIds: [...castIds],
      setting,
      visual,
      continuity: {
        carriesIn: s.continuity.carriesIn.map(clean).filter(Boolean),
        carriesOut: s.continuity.carriesOut.map(clean).filter(Boolean),
        opens: s.continuity.opens.map((o) => ({ id: o.id.trim(), question: clean(o.question) })).filter((o) => o.id),
        resolves: s.continuity.resolves.map((r) => r.trim()).filter(Boolean),
        timeJump: s.continuity.timeJump,
      },
      claimKeys: [],
      sourceIds: [],
      contextClaims,
      contextSourceIds: [],
      presentation: [],
      historicalStatus: 'UNCERTAIN',
      historicalConfidence: 0,
      estimatedDurationSec: 0,
    };

    // Figures and dates, wherever they appear, come from the selected units' evidence; a figure found in
    // another selected unit's claim links that claim. Context claims add none.
    const instructions = s.presentation.map((p) => clean(p.instruction));
    const figures = checkFigures([...storyTexts(draft), ...instructions], [...keys].filter((k) => isCore.has(k)), evidence, { linkFrom: coreClaims, strictYears: true });
    for (const f of figures.unsupported) finding('UNSUPPORTED_FIGURE', `uses the figure ${f}, which is not in the selected units' evidence`);
    for (const link of figures.links) {
      notes.push(`Sequence ${number}: linked ${link.claimKeys.join(', ')} (source of the figure ${link.figure})`);
      for (const k of link.claimKeys) addLinked(k, `the figure ${link.figure}`);
    }
    const telling = storyTexts(draft);
    for (const name of peopleMentioned(telling, outsiders)) {
      finding('PERSON_OUTSIDE_SELECTION', `mentions ${name}, who appears in the dossier but not in the selected units' evidence`);
    }
    // Setting values are noun phrases: a capitalised first word there is a place or a name, not the start of a sentence.
    const settingPhrases = [setting.location.value, setting.date.value, setting.timeOfDay.value].filter(Boolean).map((v) => `at ${v}`);
    for (const name of unknownProperNouns([...telling, ...settingPhrases].join('\n'), knownWords)) {
      finding('UNKNOWN_NAME', `names "${name}", which is neither in the evidence nor a declared cast member (an invented person or place?)`);
    }

    const claimKeys = orderedKeys(keys, evidence);
    for (const k of claimKeys.filter((x) => !isCore.has(x))) {
      finding('CORE_OUTSIDE_SELECTION', `uses ${k} as story evidence, but it is not a claim of the selected units (make it a labelled context claim or drop it)`);
    }
    if (!claimKeys.some((k) => isCore.has(k))) finding('NO_EVIDENCE', 'cites no claim of the selected units');
    const contextKeys = contextClaims.map((c) => c.claimKey);
    const allKeys = [...claimKeys, ...contextKeys];
    const evidenceText = evidence.textFor(allKeys);
    const evidenceWords = new WordIndex(evidenceText);

    // Setting presented as documented must be in this sequence's evidence.
    if (setting.location.basis === 'DOCUMENTED') {
      const places = [...setting.location.value.matchAll(/\p{Lu}[\p{L}'’-]+/gu)].map((m) => m[0]).filter((w) => wordTokens(w)[0] && !evidenceWords.has(wordTokens(w)[0]!));
      if (places.length) finding('SETTING_NOT_IN_EVIDENCE', `the location "${setting.location.value}" is presented as documented, but ${places.join(', ')} is not in this sequence's evidence: mark it RECONSTRUCTION or cite the claim`);
    }
    if (setting.timeOfDay.basis === 'DOCUMENTED') {
      const times = TIME_WORDS.filter((t) => wordTokens(setting.timeOfDay.value).includes(t) && !evidenceWords.has(t));
      if (times.length) finding('SETTING_NOT_IN_EVIDENCE', `the time of day "${setting.timeOfDay.value}" is presented as documented, but the evidence does not give it: mark it RECONSTRUCTION`);
    }

    // Quotation marks: a verified quotation from this sequence's evidence, or a planned invented line.
    for (const q of quotedPassages([...storyTexts({ ...draft, beats: beats.map((b) => ({ ...b, speech: [] })) })].join('\n'))) {
      const verified = allKeys.some((k) => evidence.verifiedQuotes(k).some((v) => quoteFoundIn(q, v))) || quoteFoundIn(q, evidenceText);
      const invented = inventedLines.some((l) => quoteFoundIn(q, l) || quoteFoundIn(l, q));
      if (!verified && !invented) finding('UNVERIFIED_QUOTATION', `"${q}" is in quotation marks but is neither a verified quotation from the evidence nor a planned invented line`);
    }

    // Presentation: every claim that is not ESTABLISHED, with the instruction its verdict requires.
    const given = new Map<string, ClaimPresentation>();
    for (const p of s.presentation) {
      const key = p.claimKey.trim();
      if (!allKeys.includes(key) || given.has(key)) continue;
      given.set(key, { claimKey: key, presentation: p.presentation, instruction: clean(p.instruction) });
    }
    const presentation: ClaimPresentation[] = [];
    for (const k of allKeys) {
      const verdict = evidence.claim(k)!.verdict;
      if (verdict === 'ESTABLISHED') continue;
      const required = PRESENTATION_FOR_VERDICT[verdict];
      const p = given.get(k);
      const why = linkedFor.get(k);
      const linked = why ? ` (the evidence rules linked it for ${why}: add the instruction, or drop ${why})` : '';
      if (!p || !p.instruction) {
        finding('MISSING_PRESENTATION', `uses ${k} (${verdict}) without saying how the narration must present it (${required})${linked}`);
        continue;
      }
      if (p.presentation !== required) finding('WRONG_PRESENTATION', `presents ${k} (${verdict}) as ${p.presentation}; a ${verdict} claim needs ${required}`);
      else if (required === 'HEDGE' && !HEDGE_PATTERN.test(p.instruction)) {
        finding('WEAK_HEDGE', `the instruction for ${k} (PROBABLE) must word the hedge, e.g. "records suggest…", "contemporary accounts indicate…" (it says: "${p.instruction}")`);
      }
      presentation.push(p);
    }

    const sourceIds = evidence.sourcesFor(claimKeys);
    if (claimKeys.length > 0 && sourceIds.length === 0) finding('NO_SOURCES', 'no retrieved source with a verified quote backs its story evidence');
    for (const k of contextKeys) if (evidence.traceableSources(k).length === 0) finding('NO_SOURCES', `context claim ${k} has no retrieved source with a verified quote`);

    if (draft.castIds.length === 0) finding('NO_HUMAN_ANCHOR', 'no person, group, role or POV is present: who is the viewer following?');
    const orientation = beats.filter((b) => b.function === 'ORIENTATION').length;
    if (orientation >= 2 && orientation / Math.max(1, beats.length) > 0.4) finding('EXPOSITION_HEAVY', `${orientation} of ${beats.length} beats are orientation: explain only what the scene needs`);

    const estimate = Number.isFinite(s.estimatedDurationSec) && s.estimatedDurationSec > 0 ? Math.round(s.estimatedDurationSec) : structuralDurationSecV2({ beats, presentation });
    return {
      ...draft,
      claimKeys,
      sourceIds,
      contextSourceIds: evidence.sourcesFor(contextKeys).filter((id) => !sourceIds.includes(id)),
      presentation,
      historicalStatus: historicalStatusOf(allKeys.map((k) => evidence.claim(k)!.verdict)),
      historicalConfidence: historicalConfidenceOf(evidence.storyClaims(allKeys)),
      estimatedDurationSec: estimate,
    };
  }

  // ── Continuity ────────────────────────────────────────────────────────────
  const opened = new Map<string, number>([['Q0', 0]]);
  const resolved = new Set<string>();
  const carriedOut: string[] = [];
  let lastYear: number | null = null;
  for (const s of sequences) {
    for (const r of s.continuity.resolves) {
      if (!opened.has(r) && !s.continuity.opens.some((o) => o.id === r)) findings.push({ kind: 'UNKNOWN_THREAD', sequence: s.number, detail: `resolves ${r}, which no sequence opened` });
      resolved.add(r);
    }
    for (const o of s.continuity.opens) if (!opened.has(o.id)) opened.set(o.id, s.number);
    for (const item of s.continuity.carriesIn) {
      if (!carriedOut.some((x) => sameItem(x, item))) findings.push({ kind: 'CONTINUITY_BREAK', sequence: s.number, detail: `carries in "${item}", which no earlier sequence carried out` });
    }
    carriedOut.push(...s.continuity.carriesOut);
    const year = extractFigures(s.setting.date.value).find(isYear);
    if (year !== undefined) {
      const y = Number(year);
      if (lastYear !== null && y < lastYear && s.continuity.timeJump !== 'FLASHBACK' && s.continuity.timeJump !== 'PARALLEL') {
        findings.push({ kind: 'CHRONOLOGY_UNMARKED', sequence: s.number, detail: `goes back from ${lastYear} to ${y} without marking a flashback or parallel time` });
      }
      lastYear = y;
    }
  }
  if (!resolved.has('Q0')) global('CENTRAL_QUESTION_UNANSWERED', 'no sequence resolves the central question (Q0)');
  for (const [id, n] of opened) if (id !== 'Q0' && !resolved.has(id)) findings.push({ kind: 'UNRESOLVED_THREAD', sequence: n, detail: `opens ${id} and no sequence resolves it` });
  sequences.slice(0, -1).forEach((s) => {
    if (!s.transition) findings.push({ kind: 'MISSING_TRANSITION', sequence: s.number, detail: 'has no transition into the next sequence' });
  });

  // ── Reconstruction budget ─────────────────────────────────────────────────
  const shares = informationShares(allBases);
  const reconstruction = { level: reconstructionLevelOf(shares), beats: allBases.length, shares };
  const creative = Math.round((shares.RECONSTRUCTION + shares.FICTION) * 100) / 100;
  if (creative > RECONSTRUCTION_BUDGET.creative) global('RECONSTRUCTION_BUDGET', `reconstruction and fiction make up ${Math.round(creative * 100)}% of the beats (budget ${RECONSTRUCTION_BUDGET.creative * 100}%)`);
  if (shares.FICTION > RECONSTRUCTION_BUDGET.fiction) global('RECONSTRUCTION_BUDGET', `fiction makes up ${Math.round(shares.FICTION * 100)}% of the beats (budget ${RECONSTRUCTION_BUDGET.fiction * 100}%)`);

  // ── Editor: priorities, unused units, order ───────────────────────────────
  const reasons = new Map(raw.unusedCandidates.map((u) => [u.candidateKey.trim(), clean(u.reason)]));
  const unusedCandidates = units
    .filter((u) => !used.has(u.key))
    .map((u) => {
      const reason = reasons.get(u.key) ?? '';
      if (u.priority === 'HIGH') global('HIGH_PRIORITY_UNUSED', `${u.key} "${u.title}" is HIGH priority but no sequence uses it`);
      else if (!reason) global('UNUSED_WITHOUT_REASON', `${u.key} "${u.title}" is not used and no reason is given`);
      return { candidateKey: u.key, reason: reason || NO_REASON };
    });
  const orderNote = clean(raw.orderNote);
  const editorOrder = units.filter((u) => u.selectionOrder !== null).sort((a, b) => a.selectionOrder! - b.selectionOrder!).map((u) => u.key);
  if (editorOrder.length > 1 && !orderNote) {
    const firstSeen = [...new Set(sequences.flatMap((s) => s.candidateKeys))].filter((k) => editorOrder.includes(k));
    const expected = editorOrder.filter((k) => firstSeen.includes(k));
    if (firstSeen.join() !== expected.join()) global('ORDER_CHANGED_WITHOUT_REASON', `the units appear as ${firstSeen.join(', ')}; the editor's order is ${expected.join(', ')}`);
  }

  return {
    content: {
      engineVersion: 2,
      logline: clean(raw.logline),
      centralQuestion: clean(raw.centralQuestion),
      centralHumanStakes: clean(raw.centralHumanStakes),
      narrativeMode: raw.narrativeMode,
      secondaryModes: [...new Set(raw.secondaryModes)].filter((m) => m !== raw.narrativeMode),
      povStrategy: { type: raw.povStrategy.type, description: clean(raw.povStrategy.description) },
      cast,
      thesis: clean(raw.thesis),
      narrativeSpine: clean(raw.narrativeSpine),
      resolution: clean(raw.resolution),
      orderNote,
      sequences,
      unusedCandidates,
      reconstruction,
    },
    notes,
    findings,
  };
}

export function blockingCount(findings: readonly ArchitectureFinding[]): number {
  return findings.filter((f) => BLOCKING_FINDINGS.includes(f.kind)).length;
}

/** Total of the sequences' estimated durations. */
export function totalDurationSec(content: { sequences: readonly { estimatedDurationSec: number }[] }): number {
  return content.sequences.reduce((sum, s) => sum + s.estimatedDurationSec, 0);
}

/** A built architecture in the architect's output shape, for the reviewers (derived fields dropped, beat ids kept for reference). */
export function toArchitectOutput(c: StoryArchitectureContentV2): ArchitectOutput & { sequences: (ArchitectSequence & { beats: (ArchitectSequence['beats'][number] & { id: string })[] })[] } {
  return {
    logline: c.logline,
    centralQuestion: c.centralQuestion,
    centralHumanStakes: c.centralHumanStakes,
    narrativeMode: c.narrativeMode,
    secondaryModes: c.secondaryModes,
    povStrategy: c.povStrategy,
    cast: c.cast.map((m) => ({ id: m.id, name: m.name, kind: m.kind, description: m.description, claimKeys: m.claimKeys, justification: m.justification })),
    thesis: c.thesis,
    narrativeSpine: c.narrativeSpine,
    resolution: c.resolution,
    orderNote: c.orderNote,
    sequences: c.sequences.map((s) => ({
      title: s.title,
      purpose: s.purpose,
      mode: s.mode,
      candidateKeys: s.candidateKeys,
      openingHook: s.openingHook,
      question: s.question,
      conflict: s.conflict,
      escalation: s.escalation,
      reveal: s.reveal,
      consequence: s.consequence,
      endingBeat: s.endingBeat,
      transition: s.transition,
      beats: s.beats.map((b) => ({ id: b.id, function: b.function, basis: b.basis, description: b.description, claimKeys: b.claimKeys, castIds: b.castIds, speech: b.speech })),
      setting: s.setting,
      visual: s.visual,
      continuity: s.continuity,
      claimKeys: s.claimKeys,
      contextClaims: s.contextClaims,
      presentation: s.presentation,
      estimatedDurationSec: s.estimatedDurationSec,
    })),
    unusedCandidates: c.unusedCandidates,
  };
}
