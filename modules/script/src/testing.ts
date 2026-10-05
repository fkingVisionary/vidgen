import { StoryArchitectureContentV2, type ClaimVerdict, type InformationClass } from '@docengine/core';
import { ProviderError, type ObjectGenerationRequest, type ObjectGenerationResult } from '@docengine/providers';
import { EvidenceBase } from '@docengine/story/shared';
import { FakeStoryAI, fakeEvidenceInput } from '@docengine/story/testing';
import { derive, normalizeBlock, renumber, type DraftBlock, type DraftSection, type ScriptDraft } from './draft.ts';
import type { FactCheckOutput, PerformanceOutput, PlannerOutput, RefineOutput, ScriptEditorOutput, WriterBlock, WriterOutput } from './schemas.ts';
import { buildScope, type ScriptScope } from './scope.ts';

/**
 * A scripted AI for the script stage's tests (and the story stages before
 * it: it extends the story fake). It reads the architecture the stage renders
 * into its prompts and writes one block per beat, worded as each claim's
 * verdict requires, so a default run passes the rules; hooks inject the
 * problems the tests need. Every text it writes says "(test)".
 */

interface FakeBeat {
  id: string;
  basis: InformationClass;
  claims: string[];
  cast: string[];
  description: string;
  speech: { speakerId: string; kind: 'RECORDED_QUOTE' | 'INVENTED'; claim: string | null; text: string }[];
}

interface FakeSequence {
  number: number;
  title: string;
  beats: FakeBeat[];
}

export interface ParsedArchitecture {
  centralQuestion: string;
  sequences: FakeSequence[];
  cast: { id: string; name: string; fictional: boolean; kind: string }[];
  verdicts: Map<string, ClaimVerdict>;
}

const list = (s: string) => (s.trim() === 'none' ? [] : s.split(',').map((x) => x.trim()).filter(Boolean));

/** The architecture as the script stage renders it into its prompts. */
export function parseArchitecture(prompt: string): ParsedArchitecture {
  const sequences: FakeSequence[] = [];
  let current: FakeSequence | null = null;
  let lastBeat: FakeBeat | null = null;
  for (const line of prompt.split('\n')) {
    const seq = /^## Sequence (\d+) — (.+?) \(about \d+:\d+\)$/.exec(line);
    if (seq) {
      current = { number: Number(seq[1]), title: seq[2]!, beats: [] };
      sequences.push(current);
      continue;
    }
    const beat = /^- beat (\S+) \[(\w+)\/(\w+)\] claims: (.*?) \| cast: (.*?) \| (.*)$/.exec(line);
    if (beat && current) {
      lastBeat = { id: beat[1]!, basis: beat[2] as InformationClass, claims: list(beat[4]!), cast: list(beat[5]!), description: beat[6]!, speech: [] };
      current.beats.push(lastBeat);
      continue;
    }
    const speech = /^ {2}speech (\S+) (\w+) claim (\S+): "(.*)"$/.exec(line);
    if (speech && lastBeat) lastBeat.speech.push({ speakerId: speech[1]!, kind: speech[2] as 'RECORDED_QUOTE' | 'INVENTED', claim: speech[3] === 'none' ? null : speech[3]!, text: speech[4]! });
  }
  const cast = [...prompt.matchAll(/^- (\S+) · (.+?) · (.+?)( · FICTIONAL DEVICE)? — /gm)].map((m) => ({ id: m[1]!, name: m[2]!, kind: m[3]!, fictional: Boolean(m[4]) }));
  const verdicts = new Map([...prompt.matchAll(/^(C\d+) \[\w+ · (\w+) · /gm)].map((m) => [m[1]!, m[2] as ClaimVerdict]));
  const cq = /^Central question \(Q0\): (.*)$/m.exec(prompt)?.[1] ?? 'What happened (test)?';
  return { centralQuestion: cq, sequences, cast, verdicts };
}

/** Words that carry each verdict's uncertainty, as the rules expect them. */
const HEDGES: Partial<Record<ClaimVerdict, string>> = {
  PROBABLE: 'Records suggest that',
  DISPUTED: 'Historians disagree, but',
  UNVERIFIED: 'No surviving record confirms it, but',
  MYTH: 'The story goes that',
};

const INTENT: Record<InformationClass, WriterBlock['visual']['intent']> = { DOCUMENTED: 'DOCUMENT', RECONSTRUCTION: 'CINEMATIC_RECONSTRUCTION', UNCERTAIN: 'ARCHIVAL', FICTION: 'CINEMATIC_RECONSTRUCTION' };

const visual = (basis: InformationClass, claims: string[]): WriterBlock['visual'] => ({
  intent: INTENT[basis],
  mustShow: basis === 'DOCUMENTED' && claims.length ? [{ detail: 'the written record (test)', claimKeys: claims.slice(0, 1) }] : [],
  mustAvoid: ['modern clothing'],
  priority: 'NORMAL',
  note: '',
});

/** The blocks a beat becomes: its narration (hedged per verdict), then its planned speech. */
export function blocksForBeat(beat: FakeBeat, arch: ParsedArchitecture, variant = ''): WriterBlock[] {
  const hedges = [...new Set(beat.claims.map((k) => arch.verdicts.get(k)).flatMap((v) => (v && HEDGES[v] ? [HEDGES[v]!] : [])))];
  const lower = beat.description.charAt(0).toLowerCase() + beat.description.slice(1);
  const text = hedges.length ? `${hedges.join(' ')} ${lower}` : beat.description;
  const out: WriterBlock[] = [{ text: variant ? `${text} ${variant}` : text, infoClass: beat.basis, beatIds: [beat.id], claimKeys: beat.claims, speakerId: null, speechKind: null, visual: visual(beat.basis, beat.claims) }];
  for (const s of beat.speech) {
    out.push({ text: `"${s.text}"`, infoClass: s.kind === 'INVENTED' ? 'FICTION' : beat.basis, beatIds: [beat.id], claimKeys: s.claim ? [s.claim] : [], speakerId: s.speakerId, speechKind: s.kind, visual: visual(s.kind === 'INVENTED' ? 'FICTION' : beat.basis, []) });
  }
  return out;
}

export function fakeWriter(prompt: string, only: readonly number[] | null, variant = ''): WriterOutput {
  const arch = parseArchitecture(prompt);
  const sequences = arch.sequences.filter((s) => !only || only.includes(s.number));
  const sections = sequences.map((s, i) => ({
    sequence: s.number,
    blocks: [
      ...(i === 0 && !only ? [{ text: arch.centralQuestion, infoClass: 'FRAMING' as const, beatIds: [], claimKeys: [], speakerId: null, speechKind: null, visual: { ...visual('RECONSTRUCTION', []), intent: 'ON_SCREEN_TEXT' as const } }] : []),
      ...s.beats.flatMap((b) => blocksForBeat(b, arch, variant)),
    ],
  }));
  const last = sections.at(-1);
  const lastSequence = arch.sequences.at(-1)?.number;
  return {
    sections,
    centralQuestion: {
      posedIn: only ? null : `${sections[0]?.sequence ?? 1}.1`,
      answeredIn: last && last.sequence === lastSequence ? `${last.sequence}.${last.blocks.length}` : null,
    },
    changeLog: only ? { summary: 'Rewrote the sections as asked (test).', changes: only.map((n) => ({ section: n, what: 'Tightened the narration (test).', why: "The editor's brief asked for it (test)." })) } : { summary: 'One block per beat, hedged as the verdicts require (test).', changes: [] },
  };
}

export function fakePlan(prompt: string): PlannerOutput {
  const arch = parseArchitecture(prompt);
  const seconds = [...prompt.matchAll(/^## Sequence (\d+) — .+? \(about (\d+):(\d+)\)$/gm)].map((m) => ({ n: Number(m[1]), sec: Number(m[2]) * 60 + Number(m[3]) }));
  return {
    narrator: { persona: 'A calm investigator (test).', tone: 'Measured, curious (test).', approach: 'Let the people carry the facts (test).' },
    sections: arch.sequences.map((s) => ({
      sequence: s.number,
      purpose: `Tell ${s.title} (test).`,
      approach: 'Scene first, then the record (test).',
      showNotSay: ['the written record (test)'],
      exposition: ['only what the turn needs (test)'],
      tension: 'Rising (test).',
      reveal: 'What the record shows (test).',
      sparse: false,
      targetSec: seconds.find((x) => x.n === s.number)?.sec ?? 60,
    })),
    centralQuestion: { poseInSection: arch.sequences[0]?.number ?? 1, answerInSection: arch.sequences.at(-1)?.number ?? 1 },
    notes: [],
  };
}

/** The script as rendered for reviewers: block references and texts. */
export function parseScript(prompt: string): { ref: string; text: string; infoClass: string; speaker: boolean }[] {
  const out: { ref: string; text: string; infoClass: string; speaker: boolean }[] = [];
  const lines = prompt.split('\n');
  lines.forEach((line, i) => {
    const m = /^\[(\d+\.\d+)\] (\w+) · /.exec(line);
    if (m) out.push({ ref: m[1]!, text: lines[i + 1] ?? '', infoClass: m[2]!, speaker: line.includes(' · speaker ') });
  });
  return out;
}

/** A block of the version to refine, as the refinement prompt renders it. */
export interface FakeBaseBlock {
  sequence: number;
  ref: string;
  text: string;
  infoClass: WriterBlock['infoClass'];
  beatIds: string[];
  claimKeys: string[];
  speakerId: string | null;
  speechKind: WriterBlock['speechKind'];
  centralQuestion: 'POSED' | 'ANSWERED' | null;
}

/** The base script in a refinement prompt (the part after "# Script vN — the text to refine"). */
export function parseBaseScript(prompt: string): FakeBaseBlock[] {
  const start = prompt.search(/^# Script v\d+ — the text to refine/m);
  if (start < 0) return [];
  const lines = prompt.slice(start).split('\n');
  const out: FakeBaseBlock[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (/^# /.test(lines[i]!)) break;
    const m = /^\[(\d+)\.(\d+)\] (\w+) · beats (.*?) · claims (.*?)(?: · speaker (\S+)(?: (\w+))?)?(?: · (POSED|ANSWERED) Q0)?$/.exec(lines[i]!);
    if (!m) continue;
    out.push({
      sequence: Number(m[1]),
      ref: `${m[1]}.${m[2]}`,
      text: lines[i + 1] ?? '',
      infoClass: m[3] as WriterBlock['infoClass'],
      beatIds: list(m[4]!),
      claimKeys: list(m[5]!),
      speakerId: m[6] ?? null,
      speechKind: (m[7] as WriterBlock['speechKind'] | undefined) ?? null,
      centralQuestion: (m[8] as 'POSED' | 'ANSWERED' | undefined) ?? null,
    });
  }
  return out;
}

/**
 * The fake refinement: every narrator line reworded ("(test)" → "(refined, test)"),
 * the first line kept word for word (and listed as kept), speech untouched;
 * beats, claims, classes and the central question carried over.
 */
export function fakeRefine(prompt: string): RefineOutput {
  const base = parseBaseScript(prompt);
  const numbers = [...new Set(base.map((b) => b.sequence))];
  const first = base[0];
  const sections = numbers.map((n) => ({
    sequence: n,
    blocks: base
      .filter((b) => b.sequence === n)
      .map((b) => ({
        text: b === first || b.speakerId ? b.text : b.text.replace('(test)', '(refined, test)'),
        infoClass: b.infoClass,
        beatIds: b.beatIds,
        claimKeys: b.claimKeys,
        speakerId: b.speakerId,
        speechKind: b.speechKind,
        visual: b.infoClass === 'FRAMING' ? { ...visual('RECONSTRUCTION', []), intent: 'ON_SCREEN_TEXT' as const } : visual(b.infoClass, b.claimKeys),
      })),
  }));
  const at = (what: 'POSED' | 'ANSWERED') => base.find((b) => b.centralQuestion === what)?.ref ?? null;
  return {
    sections,
    centralQuestion: { posedIn: at('POSED'), answeredIn: at('ANSWERED') },
    changeLog: { summary: 'Told for the ear: fewer signposts, the facts arrive through the scene (test).', changes: numbers.map((n) => ({ section: n, what: 'Reworded for the ear (test).', why: 'It read like an essay (test).' })) },
    keptLines: first ? [first.text] : [],
  };
}

/** The script editor's answers when the prompt has a refinement checklist (every question: YES, better). */
export function fakeChecklist(prompt: string): ScriptEditorOutput['assessment'] {
  const start = prompt.search(/^# Refinement checklist/m);
  if (start < 0) return [];
  const questions = [...prompt.slice(start).matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!).slice(0, 13);
  return questions.map((question) => ({ question, answer: 'YES' as const, comparedToPrevious: 'BETTER' as const, note: 'Reads as spoken (test).' }));
}

export function fakePerformance(prompt: string): PerformanceOutput {
  const blocks = parseScript(prompt);
  const firstOfSection = blocks.filter((b, i) => i === 0 || blocks[i - 1]!.ref.split('.')[0] !== b.ref.split('.')[0]);
  const arch = /^Cast: (.*)$/m.exec(prompt)?.[1] ?? '';
  const names = [...arch.matchAll(/([^;(]+) \((REAL_PERSON|FICTIONAL_COMPOSITE)\)/g)].map((m) => m[1]!.trim());
  return {
    blocks: firstOfSection.map((b, i) => {
      const word = b.text.replace(/["“”]/g, '').split(/\s+/).find((w) => /^[a-z]{5,}$/i.test(w));
      return {
        ref: b.ref,
        pace: 'NORMAL' as const,
        energy: 'MEDIUM' as const,
        emotion: i === 0 ? ('CURIOUS' as const) : ('NEUTRAL' as const),
        emphasis: word ? [{ text: word, level: 'LIGHT' as const }] : [],
        pauseBefore: i === 0 ? { length: 'NONE' as const, reason: null } : { length: 'SHORT' as const, reason: 'TRANSITION' as const },
        pauseAfter: { length: 'NONE' as const, reason: null },
      };
    }),
    pronunciations: names.map((name) => ({ term: name, respelling: name.toUpperCase(), ipa: null, language: null, confidence: 'MEDIUM' as const, note: 'Check with a native speaker (test).' })),
    notes: ['A measured read that builds towards the reveal (test).'],
  };
}

const SCORE = { score: 7, why: 'Solid (test).' };

export class FakeScriptAI extends FakeStoryAI {
  /** Text appended to every block of a rewrite (marks rewritten sections). */
  rewriteVariant = 'This time it is told more tightly (test).';
  /** Change the writer's output (e.g. to break a rule). */
  writerTransform: ((out: WriterOutput, task: string) => WriterOutput) | null = null;
  /** Change the refinement's output (e.g. to drop a hedge or a section). */
  refineTransform: ((out: RefineOutput) => RefineOutput) | null = null;
  /** The script editor's review (default: scores, no issues, no changes; the checklist answered when there is one). */
  editor: (prompt: string) => ScriptEditorOutput = (prompt) => ({ verdict: 'A solid draft (test).', scores: { NARRATIVE_SCORE: SCORE, AUDIO_FLOW_SCORE: SCORE, CLARITY_SCORE: SCORE, EMOTIONAL_SCORE: SCORE, ENDING_SCORE: SCORE }, issues: [], assessment: fakeChecklist(prompt), edits: [], removals: [], insertions: [] });
  /** The fact checker's review (default: no issues). */
  factChecker: (prompt: string) => FactCheckOutput = () => ({ verdict: 'Every block matches its evidence (test).', issues: [], edits: [], removals: [], insertions: [] });
  performance: (prompt: string) => PerformanceOutput = fakePerformance;

  override async generateObject<T>(req: ObjectGenerationRequest<T>): Promise<ObjectGenerationResult<T>> {
    if (!req.task.startsWith('script.')) return super.generateObject(req);
    this.calls[req.task] = (this.calls[req.task] ?? 0) + 1;
    const user = req.messages.map((m) => m.content).join('\n');
    (this.prompts[req.task] ??= []).push(user);
    if (this.failNextTask === req.task) {
      this.failNextTask = null;
      throw new ProviderError('fake-ai', 'overloaded (test)', true);
    }
    if (this.brokenTask === req.task) throw new ProviderError('fake-ai', 'refused (test)', false);
    const object = this.script(req.task, user);
    return {
      object: req.schema.parse(object),
      meta: { provider: 'fake-ai', model: 'fake-model', mock: false, usage: [{ unit: 'INPUT_TOKENS', quantity: Math.round(user.length / 4) }, { unit: 'OUTPUT_TOKENS', quantity: 2_000 }] },
    };
  }

  private script(task: string, user: string): unknown {
    switch (task) {
      case 'script.plan':
        return fakePlan(user);
      case 'script.write': {
        const out = fakeWriter(user, null);
        return this.writerTransform ? this.writerTransform(out, task) : out;
      }
      case 'script.rewrite': {
        const only = /^# Rewrite sections? ([\d, ]+) of script/m.exec(user)?.[1]?.split(',').map((x) => Number(x.trim())) ?? [];
        const out = fakeWriter(user, only, this.rewriteVariant);
        return this.writerTransform ? this.writerTransform(out, task) : out;
      }
      case 'script.refine': {
        const out = fakeRefine(user);
        return this.refineTransform ? this.refineTransform(out) : out;
      }
      case 'script.edit':
        return this.editor(user);
      case 'script.factCheck':
        return this.factChecker(user);
      case 'script.perform':
        return this.performance(user);
      default:
        throw new Error(`FakeScriptAI: unknown task ${task}`);
    }
  }
}

// ── A small hand-made architecture over the synthetic dossier (unit tests) ───

const setting = { location: { value: 'a crowded room (test)', basis: 'RECONSTRUCTION' as const }, date: { value: '', basis: 'RECONSTRUCTION' as const }, timeOfDay: { value: 'evening', basis: 'RECONSTRUCTION' as const } };
const seqVisual = { environment: 'Interior (test).', keyObjects: [], physicalActions: [], emotionalState: 'tension', visualMetaphor: '', mustShow: [], mustAvoid: ['modern clothing'], shotIdeas: [] };

function seq(number: number, title: string, beats: StoryArchitectureContentV2['sequences'][number]['beats'], presentation: StoryArchitectureContentV2['sequences'][number]['presentation'] = []): StoryArchitectureContentV2['sequences'][number] {
  const claimKeys = [...new Set(beats.flatMap((b) => b.claimKeys))];
  return {
    number,
    title,
    purpose: 'Moves the story on (test).',
    mode: 'INVESTIGATION',
    candidateIds: [],
    candidateKeys: [`S0${number}`],
    openingHook: 'A hook (test).',
    question: 'Why (test)?',
    conflict: '',
    escalation: '',
    reveal: '',
    consequence: '',
    endingBeat: '',
    transition: number < 3 ? 'On to the next (test).' : '',
    beats,
    castIds: [...new Set(beats.flatMap((b) => b.castIds))],
    setting,
    visual: seqVisual,
    continuity: { carriesIn: [], carriesOut: [], opens: number === 1 ? [{ id: 'Q0', question: 'Why did a flower trade end in court (test)?' }] : [], resolves: number === 3 ? ['Q0'] : [], timeJump: 'NONE' },
    claimKeys,
    sourceIds: [],
    contextClaims: [],
    contextSourceIds: [],
    presentation,
    historicalStatus: 'ESTABLISHED',
    historicalConfidence: 8,
    estimatedDurationSec: 40,
  };
}

/** Three sequences: taverns (POV, a composite with an invented line), the court (a real buyer, PROBABLE), the legend (MYTH, DISPUTED). */
export function fixtureArchitecture(): StoryArchitectureContentV2 {
  return StoryArchitectureContentV2.parse({
    engineVersion: 2,
    logline: 'Ordinary traders promise fortunes for flowers (test).',
    centralQuestion: 'Why did a flower trade end in court (test)?',
    centralHumanStakes: 'Their savings and their good name (test).',
    narrativeMode: 'INVESTIGATION',
    secondaryModes: [],
    povStrategy: { type: 'COMPANION', description: 'We follow a composite buyer (test).' },
    cast: [
      { id: 'pov', name: 'You', kind: 'POV_PROXY', description: 'The viewer (test).', claimKeys: [], justification: 'A way in (test).' },
      { id: 'F1', name: 'Pieter Graanhout', kind: 'FICTIONAL_COMPOSITE', description: 'A typical buyer (test).', claimKeys: ['C016'], justification: 'A guide (test).' },
      { id: 'R1', name: 'Cornelis Proefman', kind: 'REAL_PERSON', description: 'A buyer who was sued (test).', claimKeys: ['C008'], justification: '' },
      { id: 'R2', name: 'Jan Testbroek', kind: 'REAL_PERSON', description: 'An innkeeper (test).', claimKeys: ['C004'], justification: '' },
    ],
    thesis: 'A trade in promises (test).',
    narrativeSpine: 'From the taverns to the courts to the legend (test).',
    resolution: 'The record shows contracts, not ruin (test).',
    orderNote: '',
    sequences: [
      seq(1, 'The taverns', [
        { id: '1.1', function: 'COLD_OPEN', basis: 'RECONSTRUCTION', description: 'You push into a crowded tavern room where florists trade (test).', claimKeys: ['C002'], castIds: ['pov'], speech: [] },
        { id: '1.2', function: 'ORIENTATION', basis: 'DOCUMENTED', description: 'Buyers sign contracts for bulbs still in the ground (test).', claimKeys: ['C001'], castIds: [], speech: [] },
        { id: '1.3', function: 'ESCALATION', basis: 'FICTION', description: 'Pieter watches the bidding from the back (test).', claimKeys: [], castIds: ['F1'], speech: [{ speakerId: 'F1', text: 'Everyone here is buying paper, not flowers.', kind: 'INVENTED', claimKey: null }] },
      ]),
      seq(
        2,
        'The court',
        [
          { id: '2.1', function: 'STAKES', basis: 'UNCERTAIN', description: 'Cornelis Proefman refuses the bulbs he bought (test).', claimKeys: ['C008'], castIds: ['R1'], speech: [] },
          { id: '2.2', function: 'TURN', basis: 'DOCUMENTED', description: 'In April 1637 the courts refer the contracts to the towns (test).', claimKeys: ['C007'], castIds: [], speech: [] },
        ],
        [{ claimKey: 'C008', presentation: 'HEDGE', instruction: 'Records suggest it (test).' }],
      ),
      seq(
        3,
        'The legend',
        [
          { id: '3.1', function: 'INVESTIGATION', basis: 'UNCERTAIN', description: 'The legend of ruin is tested against the archives (test).', claimKeys: ['C010'], castIds: [], speech: [] },
          { id: '3.2', function: 'REVEAL', basis: 'UNCERTAIN', description: 'The famous price of a single bulb is contested (test).', claimKeys: ['C009'], castIds: [], speech: [] },
          { id: '3.3', function: 'CONSEQUENCE', basis: 'DOCUMENTED', description: 'A book of 1841 spread the story (test).', claimKeys: ['C012'], castIds: [], speech: [] },
        ],
        [
          { claimKey: 'C010', presentation: 'INVESTIGATE_AS_MYTH', instruction: 'Tell it as the legend, then test it (test).' },
          { claimKey: 'C009', presentation: 'PRESENT_AS_DISPUTED', instruction: 'Say it is disputed (test).' },
        ],
      ),
    ],
    unusedCandidates: [],
    reconstruction: { level: 'LOW', beats: 8, shares: { DOCUMENTED: 0.375, RECONSTRUCTION: 0.125, UNCERTAIN: 0.375, FICTION: 0.125 } },
  });
}

export function fixtureScope(): ScriptScope {
  return buildScope({ architectureId: 'arch-test', architectureVersion: 1, architecture: fixtureArchitecture(), evidence: new EvidenceBase(fakeEvidenceInput()) });
}

/** A block for the fixture scope, normalized like the writer's (delivery defaults; derived fields computed). */
export function fixtureBlock(scope: ScriptScope, raw: Partial<WriterBlock> & Pick<WriterBlock, 'text' | 'infoClass'>, extra: Partial<DraftBlock> = {}): DraftBlock {
  const b = normalizeBlock({ beatIds: [], claimKeys: [], speakerId: null, speechKind: null, visual: { intent: 'NONE', mustShow: [], mustAvoid: [], priority: 'NORMAL', note: '' }, ...raw }, scope, [], 'test');
  return derive({ ...b, ...extra, delivery: { ...b.delivery, ...(extra.delivery ?? {}) } }, scope);
}

/** A clean script of the fixture: every beat told, worded as its verdicts require. */
export function fixtureDraft(scope: ScriptScope = fixtureScope()): ScriptDraft {
  const B = (raw: Parameters<typeof fixtureBlock>[1], extra: Partial<DraftBlock> = {}) => fixtureBlock(scope, raw, extra);
  const sections: DraftSection[] = [
    {
      sequence: 1,
      key: 'SC01',
      title: 'The taverns',
      plan: null,
      reviewStatus: 'PENDING',
      editorNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      targetDurationSec: 40,
      written: true,
      blocks: [
        B({ text: 'Why did a flower trade end in court?', infoClass: 'FRAMING' }, { centralQuestion: 'POSED' }),
        B({ text: 'You push into a crowded tavern room. Around the tables, florists are trading.', infoClass: 'RECONSTRUCTION', beatIds: ['1.1'], claimKeys: ['C002'] }),
        B({ text: 'The buyers sign contracts for bulbs that are still in the ground.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['C001'] }),
        B({ text: 'Pieter watches the bidding from the back of the room, counting what he has.', infoClass: 'FICTION', beatIds: ['1.3'] }),
        B({ text: '"Everyone here is buying paper, not flowers."', infoClass: 'FICTION', beatIds: ['1.3'], speakerId: 'F1', speechKind: 'INVENTED' }),
      ],
    },
    {
      sequence: 2,
      key: 'SC02',
      title: 'The court',
      plan: null,
      reviewStatus: 'PENDING',
      editorNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      targetDurationSec: 40,
      written: true,
      blocks: [
        B({ text: 'Records suggest that Cornelis Proefman refused the bulbs he had bought, for 1,200 guilders.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'] }),
        B({ text: 'In April 1637 the courts sent the unsettled contracts back to the towns.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['C007'] }),
      ],
    },
    {
      sequence: 3,
      key: 'SC03',
      title: 'The legend',
      plan: null,
      reviewStatus: 'PENDING',
      editorNotes: null,
      reviewedBy: null,
      reviewedAt: null,
      targetDurationSec: 40,
      written: true,
      blocks: [
        B({ text: 'The legend says the trade ruined a nation. The archives tell another story.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['C010'] }),
        B({ text: 'Even the most famous price is disputed: a single bulb, offered for 5,500 guilders.', infoClass: 'UNCERTAIN', beatIds: ['3.2'], claimKeys: ['C009'] }),
        B({ text: 'A book published in 1841 spread the story of the mania.', infoClass: 'DOCUMENTED', beatIds: ['3.3'], claimKeys: ['C012'] }, { centralQuestion: 'ANSWERED' }),
      ],
    },
  ];
  return { sections: sections.map(renumber), pronunciations: [] };
}
