import {
  STORY_LIMITS,
  StoryScores,
  historicalConfidenceOf,
  historicalStatusOf,
  runtimeFit,
  structuralDurationSec,
  type CoherenceIssue,
  type QualityCheck,
  type QualityReport,
  type RuntimeTarget,
  type StoryArchitectureContent,
} from '@docengine/core';
import { NO_REASON, describeFinding, sequenceTexts, totalDurationSec, type ArchitectureFinding, type SelectedUnit } from './architecture.ts';
import type { EvidenceBase } from './evidence.ts';
import { candidateTexts, isDuplicate, type PackCandidate, type RemovedCandidate } from './mining.ts';
import { caveatClaims, checkFigures, checkPerson } from './rules.ts';

/**
 * The automated gates run before a human sees a story pack or an
 * architecture. They re-check the evidence rules on the final result (not
 * trusting the normalization that should have enforced them) and measure
 * what the rules cannot enforce. A FAIL keeps the artifact out of review;
 * nothing is ever approved automatically.
 */

function check(id: string, label: string, status: QualityCheck['status'], detail: string, metric: number | null = null, threshold: number | null = null): QualityCheck {
  return { id, label, status, detail, metric, threshold };
}

/** PASS when nothing is listed; otherwise `failStatus` with the (first few) offenders. */
function listCheck(id: string, label: string, bad: readonly string[], ok: string, failStatus: QualityCheck['status'] = 'FAIL'): QualityCheck {
  const unique = [...new Set(bad)];
  if (unique.length === 0) return check(id, label, 'PASS', ok, 0, 0);
  return check(id, label, failStatus, `${unique.length}: ${unique.slice(0, 6).join('; ')}${unique.length > 6 ? '; …' : ''}`, unique.length, 0);
}

// ── Mining ───────────────────────────────────────────────────────────────────

export function computeMiningReport(args: {
  candidates: readonly PackCandidate[];
  evidence: EvidenceBase;
  selectionKeys: readonly string[];
  removed: readonly RemovedCandidate[];
  normalizations: readonly string[];
  limits?: typeof STORY_LIMITS;
  now?: Date;
}): QualityReport {
  const { candidates: cands, evidence } = args;
  const limits = args.limits ?? STORY_LIMITS;
  const checks: QualityCheck[] = [];
  const n = cands.length;

  const count = limits.candidates;
  checks.push(
    check(
      'candidate_count',
      'Story candidates',
      n < count.fail ? 'FAIL' : n < count.min || n > count.max ? 'WARN' : 'PASS',
      `${plural(n, 'candidate')} (expected ${count.min}–${count.max}; fewer than ${count.fail} fails)`,
      n,
      count.min,
    ),
  );

  const noEvidence = cands.filter((c) => c.claimKeys.length === 0 || c.claimKeys.some((k) => !evidence.has(k))).map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('evidence_links', 'Every candidate cites dossier claims', noEvidence, 'All candidates cite existing dossier claims'));

  const untraceable = cands.filter((c) => evidence.sourcesFor(c.claimKeys).length === 0).map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('traceable_sources', 'Every candidate traces to retrieved sources', untraceable, 'Every candidate rests on claims with verified quotes from retrieved sources'));

  const invented: string[] = [];
  for (const c of cands) {
    for (const ch of c.characters) {
      if (ch.kind !== 'NAMED_PERSON') continue;
      const p = checkPerson(ch.name, [...c.claimKeys, ...ch.claimKeys], evidence);
      if (!p.grounded || p.link.length > 0) invented.push(`${c.key}: ${ch.name}`);
    }
  }
  checks.push(listCheck('grounded_people', 'Named people appear in the cited evidence', invented, 'Every named person appears in the evidence of the claims cited'));

  const badFigures: string[] = [];
  for (const c of cands) {
    const f = checkFigures(candidateTexts(c), c.claimKeys, evidence);
    for (const x of [...f.unsupported, ...f.links.map((l) => l.figure)]) badFigures.push(`${c.key}: ${x}`);
  }
  checks.push(listCheck('supported_figures', 'Figures come from the cited evidence', badFigures, 'Every figure appears in the evidence cited (years: in the dossier)'));

  const wrongStatus = cands
    .filter((c) => {
      const verdicts = c.claimKeys.flatMap((k) => evidence.claim(k)?.verdict ?? []);
      return c.historicalStatus !== historicalStatusOf(verdicts) || c.historicalConfidence !== historicalConfidenceOf(evidence.storyClaims(c.claimKeys));
    })
    .map((c) => `${c.key} ${c.title}`);
  checks.push(
    listCheck('historical_status', 'Historical status and confidence match the evidence', wrongStatus, 'Computed from the verdicts of each candidate\'s claims: disputed and unverified material is marked'),
  );

  const untoldMyths = cands
    .filter((c) => c.claimKeys.some((k) => evidence.claim(k)?.verdict === 'MYTH'))
    .filter((c) => {
      const t = c.mythThread;
      return !t || !t.popularStory || !t.origin || !t.whoSpreadIt || !t.whatHappened || !t.whyItSurvived;
    })
    .map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('myth_framing', 'Myths are told as investigations', untoldMyths, 'Every candidate using a MYTH claim tells the popular story, its origin, who spread it, what happened and why it survived'));

  const duplicates: string[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (isDuplicate(cands[i]!, cands[j]!)) duplicates.push(`${cands[i]!.key} ≈ ${cands[j]!.key}`);
  checks.push(listCheck('no_duplicates', 'No duplicated stories', duplicates, 'No two candidates tell the same story from the same claims'));

  const unscored = cands.filter((c) => !StoryScores.safeParse(c.scores).success || !Number.isFinite(c.rankScore)).map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('scores_complete', 'Every candidate is scored', unscored, 'All component scores, appeal and rank score present'));

  const flat = cands.filter((c) => !c.hook || !c.conflict || !c.turningPoint || !c.payoff || !c.viewerQuestion).map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('narrative_structure', 'Candidates are stories, not facts', flat, 'Every candidate has a hook, conflict, turning point, payoff and viewer question'));

  const types = new Set(cands.map((c) => c.storyType)).size;
  checks.push(check('story_variety', 'Variety of story types', types >= 4 ? 'PASS' : 'WARN', `${types} story types`, types, 4));

  const strong = n === 0 ? 0 : cands.filter((c) => c.historicalConfidence >= 6).length / n;
  checks.push(check('well_supported', 'Share of well-supported candidates', strong >= 0.5 ? 'PASS' : 'WARN', `${Math.round(strong * 100)}% have historical confidence ≥ 6`, Math.round(strong * 100) / 100, 0.5));

  const keys = new Set(cands.map((c) => c.key));
  const sel = args.selectionKeys.filter((k) => keys.has(k));
  const { min, max } = limits.selection;
  checks.push(
    check('selection_proposal', 'Proposed selection', sel.length >= min && sel.length <= max && sel.length === args.selectionKeys.length ? 'PASS' : 'FAIL', `${plural(sel.length, 'unit')} proposed (expected ${min}–${max})`, sel.length, min),
  );

  checks.push(
    check(
      'removed_by_rules',
      'Candidates removed by the evidence rules or the critic',
      'PASS',
      args.removed.length === 0 ? 'None' : `${args.removed.length} removed (see normalizations)`,
      args.removed.length,
      null,
    ),
  );

  const normalizations = [...args.normalizations, ...args.removed.map((r) => `Removed "${r.title}" (${r.storyType}): ${r.reason}`)];
  return { passed: checks.every((c) => c.status !== 'FAIL'), generatedAt: (args.now ?? new Date()).toISOString(), checks, normalizations, coherenceIssues: [] };
}

// ── Architecture ─────────────────────────────────────────────────────────────

export function computeArchitectureReport(args: {
  content: StoryArchitectureContent;
  evidence: EvidenceBase;
  units: readonly SelectedUnit[];
  findings: readonly ArchitectureFinding[];
  issues: readonly CoherenceIssue[];
  normalizations: readonly string[];
  target: RuntimeTarget;
  now?: Date;
}): QualityReport {
  const { content, evidence } = args;
  const seqs = content.sequences;
  const checks: QualityCheck[] = [];
  // Everything is re-checked on the content itself; only a dropped (invented) person no longer shows there.
  const invented = args.findings.filter((f) => f.kind === 'UNGROUNDED_PERSON').map(describeFinding);

  const q = content.centralQuestion;
  checks.push(check('central_question', 'Central question', !q ? 'FAIL' : q.includes('?') ? 'PASS' : 'WARN', q || 'Missing'));
  checks.push(
    check(
      'premise_and_spine',
      'Premise, spine and resolution',
      !content.premise || !content.narrativeSpine ? 'FAIL' : !content.resolution ? 'WARN' : 'PASS',
      !content.premise || !content.narrativeSpine ? 'The premise or narrative spine is missing' : !content.resolution ? 'No resolution of the central question' : 'Present',
    ),
  );
  checks.push(check('sequences', 'Sequences', seqs.length < 3 ? 'FAIL' : seqs.length > 12 ? 'WARN' : 'PASS', `${seqs.length} sequences`, seqs.length, 3));

  const noEvidence = seqs.flatMap((s) => [
    ...(s.claimKeys.length === 0 ? [`Sequence ${s.number}: cites no dossier claim`] : []),
    ...s.claimKeys.filter((k) => !evidence.has(k)).map((k) => `Sequence ${s.number}: unknown claim ${k}`),
    ...s.keyEvents.filter((e) => e.claimKeys.length === 0).map((e) => `Sequence ${s.number}: the event "${e.event}" cites no claim`),
  ]);
  checks.push(listCheck('evidence', 'Every sequence and key event cites claims', noEvidence, 'Every sequence and key event cites dossier claims'));

  const untraceable = seqs.flatMap((s) => {
    const allowed = new Set(evidence.sourcesFor(s.claimKeys));
    if (s.claimKeys.length > 0 && allowed.size === 0) return [`Sequence ${s.number}: no retrieved source backs its claims`];
    return s.sourceIds.some((id) => !allowed.has(id)) ? [`Sequence ${s.number}: a listed source is not cited by its claims`] : [];
  });
  checks.push(listCheck('traceable_sources', 'Sources trace to the claims used', untraceable, 'Every sequence lists the retrieved sources behind its claims'));

  const unitIds = new Set(args.units.map((u) => u.id));
  const foreign = seqs.filter((s) => s.candidateIds.some((id) => !unitIds.has(id))).map((s) => `Sequence ${s.number}`);
  const unitless = seqs.filter((s) => s.candidateIds.length === 0).map((s) => `Sequence ${s.number}`);
  checks.push(
    check(
      'selected_units',
      'Built from the selected units',
      foreign.length ? 'FAIL' : unitless.length ? 'WARN' : 'PASS',
      foreign.length ? `Uses units outside the selection: ${foreign.join(', ')}` : unitless.length ? `No story unit in: ${unitless.join(', ')}` : 'Every sequence tells selected story units',
      foreign.length + unitless.length,
      0,
    ),
  );
  const usedIds = new Set(seqs.flatMap((s) => s.candidateIds));
  const unused = args.units.filter((u) => !usedIds.has(u.id));
  const reasons = new Map(content.unusedCandidates.map((u) => [u.candidateKey, u.reason]));
  checks.push(listCheck('editor_priorities', 'HIGH-priority units are used', unused.filter((u) => u.priority === 'HIGH').map((u) => `${u.key} ${u.title}`), 'Every HIGH-priority unit is in a sequence'));
  checks.push(
    listCheck(
      'unused_units',
      'Unused units are explained',
      unused.filter((u) => u.priority !== 'HIGH' && (!reasons.get(u.key) || reasons.get(u.key) === NO_REASON)).map((u) => `${u.key} ${u.title}`),
      'Every selected unit is used or its omission explained',
      'WARN',
    ),
  );

  const uncaveated = seqs.flatMap((s) =>
    caveatClaims(s.claimKeys, evidence)
      .filter((k) => !s.caveats.some((c) => c.claimKey === k && c.framing))
      .map((k) => `Sequence ${s.number}: ${k} (${evidence.claim(k)!.verdict}) has no caveat`),
  );
  checks.push(
    listCheck('uncertainty_framed', 'Disputed, unverified and myth material is framed', uncaveated, 'Every disputed, unverified or myth claim used says how the narration must present it'),
  );

  checks.push(listCheck('grounded_people', 'No invented people', invented, 'Every person is in the story units or the evidence'));

  const figures = seqs.flatMap((s) => {
    const f = checkFigures(sequenceTexts(s), s.claimKeys, evidence);
    return [...f.unsupported.map((x) => `Sequence ${s.number}: ${x} is not in the dossier`), ...f.links.map((l) => `Sequence ${s.number}: ${l.figure} is not in its claims`)];
  });
  checks.push(listCheck('supported_figures', 'Figures come from the evidence', figures, 'Every figure appears in the evidence cited (years: in the dossier)'));

  const flat = seqs.filter((s) => !s.narrativeQuestion || !s.endingBeat || s.keyEvents.length < 2 || !(s.conflict || s.escalation || s.reveal)).map((s) => `Sequence ${s.number}`);
  checks.push(
    check(
      'story_structure',
      'Sequences are story, not a list of facts',
      flat.length > seqs.length / 3 ? 'FAIL' : flat.length ? 'WARN' : 'PASS',
      flat.length ? `Missing a narrative question, ending beat, conflict/escalation/reveal or at least two key events: ${flat.join(', ')}` : 'Every sequence has a question, events, tension and an ending beat',
      flat.length,
      0,
    ),
  );

  const total = totalDurationSec(content);
  const fit = runtimeFit(total, args.target);
  checks.push(
    check(
      'runtime',
      'Estimated runtime',
      fit === 'WITHIN' ? 'PASS' : fit === 'NEAR' ? 'WARN' : 'FAIL',
      `${fmtMinutes(total)} estimated (target ${fmtMinutes(args.target.minSec)}–${fmtMinutes(args.target.maxSec)})`,
      total,
      args.target.targetSec,
    ),
  );

  const inconsistent = seqs
    .filter((s) => {
      const structural = structuralDurationSec(s);
      const ratio = s.estimatedDurationSec / structural;
      return ratio < 0.5 || ratio > 2;
    })
    .map((s) => `Sequence ${s.number}: ${s.estimatedDurationSec}s for ${s.keyEvents.length} events (structure suggests ~${structuralDurationSec(s)}s)`);
  checks.push(listCheck('duration_consistency', 'Sequence durations fit their content', inconsistent, 'Each estimate is within half to double what its structure suggests', 'WARN'));

  const shaky = seqs.filter((s) => s.historicalConfidence < 4).map((s) => `Sequence ${s.number} (${s.historicalConfidence}/10, ${s.historicalStatus})`);
  checks.push(listCheck('historical_confidence', 'Historical confidence', shaky, 'Every sequence has historical confidence of at least 4/10', 'WARN'));

  const open = args.issues.filter((i) => !i.resolution.startsWith('Fixed'));
  const critical = open.filter((i) => i.severity === 'CRITICAL').length;
  const major = open.filter((i) => i.severity === 'MAJOR').length;
  checks.push(
    check(
      'review',
      'Editorial review',
      critical > 0 ? 'FAIL' : major > 0 ? 'WARN' : 'PASS',
      `${args.issues.length} issues found; ${critical} critical and ${major} major left for human review`,
      critical,
      0,
    ),
  );

  return { passed: checks.every((c) => c.status !== 'FAIL'), generatedAt: (args.now ?? new Date()).toISOString(), checks, normalizations: [...args.normalizations], coherenceIssues: [...args.issues] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
