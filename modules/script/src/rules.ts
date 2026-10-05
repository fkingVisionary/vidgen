import { HEDGE_PATTERN, SCRIPT_TIMING, scriptTiming, type ClaimVerdict, type RuntimeTarget, type ScriptBlockClass, type ScriptIssue } from '@docengine/core';
import {
  INTERACTION_VERBS,
  MENTAL_VERBS,
  SECOND_PERSON,
  checkFigures,
  extractFigures,
  nameTokens,
  peopleMentioned,
  quoteFoundIn,
  quotedPassages,
  sentences,
  subjectVerbObject,
  unknownProperNouns,
  wordTokens,
} from '@docengine/story/shared';
import { stockPhrases } from '@docengine/writing';
import { editorialFindings } from './editorial.ts';
import { evidenceInvariants } from './evidence.ts';
import { craftFindings, humanIn, inEscalation, partOfRefrain, protectedBlocks, renderTrimPlan, trimPlan, type Refrain, type TrimPlan } from './craft.ts';
import { allBlocks, fictionalMentions, sectionDurationSec, type DraftBlock, type DraftSection, type ScriptDraft } from './draft.ts';
import { DISPUTED_PATTERN, MYTH_PATTERN, PROBABILITY_PATTERN, UNVERIFIED_PATTERN, stem } from './wording.ts';
import { beatClasses, fictionalCast, realCast, type ScriptScope } from './scope.ts';

/**
 * The script rules: deterministic checks of a script version against its
 * approved architecture and evidence. Blocking findings stop approval (the
 * gate); warnings are for the editor. They run after every model step, after
 * every human edit, and on the final version.
 *
 * Heuristics are stated as such: wording patterns (hedges, myth framing),
 * subject–verb patterns (fiction acting, real people thinking) and the
 * spoken-language measures detect the common cases, not every case — the
 * reviewers and the editor cover the rest.
 */

export const SCRIPT_FINDING_KINDS = [
  // Evidence boundary
  'CLAIM_OUTSIDE_ARCHITECTURE', // a claim the approved architecture does not cite
  'NOT_IN_ARCHITECTURE', // narration (not framing) that realises no beat of the architecture
  'BLOCK_WITHOUT_EVIDENCE', // documented, uncertain or reconstructed narration that cites no claim
  'UNSUPPORTED_FIGURE', // a figure or year in no claim of the architecture
  'PERSON_OUTSIDE_ARCHITECTURE', // a dossier person the architecture does not cite
  'PERSON_WITHOUT_EVIDENCE', // documented or uncertain narration naming a real person none of its claims mentions
  'ASSERTION_UNCITED', // a sentence about a real person that says what an uncited claim about them says
  'CLAIM_LINK_LOST', // a sentence kept from the version before that no longer cites the claim behind it
  'UNKNOWN_NAME', // a name the evidence and the cast do not know
  // Information classes
  'CLASS_MISMATCH', // the block's class does not match the beats it realises
  'DOCUMENTED_NOT_ESTABLISHED', // stated as documented fact, resting on claims that are not ESTABLISHED
  'FRAMING_WITH_FACTS', // a framing line carrying claims or figures
  'FICTION_NOT_ALLOWED', // fiction where the architecture planned none
  // Uncertainty wording
  'MYTH_AS_FACT', // a MYTH claim told as fact, or outside uncertain narration
  'DISPUTED_AS_FACT', // a DISPUTED claim without words saying it is disputed
  'UNVERIFIED_AS_FACT', // an UNVERIFIED claim without words saying it is unconfirmed
  'PROBABLE_UNHEDGED', // a PROBABLE claim without a hedge
  'UNCERTAINTY_UPGRADED', // probability wording for a myth, an unverified or disputed claim, a reconstruction or framing
  // Fiction boundary
  'FICTION_IN_DOCUMENTED', // a fictional device in narration presented as documented fact
  'FICTION_REAL_INTERACTION', // a fictional character speaking to, touching or trading with a real person
  'FICTION_DOCUMENTED_ACT', // a fictional character performing a documented or dated act
  'FICTION_WITH_FACTS', // fiction carrying figures or dates
  // Speech and quotations
  'UNDECLARED_SPEAKER', // a speaker who is not in the architecture's cast
  'REAL_PERSON_INVENTED_SPEECH', // words given to a real person that are not a recorded quotation
  'FICTIONAL_RECORDED_QUOTE', // a fictional character given a recorded quotation
  'UNVERIFIED_RECORDED_QUOTE', // a recorded quote that is not a verified quotation of its claims
  'FABRICATED_QUOTE', // words in quotation marks that are not a verified quotation
  // Structure
  'SEQUENCE_MISSING', // an architecture sequence with no narration
  'CENTRAL_QUESTION_NOT_POSED', // no block poses the central question
  'CENTRAL_QUESTION_ABANDONED', // the central question is not answered at the end
  'RUNTIME_OFF', // far from the target runtime
  'OPEN_CRITICAL_FACT_ISSUE', // a critical fact issue on a block nobody has fixed
  // Semantic layers (Writing Engine 2)
  'DIRECTION_IN_NARRATION', // a production direction, label, tag or claim key inside the narration text
  // Warnings: the editor decides
  'BEAT_FROM_OTHER_SEQUENCE', // a block tells a beat of another sequence
  'QUESTION_POSED_LATE', // the central question is posed after the first third
  'CONSECUTIVE_FACTS', // a run of documented blocks with nobody in them
  'EXPOSITION_HEAVY', // a section dominated by exposition
  'LOW_HUMAN_PRESENCE', // too little narration with people in it
  'RECONSTRUCTION_BUDGET', // reconstruction + fiction over 40% of the words, or fiction over 25%
  'REAL_INTERIORITY', // a real person seems to be given thoughts or feelings
  'LONG_SENTENCES', // sentences too long to say in a breath
  'LONG_BLOCK', // a block too long for one beat of narration
  'LONG_UNBROKEN_NARRATION', // over 75 seconds without a pause or a scene change
  'REPETITIVE_OPENINGS', // many sentences opening the same way
  'REPEATED_PHRASES', // the same phrase again and again
  'AI_PHRASES', // stock phrases that sound machine-written
  'RHETORICAL_QUESTIONS', // too many questions, or questions in a row
  'FORMULAIC_TRANSITIONS', // sections opening with the same connector
  'UNSPOKEN_SYMBOLS', // symbols, abbreviations or ranges a narrator cannot read as written
  'PAUSE_OVERUSE', // pauses on most blocks, or too many long ones
  'EMPHASIS_OVERUSE', // emphasis on most blocks, or many stresses in one
  'RUNTIME_NEAR', // outside the target range, within tolerance
  'RUNTIME_BALANCE', // a section far from its planned length
  'PRONUNCIATION_REVIEW', // pronunciation notes still to be confirmed
  'NAME_WITHOUT_PRONUNCIATION', // a name in the script without a pronunciation note
  'VISUAL_WITHOUT_EVIDENCE', // a historical detail to show, without its claims
  // Script quality rules (craft.ts): warnings
  'RETOLD_CONTENT', // a block that says again what an earlier block said
  'RECAP_SECTION', // a section that spends a large share of its time retelling earlier sections
  'CLAIM_RETOLD', // the same claim explained in three or more sections
  'REFRAIN_LOST', // a refrain or callback of the version refined, gone
  'PASSENGER_FACT', // a fact along for the ride
  'SOURCE_CHATTER', // authorities named once, only to be cited
  'NAME_LOAD', // several new names in one block
  'SECTION_OVER_BUDGET', // over the maximum: a section far over its planned share
  'ENDING_DRAG', // an ending much longer than a typical section and its plan
  'WRITTEN_SYNTAX', // colons, semicolons, parentheses, written-register words
  'LIST_SENTENCE', // four or more items in one sentence
  'NUMBER_DENSE', // three or more numbers in one sentence
  'MONOTONOUS_RHYTHM', // a section of sentences of nearly the same length
  'NOUN_HEAVY', // essay prose: abstract nouns instead of people and verbs
  'META_NARRATION', // the narrator talking about the film
  'DEVICE_RELABELLED', // a fictional device labelled as invented again and again
  'DEVICE_LABEL_STACKED', // a fictional device labelled several ways at once
  'DEVICE_UNINTRODUCED', // a fictional device first seen without being introduced as one
  'PERSON_UNINTRODUCED', // a real person named without saying who they are
  'PERSON_WITHOUT_EVIDENCE_SCENE', // a reconstructed scene naming a real person none of its claims mentions
  'UNCITED_CLAIM_MATCH', // a sentence that says what an uncited claim says
  'RUNTIME_PLAN', // over the maximum: where to cut first
  // Writing Engine 2 (editorial.ts): warnings
  'AI_PATTERN', // machine-writing habits in a block (fake dramatic beats, formulas, fragment runs, trailer language…)
  'VISUAL_IN_NARRATION', // narration describing what the picture shows
  'MONEY_WITHOUT_CONTEXT', // a sum of money said without the context the evidence offers
  // The narration pass's own invariants (never found by checkScript: they reject a narration change)
  'NARRATION_FIGURE_CHANGED', // a number of the block lost or changed
  'NARRATION_NAME_CHANGED', // a name respelt or replaced
  'NARRATION_KEPT_LINE_LOST', // a line kept on purpose, gone
  'NARRATION_QUOTE_TOUCHED', // a quotation or a speaker's line changed
  'NARRATION_HEDGE_DROPPED', // a hedge of the original gone
  'NARRATION_PATTERN_ADDED', // more machine-writing patterns than before
  'NARRATION_MONEY_UNSOURCED', // money context that is not from the evidence
  'NARRATION_LENGTH_DRIFT', // a block rewritten far beyond a polish
] as const;
export type ScriptFindingKind = (typeof SCRIPT_FINDING_KINDS)[number];

export const SCRIPT_WARNINGS: readonly ScriptFindingKind[] = SCRIPT_FINDING_KINDS.slice(SCRIPT_FINDING_KINDS.indexOf('BEAT_FROM_OTHER_SEQUENCE'));
export const SCRIPT_BLOCKING: readonly ScriptFindingKind[] = SCRIPT_FINDING_KINDS.filter((k) => !SCRIPT_WARNINGS.includes(k));

export interface ScriptFinding {
  kind: ScriptFindingKind;
  /** Block key ("3.4"), section ("S3"), or null for the script. */
  ref: string | null;
  detail: string;
}

export const isBlocking = (f: ScriptFinding) => SCRIPT_BLOCKING.includes(f.kind);
const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
export const blockingCount = (fs: readonly ScriptFinding[]) => fs.filter(isBlocking).length;

// ── Wording patterns (heuristics) ────────────────────────────────────────────

export { DISPUTED_PATTERN, MYTH_PATTERN, UNVERIFIED_PATTERN };
/** Words a narrator uses to admit not knowing what someone thought. */
const UNKNOWABLE = /\b(we (?:can't|cannot|don't|do not) know|no (?:record|source|letter|diary) (?:tells|says|records|shows)|perhaps|may have|might have|must have|probably|likely)\b/i;

const WORDING: Partial<Record<ClaimVerdict, { pattern: RegExp; kind: ScriptFindingKind; what: string }>> = {
  PROBABLE: { pattern: HEDGE_PATTERN, kind: 'PROBABLE_UNHEDGED', what: 'is PROBABLE but the narration does not hedge it ("records suggest", "probably", "it appears")' },
  DISPUTED: { pattern: DISPUTED_PATTERN, kind: 'DISPUTED_AS_FACT', what: 'is DISPUTED but the narration does not say it is disputed' },
  UNVERIFIED: { pattern: UNVERIFIED_PATTERN, kind: 'UNVERIFIED_AS_FACT', what: 'is UNVERIFIED but the narration does not say it cannot be confirmed' },
  MYTH: { pattern: MYTH_PATTERN, kind: 'MYTH_AS_FACT', what: 'is a MYTH but the narration does not frame it as the popular story or legend' },
};

/** Actions a fictional device may not perform in documented history (interaction verbs plus transactions and deeds). */
const ACTION_VERBS = new Set([
  ...INTERACTION_VERBS,
  ...'buys bought sells sold signs signed pays paid bids bid trades traded borrows borrowed lends lent invests invested wins won loses lost owns owned inherits inherited founds founded orders ordered writes wrote publishes published plants planted ships shipped sues sued testifies testified votes voted marries married'.split(' '),
]);

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
/** A year or a calendar date ("1637", "14 January", "January 14th"): a fictional act with one becomes a dated historical claim. */
const DATE_PATTERN = new RegExp(`\\b(?:1[0-9]{3}|20[0-9]{2})\\b|\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS})\\b`, 'i');

const CONNECTORS = new Set(['but', 'so', 'meanwhile', 'now', 'then', 'and', 'yet', 'still', 'today', 'soon', 'later']);
const SYMBOLS = /[&%#@*_~\\/[\]{}<>|^=+]|\b(?:c|ca|fl|approx|etc|vs)\.(?=\s|$)|\b(?:e\.g|i\.e)\.|\d\s*[–-]\s*\d/i;
const STOPWORDS = new Set('the a an of to in and or but that this it is was were be been for on at by with as from into than then they he she his her its their our we you i not no so'.split(' '));

const PAUSE_RANK = { NONE: 0, MICRO: 1, SHORT: 2, MEDIUM: 3, LONG: 4 } as const;

// ── Block rules ──────────────────────────────────────────────────────────────

/** Classes a block may take, given the classes of the beats it realises. */
const COMPATIBLE: Record<Exclude<ScriptBlockClass, 'FRAMING'>, ReadonlySet<string>> = {
  DOCUMENTED: new Set(['DOCUMENTED']),
  UNCERTAIN: new Set(['DOCUMENTED', 'UNCERTAIN']),
  RECONSTRUCTION: new Set(['DOCUMENTED', 'RECONSTRUCTION', 'UNCERTAIN']),
  FICTION: new Set(['FICTION', 'RECONSTRUCTION']),
};

function blockFindings(b: DraftBlock, sectionSeq: number, scope: ScriptScope, out: ScriptFinding[]): void {
  const at = `Block ${b.key}`;
  const f = (kind: ScriptFindingKind, detail: string) => out.push({ kind, ref: b.key, detail: `${at}: ${detail}` });
  const text = b.text;
  const words = new Set(wordTokens(text));
  const fictional = fictionalCast(scope);
  const real = realCast(scope);
  const povPresent = fictional.some((c) => c.member.kind === 'POV_PROXY');
  const fictionalTokens = fictional.flatMap((c) => c.tokens);
  const realTokens = real.flatMap((c) => c.tokens);
  const verdict = (k: string) => scope.evidence.claim(k)?.verdict;

  // Evidence boundary.
  const outside = b.claimKeys.filter((k) => !scope.claimSet.has(k));
  if (outside.length) f('CLAIM_OUTSIDE_ARCHITECTURE', `cites ${outside.join(', ')}, which the approved architecture does not cite`);
  if (b.infoClass !== 'FRAMING' && b.beatIds.length === 0) f('NOT_IN_ARCHITECTURE', 'realises no beat of the architecture: narration tells the approved story, nothing else');
  const foreign = b.beatIds.filter((id) => scope.beats.get(id)?.sequence !== sectionSeq);
  if (foreign.length) out.push({ kind: 'BEAT_FROM_OTHER_SEQUENCE', ref: b.key, detail: `${at} tells ${foreign.join(', ')}, from another sequence` });
  if ((b.infoClass === 'DOCUMENTED' || b.infoClass === 'UNCERTAIN' || b.infoClass === 'RECONSTRUCTION') && b.claimKeys.length === 0) {
    f('BLOCK_WITHOUT_EVIDENCE', `${b.infoClass.toLowerCase()} narration that cites no claim`);
  }

  // Information classes.
  if (b.infoClass !== 'FRAMING') {
    const classes = beatClasses(scope, b.beatIds);
    const bad = [...classes].filter((c) => !COMPATIBLE[b.infoClass as Exclude<ScriptBlockClass, 'FRAMING'>].has(c));
    if (b.infoClass === 'FICTION' && !classes.has('FICTION')) {
      f('FICTION_NOT_ALLOWED', `is fiction, but the beats it tells (${b.beatIds.join(', ') || 'none'}) are not FICTION beats of the architecture`);
    } else if (bad.length) {
      f('CLASS_MISMATCH', `is ${b.infoClass} but tells ${b.beatIds.map((id) => `${id} (${scope.beats.get(id)?.beat.basis})`).join(', ')}; the narration must keep the beat's class`);
    }
  }
  if (b.infoClass === 'DOCUMENTED') {
    const weak = b.claimKeys.filter((k) => verdict(k) !== 'ESTABLISHED');
    if (weak.length) f('DOCUMENTED_NOT_ESTABLISHED', `is stated as documented fact but rests on ${weak.map((k) => `${k} (${verdict(k)})`).join(', ')}: tell it as uncertain history`);
  }
  if (b.infoClass === 'FRAMING' && (b.claimKeys.length > 0 || extractFigures(text).length > 0)) f('FRAMING_WITH_FACTS', 'a framing line carries no facts: no claims, figures or dates');

  // Uncertainty wording, per claim that is not ESTABLISHED.
  const byKind = new Map<ScriptFindingKind, string[]>();
  for (const k of b.claimKeys) {
    const v = verdict(k);
    const rule = v ? WORDING[v] : undefined;
    if (!rule) continue;
    const mythOutside = v === 'MYTH' && b.infoClass !== 'UNCERTAIN';
    if (mythOutside || !rule.pattern.test(text)) byKind.set(rule.kind, [...(byKind.get(rule.kind) ?? []), k]);
  }
  for (const [kind, keys] of byKind) {
    const rule = Object.values(WORDING).find((r) => r!.kind === kind)!;
    const myth = kind === 'MYTH_AS_FACT' && b.infoClass !== 'UNCERTAIN' ? ` (and myth belongs in uncertain narration, not ${b.infoClass})` : '';
    f(kind, `${keys.join(', ')} ${rule.what}${myth}`);
  }

  // Figures, people, names.
  if (b.infoClass === 'FICTION') {
    const figures = extractFigures(text);
    if (figures.length) f('FICTION_WITH_FACTS', `fiction carries no facts, but it states ${figures.join(', ')}`);
  } else if (b.infoClass !== 'FRAMING') {
    const fig = checkFigures([text], b.claimKeys, scope.evidence, { linkFrom: scope.claims, strictYears: true });
    if (fig.unsupported.length) f('UNSUPPORTED_FIGURE', `${fig.unsupported.join(', ')} is in no claim of the approved architecture`);
  }
  const outsiders = peopleMentioned([text], scope.outsiders);
  if (outsiders.length) f('PERSON_OUTSIDE_ARCHITECTURE', `names ${outsiders.join(', ')}, whom the approved architecture does not include`);
  const unknown = unknownProperNouns(text, scope.known);
  if (unknown.length) f('UNKNOWN_NAME', `names ${unknown.join(', ')}, which the evidence and the cast do not know`);

  // Fiction boundary.
  const fictionHere = fictionalMentions(text, scope);
  if (b.infoClass === 'DOCUMENTED' && (fictionHere.length > 0 || (povPresent && SECOND_PERSON.test(text)))) {
    f('FICTION_IN_DOCUMENTED', `a fictional device (${fictionHere.map((id) => scope.cast.get(id)?.member.name ?? id).join(', ') || 'the viewer'}) in narration presented as documented fact`);
  }
  if (subjectVerbObject(text, fictionalTokens, INTERACTION_VERBS, realTokens) || subjectVerbObject(text, realTokens, INTERACTION_VERBS, fictionalTokens)) {
    f('FICTION_REAL_INTERACTION', 'a fictional character and a real person interact; fictional characters may only observe real people');
  }
  const actsInDocumented = [...beatClasses(scope, b.beatIds)].includes('DOCUMENTED') && subjectVerbObject(text, fictionalTokens.filter((t) => t !== 'your'), ACTION_VERBS);
  const datedAct = sentences(text).some((s) => subjectVerbObject(s, fictionalTokens.filter((t) => t !== 'your'), ACTION_VERBS) && DATE_PATTERN.test(s));
  if (actsInDocumented || datedAct) {
    f('FICTION_DOCUMENTED_ACT', `a fictional character performs ${datedAct ? 'a dated act' : 'an act in documented history'}; fiction may observe history, never make it`);
  }

  // Speech and quotations.
  const verifiedIn = (q: string) => b.claimKeys.some((k) => scope.evidence.verifiedQuotes(k).some((v) => quoteFoundIn(q, v)));
  if (b.speakerId) {
    const sp = scope.cast.get(b.speakerId);
    if (!sp) f('UNDECLARED_SPEAKER', `the speaker ${b.speakerId} is not in the architecture's cast`);
    else if (!sp.fictional && b.speechKind !== 'RECORDED_QUOTE') f('REAL_PERSON_INVENTED_SPEECH', `${sp.member.name} is a real person: only a recorded quotation may be put in their mouth`);
    else if (sp.fictional && b.speechKind === 'RECORDED_QUOTE') f('FICTIONAL_RECORDED_QUOTE', `${sp.member.name} is a fictional device and cannot have a recorded quotation`);
    if (sp && !sp.fictional && b.speechKind === 'RECORDED_QUOTE') {
      const quoted = quotedPassages(text, 2);
      const spoken = quoted.length ? quoted : [text];
      if (!spoken.every(verifiedIn)) f('UNVERIFIED_RECORDED_QUOTE', `the words given to ${sp.member.name} are not a verified quotation of ${b.claimKeys.join(', ') || 'any cited claim'}`);
    }
    if (sp?.fictional && b.speechKind === 'INVENTED' && b.infoClass !== 'FICTION') f('CLASS_MISMATCH', `an invented line of ${sp.member.name} is FICTION, not ${b.infoClass}`);
  } else {
    const namesReal = realTokens.some((t) => words.has(t));
    for (const q of quotedPassages(text)) {
      if (verifiedIn(q)) continue;
      if (b.infoClass === 'FICTION' && !namesReal) continue; // an invented line of a fictional device, labelled as fiction
      f('FABRICATED_QUOTE', `"${q}" is in quotation marks but is not a verified quotation of the block's claims`);
    }
  }

  // Warnings.
  const realSubjects = realTokens.filter((t) => t !== 'you' && t !== 'your');
  if (subjectVerbObject(text, realSubjects, MENTAL_VERBS) && !HEDGE_PATTERN.test(text) && !UNKNOWABLE.test(text)) {
    out.push({ kind: 'REAL_INTERIORITY', ref: b.key, detail: `${at} may give a real person thoughts or feelings no source records; frame them ("we can't know what he thought")` });
  }
  const bare = b.visual.mustShow.filter((m) => m.claimKeys.length === 0);
  if (bare.length) out.push({ kind: 'VISUAL_WITHOUT_EVIDENCE', ref: b.key, detail: `${at}: must show ${bare.map((m) => `"${m.detail}"`).join(', ')} without the claims that ground it` });
  if (b.wordCount > 90) out.push({ kind: 'LONG_BLOCK', ref: b.key, detail: `${at} runs ${b.wordCount} words; split it so each block carries one beat` });
  const symbol = SYMBOLS.exec(text);
  if (symbol) out.push({ kind: 'UNSPOKEN_SYMBOLS', ref: b.key, detail: `${at} has "${symbol[0]}", which a narrator cannot read as written; write it as it is spoken` });
}

// ── Script rules ─────────────────────────────────────────────────────────────

export interface CheckOptions {
  target: RuntimeTarget;
  /** The fact checker's issues on this version (open CRITICAL ones on a block block approval until fixed). */
  factIssues?: readonly ScriptIssue[];
  /** The version this one refines: its refrains and callbacks must survive. */
  previous?: ScriptDraft | null;
  /** Lines kept on purpose (a refinement's kept lines): never cut candidates. */
  kept?: readonly string[];
}

/** All findings for a script version, in script order. */
export function checkScript(draft: ScriptDraft, scope: ScriptScope, opts: CheckOptions): ScriptFinding[] {
  const out: ScriptFinding[] = [];
  const blocks = allBlocks(draft);

  // Every sequence told.
  for (const s of scope.architecture.sequences) {
    const sec = draft.sections.find((x) => x.sequence === s.number);
    if (!sec || sec.blocks.length === 0) out.push({ kind: 'SEQUENCE_MISSING', ref: `S${s.number}`, detail: `Sequence ${s.number} "${s.title}" has no narration` });
  }
  for (const sec of draft.sections) for (const b of sec.blocks) blockFindings(b, sec.sequence, scope, out);

  // The central question: posed early, answered at the end.
  const timing = scriptTiming(blocks, opts.target);
  const posed = blocks.find((b) => b.centralQuestion === 'POSED');
  const answered = blocks.find((b) => b.centralQuestion === 'ANSWERED');
  if (!posed) out.push({ kind: 'CENTRAL_QUESTION_NOT_POSED', ref: null, detail: `No block poses the central question ("${scope.architecture.centralQuestion}")` });
  else {
    const before = blocks.slice(0, blocks.indexOf(posed)).reduce((n, b) => n + b.estimatedDurationSec, 0);
    if (timing.totalSec > 0 && before / timing.totalSec > 1 / 3) out.push({ kind: 'QUESTION_POSED_LATE', ref: posed.key, detail: `The central question is posed only at ${Math.round((before / timing.totalSec) * 100)}% of the runtime (block ${posed.key})` });
  }
  const lastTwo = draft.sections.slice(-2).flatMap((s) => s.blocks);
  if (!answered || !lastTwo.includes(answered)) {
    out.push({ kind: 'CENTRAL_QUESTION_ABANDONED', ref: answered?.key ?? null, detail: answered ? `The central question is answered in block ${answered.key}, not at the end of the film` : 'No block answers the central question' });
  }

  // Runtime.
  const runtime = `script ${clock(timing.totalSec)} against a target of ${clock(timing.targetSec)} (${clock(timing.minSec)}–${clock(timing.maxSec)})`;
  if (timing.fit === 'OFF') out.push({ kind: 'RUNTIME_OFF', ref: null, detail: `Runtime far from the target: ${runtime}` });
  else if (timing.fit === 'NEAR') out.push({ kind: 'RUNTIME_NEAR', ref: null, detail: `Runtime outside the target range: ${runtime}` });
  for (const s of draft.sections) {
    const planned = s.plan?.targetSec || s.targetDurationSec || 0;
    const actual = sectionDurationSec(s);
    if (planned > 0 && actual > 0 && (actual < planned * 0.5 || actual > planned * 1.6)) {
      out.push({ kind: 'RUNTIME_BALANCE', ref: `S${s.sequence}`, detail: `Section ${s.sequence} runs ${clock(actual)} against ${clock(planned)} planned` });
    }
  }

  // Fact checker's critical issues on a block, until the block is fixed (edited by the editor, or gone).
  for (const i of opts.factIssues ?? []) {
    if (i.severity !== 'CRITICAL' || !i.resolution.startsWith('open') || !i.ref) continue;
    const b = blocks.find((x) => x.key === i.ref);
    if (b && !b.editedAt) out.push({ kind: 'OPEN_CRITICAL_FACT_ISSUE', ref: b.key, detail: `Block ${b.key}: the fact checker found "${i.note}" and it is not fixed; edit the block or rewrite its section` });
  }

  // The script quality rules, then (over the maximum) where to cut.
  const craft = craftFindings(draft, scope, timing, { previous: opts.previous });
  storyShape(draft, scope, out);
  spokenLanguage(draft, timing.totalSec, craft.refrains, out);
  performance(draft, out);
  pronunciation(draft, scope, out);
  out.push(...craft.findings);
  out.push(...evidenceInvariants(draft, scope, opts.previous ?? null));
  editorialFindings(draft, scope, out);
  const plan = trimPlan(draft, timing, out, protectedBlocks(draft, scope, craft.refrains, opts.kept), scope);
  if (plan) out.push({ kind: 'RUNTIME_PLAN', ref: null, detail: `Over the ${clock(plan.maxSec)} maximum by ${clock(plan.overMaxSec)}: cut or compress first ${plan.candidates.slice(0, 8).map((c) => `${c.ref} (${c.reasons.join(', ')})`).join('; ') || '(no obvious candidate)'}` });
  return out;
}

/** Where to cut, and what never to cut, for a version over its maximum (null when it fits). */
export function cutPlan(draft: ScriptDraft, scope: ScriptScope, opts: CheckOptions): { plan: TrimPlan | null; text: string | null; refrains: Refrain[] } {
  const timing = scriptTiming(allBlocks(draft), opts.target);
  const craft = craftFindings(draft, scope, timing, { previous: opts.previous });
  const plan = trimPlan(draft, timing, [...checkScript(draft, scope, opts)], protectedBlocks(draft, scope, craft.refrains, opts.kept), scope);
  return { plan, text: plan ? renderTrimPlan(plan) : null, refrains: craft.refrains };
}

/** The kinds the script quality rules report (craft.ts): one blocking, the rest warnings. */
export const CRAFT_KINDS: readonly ScriptFindingKind[] = ['PERSON_WITHOUT_EVIDENCE', 'ASSERTION_UNCITED', 'CLAIM_LINK_LOST', 'UNCERTAINTY_UPGRADED', ...SCRIPT_FINDING_KINDS.slice(SCRIPT_FINDING_KINDS.indexOf('RETOLD_CONTENT'))];

export interface RuleDigest {
  words: number;
  runtime: string;
  /** How far over the acceptable maximum it runs (null within it). */
  overMax: string | null;
  /** The quality rules' findings by kind: how many, and where. */
  counts: Partial<Record<ScriptFindingKind, number>>;
  where: Partial<Record<ScriptFindingKind, string>>;
  /** The findings themselves (the first 80). */
  details: string[];
  /** Deliberate repetition the rules recognised, and leave alone. */
  repetition: string[];
  /** Over the maximum: the blocks to cut or compress first, ranked. */
  cutFirst: string[];
}

/**
 * A version as the script quality rules see it, compactly — for the job log,
 * so a run shows what the rules find in the version it starts from, the
 * versions it replaces and the one it makes.
 */
export function ruleDigest(draft: ScriptDraft, scope: ScriptScope, opts: CheckOptions): RuleDigest {
  const timing = scriptTiming(allBlocks(draft), opts.target);
  const found = checkScript(draft, scope, opts).filter((f) => CRAFT_KINDS.includes(f.kind) && f.kind !== 'RUNTIME_PLAN');
  const { plan, refrains } = cutPlan(draft, scope, opts);
  const counts: Partial<Record<ScriptFindingKind, number>> = {};
  const where: Partial<Record<ScriptFindingKind, string[]>> = {};
  for (const f of found) {
    counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    (where[f.kind] ??= []).push(f.ref ?? 'script');
  }
  return {
    words: timing.words,
    runtime: clock(timing.totalSec),
    overMax: timing.totalSec > timing.maxSec ? clock(timing.totalSec - timing.maxSec) : null,
    counts,
    where: Object.fromEntries(Object.entries(where).map(([k, refs]) => [k, refs.join(', ')])),
    details: found.slice(0, 80).map((f) => f.detail),
    repetition: refrains.map((r) => (r.kind === 'ESCALATION' ? `escalation in ${r.refs.join(', ')}` : `${r.kind.toLowerCase()} "${r.phrase}" (${r.refs.join(', ')})`)),
    cutFirst: plan?.candidates.map((c) => `${c.ref} (${c.sec.toFixed(1)} s): ${c.reasons.join('; ')}`) ?? [],
  };
}

function storyShape(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const blocks = allBlocks(draft);
  // Runs of documented facts with nobody in them.
  let run: DraftBlock[] = [];
  const flush = () => {
    if (run.length >= 4) out.push({ kind: 'CONSECUTIVE_FACTS', ref: run[0]!.key, detail: `${run.length} documented blocks in a row with nobody in them (${run[0]!.key}–${run.at(-1)!.key}): let a person carry the facts` });
    run = [];
  };
  for (const s of draft.sections) {
    for (const b of s.blocks) {
      if (b.infoClass === 'DOCUMENTED' && !humanIn(b, scope)) run.push(b);
      else flush();
    }
    flush();
  }
  for (const s of draft.sections) {
    const words = s.blocks.reduce((n, b) => n + b.wordCount, 0);
    const exposition = s.blocks.filter((b) => b.infoClass === 'DOCUMENTED' && !humanIn(b, scope)).reduce((n, b) => n + b.wordCount, 0);
    if (words >= 60 && exposition / words > 0.7) out.push({ kind: 'EXPOSITION_HEAVY', ref: `S${s.sequence}`, detail: `Section ${s.sequence} is ${Math.round((exposition / words) * 100)}% exposition with nobody in it` });
  }
  const narrated = blocks.filter((b) => b.infoClass !== 'FRAMING');
  const human = narrated.filter((b) => humanIn(b, scope)).length;
  if (narrated.length >= 6 && human / narrated.length < 0.4) out.push({ kind: 'LOW_HUMAN_PRESENCE', ref: null, detail: `Only ${Math.round((human / narrated.length) * 100)}% of the narration has a person in it` });
  const total = blocks.reduce((n, b) => n + b.wordCount, 0);
  const creative = blocks.filter((b) => b.infoClass === 'RECONSTRUCTION' || b.infoClass === 'FICTION').reduce((n, b) => n + b.wordCount, 0);
  const fiction = blocks.filter((b) => b.infoClass === 'FICTION').reduce((n, b) => n + b.wordCount, 0);
  if (total > 0 && (creative / total > 0.4 || fiction / total > 0.25)) {
    out.push({ kind: 'RECONSTRUCTION_BUDGET', ref: null, detail: `Reconstruction and fiction are ${Math.round((creative / total) * 100)}% of the words (fiction ${Math.round((fiction / total) * 100)}%); the budget is 40% (fiction 25%)` });
  }
}

function spokenLanguage(draft: ScriptDraft, totalSec: number, refrains: readonly Refrain[], out: ScriptFinding[]): void {
  const narration = allBlocks(draft).filter((b) => !b.speakerId);
  const all = narration.flatMap((b) => sentences(b.text).map((s) => ({ s, key: b.key })));
  // Openings counted without escalation runs ("Not one. Not ten.") — they repeat on purpose.
  const counted = narration.filter((b) => !inEscalation(b, refrains)).flatMap((b) => sentences(b.text).map((s) => ({ s, key: b.key })));
  const lengths = all.map((x) => wordTokens(x.s).length);
  const long = all.filter((_, i) => lengths[i]! > 32);
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  if (long.length >= 3 || avg > 20) {
    out.push({ kind: 'LONG_SENTENCES', ref: long[0]?.key ?? null, detail: `${long.length} sentences over 32 words${long.length ? ` (first in ${long[0]!.key})` : ''}; average ${avg.toFixed(1)} words` });
  }
  // Openings.
  const firsts = counted.map((x) => wordTokens(x.s)[0] ?? '').filter(Boolean);
  const counts = new Map<string, number>();
  for (const w of firsts) counts.set(w, (counts.get(w) ?? 0) + 1);
  const [topWord, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const pairs = new Map<string, number>();
  for (const x of counted) {
    const p = wordTokens(x.s).slice(0, 2).join(' ');
    if (p.includes(' ')) pairs.set(p, (pairs.get(p) ?? 0) + 1);
  }
  const repeatedPairs = [...pairs.entries()].filter(([, n]) => n >= 4);
  if ((topCount >= 6 && topCount / Math.max(firsts.length, 1) > 0.2) || repeatedPairs.length) {
    out.push({ kind: 'REPETITIVE_OPENINGS', ref: null, detail: [topCount >= 6 && topCount / firsts.length > 0.2 ? `${topCount} of ${firsts.length} sentences open with "${topWord}"` : '', ...repeatedPairs.map(([p, n]) => `"${p}…" opens ${n} sentences`)].filter(Boolean).join('; ') });
  }
  // Repeated phrases (four words, not all function words).
  const grams = new Map<string, number>();
  for (const b of narration) {
    const w = wordTokens(b.text);
    for (let i = 0; i + 4 <= w.length; i++) {
      const g = w.slice(i, i + 4);
      if (g.every((x) => STOPWORDS.has(x))) continue;
      const k = g.join(' ');
      grams.set(k, (grams.get(k) ?? 0) + 1);
    }
  }
  // A refrain or callback repeats on purpose: not a repeated phrase.
  const repeated = [...grams.entries()].filter(([g, n]) => n >= 3 && !partOfRefrain(g, refrains)).sort((a, b) => b[1] - a[1]);
  if (repeated.length) out.push({ kind: 'REPEATED_PHRASES', ref: null, detail: repeated.slice(0, 3).map(([g, n]) => `"${g}" ×${n}`).join(', ') });
  // Stock phrases, in the narrator's own words (the writing engine's lexicon, shared with the prompts): not in a name or a quotation.
  const stock = narration.flatMap((b) => stockPhrases(b.text).map((p) => `"${p}" (${b.key})`));
  if (stock.length) out.push({ kind: 'AI_PHRASES', ref: null, detail: `Stock phrases: ${stock.slice(0, 6).join(', ')}${stock.length > 6 ? ` (+${stock.length - 6} more)` : ''}` });
  // Questions.
  const questions = all.filter((x) => x.s.trim().endsWith('?'));
  let streak = 0;
  let maxStreak = 0;
  for (const x of all) {
    streak = x.s.trim().endsWith('?') ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const minutes = Math.max(totalSec / 60, 1);
  if (questions.length / minutes > 1.5 || maxStreak >= 3) {
    out.push({ kind: 'RHETORICAL_QUESTIONS', ref: questions[0]?.key ?? null, detail: `${questions.length} questions in ${minutes.toFixed(1)} minutes${maxStreak >= 3 ? `, ${maxStreak} in a row` : ''}` });
  }
  // Section openings.
  const opens = draft.sections.slice(1).map((s) => wordTokens(s.blocks[0]?.text ?? '')[0] ?? '').filter((w) => CONNECTORS.has(w));
  const openCounts = new Map<string, number>();
  for (const w of opens) openCounts.set(w, (openCounts.get(w) ?? 0) + 1);
  const formulaic = [...openCounts.entries()].filter(([, n]) => n >= 3);
  if (formulaic.length) out.push({ kind: 'FORMULAIC_TRANSITIONS', ref: null, detail: formulaic.map(([w, n]) => `${n} sections open with "${w}"`).join('; ') });
}

function performance(draft: ScriptDraft, out: ScriptFinding[]): void {
  const blocks = allBlocks(draft);
  if (blocks.length === 0) return;
  const paused = blocks.filter((b) => PAUSE_RANK[b.delivery.pauseAfter.length] >= 2 || PAUSE_RANK[b.delivery.pauseBefore.length] >= 2).length;
  const long = blocks.filter((b) => b.delivery.pauseAfter.length === 'LONG' || b.delivery.pauseBefore.length === 'LONG').length;
  if (paused / blocks.length > 0.5 || long > Math.max(4, draft.sections.length)) {
    out.push({ kind: 'PAUSE_OVERUSE', ref: null, detail: `Pauses on ${paused} of ${blocks.length} blocks (${long} long): pause for reveals, numbers and turns, not after every block` });
  }
  const emphasised = blocks.filter((b) => b.delivery.emphasis.length > 0).length;
  const heavy = blocks.filter((b) => b.delivery.emphasis.length > 3);
  if (emphasised / blocks.length > 0.5 || heavy.length) {
    out.push({ kind: 'EMPHASIS_OVERUSE', ref: heavy[0]?.key ?? null, detail: `Emphasis on ${emphasised} of ${blocks.length} blocks${heavy.length ? `; ${heavy.map((b) => b.key).join(', ')} stress more than three words` : ''}` });
  }
  // Long stretches without a pause or a new section.
  for (const s of draft.sections) {
    let acc = 0;
    let start: DraftBlock | null = null;
    for (const b of s.blocks) {
      if (PAUSE_RANK[b.delivery.pauseBefore.length] >= 2) {
        acc = 0;
        start = null;
      }
      start ??= b;
      acc += b.estimatedDurationSec;
      if (acc > 75) {
        out.push({ kind: 'LONG_UNBROKEN_NARRATION', ref: start.key, detail: `${Math.round(acc)} seconds without a pause from ${start.key} to ${b.key}` });
        acc = 0;
        start = null;
        continue;
      }
      if (PAUSE_RANK[b.delivery.pauseAfter.length] >= 2) {
        acc = 0;
        start = null;
      }
    }
  }
}

function pronunciation(draft: ScriptDraft, scope: ScriptScope, out: ScriptFinding[]): void {
  const pending = draft.pronunciations.filter((p) => p.needsReview);
  if (pending.length) out.push({ kind: 'PRONUNCIATION_REVIEW', ref: null, detail: `${pending.length} pronunciation note(s) to confirm: ${pending.map((p) => p.term).slice(0, 8).join(', ')}${pending.length > 8 ? '…' : ''}` });
  const spoken = new Set(wordTokens(allBlocks(draft).map((b) => b.text).join('\n')));
  const noted = new Set(draft.pronunciations.flatMap((p) => wordTokens(p.term)));
  const names = [...scope.cast.values()]
    .filter((c) => c.member.kind === 'REAL_PERSON' || c.member.kind === 'FICTIONAL_COMPOSITE')
    .filter((c) => c.tokens.some((t) => spoken.has(t)))
    .filter((c) => !nameTokens(c.member.name).some((t) => noted.has(t)))
    .map((c) => c.member.name);
  if (names.length) out.push({ kind: 'NAME_WITHOUT_PRONUNCIATION', ref: null, detail: `No pronunciation note for ${names.join(', ')}` });
}

export const sectionOf = (draft: ScriptDraft, key: string): DraftSection | undefined => draft.sections.find((s) => s.blocks.some((b) => b.key === key));
export const timingOf = (draft: ScriptDraft, target: RuntimeTarget) => scriptTiming(allBlocks(draft), target);
export { SCRIPT_TIMING };
