import {
  ARCHIVAL_PREFERENCE_LABELS,
  ARCHIVAL_PREFERENCES,
  ASPECT_RATIOS,
  BEAT_FUNCTION_LABELS,
  CAMERA_STYLE_LABELS,
  CAMERA_STYLES,
  CLAIM_VERDICT_LABELS,
  DEPICTION_LABELS,
  FILM_GRAIN_LABELS,
  FILM_GRAINS,
  GRAPHICS_PREFERENCE_LABELS,
  GRAPHICS_PREFERENCES,
  INFORMATION_CLASS_LABELS,
  MOTION_INTENSITIES,
  MOTION_INTENSITY_LABELS,
  PRICE_CONFIDENCE_LABELS,
  PRODUCTION_METHOD_LABELS,
  PRODUCTION_METHODS,
  SCRIPT_BLOCK_CLASS_LABELS,
  SHOT_CLAIM_ROLE_LABELS,
  SIDE_JOBS,
  STATUS_LABELS,
  STORYBOARD_DECISION_LABELS,
  STORYBOARD_ORIGIN_LABELS,
  STORYBOARD_STATUS_LABELS,
  VISUAL_APPROACH_LABELS,
  VISUAL_APPROACHES,
  VISUAL_DENSITIES,
  VISUAL_DENSITY_LABELS,
  VISUAL_PROFILE_ORIGIN_LABELS,
  VISUAL_REALISM_LABELS,
  VISUAL_REALISMS,
  VISUAL_RESOLUTIONS,
  VISUAL_TREATMENT_LABELS,
  VISUAL_TREATMENTS,
  VOICE_RUN_KIND_LABELS,
  type ContinuitySpec,
  type CostBucket,
  type CutPointView,
  type DetailBasis,
  type JobType,
  type LabelTone,
  type ProductionMethod,
  type ProjectDetailView,
  type ProjectStatus,
  type RhythmStats,
  type ScriptBlockClass,
  type ShotPatch,
  type ShotSpec,
  type ShotSpecific,
  type ShotSubjectDetail,
  type ShotView,
  type StoryboardAssemblyOptionView,
  type StoryboardDecisionView,
  type StoryboardInputsView,
  type StoryboardQaFinding,
  type StoryboardSummaryView,
  type StoryboardVersionView,
  type TimingRelation,
  type VersionChanges,
  type VisualConfigOverrides,
  type VisualConfigProvenance,
  type VisualCostBasis,
  type VisualCostEstimate,
  type VisualPricingSnapshot,
  type VisualProfileOrigin,
  type VisualStyleProfileConfig,
  type VisualTreatment,
} from '@docengine/core';
import { formatLength } from './format.ts';

/**
 * The Storyboard page's arithmetic, kept out of the components: the
 * timeline's lanes on the narration clock, the dashboard's colours for
 * core's semantic tones, how a forecast reads (always an estimate; an
 * unpriced shot is never $0), how a shot relates to its words, the "why is
 * this visual here?" chain, what an edit form sends, and how a visual
 * profile's settings and overrides read.
 */

// ── Tones ────────────────────────────────────────────────────────────────────

/** A pill in a tone. */
export const TONE_PILL: Record<LabelTone, string> = {
  NEUTRAL: 'bg-stone-100 text-stone-700',
  INFO: 'bg-sky-100 text-sky-800',
  PENDING: 'bg-violet-100 text-violet-800',
  SUCCESS: 'bg-emerald-100 text-emerald-800',
  WARNING: 'bg-amber-100 text-amber-900',
  DANGER: 'bg-red-100 text-red-800',
};

/** A box on a timeline lane in a tone (with a border, so neighbours stay apart). */
export const TONE_BAR: Record<LabelTone, string> = {
  NEUTRAL: 'border-stone-400 bg-stone-200 text-stone-900',
  INFO: 'border-sky-500 bg-sky-200 text-sky-950',
  PENDING: 'border-violet-500 bg-violet-200 text-violet-950',
  SUCCESS: 'border-emerald-600 bg-emerald-200 text-emerald-950',
  WARNING: 'border-amber-500 bg-amber-200 text-amber-950',
  DANGER: 'border-red-500 bg-red-200 text-red-950',
};

/** Information classes on the class lane (the script page's colours). */
export const CLASS_BAR: Record<ScriptBlockClass, string> = {
  DOCUMENTED: 'border-emerald-700 bg-emerald-600 text-white',
  RECONSTRUCTION: 'border-sky-700 bg-sky-600 text-white',
  UNCERTAIN: 'border-amber-500 bg-amber-300 text-amber-950',
  FICTION: 'border-fuchsia-800 border-dashed bg-fuchsia-700 text-white',
  FRAMING: 'border-stone-400 bg-stone-200 text-stone-800',
};

// ── Times ────────────────────────────────────────────────────────────────────

/** "1:04.2" on the narration clock. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export const rangeText = (startMs: number, endMs: number) => `${clock(startMs)}–${clock(endMs)}`;
export const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** "1.1–1.10" (a single block reads as itself; none as "none"). */
export function blockRange(keys: readonly string[]): string {
  if (!keys.length) return 'none';
  return keys.length === 1 ? keys[0]! : `${keys[0]}–${keys.at(-1)}`;
}

// ── The timeline ─────────────────────────────────────────────────────────────

/** Zoom levels of the timeline, in px per second of narration. */
export const ZOOM_LEVELS = [4, 8, 16, 32, 64] as const;

/** The widest zoom whose lanes stay under `maxPx` (the narrowest when none does). */
export function defaultZoom(totalMs: number, maxPx = 2400): number {
  const fits = ZOOM_LEVELS.filter((z) => (totalMs / 1000) * z <= maxPx);
  return fits.at(-1) ?? ZOOM_LEVELS[0];
}

/** A lane's width in px. */
export const laneWidth = (totalMs: number, pxPerSecond: number) => Math.max(1, Math.ceil((totalMs / 1000) * pxPerSecond));

/** Where a span sits on a lane, in px: never narrower than 1 px, so a short shot stays visible. */
export function laneBox(startMs: number, endMs: number, pxPerSecond: number): { left: number; width: number } {
  const left = (startMs / 1000) * pxPerSecond;
  return { left: Math.round(left * 10) / 10, width: Math.max(1, Math.round(((Math.max(endMs, startMs) - startMs) / 1000) * pxPerSecond * 10) / 10) };
}

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

/** The ruler's ticks: the smallest step (in seconds) that keeps labels at least `minGapPx` apart. */
export function rulerTicks(totalMs: number, pxPerSecond: number, minGapPx = 56): { atMs: number; label: string }[] {
  const step = TICK_STEPS.find((s) => s * pxPerSecond >= minGapPx) ?? TICK_STEPS.at(-1)!;
  const out: { atMs: number; label: string }[] = [];
  for (let s = 0; s * 1000 <= totalMs; s += step) out.push({ atMs: s * 1000, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  return out;
}

/** Runtime per treatment, largest first (null: a placeholder shot with no treatment), with its share of the whole. */
export function treatmentMix(shots: readonly Pick<ShotView, 'treatment' | 'durationMs'>[]): { treatment: VisualTreatment | null; ms: number; share: number }[] {
  const total = shots.reduce((n, s) => n + s.durationMs, 0);
  const by = new Map<VisualTreatment | null, number>();
  for (const s of shots) by.set(s.treatment, (by.get(s.treatment) ?? 0) + s.durationMs);
  return [...by.entries()].map(([treatment, ms]) => ({ treatment, ms, share: total ? ms / total : 0 })).sort((a, b) => b.ms - a.ms || order(a.treatment) - order(b.treatment));
}
const order = (t: VisualTreatment | null) => (t ? VISUAL_TREATMENTS.indexOf(t) : VISUAL_TREATMENTS.length);

/** An approach's mix (runtime per treatment) as shares, largest first. */
export function mixShares(mix: Partial<Record<VisualTreatment, number>>): { treatment: VisualTreatment; share: number }[] {
  const entries = Object.entries(mix) as [VisualTreatment, number][];
  const total = entries.reduce((n, [, ms]) => n + ms, 0);
  return entries.map(([treatment, ms]) => ({ treatment, share: total ? ms / total : 0 })).sort((a, b) => b.share - a.share || order(a.treatment) - order(b.treatment));
}

export const percent = (share: number) => `${Math.round(share * 100)}%`;

// ── Relations ────────────────────────────────────────────────────────────────

/** How a shot's picture sits against its words, with the numbers code computed ("Leads in by 0.8 s"). */
export function relationText(shot: Pick<ShotView, 'relation' | 'timing'>): string {
  const t = shot.timing;
  const extra = [t.leadInMs > 0 ? `leads in by ${secondsText(t.leadInMs)}` : '', t.tailOutMs > 0 ? `tails out by ${secondsText(t.tailOutMs)}` : ''].filter(Boolean);
  switch (shot.relation) {
    case 'BRIDGE': {
      const kind = t.bridge?.kind;
      const what = kind === 'SILENCE' ? 'Fills a silence' : kind === 'SECTION' ? 'Bridges two sections' : kind === 'BEAT' ? 'Bridges two beats' : 'Bridges two blocks';
      return [what, ...extra].join(', ');
    }
    case 'LEAD_IN':
      return `Leads in by ${secondsText(t.leadInMs)}${t.tailOutMs > 0 ? `, tails out by ${secondsText(t.tailOutMs)}` : ''}`;
    case 'TAIL_OUT':
      return `Tails out by ${secondsText(t.tailOutMs)}`;
    default:
      return 'Timed to the narration';
  }
}

/** Marks drawn on the shot lane for a relation (none for a shot timed to its words). */
export const RELATION_MARK: Record<TimingRelation, string> = { TIMED_TO_NARRATION: '', LEAD_IN: '◂', TAIL_OUT: '▸', BRIDGE: '⇄' };

// ── Forecasts ────────────────────────────────────────────────────────────────

/** A forecast in dollars: "~$2.52", "<$0.01" for a priced fraction of a cent, "unpriced" without a verified price (never $0). */
export function estimateUsd(usd: number | null): string {
  if (usd === null) return 'unpriced';
  if (usd > 0 && usd < 0.005) return '<$0.01';
  return `~$${usd.toFixed(2)}`;
}

/** A rollup as it must always read: the priced total with its basis, and the shots it leaves out. */
export function rollupText(r: { totalUsd: number | null; basis: VisualCostBasis | 'MIXED' | null; unpricedShots: number }): string {
  const unpriced = r.unpricedShots ? `${r.unpricedShots} shot${r.unpricedShots === 1 ? '' : 's'} unpriced (not in the total)` : '';
  if (r.totalUsd === null) return `Unpriced: no verified price${r.unpricedShots ? ` for ${r.unpricedShots} shot${r.unpricedShots === 1 ? '' : 's'}` : ''}`;
  const head = `${estimateUsd(r.totalUsd)} estimate${r.basis === 'MOCK' ? ' (mock prices)' : ''}`;
  return unpriced ? `${head} · ${unpriced}` : head;
}

/** The forecast a finished minute, which counts the priced shots only (null: nothing priced). */
export function perMinuteText(r: { perFinishedMinute: number | null; unpricedShots: number }): string | null {
  if (r.perFinishedMinute === null) return null;
  return `About ${estimateUsd(r.perFinishedMinute)} a finished minute${r.unpricedShots ? ` (the priced shots only; ${r.unpricedShots} unpriced)` : ''}.`;
}

/** One shot's forecast in a line: what it would cost, how sure, or why it is unpriced. */
export function shotCostText(c: VisualCostEstimate | null): string {
  if (!c) return 'No forecast (a placeholder shot)';
  if (c.basis === 'UNPRICED') return `Unpriced: ${c.note}`;
  const sure = c.confidence ? `, ${c.confidence === 'LIST_PRICE' ? 'list price' : c.confidence === 'PLAN_PRICE' ? 'plan price' : 'assumption'}` : '';
  const gens = c.lines.length ? ` (${c.generations} generation${c.generations === 1 ? '' : 's'}${sure})` : '';
  return `${estimateUsd(c.totalUsd)} estimate${c.basis === 'MOCK' ? ' (mock prices)' : ''}${gens}`;
}

/** "provider model" of a recommendation, or why there is none: the shot reuses another's asset, or needs no provider. */
export const recommendationText = (c: VisualCostEstimate | null, reuseOf: string | null = null) =>
  reuseOf ? `reuses ${reuseOf}'s asset` : c?.provider ? `${c.provider}${c.model ? ` ${c.model}` : ''}${c.source === 'USER' ? ' (your choice)' : ''}` : 'no provider needed';

/** A rollup's buckets as table rows, with their key labelled ("Cinematic reconstruction"), largest priced total first. */
export function bucketRows(buckets: readonly CostBucket[], label: (key: string) => string = (k) => k): { key: string; label: string; shots: number; total: string; unpriced: number }[] {
  return [...buckets]
    .sort((a, b) => (b.totalUsd ?? -1) - (a.totalUsd ?? -1) || a.key.localeCompare(b.key))
    .map((b) => ({ key: b.key, label: label(b.key), shots: b.shots, total: estimateUsd(b.totalUsd), unpriced: b.unpricedShots }));
}

/** A cost bucket's key as read: treatments and methods by their labels, anything else as it is. */
export function bucketLabel(key: string): string {
  if ((VISUAL_TREATMENTS as readonly string[]).includes(key)) return VISUAL_TREATMENT_LABELS[key as VisualTreatment];
  if ((PRODUCTION_METHODS as readonly string[]).includes(key)) return PRODUCTION_METHOD_LABELS[key as (typeof PRODUCTION_METHODS)[number]];
  return key === 'none' ? 'None needed' : key;
}

// ── Versions, inputs and the project page ────────────────────────────────────

/** "v3 — In review — Edited (from v2)", as the version picker lists it. */
export function versionLabel(v: Pick<StoryboardSummaryView, 'version' | 'status' | 'origin' | 'baseVersion' | 'scope' | 'stale'>): string {
  return `v${v.version} — ${STORYBOARD_STATUS_LABELS[v.status]} — ${STORYBOARD_ORIGIN_LABELS[v.origin]}${v.baseVersion ? ` (from v${v.baseVersion})` : ''}${v.scope === 'PARTIAL' ? ' · preview' : ''}${v.stale ? ' · stale' : ''}`;
}

/** The takes a version is timed on, approved now. */
export function takesApproved(lane: { takes: readonly { status: string }[] }): { approved: number; total: number } {
  return { approved: lane.takes.filter((t) => t.status === 'APPROVED').length, total: lane.takes.length };
}

/**
 * What a version was planned from, as the page's inputs strip reads it:
 * "Script v5 · Architecture v3 · Voice run 3 (audition, blocks 1.1–1.10) ·
 * assembly v1 · takes 0/11 approved, provisional timing · Visual profile
 * Cinematic History v1 · engine v1".
 */
export function inputsStrip(v: Pick<StoryboardVersionView, 'inputs' | 'scopeInfo' | 'narrationLane'>): string[] {
  const n = v.inputs.narration;
  const { approved, total } = takesApproved(v.narrationLane.takes.length ? v.narrationLane : { takes: n.takes });
  const p = v.inputs.profile;
  return [
    `Script v${v.inputs.script.version}`,
    `Architecture v${v.inputs.architecture.version}`,
    `Voice run ${n.runNumber} (${VOICE_RUN_KIND_LABELS[n.runKind].toLowerCase()}, blocks ${blockRange(v.scopeInfo.blockKeys)})`,
    `assembly v${n.assemblyVersion}`,
    `takes ${approved}/${total} approved${approved < total ? ', provisional timing' : ''}`,
    `Visual profile ${p.familyName} v${p.version}`,
    'engine v1',
  ];
}

const STORYBOARD_PHASE: readonly ProjectStatus[] = ['VOICE_REVIEW', 'VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED'];

/** The project has a storyboard, or one can be planned (its narration is under review or approved). */
export function hasStoryboardPage(p: Pick<ProjectDetailView, 'status' | 'failedFromStatus' | 'storyboard'>): boolean {
  if (p.storyboard) return true;
  const status = p.status === 'FAILED' ? p.failedFromStatus : p.status;
  return status !== null && STORYBOARD_PHASE.includes(status);
}

/** The Storyboard pill's note: "planning…", "approval needed", "stale", "preview v2", "v3" or "ready to plan". */
export function storyboardNote(p: Pick<ProjectDetailView, 'status' | 'storyboard'>): string | null {
  if (p.status === 'VISUAL_PLANNING') return 'planning…';
  if (p.status === 'STORYBOARD_REVIEW') return 'approval needed';
  const s = p.storyboard;
  if (s?.stale) return 'stale';
  if (s) return s.scope === 'PARTIAL' ? `preview v${s.version}` : `v${s.version}`;
  return STORYBOARD_PHASE.includes(p.status) ? 'ready to plan' : null;
}

/** The project card's line: "v2 · In review · preview · 1:49.8 · 14 beats, 16 shots". */
export function summaryLine(s: StoryboardSummaryView): string {
  return [`v${s.version}`, STORYBOARD_STATUS_LABELS[s.status], s.scope === 'PARTIAL' ? 'preview' : 'whole script', s.runtimeMs !== null ? clock(s.runtimeMs) : null, `${s.beatCount} beats, ${s.shotCount} shots`].filter(Boolean).join(' · ');
}

/** A person's decision as read: "Approved by Ana — carried from v1: “steady”". */
export function decisionText(d: Pick<StoryboardDecisionView, 'decision' | 'decidedBy' | 'carriedFromVersion' | 'note' | 'approvalId'>): string {
  return `${STORYBOARD_DECISION_LABELS[d.decision]}${d.decidedBy ? ` by ${d.decidedBy}` : ''}${d.approvalId ? ' (the film’s storyboard approval)' : ''}${d.carriedFromVersion ? ` — carried from v${d.carriedFromVersion}` : ''}${d.note ? `: “${d.note}”` : ''}`;
}

/**
 * A version's last decision in words: "approved by Ana", "changes
 * requested by Ana". A superseded version was superseded by a later save
 * or approval, not by the person who decided it: "decided by Ana" (its
 * status note says what). Null when no one has decided it.
 */
export function decidedText(v: Pick<StoryboardSummaryView, 'status' | 'decidedBy'>): string | null {
  if (!v.decidedBy) return null;
  const what = v.status === 'APPROVED' || v.status === 'REJECTED' || v.status === 'CHANGES_REQUESTED' ? STORYBOARD_STATUS_LABELS[v.status].toLowerCase() : 'decided';
  return `${what} by ${v.decidedBy}`;
}

/** Blocking findings and warnings counted. */
export function findingCounts(findings: readonly Pick<StoryboardQaFinding, 'severity'>[]): { blocking: number; warnings: number } {
  const blocking = findings.filter((f) => f.severity === 'BLOCKING').length;
  return { blocking, warnings: findings.length - blocking };
}

/** The staleness findings now (approval of the version no longer stands, or its profile or prices moved). */
export const staleFindings = (findings: readonly StoryboardQaFinding[]) => findings.filter((f) => f.kind.startsWith('STALE_'));

// ── "Why is this visual here?" ───────────────────────────────────────────────

export interface WhyStep {
  level: 'Shot' | 'Visual beat' | 'Narration' | 'Script block' | 'Architecture beat' | 'Sequence' | 'Claim' | 'Source';
  label: string;
  detail: string;
}

/**
 * The chain from a shot to its evidence, in order: shot → visual beat →
 * narration (words and times) → script blocks → architecture beats and
 * sequence (setting with each field's basis) → claims (verdict now, role) →
 * traceable sources (quote). A shot that depicts nothing says so.
 */
export function whyChain(shot: Pick<ShotView, 'why'>): WhyStep[] {
  const w = shot.why;
  const steps: WhyStep[] = [
    {
      level: 'Shot',
      label: [w.shot.key, w.shot.treatment ? VISUAL_TREATMENT_LABELS[w.shot.treatment] : 'Not planned', DEPICTION_LABELS[w.shot.depiction], w.shot.infoClass ? SCRIPT_BLOCK_CLASS_LABELS[w.shot.infoClass] : null].filter(Boolean).join(' · '),
      detail: w.shot.purpose,
    },
    { level: 'Visual beat', label: `${w.beat.key} · ${w.beat.title}`, detail: [w.beat.purpose, w.beat.concept].filter(Boolean).join(' — ') },
    { level: 'Narration', label: w.narration.startMs !== null && w.narration.endMs !== null ? rangeText(w.narration.startMs, w.narration.endMs) : 'A silence (no words)', detail: w.narration.text ? `“${w.narration.text}”` : '' },
    ...w.blocks.map((b): WhyStep => ({ level: 'Script block', label: `${b.key} · ${SCRIPT_BLOCK_CLASS_LABELS[b.infoClass]}`, detail: b.text })),
    ...w.architecture.beats.map((b): WhyStep => ({ level: 'Architecture beat', label: `${b.id} · ${BEAT_FUNCTION_LABELS[b.function]} · ${INFORMATION_CLASS_LABELS[b.basis]}`, detail: b.description })),
  ];
  const seq = w.architecture.sequence;
  if (seq) {
    const field = (name: string, f: { value: string; basis: string }) => (f.value ? `${name} ${f.value} (${f.basis.toLowerCase()})` : '');
    steps.push({ level: 'Sequence', label: `Sequence ${seq.number}: ${seq.title}`, detail: [field('place', seq.setting.location), field('date', seq.setting.date), field('time of day', seq.setting.timeOfDay)].filter(Boolean).join('; ') });
  }
  if (!w.claims.length) steps.push({ level: 'Claim', label: 'No claim', detail: 'The picture asserts no fact of the evidence.' });
  for (const c of w.claims) {
    const was = c.savedVerdict ? ` (was ${CLAIM_VERDICT_LABELS[c.savedVerdict]} when saved)` : '';
    steps.push({ level: 'Claim', label: `${c.key} · ${CLAIM_VERDICT_LABELS[c.verdict]}${was}${c.role ? ` · ${SHOT_CLAIM_ROLE_LABELS[c.role]}` : ''}`, detail: c.statement });
  }
  for (const s of w.sources) steps.push({ level: 'Source', label: s.title, detail: s.quote ? `“${s.quote}”` : '' });
  return steps;
}

// ── Editing ──────────────────────────────────────────────────────────────────

/** Cut points strictly between two times (where a cut may move to, or a shot be split at). */
export function cutPointsBetween(points: readonly CutPointView[], fromMs: number, toMs: number, exclude: readonly string[] = []): CutPointView[] {
  return points.filter((p) => p.atMs > fromMs && p.atMs < toMs && !exclude.includes(p.id));
}

/** Shots in clock order. */
export const byTime = <T extends Pick<ShotView, 'startMs' | 'sortOrder'>>(shots: readonly T[]) => [...shots].sort((a, b) => a.startMs - b.startMs || a.sortOrder - b.sortOrder);

/** The shot right after this one in its beat (null: it is the beat's last), the only one it can merge with. */
export function nextInBeat<T extends Pick<ShotView, 'key' | 'beatKey' | 'startMs' | 'sortOrder'>>(shots: readonly T[], key: string): T | null {
  const ordered = byTime(shots);
  const i = ordered.findIndex((s) => s.key === key);
  const next = i >= 0 ? ordered[i + 1] : undefined;
  return next && next.beatKey === ordered[i]!.beatKey ? next : null;
}

/** The shot right after this one on the clock (null: the last), the neighbour of the cut after it. */
export function nextShot<T extends Pick<ShotView, 'key' | 'startMs' | 'sortOrder'>>(shots: readonly T[], key: string): T | null {
  const ordered = byTime(shots);
  const i = ordered.findIndex((s) => s.key === key);
  return i >= 0 ? (ordered[i + 1] ?? null) : null;
}

/** A beat's shot order with one shot moved up (-1) or down (+1); null when it cannot move that way. */
export function moved(order: readonly string[], key: string, by: -1 | 1): string[] | null {
  const i = order.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const out = [...order];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The classes a person may lower a shot to (never raise): DOCUMENTED > RECONSTRUCTION > UNCERTAIN. */
export function lowerClasses(cls: ScriptBlockClass | null): ScriptBlockClass[] {
  const rank: ScriptBlockClass[] = ['DOCUMENTED', 'RECONSTRUCTION', 'UNCERTAIN'];
  const i = cls ? rank.indexOf(cls) : -1;
  return i < 0 ? [] : rank.slice(i + 1);
}

/** The text fields a shot's edit form changes. */
export type ShotTextFields = Pick<ShotSpec, 'purpose' | 'description' | 'composition' | 'lighting' | 'mood'>;

/** A specific detail (a uniform, a document, a date…) as the shot form holds it: the claim keys typed comma-separated. */
export interface SpecificRow {
  detail: string;
  kind: ShotSpecific['kind'];
  basis: DetailBasis;
  claimKeys: string;
}

/** An object in the frame as the shot form holds it. */
export interface ObjectRow {
  name: string;
  basis: DetailBasis;
  claimKeys: string;
}

/** A subject in the shot as the form holds it: its role, action, likeness, interactions and speech. */
export interface SubjectRow {
  subjectKey: string;
  detail: ShotSubjectDetail;
}

/** What the edit form holds: the spec's editable fields, the treatment and method, a lowered class, details with their bases, the subjects, and lines to add. */
export interface ShotForm extends ShotTextFields {
  treatment: VisualTreatment | null;
  method: ShotView['method'];
  infoClass: ScriptBlockClass | null;
  shotType: ShotSpec['shotType'];
  camera: ShotSpec['camera'];
  movement: ShotSpec['movement'];
  environment: string;
  transitionIn: ShotSpec['transitionIn'];
  transitionOut: ShotSpec['transitionOut'];
  uncertaintyDevice: ShotSpec['uncertaintyDevice'];
  /** The overlays proposed (automatic labels are recomputed by code, never sent). */
  overlays: ShotSpec['overlays'];
  /** Must-avoid lines added by the editor (kept with the inherited ones). */
  addMustAvoid: string;
  notes: string[];
  claims: { claimKey: string; role: NonNullable<ShotView['claims'][number]['role']> }[];
  /** Specific details and objects, each with its basis (an invented one stays labelled so). */
  specifics: SpecificRow[];
  objects: ObjectRow[];
  /** The subjects in the shot (one removed leaves the shot, not the storyboard). */
  subjects: SubjectRow[];
}

/** The form at a shot as it is. */
export function shotForm(s: Pick<ShotView, 'treatment' | 'method' | 'infoClass' | 'spec' | 'claims' | 'subjects'>): ShotForm {
  const p = s.spec;
  return {
    treatment: s.treatment,
    method: s.method,
    infoClass: s.infoClass,
    purpose: p.purpose,
    description: p.description,
    composition: p.composition,
    lighting: p.lighting,
    mood: p.mood,
    shotType: p.shotType,
    camera: { ...p.camera },
    movement: { ...p.movement },
    environment: p.environment.description,
    transitionIn: p.transitionIn,
    transitionOut: p.transitionOut,
    uncertaintyDevice: p.uncertaintyDevice,
    overlays: p.overlays.filter((o) => !o.auto).map((o) => ({ ...o, claimKeys: [...o.claimKeys] })),
    addMustAvoid: '',
    notes: [...p.notes],
    claims: s.claims.flatMap((c) => (c.role ? [{ claimKey: c.key, role: c.role }] : [])),
    specifics: p.specifics.map((d) => ({ detail: d.detail, kind: d.kind, basis: d.basis, claimKeys: d.claimKeys.join(', ') })),
    objects: p.objects.map((o) => ({ name: o.name, basis: o.basis, claimKeys: o.claimKeys.join(', ') })),
    subjects: s.subjects.map((x) => ({ subjectKey: x.subjectKey, detail: structuredClone(x.detail) })),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const specificsOf = (rows: readonly SpecificRow[]): ShotSpec['specifics'] => rows.map((r) => ({ detail: r.detail.trim(), kind: r.kind, basis: r.basis, claimKeys: wordsOf(r.claimKeys) })).filter((r) => r.detail);
const objectsOf = (rows: readonly ObjectRow[]): ShotSpec['objects'] => rows.map((r) => ({ name: r.name.trim(), basis: r.basis, claimKeys: wordsOf(r.claimKeys) })).filter((r) => r.name);
const subjectsOf = (rows: readonly SubjectRow[]): SubjectRow[] => rows.map((r) => ({ subjectKey: r.subjectKey, detail: { ...r.detail, action: r.detail.action.trim() } }));

/** What a shot form must fix before it saves: a detail or object said to rest on a claim names it (else it rests on nothing). */
export function shotFormProblems(f: Pick<ShotForm, 'specifics' | 'objects'>): string[] {
  const unnamed = [...specificsOf(f.specifics).map((d) => ({ text: d.detail, ...d })), ...objectsOf(f.objects).map((o) => ({ text: o.name, ...o }))].filter((d) => d.basis === 'CLAIM' && !d.claimKeys.length);
  return unnamed.map((d) => `“${d.text}” rests on a claim: name it, or mark it generic for the period or invented`);
}

/**
 * What an edit form sends: only what changed (a patch never carries the
 * depiction or times). Added must-avoid lines join the inherited ones, each
 * line once; a class is sent only when lowered below the one shown (code
 * derives it again, and never raises it). Details, objects and subjects go
 * as whole lists when any of them changed. Null when nothing changed.
 */
export function shotPatch(s: Pick<ShotView, 'treatment' | 'method' | 'infoClass' | 'spec' | 'claims' | 'subjects'>, f: ShotForm): ShotPatch | null {
  const before = shotForm(s);
  const patch: Record<string, unknown> = {};
  if (f.treatment && f.treatment !== before.treatment) patch.treatment = f.treatment;
  if (f.method && (f.method !== before.method || patch.treatment)) patch.method = f.method;
  if (f.infoClass && f.infoClass !== before.infoClass && lowerClasses(before.infoClass).includes(f.infoClass)) patch.infoClass = f.infoClass;
  for (const k of ['purpose', 'description', 'composition', 'lighting', 'mood'] as const) if (f[k].trim() !== before[k]) patch[k] = f[k].trim();
  for (const k of ['shotType', 'transitionIn', 'transitionOut', 'uncertaintyDevice'] as const) if (f[k] !== before[k]) patch[k] = f[k];
  if (!same(f.camera, before.camera)) patch.camera = { angle: f.camera.angle.trim(), lens: f.camera.lens?.trim() ? f.camera.lens.trim() : null };
  if (!same(f.movement, before.movement)) patch.movement = { ...f.movement, note: f.movement.note.trim() };
  if (f.environment.trim() !== before.environment) patch.environment = { subjectKey: s.spec.environment.subjectKey, description: f.environment.trim() };
  if (!same(f.overlays, before.overlays)) patch.overlays = f.overlays.map((o) => ({ ...o, text: o.text.trim(), reason: o.reason.trim() }));
  const added = f.addMustAvoid
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, all) => l && all.indexOf(l) === i && !s.spec.mustAvoid.some((m) => m.text === l));
  if (added.length) patch.mustAvoid = [...s.spec.mustAvoid, ...added.map((text) => ({ text, origin: 'STORYBOARD' as const }))];
  const notes = f.notes.map((n) => n.trim()).filter(Boolean);
  if (!same(notes, before.notes)) patch.notes = notes;
  const claims = f.claims.map((c) => ({ claimKey: c.claimKey.trim(), role: c.role })).filter((c) => c.claimKey);
  if (!same(claims, before.claims)) patch.claims = claims;
  const specifics = specificsOf(f.specifics);
  if (!sameSettings(specifics, s.spec.specifics)) patch.specifics = specifics;
  const objects = objectsOf(f.objects);
  if (!sameSettings(objects, s.spec.objects)) patch.objects = objects;
  const subjects = subjectsOf(f.subjects);
  if (!sameSettings(subjects, s.subjects.map((x) => ({ subjectKey: x.subjectKey, detail: x.detail })))) patch.subjects = subjects;
  return Object.keys(patch).length ? (patch as ShotPatch) : null;
}

/** A design detail of a continuity subject as its form holds it: the claim keys typed comma-separated. */
export interface DetailRow {
  detail: string;
  basis: DetailBasis;
  claimKeys: string;
}

export const detailRows = (details: ContinuitySpec['designDetails']): DetailRow[] => details.map((d) => ({ detail: d.detail, basis: d.basis, claimKeys: d.claimKeys.join(', ') }));

/** The design details a form sends (empty ones dropped), and why they cannot be saved: a detail said to rest on a claim names it. */
export function designDetailsFrom(rows: readonly DetailRow[]): { details: ContinuitySpec['designDetails']; problems: string[] } {
  const details = rows.map((r) => ({ detail: r.detail.trim(), basis: r.basis, claimKeys: wordsOf(r.claimKeys) })).filter((d) => d.detail);
  const problems = details.filter((d) => d.basis === 'CLAIM' && !d.claimKeys.length).map((d) => `“${d.detail}” rests on a claim: name it, or mark it generic for the period or invented`);
  return { details, problems };
}

// ── Visual profiles ──────────────────────────────────────────────────────────

/** "a seeded preset (Cinematic History)", "an edit of v2", "a duplicate of v1 of …". */
export function visualOriginText(o: VisualProfileOrigin): string {
  switch (o.kind) {
    case 'PRESET':
      return `${VISUAL_PROFILE_ORIGIN_LABELS.PRESET} (${o.preset})`;
    case 'EDIT':
      return `${VISUAL_PROFILE_ORIGIN_LABELS.EDIT} of v${o.basedOnVersion}`;
    case 'DUPLICATE':
      return `${VISUAL_PROFILE_ORIGIN_LABELS.DUPLICATE} of v${o.fromVersion} of another profile`;
    default:
      return VISUAL_PROFILE_ORIGIN_LABELS[o.kind];
  }
}

/** A visual profile in a line: "Cinematic · classical camera · balanced · approach C (Hybrid) · 16:9 1080p". */
export function profileLine(c: VisualStyleProfileConfig): string {
  return `${VISUAL_REALISM_LABELS[c.realism]} · ${CAMERA_STYLE_LABELS[c.cameraLanguage.style].toLowerCase()} camera · ${VISUAL_DENSITY_LABELS[c.density].toLowerCase()} · approach ${c.approach} (${VISUAL_APPROACH_LABELS[c.approach]}) · ${c.aspectRatio} ${c.resolution}`;
}

const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');
const usd = (v: number | null) => (v === null ? 'no ceiling' : `$${v}`);

/** Every setting of a visual profile as rows: its label, its value, and where it came from (the profile unless the project overrode it). */
export function visualConfigRows(c: VisualStyleProfileConfig, provenance: VisualConfigProvenance = {}): { path: string; label: string; value: string; source: 'PROFILE' | 'PROJECT' }[] {
  const from = (path: string): 'PROFILE' | 'PROJECT' => (Object.entries(provenance).some(([p, s]) => s === 'PROJECT' && (p === path || p.startsWith(`${path}.`))) ? 'PROJECT' : 'PROFILE');
  const prefs = Object.entries(c.providerPreferences).filter(([, v]) => v && v.length);
  const rerolls = Object.entries(c.generation.rerolls);
  const rows: [string, string, string][] = [
    ['realism', 'Realism', VISUAL_REALISM_LABELS[c.realism]],
    ['cameraLanguage', 'Camera language', `${CAMERA_STYLE_LABELS[c.cameraLanguage.style]}${c.cameraLanguage.note ? ` — ${c.cameraLanguage.note}` : ''}`],
    ['lenses', 'Lenses', list(c.lenses)],
    ['colour', 'Colour', `${c.colour.treatment || '—'}${c.colour.palette.length ? ` (${c.colour.palette.join(', ')})` : ''}`],
    ['lighting', 'Lighting', c.lighting || '—'],
    ['filmGrain', 'Film grain', FILM_GRAIN_LABELS[c.filmGrain]],
    ['aspectRatio', 'Aspect ratio', c.aspectRatio],
    ['resolution', 'Resolution', c.resolution],
    ['motionIntensity', 'Motion', MOTION_INTENSITY_LABELS[c.motionIntensity]],
    ['density', 'Visual density', VISUAL_DENSITY_LABELS[c.density]],
    ['archival', 'Archival', ARCHIVAL_PREFERENCE_LABELS[c.archival]],
    ['graphics', 'Graphics', GRAPHICS_PREFERENCE_LABELS[c.graphics]],
    ['generation', 'Generation', `generated video at most ${percent(c.generation.maxGeneratedVideoShare)} of the runtime${c.generation.preferStillMotion ? '; animated stills preferred' : ''}${rerolls.length ? `; rerolls ${rerolls.map(([m, n]) => `${PRODUCTION_METHOD_LABELS[m as keyof typeof PRODUCTION_METHOD_LABELS]} ${n}`).join(', ')}` : ''}`],
    ['approach', 'Approach', `${c.approach} — ${VISUAL_APPROACH_LABELS[c.approach]}`],
    ['providerPreferences', 'Provider preferences', prefs.length ? prefs.map(([m, v]) => `${PRODUCTION_METHOD_LABELS[m as keyof typeof PRODUCTION_METHOD_LABELS]}: ${v!.map((x) => `${x.provider}${x.model ? ` ${x.model}` : ''}`).join(', ')}`).join('; ') : 'none (the catalog order)'],
    ['costCeilingUsd', 'Cost ceiling', `${usd(c.costCeilingUsd.total)} in all; ${usd(c.costCeilingUsd.perFinishedMinute)} a finished minute`],
    ['notes', 'Notes', c.notes || '—'],
  ];
  return rows.map(([path, label, value]) => ({ path, label, value, source: from(path) }));
}

/** A project's overrides in words ("none"; "density, approach"). */
export function describeVisualOverrides(o: VisualConfigOverrides): string {
  const keys = Object.entries(o).filter(([, v]) => v !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0));
  return keys.length ? keys.map(([k]) => k).join(', ') : 'none';
}

/** The project's status as the storyboard page explains it. */
export const statusWords = (s: string) => STATUS_LABELS[s as ProjectStatus] ?? s;

// ── Planning a storyboard ────────────────────────────────────────────────────

/** Statuses a preview (the side job) runs in: while the narration is reviewed or just approved. */
const PREVIEW_STATUSES: readonly ProjectStatus[] = SIDE_JOBS.STORYBOARD_PREVIEW ?? [];
const PHASE_STATUSES: readonly ProjectStatus[] = ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED'];

/** Visual generation is the next milestone: while the storyboard is real here, its jobs are held (the server refuses them, on enqueue and on retry). */
export const generationHeld = (realStages: readonly string[], type: JobType) => realStages.includes('VISUAL_PLAN') && (type === 'VISUAL_GENERATION' || type === 'INFOGRAPHIC');

/** The phase job may run: from VOICE_COMPLETE until visual generation, or to recover a failed plan. */
export const phaseOpen = (p: Pick<ProjectDetailView, 'status' | 'failedFromStatus'>) => PHASE_STATUSES.includes(p.status) || (p.status === 'FAILED' && p.failedFromStatus === 'VISUAL_PLANNING');

/**
 * What planning on an assembly would queue, as the server decides it: the
 * phase job on the narration the VOICE gate approved (while the phase is
 * open), a preview while the narration is reviewed or just approved, or
 * nothing, and why.
 */
export function planKind(p: Pick<ProjectDetailView, 'status' | 'failedFromStatus'>, a: Pick<StoryboardAssemblyOptionView, 'gateApproved'>): { kind: 'PREVIEW' | 'PHASE' | null; reason: string | null } {
  if (a.gateApproved && phaseOpen(p)) return { kind: 'PHASE', reason: null };
  if (PREVIEW_STATUSES.includes(p.status)) return { kind: 'PREVIEW', reason: null };
  return {
    kind: null,
    reason: phaseOpen(p)
      ? `In “${STATUS_LABELS[p.status]}” the storyboard is planned on the film’s approved narration`
      : `A storyboard is planned while the narration is reviewed or after it is approved, and before visual generation (the project is “${STATUS_LABELS[p.status]}”)`,
  };
}

/**
 * The narration offered first: the run named (?run=N on the page), then
 * while the phase is open the run and assembly the VOICE gate approved,
 * then the project's chosen run, else the newest run of the approved script
 * that has one — at the gate's assembly where it has it, else its latest.
 * Runs of another script or not assembled are never offered. Null: none.
 */
export function planDefaults(p: Pick<ProjectDetailView, 'status' | 'failedFromStatus'>, inputs: Pick<StoryboardInputsView, 'runs'>, named?: number | null, chosen?: number | null): { runId: string; assemblyId: string } | null {
  const usable = inputs.runs.filter((r) => r.current && r.assemblies.length);
  const at = (r: (typeof usable)[number]) => ({ runId: r.id, assemblyId: (phaseOpen(p) ? r.assemblies.find((a) => a.gateApproved) : undefined)?.id ?? r.assemblies[0]!.id });
  const byNumber = (n: number | null | undefined) => (n ? usable.find((r) => r.number === n) : undefined);
  const gate = phaseOpen(p) ? usable.find((r) => r.assemblies.some((a) => a.gateApproved)) : undefined;
  const run = byNumber(named) ?? gate ?? byNumber(chosen) ?? usable[0];
  return run ? at(run) : null;
}

/** "Voice run 3 · C expressive · 11/11 takes approved · 1:50 · ★ your chosen run": a run and its assembly in words, as the plan form names them. */
export function planRunText(r: Pick<StoryboardInputsView['runs'][number], 'number' | 'variant' | 'label'>, a: Pick<StoryboardAssemblyOptionView, 'takes' | 'totalDurationMs'> | null, chosen = false): string {
  return [`Voice run ${r.number}`, r.variant ?? r.label, a ? `${a.takes.approved}/${a.takes.total} takes approved` : 'not assembled', a ? formatLength(a.totalDurationMs) : null, chosen ? '★ your chosen run' : null].filter(Boolean).join(' · ');
}

/** "Assembly v2 · 1:49.8 · takes 11/11 approved · mock audio" as the plan form lists it. */
export function assemblyText(a: Pick<StoryboardAssemblyOptionView, 'version' | 'totalDurationMs' | 'takes' | 'mock' | 'gateApproved' | 'complete'>): string {
  return [`Assembly v${a.version}`, clock(a.totalDurationMs), `takes ${a.takes.approved}/${a.takes.total} approved`, a.gateApproved ? 'the film’s approved narration' : null, a.complete ? 'the whole script' : null, a.mock ? 'mock audio' : null].filter(Boolean).join(' · ');
}

// ── Decisions ────────────────────────────────────────────────────────────────

/**
 * Why a version cannot be approved now, as the server will judge it (empty:
 * it can): live blocking findings, rejected shots, and takes not all
 * approved (approval needs the narration it is timed on approved). A
 * whole-script version passes the STORYBOARD gate only on the narration
 * the VOICE gate approved; the gate also checks the version is the one
 * under review.
 */
export function approvalNeeds(v: Pick<StoryboardVersionView, 'qa' | 'shots' | 'narration' | 'narrationLane' | 'scope'>): string[] {
  const out: string[] = [];
  const blocking = v.qa.live.filter((f) => f.severity === 'BLOCKING').length;
  if (blocking) out.push(`${blocking} blocking finding${blocking === 1 ? '' : 's'} to resolve (see QA)`);
  const rejected = v.shots.filter((s) => s.review === 'REJECTED').map((s) => s.key);
  if (rejected.length) out.push(`${rejected.join(', ')} ${rejected.length === 1 ? 'is' : 'are'} rejected: edit ${rejected.length === 1 ? 'it' : 'them'}, or clear the decision`);
  if (v.scope === 'FULL' && v.narration.approval !== 'GATE_APPROVED') out.push('plan it on the film’s approved narration: the film’s storyboard is approved only on that narration');
  else if (v.narration.approval === 'UNREVIEWED') {
    const t = takesApproved(v.narrationLane);
    out.push(`approve the takes it is timed on first (${t.approved}/${t.total} approved, on the Voice page)`);
  }
  return out;
}

/** What a version changed from the one it was made from, a line each: "Shots added: SH017", "SH004 changed: treatment, description". */
export function changesLines(c: VersionChanges | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  const keys = (what: string, list: readonly string[]) => {
    if (list.length) out.push(`${what}: ${list.join(', ')}`);
  };
  keys('Shots added', c.shots.added);
  keys('Shots removed', c.shots.removed);
  for (const x of c.shots.changed) out.push(`${x.shotKey} changed: ${x.fields.join(', ')}`);
  keys('Beats added', c.beats.added);
  keys('Beats removed', c.beats.removed);
  for (const x of c.beats.changed) out.push(`${x.beatKey} changed: ${x.fields.join(', ')}`);
  return out.length ? out : [`No change from v${c.baseVersion}`];
}

// ── Costs, evidence and rhythm ───────────────────────────────────────────────

const UNIT_WORDS: Readonly<Record<string, string>> = { VIDEO_SECONDS: 'a second of video', IMAGES: 'an image', REQUESTS: 'an item', AUDIO_SECONDS: 'a second of audio', CREDITS: 'a credit' };

/** A price per unit as written: up to four decimals, and a priced fraction below that in three significant digits (never $0). */
const unitUsd = (usd: number) => (usd > 0 && usd < 0.0001 ? String(Number(usd.toPrecision(3))) : String(Number(usd.toFixed(4))));

/** A rate as read: "$0.168 a second of video", "$0.0057 an image". */
export const rateText = (r: { unit: string; usdPerUnit: number }) => `$${unitUsd(r.usdPerUnit)} ${UNIT_WORDS[r.unit] ?? `per ${r.unit.toLowerCase().replace(/_/g, ' ')}`}`;

/**
 * The prices a version was costed with, frozen when it was saved: each
 * model's rates with where they come from (the card's source, and each
 * rate's own where it names another page), when they were checked and how
 * sure they are. A card with no rate reads "not priced" whatever its card
 * says (its forecasts are unpriced, never $0).
 */
export function pricingRows(s: VisualPricingSnapshot): { key: string; provider: string; model: string; label: string; methods: string; rates: string; source: string; rateSources: string[]; checkedAt: string; sure: string }[] {
  return s.cards.map((c) => ({
    key: `${c.provider}/${c.model}`,
    provider: c.provider,
    model: c.model,
    label: c.label,
    methods: c.methods.map((m) => PRODUCTION_METHOD_LABELS[m]).join(', '),
    rates: c.rates.length ? c.rates.map(rateText).join('; ') : 'not priced',
    source: c.source,
    rateSources: [...new Set(c.rates.map((r) => r.source))].filter((x) => x !== c.source),
    checkedAt: c.checkedAt,
    sure: c.rates.length ? PRICE_CONFIDENCE_LABELS[c.confidence] : 'not priced',
  }));
}

/** The forecast of each shot in clock order: its method and recommendation, the generations, the estimate or "unpriced". */
export function shotCostRows(shots: readonly Pick<ShotView, 'key' | 'startMs' | 'sortOrder' | 'treatment' | 'method' | 'cost' | 'assetRequirement'>[]): { key: string; treatment: string; method: string; recommendation: string; generations: string; estimate: string }[] {
  return byTime(shots).map((s) => ({
    key: s.key,
    treatment: s.treatment ? VISUAL_TREATMENT_LABELS[s.treatment] : 'Not planned',
    method: s.method ? PRODUCTION_METHOD_LABELS[s.method] : '—',
    recommendation: recommendationText(s.cost, s.assetRequirement?.reuseOf ?? null),
    generations: s.cost?.lines.length ? String(s.cost.generations) : '—',
    estimate: s.cost ? `${estimateUsd(s.cost.totalUsd)}${s.cost.basis === 'MOCK' ? ' (mock)' : ''}` : 'no forecast',
  }));
}

/** A shot against its evidence: a factual visual traced (it rests on a retrieved source, every claim it depicts included) or untraced (blocks approval), or a picture that shows no fact. */
export type EvidenceState = 'TRACED' | 'UNTRACED' | 'NOT_FACTUAL';

/**
 * A factual visual, as the version's evidence coverage counts it: a
 * factual class shown as a record, a reconstruction or data, or any
 * depicting, source or data claim. A placeholder shot is none.
 */
export function factualShot(s: Pick<ShotView, 'unplanned' | 'infoClass' | 'spec' | 'claims'>): boolean {
  if (s.unplanned) return false;
  const factualClass = s.infoClass === 'DOCUMENTED' || s.infoClass === 'RECONSTRUCTION' || s.infoClass === 'UNCERTAIN';
  const d = s.spec.depiction;
  return (factualClass && (d === 'RECORD' || d === 'RECONSTRUCTED' || d === 'DATA')) || s.claims.some((c) => c.role === 'DEPICTS' || c.role === 'SHOWS_SOURCE' || c.role === 'DATA');
}

/** Each shot's evidence in clock order: its state and how many retrieved sources stand behind it. */
export function evidenceRows<S extends Pick<ShotView, 'key' | 'startMs' | 'sortOrder' | 'claims' | 'unplanned' | 'infoClass' | 'spec'>>(v: { shots: readonly S[]; evidenceCoverage: Pick<StoryboardVersionView['evidenceCoverage'], 'untraced'> }): { shot: S; state: EvidenceState; sources: number }[] {
  return byTime(v.shots).map((s) => {
    const state: EvidenceState = v.evidenceCoverage.untraced.includes(s.key) ? 'UNTRACED' : factualShot(s) ? 'TRACED' : 'NOT_FACTUAL';
    return { shot: s, state, sources: new Set(s.claims.flatMap((c) => c.sourceIds)).size };
  });
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const kindWords = (k: string) => k.toLowerCase().replace(/_/g, ' ');

/** The version's visual rhythm as rows. */
export function rhythmRows(r: RhythmStats): { label: string; value: string }[] {
  const rows: [string, string][] = [
    ['Shots', String(r.shots)],
    ['Average shot', secondsText(r.averageShotMs)],
    ['Median shot', secondsText(r.medianShotMs)],
    ['Shortest – longest', `${secondsText(r.minShotMs)} – ${secondsText(r.maxShotMs)}`],
    ['Cuts a minute', r.cutsPerMinute.toFixed(1)],
    ['Treatment changes', String(r.treatmentChanges)],
    ['Longest run of one treatment', plural(r.longestSameTreatmentRun, 'shot')],
    ['Static · moving', `${percent(r.staticShare)} · ${percent(r.movingShare)}`],
    ['Claims a minute', r.claimsPerMinute.toFixed(1)],
    ['Overlays a minute', r.overlaysPerMinute.toFixed(1)],
    ['Generated video', `${percent(r.generatedVideoShare)} of the runtime`],
    ['Reset points', r.resetPoints.length ? r.resetPoints.map((x) => `${clock(x.atMs)} ${kindWords(x.kind)}`).join(', ') : 'none'],
    ['Peaks', r.peaks.length ? r.peaks.map((x) => `${clock(x.atMs)} ${x.beatKey} ${kindWords(x.kind)}`).join(', ') : 'none'],
    ['Reveals · transitions', `${r.reveals} · ${r.transitions}`],
  ];
  return rows.map(([label, value]) => ({ label, value }));
}

// ── Visual profile forms ─────────────────────────────────────────────────────

const choices = <T extends string>(values: readonly T[], labels: Readonly<Record<T, string>>) => values.map((value) => ({ value, label: labels[value] }));

/** How a profile setting is entered: a choice, a line, a long text, a comma-separated list, a share of the runtime in %, yes or no, or dollars (empty: none). */
export type VisualFieldKind = 'choice' | 'text' | 'long' | 'words' | 'share' | 'flag' | 'usd';

export interface VisualField {
  path: string;
  label: string;
  kind: VisualFieldKind;
  options?: readonly { value: string; label: string }[];
}

/** The settings a visual profile form edits one by one, in the order a profile reads (rerolls and provider preferences have rows of their own). */
export const VISUAL_FIELDS: readonly VisualField[] = [
  { path: 'realism', label: 'Realism', kind: 'choice', options: choices(VISUAL_REALISMS, VISUAL_REALISM_LABELS) },
  { path: 'cameraLanguage.style', label: 'Camera language', kind: 'choice', options: choices(CAMERA_STYLES, CAMERA_STYLE_LABELS) },
  { path: 'cameraLanguage.note', label: 'Camera note', kind: 'text' },
  { path: 'lenses', label: 'Lenses (comma-separated)', kind: 'words' },
  { path: 'colour.treatment', label: 'Colour treatment', kind: 'text' },
  { path: 'colour.palette', label: 'Palette (comma-separated)', kind: 'words' },
  { path: 'lighting', label: 'Lighting', kind: 'text' },
  { path: 'filmGrain', label: 'Film grain', kind: 'choice', options: choices(FILM_GRAINS, FILM_GRAIN_LABELS) },
  { path: 'aspectRatio', label: 'Aspect ratio', kind: 'choice', options: ASPECT_RATIOS.map((value) => ({ value, label: value })) },
  { path: 'resolution', label: 'Resolution', kind: 'choice', options: VISUAL_RESOLUTIONS.map((value) => ({ value, label: value })) },
  { path: 'motionIntensity', label: 'Motion', kind: 'choice', options: choices(MOTION_INTENSITIES, MOTION_INTENSITY_LABELS) },
  { path: 'density', label: 'Visual density', kind: 'choice', options: choices(VISUAL_DENSITIES, VISUAL_DENSITY_LABELS) },
  { path: 'archival', label: 'Archival', kind: 'choice', options: choices(ARCHIVAL_PREFERENCES, ARCHIVAL_PREFERENCE_LABELS) },
  { path: 'graphics', label: 'Graphics', kind: 'choice', options: choices(GRAPHICS_PREFERENCES, GRAPHICS_PREFERENCE_LABELS) },
  { path: 'generation.maxGeneratedVideoShare', label: 'Generated video at most (% of the runtime)', kind: 'share' },
  { path: 'generation.preferStillMotion', label: 'Prefer animated stills to generated video', kind: 'flag' },
  { path: 'approach', label: 'Approach planned in full', kind: 'choice', options: VISUAL_APPROACHES.map((value) => ({ value, label: `${value} — ${VISUAL_APPROACH_LABELS[value]}` })) },
  { path: 'costCeilingUsd.total', label: 'Cost ceiling in all (USD, empty: none)', kind: 'usd' },
  { path: 'costCeilingUsd.perFinishedMinute', label: 'Cost ceiling a finished minute (USD, empty: none)', kind: 'usd' },
  { path: 'notes', label: 'Notes', kind: 'long' },
];

/** Settings edited as a whole, by rows of their own. */
export const VISUAL_ROW_PATHS = ['generation.rerolls', 'providerPreferences'] as const;
const EDITED_PATHS: readonly string[] = [...VISUAL_FIELDS.map((f) => f.path), ...VISUAL_ROW_PATHS];

/** A setting by its path ("cameraLanguage.style"); undefined when absent. */
export function valueAt(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((x, k) => (x !== null && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
}

/** A copy with one setting set by its path: the objects on the way are copied, never shared. */
export function withValue<T extends object>(o: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.') as [string, ...string[]];
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>) };
  const inner = out[head];
  out[head] = rest.length ? withValue(inner !== null && typeof inner === 'object' ? inner : {}, rest.join('.'), value) : value;
  return out as T;
}

/** A value with its keys in order, so two equal settings compare equal however they were built. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

export const sameSettings = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** A project's overrides by path ("density", "generation.maxGeneratedVideoShare"), as the overrides form holds them. */
export function overridePaths(o: VisualConfigOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of EDITED_PATHS) {
    const v = valueAt(o, p);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/** Overrides from settings by path, nested as the contract takes them. */
export function overridesFrom(paths: Readonly<Record<string, unknown>>): VisualConfigOverrides {
  let o: VisualConfigOverrides = {};
  for (const [p, v] of Object.entries(paths)) if (v !== undefined) o = withValue(o, p, v);
  return o;
}

/** What a form changed from a profile version, as overrides of it ({}: nothing changed). */
export function configChanges(base: VisualStyleProfileConfig, next: VisualStyleProfileConfig): VisualConfigOverrides {
  const changed: Record<string, unknown> = {};
  for (const p of EDITED_PATHS) if (!sameSettings(valueAt(base, p), valueAt(next, p))) changed[p] = valueAt(next, p);
  return overridesFrom(changed);
}

/** A list typed as text: "35mm, 50mm" (empty items dropped). */
export const wordsOf = (text: string) =>
  text
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);

/** A share typed in % (0–100), as the profile keeps it (0–1); undefined when not a number in range. */
export function shareOf(text: string): number | undefined {
  const n = Number(text);
  return text.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 10_000 : undefined;
}

/** Dollars typed (empty: no ceiling, null); undefined when not a number of at least 0. */
export function usdOf(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** "Cinematic History v1 · follows its current version", "… · pinned to v1 (v2 available)", "… · the library default". */
export function productionText(p: { mode: 'FOLLOW' | 'PIN' | 'DEFAULT'; family: { name: string } | null; profile: { version: number } | null; newer: { version: number } | null }): string {
  if (!p.profile || !p.family) return 'none yet (the presets are made when the library is first opened)';
  const how = p.mode === 'PIN' ? `pinned to v${p.profile.version}${p.newer ? ` (v${p.newer.version} available)` : ''}` : p.mode === 'FOLLOW' ? 'follows its current version' : 'the library default';
  return `${p.family.name} v${p.profile.version} · ${how}`;
}

/** Methods as a person picks them for rerolls and provider preferences. */
export const METHOD_CHOICES: readonly { value: ProductionMethod; label: string }[] = choices(PRODUCTION_METHODS, PRODUCTION_METHOD_LABELS);
