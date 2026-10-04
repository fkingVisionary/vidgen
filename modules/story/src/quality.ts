import {
  STORY_LIMITS,
  StoryScoresV2,
  historicalConfidenceOf,
  historicalStatusOf,
  runtimeFit,
  structuralDurationSecV2,
  type CoherenceIssue,
  type QualityCheck,
  type QualityReport,
  type RuntimeTarget,
  type StoryArchitectureContentV2,
} from '@docengine/core';
import { NO_REASON, describeFinding, totalDurationSec, type ArchitectureFinding, type FindingKind, type SelectedUnit } from './architecture.ts';
import type { EvidenceBase } from './evidence.ts';
import { NOT_SCORED, candidateTexts, isDuplicate, type PackCandidate, type RemovedCandidate } from './mining.ts';
import { SECOND_PERSON, checkFigures, checkPerson } from './rules.ts';

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

  const unscored = cands.filter((c) => !StoryScoresV2.safeParse(c.scores).success || !Number.isFinite(c.rankScore)).map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('scores_complete', 'Every candidate is scored', unscored, 'Story value, historical value and story appeal present for every candidate'));

  if (cands.some((c) => c.carriedFrom)) {
    const notScored = cands.filter((c) => c.scores.rationale === NOT_SCORED).map((c) => `${c.key} ${c.title}`);
    checks.push(listCheck('carried_scored', 'Carried candidates are scored', notScored, 'Every candidate carried from an earlier pack was scored on this pass', 'WARN'));
  }

  // A second-person or reconstructed opening is never documented fact, and documented fact rests on ESTABLISHED claims only.
  const mislabelled = cands
    .filter((c) => c.storyDesign.coldOpen.basis === 'DOCUMENTED' && (SECOND_PERSON.test(c.storyDesign.coldOpen.text) || c.claimKeys.some((k) => evidence.claim(k)?.verdict !== 'ESTABLISHED')))
    .map((c) => `${c.key} ${c.title}`);
  checks.push(listCheck('cold_open_labelled', 'Cold opens are labelled honestly', mislabelled, 'No cold open presents a reconstruction or uncertain material as documented fact'));

  const human = n === 0 ? 0 : cands.filter((c) => c.storyDesign.humanStory).length / n;
  const selectedWithout = cands.filter((c) => args.selectionKeys.includes(c.key) && !c.storyDesign.humanStory).map((c) => `${c.key} ${c.title}`);
  checks.push(
    check(
      'human_stories',
      'Candidates have a human story',
      human >= 0.5 && selectedWithout.length === 0 ? 'PASS' : 'WARN',
      `${Math.round(human * 100)}% have a protagonist with something at stake` + (selectedWithout.length ? `; proposed without one: ${selectedWithout.join('; ')}` : ''),
      Math.round(human * 100) / 100,
      0.5,
    ),
  );

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

/** The story editor's verdict, recorded on the report (it never fails the gate: the human decides). */
export interface StoryEditorVerdict {
  scores: Record<string, number>;
  qualityBar: { storyWithoutCitations: { pass: boolean; why: string }; compellingDocumentary: { pass: boolean; why: string }; truthAndExperience: { pass: boolean; why: string } };
}

const QUALITY_BAR_LABELS: Record<keyof StoryEditorVerdict['qualityBar'], string> = {
  storyWithoutCitations: 'a story without the citations',
  compellingDocumentary: 'a compelling documentary',
  truthAndExperience: 'truth and experience together',
};

/**
 * The Story Engine 2.0 architecture gate. The evidence rules ran on the final
 * architecture (buildArchitecture); their findings are grouped into checks
 * here, alongside what only the whole can show (structure, runtime, review).
 * Blocking findings FAIL; the warnings (fiction budget, continuity threads,
 * interiority, exposition) and the story editor's verdict never do.
 */
export function computeArchitectureReport(args: {
  content: StoryArchitectureContentV2;
  evidence: EvidenceBase;
  units: readonly SelectedUnit[];
  findings: readonly ArchitectureFinding[];
  issues: readonly CoherenceIssue[];
  normalizations: readonly string[];
  target: RuntimeTarget;
  storyEditor?: StoryEditorVerdict | { unavailable: string } | null;
  now?: Date;
}): QualityReport {
  const { content, evidence } = args;
  const seqs = content.sequences;
  const checks: QualityCheck[] = [];
  const of = (...kinds: FindingKind[]) => args.findings.filter((f) => kinds.includes(f.kind)).map(describeFinding);

  const q = content.centralQuestion;
  checks.push(check('central_question', 'Central question', !q ? 'FAIL' : q.includes('?') ? 'PASS' : 'WARN', q || 'Missing'));
  const missingTop = [!content.logline && 'logline', !content.centralHumanStakes && 'central human stakes', !content.thesis && 'thesis'].filter((x): x is string => !!x);
  checks.push(check('logline_and_stakes', 'Logline, human stakes and thesis', missingTop.length ? 'FAIL' : !content.resolution || !content.narrativeSpine ? 'WARN' : 'PASS', missingTop.length ? `Missing: ${missingTop.join(', ')}` : !content.resolution || !content.narrativeSpine ? 'No narrative spine or resolution' : content.logline));
  checks.push(
    check(
      'narrative_mode_and_pov',
      'Narrative mode and POV strategy',
      content.povStrategy.type !== 'NARRATOR' && !content.povStrategy.description ? 'WARN' : 'PASS',
      `${content.narrativeMode}${content.secondaryModes.length ? ` (+ ${content.secondaryModes.join(', ')})` : ''}; POV ${content.povStrategy.type}${content.povStrategy.description ? `: ${content.povStrategy.description}` : ' (not described)'}`,
    ),
  );
  checks.push(check('sequences', 'Sequences', seqs.length < 3 ? 'FAIL' : seqs.length > 12 ? 'WARN' : 'PASS', `${seqs.length} sequences`, seqs.length, 3));

  const DRAMA = new Set(['STAKES', 'CONFLICT', 'ESCALATION', 'TURN', 'REVEAL', 'INVESTIGATION']);
  const flat = seqs.filter((s) => !s.openingHook || !s.question || !s.endingBeat || s.beats.length < 2 || !s.beats.some((b) => DRAMA.has(b.function))).map((s) => `Sequence ${s.number}`);
  checks.push(
    check(
      'story_structure',
      'Sequences are scenes, not headings',
      flat.length > seqs.length / 3 ? 'FAIL' : flat.length ? 'WARN' : 'PASS',
      flat.length ? `Missing an opening hook, question, ending beat, two beats or a dramatic beat (stakes, conflict, escalation, turn, reveal, investigation): ${flat.join(', ')}` : 'Every sequence opens on a hook, asks a question, turns and ends on a beat',
      flat.length,
      0,
    ),
  );

  checks.push(listCheck('information_classes', 'Every beat is labelled and grounded', of('BEAT_WITHOUT_EVIDENCE', 'DOCUMENTED_NOT_ESTABLISHED', 'UNKNOWN_CLAIM'), 'Documented beats rest on ESTABLISHED claims; reconstructions and uncertain history cite their claims; every claim exists in the approved dossier'));

  const unitIds = new Set(args.units.map((u) => u.id));
  const foreign = seqs.filter((s) => s.candidateIds.some((id) => !unitIds.has(id))).map((s) => `Sequence ${s.number}: uses units outside the selection`);
  checks.push(listCheck('selected_units', 'Built from the selected units', [...foreign, ...of('NO_UNIT')], 'Every sequence tells selected story units, and only those'));
  checks.push(listCheck('core_evidence', 'Story evidence is the selected units\' own claims', of('CORE_OUTSIDE_SELECTION', 'BEAT_OUTSIDE_SELECTION', 'NO_EVIDENCE'), 'Every sequence and beat rests only on claims of the selected units (background only orients)'));

  const heavy = seqs.filter((s) => s.contextClaims.length > s.claimKeys.length).map((s) => `Sequence ${s.number}: ${s.contextClaims.length} context claims against ${s.claimKeys.length} story claims`);
  const badContext = of('CONTEXT_WITHOUT_PURPOSE');
  checks.push(
    badContext.length
      ? listCheck('context_claims', 'Other dossier claims are labelled background', badContext, '')
      : listCheck('context_claims', 'Other dossier claims are labelled background', heavy, 'Every other dossier claim used is labelled background with its purpose, and never outweighs the story evidence', 'WARN'),
  );

  const untraceable = seqs.flatMap((s) => {
    const allowed = new Set(evidence.sourcesFor(s.claimKeys));
    const allowedContext = new Set(evidence.sourcesFor(s.contextClaims.map((c) => c.claimKey)));
    return [
      ...(s.sourceIds.some((id) => !allowed.has(id)) ? [`Sequence ${s.number}: a listed source is not cited by its story evidence`] : []),
      ...(s.contextSourceIds.some((id) => !allowedContext.has(id)) ? [`Sequence ${s.number}: a listed context source is not cited by its context claims`] : []),
    ];
  });
  checks.push(listCheck('traceable_sources', 'Sources trace to the claims used', [...of('NO_SOURCES'), ...untraceable], 'Every sequence lists the retrieved sources behind its story evidence and its context claims'));

  checks.push(listCheck('presentation', 'Uncertain history keeps its status', of('MISSING_PRESENTATION', 'WRONG_PRESENTATION', 'WEAK_HEDGE', 'MYTH_NOT_INVESTIGATED'), 'Every probable claim is hedged, every disputed one told as a dispute, every unverified one as unconfirmed, every myth as an investigation'));
  checks.push(listCheck('fiction_labelled', 'Fictional devices are declared', of('UNDECLARED_CHARACTER', 'UNKNOWN_NAME', 'FICTION_NAME_COLLISION', 'COMPOSITE_WITHOUT_BASIS'), 'Every character is declared in the cast; fictional ones are justified and named unlike anyone in the record; no unknown names or places'));
  checks.push(listCheck('fiction_limits', 'Fictional devices are few', of('TOO_MANY_FICTIONAL'), 'At most one POV and two composites', 'WARN'));
  checks.push(listCheck('fiction_boundary', 'Fiction stays out of the record', of('FICTION_IN_DOCUMENTED_BEAT', 'FICTION_REAL_INTERACTION', 'INVENTED_SPEECH_REAL_PERSON'), 'Fictional characters never act in documented events or interact with real people; real people get no invented words'));
  checks.push(listCheck('real_interiority', 'No invented inner life for real people', of('POSSIBLE_REAL_INTERIORITY'), 'No real person is given thoughts or feelings no source records', 'WARN'));
  checks.push(listCheck('quotations', 'Quotations are verified', of('FICTIONAL_RECORDED_QUOTE', 'UNVERIFIED_QUOTE', 'UNVERIFIED_QUOTATION'), 'Every recorded quotation is verified in the evidence; invented lines belong to fictional characters only'));
  checks.push(listCheck('grounded_people', 'No invented or outside people', of('UNGROUNDED_PERSON', 'CAST_WITHOUT_EVIDENCE', 'PERSON_OUTSIDE_SELECTION'), 'Every real person, group and role is in the selected units or their evidence'));
  checks.push(listCheck('supported_figures', 'Figures and dates come from the evidence', of('UNSUPPORTED_FIGURE'), 'Every figure and date — in beats, speech, setting and visuals — is in the selected units\' evidence'));
  checks.push(listCheck('setting_and_visuals', 'Setting and visual details are honest', of('SETTING_NOT_IN_EVIDENCE', 'VISUAL_DETAIL_WITHOUT_EVIDENCE'), 'Documented places and times are in the evidence; historical details that must appear cite their claims'));

  checks.push(listCheck('central_question_answered', 'The central question is answered', of('CENTRAL_QUESTION_UNANSWERED'), 'A sequence resolves the central question (Q0)'));
  checks.push(listCheck('continuity', 'One continuous story', of('CONTINUITY_BREAK', 'UNRESOLVED_THREAD', 'UNKNOWN_THREAD', 'CHRONOLOGY_UNMARKED', 'MISSING_TRANSITION'), 'Objects, questions and time carry from sequence to sequence; every sequence hands on to the next', 'WARN'));

  const r = content.reconstruction;
  const budget = of('RECONSTRUCTION_BUDGET');
  checks.push(
    check(
      'reconstruction_budget',
      'Creative reconstruction level',
      budget.length ? 'WARN' : 'PASS',
      `${r.level}: ${Math.round(r.shares.DOCUMENTED * 100)}% documented, ${Math.round(r.shares.UNCERTAIN * 100)}% uncertain, ${Math.round(r.shares.RECONSTRUCTION * 100)}% reconstruction, ${Math.round(r.shares.FICTION * 100)}% fiction of ${r.beats} beats${budget.length ? ` — ${budget.join('; ')}` : ''}`,
      Math.round((r.shares.RECONSTRUCTION + r.shares.FICTION) * 100) / 100,
      0.4,
    ),
  );
  checks.push(listCheck('human_anchor', 'Every sequence has a human anchor', of('NO_HUMAN_ANCHOR'), 'Someone the viewer follows is present in every sequence', 'WARN'));
  checks.push(listCheck('exposition', 'Scenes, not explanation', of('EXPOSITION_HEAVY', 'BEAT_TOO_LONG'), 'Orientation is kept to what each scene needs; beats describe drama, not narration', 'WARN'));

  checks.push(listCheck('editor_priorities', 'HIGH-priority units are used', of('HIGH_PRIORITY_UNUSED'), 'Every HIGH-priority unit is in a sequence'));
  const used = new Set(seqs.flatMap((s) => s.candidateIds));
  const reasons = new Map(content.unusedCandidates.map((u) => [u.candidateKey, u.reason]));
  checks.push(
    listCheck(
      'unused_units',
      'Unused units are explained',
      args.units.filter((u) => !used.has(u.id) && u.priority !== 'HIGH' && (!reasons.get(u.key) || reasons.get(u.key) === NO_REASON)).map((u) => `${u.key} ${u.title}`),
      'Every selected unit is used or its omission explained',
      'WARN',
    ),
  );
  checks.push(listCheck('editor_order', 'The editor\'s order is kept or explained', of('ORDER_CHANGED_WITHOUT_REASON'), content.orderNote ? `Order changed: ${content.orderNote}` : 'Follows the editor\'s order where one was set', 'WARN'));

  const total = totalDurationSec(content);
  const fit = runtimeFit(total, args.target);
  checks.push(
    check('runtime', 'Estimated runtime', fit === 'WITHIN' ? 'PASS' : fit === 'NEAR' ? 'WARN' : 'FAIL', `${fmtMinutes(total)} estimated (target ${fmtMinutes(args.target.minSec)}–${fmtMinutes(args.target.maxSec)})`, total, args.target.targetSec),
  );
  const inconsistent = seqs
    .filter((s) => {
      const structural = structuralDurationSecV2(s);
      const ratio = structural === 0 ? 0 : s.estimatedDurationSec / structural;
      return ratio < 0.5 || ratio > 2;
    })
    .map((s) => `Sequence ${s.number}: ${s.estimatedDurationSec}s for ${s.beats.length} beats (structure suggests ~${structuralDurationSecV2(s)}s)`);
  checks.push(listCheck('duration_consistency', 'Sequence durations fit their content', inconsistent, 'Each estimate is within half to double what its beats suggest', 'WARN'));
  const shaky = seqs.filter((s) => s.historicalConfidence < 4).map((s) => `Sequence ${s.number} (${s.historicalConfidence}/10, ${s.historicalStatus})`);
  checks.push(listCheck('historical_confidence', 'Historical confidence', shaky, 'Every sequence has historical confidence of at least 4/10', 'WARN'));

  const editor = args.storyEditor;
  if (editor && 'unavailable' in editor) {
    checks.push(check('story_review', 'Story editor', 'WARN', `Story review unavailable: ${editor.unavailable}`));
  } else if (editor) {
    const failedBar = (Object.keys(QUALITY_BAR_LABELS) as (keyof StoryEditorVerdict['qualityBar'])[]).filter((k) => !editor.qualityBar[k].pass);
    const scores = Object.entries(editor.scores).map(([k, v]) => `${k} ${v}/10`).join(', ');
    checks.push(
      check(
        'story_review',
        'Story editor: is it a story?',
        failedBar.length ? 'WARN' : 'PASS',
        failedBar.length
          ? `Not yet ${failedBar.map((k) => `${QUALITY_BAR_LABELS[k]} (${editor.qualityBar[k].why})`).join('; ')}. Scores: ${scores}`
          : `Passes the quality bar: ${(Object.keys(QUALITY_BAR_LABELS) as (keyof StoryEditorVerdict['qualityBar'])[]).map((k) => editor.qualityBar[k].why).join(' ')} Scores: ${scores}`,
        failedBar.length,
        0,
      ),
    );
  }

  const open = args.issues.filter((i) => !i.resolution.startsWith('Fixed'));
  const critical = open.filter((i) => i.severity === 'CRITICAL').length;
  const major = open.filter((i) => i.severity === 'MAJOR').length;
  checks.push(check('review', 'Editorial review', critical > 0 ? 'FAIL' : major > 0 ? 'WARN' : 'PASS', `${args.issues.length} issues found; ${critical} critical and ${major} major left for human review`, critical, 0));

  return { passed: checks.every((c) => c.status !== 'FAIL'), generatedAt: (args.now ?? new Date()).toISOString(), checks, normalizations: [...args.normalizations], coherenceIssues: [...args.issues] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
