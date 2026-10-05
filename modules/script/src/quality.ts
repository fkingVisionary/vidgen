import { SCRIPT_SCORES, fmtClock, fmtVariance, type CoherenceIssue, type QualityCheck, type QualityReport, type ScriptContent, type ScriptTiming } from '@docengine/core';
import { SCRIPT_BLOCKING, type ScriptFinding, type ScriptFindingKind } from './rules.ts';

/**
 * The script's quality gate: the rule findings grouped into checks. A FAIL
 * blocks approval of the version (the editor can fix it by editing, or
 * rewrite the section); WARNs are for the editor. The reviewers' verdicts are
 * recorded beside the checks; the script editor's never fails the gate.
 */

const GROUPS: { id: string; label: string; kinds: ScriptFindingKind[] }[] = [
  { id: 'evidence', label: 'Every fact traces to the approved architecture', kinds: ['CLAIM_OUTSIDE_ARCHITECTURE', 'NOT_IN_ARCHITECTURE', 'BLOCK_WITHOUT_EVIDENCE'] },
  { id: 'figures_names', label: 'Figures, dates and names come from the evidence', kinds: ['UNSUPPORTED_FIGURE', 'PERSON_OUTSIDE_ARCHITECTURE', 'UNKNOWN_NAME'] },
  { id: 'information_classes', label: 'Information classes are preserved', kinds: ['CLASS_MISMATCH', 'DOCUMENTED_NOT_ESTABLISHED', 'FRAMING_WITH_FACTS', 'FICTION_NOT_ALLOWED'] },
  { id: 'uncertainty', label: 'Uncertain history is worded as uncertain', kinds: ['MYTH_AS_FACT', 'DISPUTED_AS_FACT', 'UNVERIFIED_AS_FACT', 'PROBABLE_UNHEDGED'] },
  { id: 'fiction_boundary', label: 'Fiction stays fiction', kinds: ['FICTION_IN_DOCUMENTED', 'FICTION_REAL_INTERACTION', 'FICTION_DOCUMENTED_ACT', 'FICTION_WITH_FACTS'] },
  { id: 'speech', label: 'Real people speak only in recorded quotations', kinds: ['UNDECLARED_SPEAKER', 'REAL_PERSON_INVENTED_SPEECH', 'FICTIONAL_RECORDED_QUOTE', 'UNVERIFIED_RECORDED_QUOTE', 'FABRICATED_QUOTE'] },
  { id: 'structure', label: 'The architecture is told in full and its question answered', kinds: ['SEQUENCE_MISSING', 'CENTRAL_QUESTION_NOT_POSED', 'CENTRAL_QUESTION_ABANDONED'] },
  { id: 'fact_check', label: "The fact checker's critical issues are fixed", kinds: ['OPEN_CRITICAL_FACT_ISSUE'] },
  { id: 'story_shape', label: 'A story, not a lecture', kinds: ['CONSECUTIVE_FACTS', 'EXPOSITION_HEAVY', 'LOW_HUMAN_PRESENCE', 'QUESTION_POSED_LATE', 'BEAT_FROM_OTHER_SEQUENCE'] },
  { id: 'reconstruction_budget', label: 'Reconstruction and fiction within budget', kinds: ['RECONSTRUCTION_BUDGET'] },
  { id: 'real_people', label: 'Real people are not given invented thoughts', kinds: ['REAL_INTERIORITY'] },
  {
    id: 'spoken_language',
    label: 'Written for the ear',
    kinds: ['LONG_SENTENCES', 'LONG_BLOCK', 'LONG_UNBROKEN_NARRATION', 'REPETITIVE_OPENINGS', 'REPEATED_PHRASES', 'AI_PHRASES', 'RHETORICAL_QUESTIONS', 'FORMULAIC_TRANSITIONS', 'UNSPOKEN_SYMBOLS'],
  },
  { id: 'performance', label: 'Pauses and emphasis with restraint', kinds: ['PAUSE_OVERUSE', 'EMPHASIS_OVERUSE'] },
  { id: 'runtime_balance', label: 'Sections near their planned length', kinds: ['RUNTIME_BALANCE'] },
  { id: 'pronunciation', label: 'Pronunciations confirmed', kinds: ['PRONUNCIATION_REVIEW', 'NAME_WITHOUT_PRONUNCIATION'] },
  { id: 'visual_handoff', label: 'Visual details carry their evidence', kinds: ['VISUAL_WITHOUT_EVIDENCE'] },
];

const summarise = (fs: readonly ScriptFinding[], max = 6) => fs.slice(0, max).map((f) => f.detail).join('; ') + (fs.length > max ? `; (+${fs.length - max} more)` : '');

export function computeScriptReport(args: {
  findings: readonly ScriptFinding[];
  timing: ScriptTiming;
  content: Pick<ScriptContent, 'editor' | 'factCheck'>;
  notes: readonly string[];
  reviewers?: { editor: string | null; factCheck: string | null };
}): QualityReport {
  const { findings, timing, content } = args;
  const checks: QualityCheck[] = [];
  for (const g of GROUPS) {
    const fs = findings.filter((f) => g.kinds.includes(f.kind));
    const blocking = g.kinds.some((k) => SCRIPT_BLOCKING.includes(k));
    checks.push({ id: g.id, label: g.label, status: fs.length === 0 ? 'PASS' : blocking ? 'FAIL' : 'WARN', detail: fs.length ? summarise(fs) : 'No findings', metric: fs.length, threshold: 0 });
  }
  // Runtime, with its numbers.
  const off = findings.some((f) => f.kind === 'RUNTIME_OFF');
  const near = findings.some((f) => f.kind === 'RUNTIME_NEAR');
  checks.splice(8, 0, {
    id: 'runtime',
    label: 'Estimated voice runtime',
    status: off ? 'FAIL' : near ? 'WARN' : 'PASS',
    detail: `Target ${fmtClock(timing.targetSec)} (${fmtClock(timing.minSec)}–${fmtClock(timing.maxSec)}) · script ${fmtClock(timing.totalSec)} · variance ${fmtVariance(timing.varianceSec)} · ${timing.words} words`,
    metric: timing.totalSec,
    threshold: timing.targetSec,
  });
  // The reviewers, recorded.
  const scores = content.editor ? SCRIPT_SCORES.flatMap((k) => (content.editor!.scores[k] ? [`${k.replace('_SCORE', '').toLowerCase().replace('_', ' ')} ${content.editor!.scores[k]!.score}`] : [])).join(', ') : '';
  checks.push({
    id: 'script_editor',
    label: 'Script editor (craft; recorded, never blocking)',
    status: content.editor ? 'PASS' : 'WARN',
    detail: content.editor ? `${content.editor.verdict}${scores ? ` — ${scores}` : ''}` : (args.reviewers?.editor ?? 'The script editor did not review this version'),
    metric: null,
    threshold: null,
  });
  checks.push({
    id: 'fact_checker',
    label: 'Fact checker',
    status: content.factCheck ? 'PASS' : 'WARN',
    detail: content.factCheck ? `${content.factCheck.verdict} (${content.factCheck.issues.length} issue(s))` : (args.reviewers?.factCheck ?? 'The fact checker did not review this version'),
    metric: content.factCheck?.issues.length ?? null,
    threshold: null,
  });
  const coherenceIssues: CoherenceIssue[] = [...(content.factCheck?.issues ?? []), ...(content.editor?.issues ?? [])].map((i) => ({
    severity: i.severity,
    description: `${i.ref ? `${i.ref}: ` : ''}[${i.kind}] ${i.note}`,
    claimKeys: [],
    resolution: i.resolution,
  }));
  return { passed: checks.every((c) => c.status !== 'FAIL'), generatedAt: new Date().toISOString(), checks, normalizations: [...args.notes], coherenceIssues };
}

/** The blocking findings as the API shows them (why approval is refused). */
export const blockingDetails = (report: QualityReport | null) => (report ? report.checks.filter((c) => c.status === 'FAIL').map((c) => `${c.label}: ${c.detail}`) : []);
