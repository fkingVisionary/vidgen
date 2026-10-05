import { SCRIPT_SCORES, SCRIPT_TIMING, fmtClock, fmtVariance, type CoherenceIssue, type QualityCheck, type QualityJudgment, type QualityMeasurement, type QualityReport, type ScriptContent, type ScriptTiming } from '@docengine/core';
import { rhythmProfile, summarise as fingerprint } from '@docengine/writing';
import { allBlocks, type ScriptDraft } from './draft.ts';
import { narrationBlocks } from './editorial.ts';
import { NARRATION_CHECKLIST, REFINEMENT_CHECKLIST } from './prompts.ts';
import { SCRIPT_BLOCKING, type ScriptFinding, type ScriptFindingKind } from './rules.ts';

/**
 * The script's quality gate: the rule findings grouped into checks. A FAIL
 * blocks approval of the version (the editor can fix it by editing, or
 * rewrite the section); WARNs are for the editor. Beside the checks, two
 * things are kept apart on purpose: measurements, computed by code from the
 * structured script (words, runtime, pauses, claims, findings by kind,
 * reviewer changes), and judgments, the models' verdicts and scores — opinions,
 * recorded, never presented as measurements and never failing the gate.
 */

const GROUPS: { id: string; label: string; kinds: ScriptFindingKind[] }[] = [
  { id: 'evidence', label: 'Every fact traces to the approved architecture', kinds: ['CLAIM_OUTSIDE_ARCHITECTURE', 'NOT_IN_ARCHITECTURE', 'BLOCK_WITHOUT_EVIDENCE'] },
  { id: 'figures_names', label: 'Figures, dates and names come from the evidence', kinds: ['UNSUPPORTED_FIGURE', 'PERSON_OUTSIDE_ARCHITECTURE', 'UNKNOWN_NAME'] },
  { id: 'assertions', label: 'Every factual assertion rests on a claim the block cites', kinds: ['PERSON_WITHOUT_EVIDENCE', 'ASSERTION_UNCITED', 'CLAIM_LINK_LOST', 'PERSON_WITHOUT_EVIDENCE_SCENE', 'UNCITED_CLAIM_MATCH'] },
  { id: 'information_classes', label: 'Information classes are preserved', kinds: ['CLASS_MISMATCH', 'DOCUMENTED_NOT_ESTABLISHED', 'FRAMING_WITH_FACTS', 'FICTION_NOT_ALLOWED'] },
  { id: 'uncertainty', label: 'Uncertain history is worded as uncertain, never upgraded', kinds: ['MYTH_AS_FACT', 'DISPUTED_AS_FACT', 'UNVERIFIED_AS_FACT', 'PROBABLE_UNHEDGED', 'UNCERTAINTY_UPGRADED'] },
  { id: 'fiction_boundary', label: 'Fiction stays fiction', kinds: ['FICTION_IN_DOCUMENTED', 'FICTION_REAL_INTERACTION', 'FICTION_DOCUMENTED_ACT', 'FICTION_WITH_FACTS'] },
  { id: 'speech', label: 'Real people speak only in recorded quotations', kinds: ['UNDECLARED_SPEAKER', 'REAL_PERSON_INVENTED_SPEECH', 'FICTIONAL_RECORDED_QUOTE', 'UNVERIFIED_RECORDED_QUOTE', 'FABRICATED_QUOTE'] },
  { id: 'structure', label: 'The architecture is told in full and its question answered', kinds: ['SEQUENCE_MISSING', 'CENTRAL_QUESTION_NOT_POSED', 'CENTRAL_QUESTION_ABANDONED'] },
  { id: 'fact_check', label: "The fact checker's critical issues are fixed", kinds: ['OPEN_CRITICAL_FACT_ISSUE'] },
  { id: 'story_shape', label: 'A story, not a lecture', kinds: ['CONSECUTIVE_FACTS', 'EXPOSITION_HEAVY', 'LOW_HUMAN_PRESENCE', 'QUESTION_POSED_LATE', 'BEAT_FROM_OTHER_SEQUENCE'] },
  { id: 'redundancy', label: 'Said once (deliberate echoes aside)', kinds: ['RETOLD_CONTENT', 'RECAP_SECTION', 'CLAIM_RETOLD', 'REFRAIN_LOST'] },
  { id: 'exposition', label: 'Every fact earns its place', kinds: ['PASSENGER_FACT', 'SOURCE_CHATTER', 'NAME_LOAD'] },
  { id: 'meta_narration', label: 'The story, not the film about it', kinds: ['META_NARRATION'] },
  { id: 'introductions', label: 'People and devices introduced once, plainly', kinds: ['DEVICE_RELABELLED', 'DEVICE_LABEL_STACKED', 'DEVICE_UNINTRODUCED', 'PERSON_UNINTRODUCED'] },
  { id: 'reconstruction_budget', label: 'Reconstruction and fiction within budget', kinds: ['RECONSTRUCTION_BUDGET'] },
  { id: 'real_people', label: 'Real people are not given invented thoughts', kinds: ['REAL_INTERIORITY'] },
  {
    id: 'spoken_language',
    label: 'Written for the ear',
    kinds: ['LONG_SENTENCES', 'LONG_BLOCK', 'LONG_UNBROKEN_NARRATION', 'REPETITIVE_OPENINGS', 'REPEATED_PHRASES', 'AI_PHRASES', 'RHETORICAL_QUESTIONS', 'FORMULAIC_TRANSITIONS', 'UNSPOKEN_SYMBOLS', 'WRITTEN_SYNTAX', 'LIST_SENTENCE', 'NUMBER_DENSE', 'MONOTONOUS_RHYTHM', 'NOUN_HEAVY'],
  },
  { id: 'human_voice', label: 'Sounds written by a person (AI-pattern signals)', kinds: ['AI_PATTERN', 'VISUAL_IN_NARRATION'] },
  { id: 'money_context', label: 'Sums of money carry the context the evidence gives', kinds: ['MONEY_WITHOUT_CONTEXT'] },
  { id: 'layers', label: 'Only narration is spoken (no directions in the text)', kinds: ['DIRECTION_IN_NARRATION'] },
  { id: 'performance', label: 'Pauses and emphasis with restraint', kinds: ['PAUSE_OVERUSE', 'EMPHASIS_OVERUSE'] },
  { id: 'runtime_balance', label: 'Sections paced to the story', kinds: ['RUNTIME_BALANCE', 'SECTION_OVER_BUDGET', 'ENDING_DRAG'] },
  { id: 'runtime_plan', label: 'If it runs long: where to cut first', kinds: ['RUNTIME_PLAN'] },
  { id: 'pronunciation', label: 'Pronunciations confirmed', kinds: ['PRONUNCIATION_REVIEW', 'NAME_WITHOUT_PRONUNCIATION'] },
  { id: 'visual_handoff', label: 'Visual details carry their evidence', kinds: ['VISUAL_WITHOUT_EVIDENCE'] },
];

const summarise = (fs: readonly ScriptFinding[], max = 6) => fs.slice(0, max).map((f) => f.detail).join('; ') + (fs.length > max ? `; (+${fs.length - max} more)` : '');

const EVIDENCE_KINDS: ScriptFindingKind[] = ['BLOCK_WITHOUT_EVIDENCE', 'UNSUPPORTED_FIGURE', 'PERSON_WITHOUT_EVIDENCE', 'ASSERTION_UNCITED', 'CLAIM_LINK_LOST', 'UNCERTAINTY_UPGRADED', 'UNCITED_CLAIM_MATCH'];
const refsOf = (fs: readonly ScriptFinding[], kinds: readonly ScriptFindingKind[]) => fs.filter((f) => kinds.includes(f.kind)).map((f) => f.ref ?? 'script');
const listed = (refs: readonly string[]) => (refs.length ? `${refs.slice(0, 12).join(', ')}${refs.length > 12 ? ` (+${refs.length - 12})` : ''}` : null);

export function computeScriptReport(args: {
  findings: readonly ScriptFinding[];
  timing: ScriptTiming;
  content: Pick<ScriptContent, 'editor' | 'factCheck'> & Partial<Pick<ScriptContent, 'reviewChanges' | 'narration' | 'provenance'>>;
  notes: readonly string[];
  reviewers?: { editor: string | null; factCheck: string | null };
  /** The script, for the measurements. */
  draft?: ScriptDraft;
  /** The runtime with no performance timing in the sections the run marked. */
  narrationSec?: number | null;
}): QualityReport {
  const { findings, timing, content } = args;
  const checks: QualityCheck[] = [];
  for (const g of GROUPS) {
    const fs = findings.filter((f) => g.kinds.includes(f.kind));
    // A group fails on a blocking finding, never on a warning that shares its group.
    const failing = fs.filter((f) => SCRIPT_BLOCKING.includes(f.kind));
    const shown = [...failing, ...fs.filter((f) => !failing.includes(f))];
    checks.push({ id: g.id, label: g.label, status: fs.length === 0 ? 'PASS' : failing.length ? 'FAIL' : 'WARN', detail: fs.length ? summarise(shown) : 'No findings', metric: fs.length, threshold: 0 });
  }
  // Runtime, with its numbers.
  const off = findings.some((f) => f.kind === 'RUNTIME_OFF');
  const near = findings.some((f) => f.kind === 'RUNTIME_NEAR');
  checks.splice(checks.findIndex((c) => c.id === 'fact_check') + 1, 0, {
    id: 'runtime',
    label: 'Estimated voice runtime',
    status: off ? 'FAIL' : near ? 'WARN' : 'PASS',
    detail: `Target ${fmtClock(timing.targetSec)} (${fmtClock(timing.minSec)}–${fmtClock(timing.maxSec)}) · script ${fmtClock(timing.totalSec)} · variance ${fmtVariance(timing.varianceSec)} · ${timing.words} words`,
    metric: timing.totalSec,
    threshold: timing.targetSec,
  });
  const coherenceIssues: CoherenceIssue[] = [...(content.factCheck?.issues ?? []), ...(content.editor?.issues ?? [])].map((i) => ({
    severity: i.severity,
    description: `${i.ref ? `${i.ref}: ` : ''}[${i.kind}] ${i.note}`,
    claimKeys: [],
    resolution: i.resolution,
  }));
  return {
    passed: checks.every((c) => c.status !== 'FAIL'),
    generatedAt: new Date().toISOString(),
    checks,
    normalizations: [...args.notes],
    coherenceIssues,
    measurements: measure(args),
    judgments: judgments(args),
  };
}

/** What code measured: never a model's estimate. */
function measure(args: Parameters<typeof computeScriptReport>[0]): QualityMeasurement[] {
  const { findings, timing, draft } = args;
  const m = (id: string, label: string, value: string, detail: string | null = null): QualityMeasurement => ({ id, label, value, detail });
  const out: QualityMeasurement[] = [
    m('words', 'Spoken words', timing.words.toLocaleString('en'), `counted from the script at ${SCRIPT_TIMING.wordsPerMinute} words a minute`),
    m('runtime', 'Runtime, with performance timing', fmtClock(timing.totalSec), `acceptable ${fmtClock(timing.minSec)}–${fmtClock(timing.maxSec)} · ${timing.totalSec > timing.maxSec ? `${fmtClock(timing.totalSec - timing.maxSec)} over the maximum` : timing.totalSec < timing.minSec ? `${fmtClock(timing.minSec - timing.totalSec)} under the minimum` : 'within the range'}`),
  ];
  if (args.narrationSec != null) out.push(m('narration', 'Runtime of the words alone', fmtClock(args.narrationSec), `performance timing (pauses, pace) adds ${Math.max(0, timing.totalSec - args.narrationSec).toFixed(1)} s`));
  if (draft) {
    const blocks = allBlocks(draft);
    const pauses = blocks.flatMap((b) => [b.delivery.pauseBefore, b.delivery.pauseAfter]).filter((p) => p.length !== 'NONE');
    const pauseSec = pauses.reduce((n, p) => n + SCRIPT_TIMING.pauseSec[p.length], 0);
    const slow = blocks.filter((b) => b.delivery.pace === 'SLOW').length;
    out.push(m('pauses', 'Pauses', `${pauses.length}`, `${pauseSec.toFixed(1)} s in all · ${slow} block(s) at a slow pace`));
    const claims = new Set(blocks.flatMap((b) => b.claimKeys));
    out.push(m('claims', 'Claims cited', `${claims.size}`, `across ${blocks.length} blocks`));
    const words = new Map<string, number>();
    for (const b of blocks) words.set(b.infoClass, (words.get(b.infoClass) ?? 0) + b.wordCount);
    out.push(m('classes', 'Words by information class', [...words].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'));
  }
  const evidence = refsOf(findings, EVIDENCE_KINDS);
  out.push(m('unsupported', 'Assertions without the claim behind them', `${evidence.length}`, listed(evidence)));
  const retold = refsOf(findings, ['RETOLD_CONTENT', 'RECAP_SECTION', 'CLAIM_RETOLD']);
  out.push(m('repeated', 'Repeated material (retellings, recap sections, claims explained again)', `${retold.length}`, listed(retold)));
  const passengers = refsOf(findings, ['PASSENGER_FACT']);
  out.push(m('passengers', 'Passenger candidates (for the editor to decide)', `${passengers.length}`, listed(passengers)));
  const meta = refsOf(findings, ['META_NARRATION']);
  out.push(m('meta', 'Lines about the film itself (one allowed in the opening)', `${meta.length}`, listed(meta)));
  // Writing Engine 2: measured from the text as it stands (an editor's edit updates them), beside what the narration pass found before it.
  const narration = args.content.narration;
  if (draft) {
    const blocks = narrationBlocks(draft);
    const fp = fingerprint(blocks);
    const before = narration?.diagnostics.before?.fingerprint;
    out.push(m('ai_fingerprint', 'AI-pattern score (0 = none found; a heuristic indicator, not a detector)', `${fp.score}/100`, `${before ? `${before.score}/100 before the narration pass · ` : ''}${fp.signals} signal(s)${Object.keys(fp.perPattern).length ? `: ${Object.entries(fp.perPattern).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`));
    const r = rhythmProfile(blocks);
    out.push(m('rhythm', 'Spoken rhythm', `${r.meanWords} words a sentence, spread ${r.variation}`, `${Math.round(r.fragmentShare * 100)}% fragments · longest run of fragments ${r.longestFragmentRun} · ${r.sameLengthRuns} run(s) of same-length sentences · ${r.clausesPerSentence} clauses a sentence · ${r.tongueTwisters.length} tongue-twister(s)`));
  }
  if (narration) {
    out.push(m('rubric', 'Read-aloud rubric when the version was made (telemetry; never a gate)', narration.diagnostics.after.rubric.map((x) => `${x.dimension.toLowerCase().replace(/_/g, ' ')} ${x.score}`).join(' · '), null));
    out.push(m('money_context', 'Money context', `${narration.money.used.length} added`, `${narration.money.contexts.length} comparison(s) the evidence supports · ${narration.money.gaps.length} sum(s) the evidence gives no context for`));
    const candidates = narration.names.filter((n) => n.candidate);
    out.push(m('names', 'Names', `${narration.names.length}`, candidates.length ? `pronunciation to decide: ${candidates.map((n) => n.displayName).join(', ')}` : 'every name has a confident or confirmed pronunciation note'));
  }
  const changes = args.content.reviewChanges ?? [];
  if (changes.length) {
    const count = (who: string, s: string) => changes.filter((c) => c.reviewer === who && c.status === s).length;
    const by = (who: string, label: string) => (changes.some((c) => c.reviewer === who) ? `${label} ${count(who, 'ACCEPTED')} kept / ${count(who, 'REJECTED')} rejected / ${count(who, 'SKIPPED')} skipped` : null);
    out.push(
      m(
        'review_changes',
        'Reviewer changes',
        `${changes.filter((c) => c.status === 'ACCEPTED').length} kept, ${changes.filter((c) => c.status === 'REJECTED').length} rejected, ${changes.filter((c) => c.status === 'SKIPPED').length} skipped`,
        [by('NARRATION', 'narration pass'), by('SCRIPT_EDITOR', 'script editor'), by('FACT_CHECKER', 'fact checker'), by('PERFORMANCE', 'performance timing')].filter(Boolean).join(' · '),
      ),
    );
  }
  return out;
}

/** Questions only the narration checklist asks: they say which checklist an answer sheet is, also on a restored copy (which keeps the answers, not the run that asked them). */
const NARRATION_ONLY = new Set<string>(NARRATION_CHECKLIST.filter((q) => !(REFINEMENT_CHECKLIST as readonly string[]).includes(q)));

/** What the models judged: recorded as opinions. */
function judgments(args: Parameters<typeof computeScriptReport>[0]): QualityJudgment[] {
  const { content } = args;
  const j = (id: string, label: string, source: string, value: string, detail: string | null = null): QualityJudgment => ({ id, label, source, value, detail });
  const out: QualityJudgment[] = [];
  if (content.editor) {
    const scores = SCRIPT_SCORES.flatMap((k) => (content.editor!.scores[k] ? [`${k.replace('_SCORE', '').toLowerCase().replace('_', ' ')} ${content.editor!.scores[k]!.score}`] : [])).join(', ');
    out.push(j('script_editor', "Script editor's verdict and scores", 'script editor (model)', scores || '—', content.editor.verdict));
    const a = content.editor.assessment ?? [];
    if (a.length) out.push(j('checklist', content.provenance?.origin === 'NARRATION' || a.some((x) => NARRATION_ONLY.has(x.question)) ? 'Narration checklist (first: would a listener assume a competent human writer?)' : 'Refinement checklist', 'script editor (model)', `${a.filter((x) => x.answer === 'YES').length} yes, ${a.filter((x) => x.answer === 'PARTLY').length} partly, ${a.filter((x) => x.answer === 'NO').length} no`, `${a.filter((x) => x.comparedToPrevious === 'WORSE').length} judged worse than the version before`));
  } else out.push(j('script_editor', "Script editor's verdict and scores", 'script editor (model)', 'not reviewed', args.reviewers?.editor ?? 'The script editor did not review this version'));
  if (content.narration) out.push(j('narration_pass', 'Narration pass verdict', 'narration editor (model)', content.narration.unavailable ? 'not run' : `${content.narration.counts.kept} edit(s) kept of ${content.narration.counts.proposed}`, content.narration.unavailable ?? content.narration.verdict));
  if (content.factCheck) out.push(j('fact_checker', "Fact checker's verdict", 'fact checker (model)', `${content.factCheck.issues.length} issue(s)`, content.factCheck.verdict));
  else out.push(j('fact_checker', "Fact checker's verdict", 'fact checker (model)', 'not reviewed', args.reviewers?.factCheck ?? 'The fact checker did not review this version'));
  return out;
}

/** The blocking findings as the API shows them (why approval is refused). */
export const blockingDetails = (report: QualityReport | null) => (report ? report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label}: ${c.detail}`) : []);
