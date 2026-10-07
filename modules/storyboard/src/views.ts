import {
  AssemblyEntry,
  SIDE_JOBS,
  StoryboardContent,
  VISUAL_APPROACH_LABELS,
  type ArtifactStatus,
  type ClaimVerdict,
  type ContinuitySubjectView,
  type CostAlternativeView,
  type EditorialAction,
  type JobView,
  type NarrationApproval,
  type NarrationLaneView,
  type ProjectStatus,
  type ShotReviewState,
  type ShotView,
  type StoryboardAssemblyOptionView,
  type StoryboardClaimView,
  type StoryboardDecisionView,
  type StoryboardEditorialActions,
  type StoryboardInputsView,
  type StoryboardQaFinding,
  type StoryboardSummaryView,
  type StoryboardVersionView,
  type StoryboardView,
  type VisualBeatView,
  type VisualCatalog,
  type VisualProductionView,
  type VisualProfileFamilyView,
  type VisualProfileHistoryView,
  type VisualProfileLibraryView,
  type VisualProfileUseView,
  type VisualProfileView,
  type VoiceGenerationStatus,
  type WhyChainView,
  DEFAULT_VISUAL_PROFILE_CONFIG,
} from '@docengine/core';
import type { Database, Project, StoryboardDecision, Tx, VisualProfile, VisualProfileFamily } from '@docengine/database';
import { EVENT } from '@docengine/pipeline';
import { approvedScript, narrationFingerprint } from '@docengine/voice';
import { z } from 'zod';
import { continuityRequirement } from './continuity.ts';
import type { PlannedShot, StoryboardFacts } from './draft.ts';
import { applyEdits, EditError } from './edits.ts';
import { InputError, gateAssemblyId, liveFactsMany, liveNarrationApproval, pinnedFacts, versionFacts } from './inputs.ts';
import { configDifferences, originOf, profileConfig, resolveVisualProduction, unknownPreferences, type VisualProduction } from './profiles.ts';
import { checkStoryboard } from './rules.ts';
import { staleFindings, type LiveFacts, type PinnedFacts } from './stale.ts';
import { STORYBOARD_INCLUDE, latestShotDecisions, toLoaded, type LoadedStoryboard } from './store.ts';
import { displayId } from './timing.ts';

/**
 * The Storyboard page's read models, the visual profile library and a
 * project's production profile. Reads never write: no preset is made here,
 * nothing is re-planned. A version is shown as it was saved, with its QA as
 * saved and live — the version's own checks against the evidence now, and
 * staleness (what it pinned against what is true now), which is derived
 * here and never stored. Every cost is a forecast, never spend.
 */

type Db = Database | Tx;

const audioUrl = (assetId: string | null | undefined) => (assetId ? `/api/voice/audio/${assetId}` : null);

/** Blocking staleness: approval of the version no longer stands. */
const STALE_KINDS = new Set(['STALE_SCRIPT', 'STALE_ARCHITECTURE', 'STALE_NARRATION', 'STALE_VERDICT']);
const isStale = (findings: readonly StoryboardQaFinding[]) => findings.some((f) => STALE_KINDS.has(f.kind) && f.severity === 'BLOCKING');

// ── Live QA ──────────────────────────────────────────────────────────────────

export interface LiveQa {
  /** The version's checks now, and its staleness. */
  findings: StoryboardQaFinding[];
  /** How far its narration is approved now. */
  approval: NarrationApproval;
  /** Its takes approved now. */
  approvedTakes: number;
  /** A blocking STALE_* finding applies. */
  stale: boolean;
  /** What it was checked against (null: its narration or script can no longer be read). */
  facts: StoryboardFacts | null;
  pinned: PinnedFacts;
  live: LiveFacts;
}

/**
 * A saved version's QA now: its own checks against its narration, its
 * script and the evidence as they are (verdicts re-read), and staleness. A
 * version whose narration can no longer be read keeps its saved checks, and
 * blocks on that.
 */
export async function liveQa(db: Db, loaded: LoadedStoryboard, catalog: VisualCatalog, o: { gate?: boolean; live?: LiveFacts } = {}): Promise<LiveQa> {
  const { row, content, planned } = loaded;
  const pinned = pinnedFacts(row, content, planned.shots.map((s) => ({ key: s.key, evidence: s.evidence })));
  const live = o.live ?? (await liveFactsMany(db, row.projectId, [{ pinned, voiceRunId: row.voiceRunId }], catalog))[0]!;
  const stale = staleFindings(pinned, live, o);
  let facts: StoryboardFacts | null = null;
  let checks: StoryboardQaFinding[];
  try {
    facts = await versionFacts(db, row, { catalog, profile: content.inputs.profile });
    checks = checkStoryboard(planned, facts, o);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    checks = [...planned.qa.filter((f) => !f.kind.startsWith('STALE_')), { kind: 'STALE_NARRATION', severity: 'BLOCKING', ref: null, detail: `It can no longer be checked: ${err.message}` }];
  }
  const findings = [...checks, ...stale];
  return {
    findings,
    approval: facts?.narrationApproval ?? liveNarrationApproval(pinned, live, live.pinnedAssemblyStatus),
    approvedTakes: pinned.takes.filter((t) => live.takeStatuses.get(t.id) === 'APPROVED').length,
    stale: isStale(findings),
    facts,
    pinned,
    live,
  };
}

// ── Summaries ────────────────────────────────────────────────────────────────

type SummaryRow = { id: string; version: number; status: string; scope: string; runtimeMs: number | null; beatCount: number; shotCount: number; estimatedCostUsd: unknown; costBasis: string | null; unpricedShotCount: number; qaPassed: boolean; qa: unknown; decidedBy: string | null; decidedAt: Date | null; createdBy: string | null; createdAt: Date };

function summaryOf(row: SummaryRow, content: StoryboardContent, now: { stale: boolean; approval: NarrationApproval }): StoryboardSummaryView {
  const qa = z.array(z.object({ severity: z.string() }).passthrough()).parse(row.qa);
  const n = content.inputs.narration;
  return {
    id: row.id,
    version: row.version,
    status: row.status as StoryboardSummaryView['status'],
    scope: row.scope as StoryboardSummaryView['scope'],
    origin: content.provenance.origin,
    baseVersion: content.provenance.baseVersion,
    approach: content.approaches.chosen,
    runtimeMs: row.runtimeMs,
    beatCount: row.beatCount,
    shotCount: row.shotCount,
    estimatedCostUsd: row.estimatedCostUsd === null ? null : Number(row.estimatedCostUsd),
    costBasis: row.costBasis as StoryboardSummaryView['costBasis'],
    unpricedShotCount: row.unpricedShotCount,
    qaPassed: row.qaPassed,
    blocking: qa.filter((f) => f.severity === 'BLOCKING').length,
    warnings: qa.filter((f) => f.severity === 'WARNING').length,
    narration: { runId: n.runId, runNumber: n.runNumber, runKind: n.runKind, assemblyId: n.assemblyId, assemblyVersion: n.assemblyVersion, approval: now.approval },
    stale: now.stale,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every version of a project, newest first, with its staleness now (a few queries for all of them). */
export async function storyboardSummaries(db: Db, projectId: string, catalog: VisualCatalog): Promise<StoryboardSummaryView[]> {
  const rows = await db.storyboard.findMany({ where: { projectId }, orderBy: { version: 'desc' }, include: { shots: { select: { shotKey: true, evidence: true } } } });
  if (!rows.length) return [];
  const parsed = rows.map((r) => {
    const content = StoryboardContent.parse(r.content);
    const pinned = pinnedFacts(r, content, r.shots.map((s) => ({ key: s.shotKey ?? '', evidence: (s.evidence ?? null) as PinnedFacts['shots'][number]['evidence'] })));
    return { row: r, content, pinned };
  });
  const lives = await liveFactsMany(db, projectId, parsed.map((p) => ({ pinned: p.pinned, voiceRunId: p.row.voiceRunId })), catalog);
  return parsed.map((p, i) => {
    const live = lives[i]!;
    const stale = staleFindings(p.pinned, live);
    return summaryOf(p.row, p.content, { stale: isStale(stale), approval: liveNarrationApproval(p.pinned, live, live.pinnedAssemblyStatus) });
  });
}

/** The project page's storyboard card: its newest version (null: none yet). */
export async function storyboardSummary(db: Db, projectId: string, catalog: VisualCatalog): Promise<StoryboardSummaryView | null> {
  const newest = await db.storyboard.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: { shots: { select: { shotKey: true, evidence: true } } } });
  if (!newest) return null;
  const content = StoryboardContent.parse(newest.content);
  const pinned = pinnedFacts(newest, content, newest.shots.map((s) => ({ key: s.shotKey ?? '', evidence: (s.evidence ?? null) as PinnedFacts['shots'][number]['evidence'] })));
  const [live] = await liveFactsMany(db, projectId, [{ pinned, voiceRunId: newest.voiceRunId }], catalog);
  return summaryOf(newest, content, { stale: isStale(staleFindings(pinned, live!)), approval: liveNarrationApproval(pinned, live!, live!.pinnedAssemblyStatus) });
}

// ── One version ──────────────────────────────────────────────────────────────

/** A claim as the page shows it: what it says and its verdict now, the verdict it had when saved where that differs. */
function claimView(facts: StoryboardFacts | null, c: { claimId: string; claimKey: string; role: ShotView['claims'][number]['role'] }, saved: { verdict: ClaimVerdict; confidence: StoryboardClaimView['confidence']; presentation: StoryboardClaimView['presentation']; sourceIds: string[] } | null, live: LiveFacts): StoryboardClaimView {
  const now = facts?.scope.evidence.claim(c.claimKey);
  const verdict = live.verdicts.get(c.claimId) ?? now?.verdict ?? saved?.verdict ?? 'UNVERIFIED';
  return {
    claimId: c.claimId,
    key: c.claimKey,
    statement: now?.statement ?? '',
    role: c.role,
    verdict,
    savedVerdict: saved && saved.verdict !== verdict ? saved.verdict : null,
    confidence: now?.confidence ?? saved?.confidence ?? 'LOW',
    presentation: facts?.scope.presentation.get(c.claimKey)?.presentation ?? saved?.presentation ?? null,
    sourceIds: now ? facts!.scope.evidence.traceableSources(c.claimKey) : (saved?.sourceIds ?? []),
  };
}

function decisionView(d: StoryboardDecision, shotKey: string | null, versionOf: ReadonlyMap<string, number>): StoryboardDecisionView {
  return {
    id: d.id,
    shotKey,
    decision: d.decision,
    note: d.note,
    decidedBy: d.decidedBy,
    carriedFromVersion: d.carriedFromId ? (versionOf.get(d.carriedFromId) ?? null) : null,
    approvalId: d.approvalId,
    createdAt: d.createdAt.toISOString(),
  };
}

const reviewOf = (d: StoryboardDecision | undefined): ShotReviewState => (d?.decision === 'APPROVED' ? 'APPROVED' : d?.decision === 'REJECTED' ? 'REJECTED' : 'PENDING');

/** The words a range covers, as heard. */
function wordsOf(facts: StoryboardFacts | null, s: Pick<PlannedShot, 'narration'>): string {
  if (!facts || !s.narration) return '';
  const from = facts.spine.point(s.narration.from);
  const to = facts.spine.point(s.narration.to);
  return from && to ? facts.spine.words.slice(from.position, to.position).map((w) => w.text).join(' ') : '';
}

interface VersionContext {
  db: Db;
  catalog: VisualCatalog;
  loaded: LoadedStoryboard;
  qa: LiveQa;
  /** Newest version of the project, if newer than this one. */
  newer: { id: string; version: number; status: string } | null;
  editorial: StoryboardEditorialActions;
}

async function versionView(c: VersionContext): Promise<StoryboardVersionView> {
  const { db, loaded, qa } = c;
  const { row, content, planned } = loaded;
  const facts = qa.facts;
  const scope = facts?.scope ?? null;
  const live = qa.live;

  // Decisions, and the versions carried decisions came from.
  const decisions = await db.storyboardDecision.findMany({ where: { storyboardId: row.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const carriedIds = decisions.flatMap((d) => (d.carriedFromId ? [d.carriedFromId] : []));
  const carriedFrom = carriedIds.length ? await db.storyboardDecision.findMany({ where: { id: { in: carriedIds } }, select: { id: true, storyboard: { select: { version: true } } } }) : [];
  const versionOf = new Map(carriedFrom.map((d) => [d.id, d.storyboard.version]));
  const latest = await latestShotDecisions(db, row.id);
  const shotKeyOf = new Map(row.shots.map((s) => [s.id, s.shotKey]));

  // Sources of the claims shown (traceable ones, with the verified quote).
  const sourceIds = [...new Set(planned.shots.flatMap((s) => s.claimRows.flatMap((r) => (scope ? scope.evidence.traceableSources(r.claimKey) : (s.evidence?.claims.find((x) => x.claimId === r.claimId)?.sourceIds ?? [])))))];
  const sources = sourceIds.length ? await db.source.findMany({ where: { id: { in: sourceIds } }, select: { id: true, title: true, url: true } }) : [];
  const sourceOf = new Map(sources.map((s) => [s.id, s]));

  const beatsByKey = new Map(planned.beats.map((b) => [b.key, b]));
  const rowShot = new Map(row.shots.map((s) => [s.shotKey, s]));
  const rowBeat = new Map(row.beats.map((b) => [b.beatKey, b]));
  const subjects = new Map(planned.subjects.map((s) => [s.key, s]));
  const blockOf = (key: string) => facts?.spine.block(key)?.block ?? null;

  const shots: ShotView[] = planned.shots.map((s) => {
    const r = rowShot.get(s.key)!;
    const beat = beatsByKey.get(s.beatKey);
    const savedClaim = (id: string) => s.evidence?.claims.find((x) => x.claimId === id) ?? null;
    const claims = s.claimRows.map((x) => claimView(facts, x, savedClaim(x.claimId), live));
    const blocks = s.blocks.map((b) => ({ blockId: b.scriptBlockId, blockKey: b.blockKey, startMs: b.startMs, endMs: b.endMs, firstWord: b.firstWord, lastWord: b.lastWord }));
    const archBeatIds = s.evidence?.archBeatIds ?? [];
    const sequence = s.evidence?.sequenceNumber ? (scope?.sequences.get(s.evidence.sequenceNumber) ?? null) : null;
    const why: WhyChainView = {
      shot: { key: s.key, purpose: s.direction.purpose, treatment: s.treatment, depiction: s.direction.depiction, infoClass: s.infoClass },
      beat: { key: s.beatKey, title: beat?.stored.title ?? '', purpose: beat?.stored.purpose ?? '', concept: beat?.stored.concept ?? '' },
      narration: { text: wordsOf(facts, s), startMs: s.timing?.narrationStartMs ?? null, endMs: s.timing?.narrationEndMs ?? null },
      blocks: s.blocks.flatMap((b) => {
        const block = blockOf(b.blockKey);
        return block ? [{ id: b.scriptBlockId, key: b.blockKey, infoClass: block.infoClass, text: block.text, beatIds: block.beatIds }] : [];
      }),
      architecture: {
        beats: archBeatIds.flatMap((id) => {
          const x = scope?.beats.get(id);
          return x ? [{ id, function: x.beat.function, basis: x.beat.basis, description: x.beat.description }] : [];
        }),
        sequence: sequence ? { number: sequence.number, title: sequence.title, setting: sequence.setting } : null,
      },
      claims,
      sources: [...new Set(claims.flatMap((x) => x.sourceIds))].map((id) => {
        const src = sourceOf.get(id);
        const quote = scope ? (claims.flatMap((x) => scope.evidence.claim(x.key)?.citations ?? []).find((ci) => ci.sourceId === id && ci.quoteVerified)?.quote ?? null) : null;
        return { id, title: src?.title ?? id, url: src?.url ?? null, quote };
      }),
    };
    const latestDecision = latest.get(r.id);
    return {
      id: r.id,
      key: s.key,
      beatKey: s.beatKey,
      sortOrder: s.sortOrder,
      sectionKey: s.sectionKey,
      startMs: s.startMs!,
      endMs: s.endMs!,
      durationMs: s.endMs! - s.startMs!,
      relation: s.relation!,
      timing: s.timing!,
      narrationAnchor: s.narrationAnchor,
      narration: { text: why.narration.text, blocks },
      treatment: s.treatment,
      method: s.method,
      infoClass: s.infoClass,
      unplanned: s.unplanned,
      spec: s.direction,
      subjects: s.subjects.map((x) => {
        const subj = subjects.get(x.subjectKey);
        return { subjectKey: x.subjectKey, name: subj?.spec.name ?? x.subjectKey, kind: subj?.spec.kind ?? 'OTHER', castKind: subj?.spec.castKind ?? null, detail: x.detail };
      }),
      claims,
      evidence: s.evidence,
      assetRequirement: s.asset,
      cost: s.cost,
      decision: latestDecision ? decisionView(latestDecision, s.key, versionOf) : null,
      review: reviewOf(latestDecision),
      why,
      findings: qa.findings.filter((f) => f.ref === s.key),
      contentHash: s.contentHash,
    };
  });

  const beats: VisualBeatView[] = planned.beats.map((b) => ({
    id: rowBeat.get(b.key)!.id,
    key: b.key,
    sortOrder: b.sortOrder,
    sectionKey: b.sectionKey,
    sequenceNumber: b.sequenceNumber,
    archBeatIds: b.archBeatIds,
    startMs: b.startMs!,
    endMs: b.endMs!,
    durationMs: b.endMs! - b.startMs!,
    treatment: b.treatment,
    infoClass: b.infoClass,
    content: b.stored,
    blocks: b.blocks.map((x) => ({ blockId: x.scriptBlockId, blockKey: x.blockKey, startMs: x.startMs, endMs: x.endMs, firstWord: x.firstWord, lastWord: x.lastWord })),
    claims: b.claimRows.map((x) => claimView(facts, { ...x, role: null }, null, live)),
    shotKeys: b.shotKeys,
  }));

  const continuity: ContinuitySubjectView[] = planned.subjects.map((s) => ({
    id: row.continuity.find((x) => x.subjectKey === s.key)!.id,
    key: s.key,
    kind: s.spec.kind,
    castId: s.spec.castId,
    name: s.spec.name,
    infoClass: s.infoClass,
    spec: s.spec,
    appearances: s.appearances,
    requirement: continuityRequirement(s.spec),
  }));

  const narrationLane: NarrationLaneView = facts
    ? {
        totalDurationMs: facts.spine.totalDurationMs,
        blocks: facts.spine.blocks.map((b) => ({ id: b.id, key: b.key, sectionKey: b.sectionKey, infoClass: b.block.infoClass, startMs: b.startMs, endMs: b.endMs, text: b.block.text })),
        silences: facts.spine.silences,
        takes: facts.spine.narration.entries.map((e) => {
          const take = facts.spine.narration.takes.find((t) => t.id === e.generationId);
          return { generationId: e.generationId, chunkIndex: e.chunkIndex, status: (live.takeStatuses.get(e.generationId) ?? take?.status ?? 'FAILED') as VoiceGenerationStatus, startMs: e.startMs, endMs: e.endMs, audioUrl: audioUrl(take?.audioAssetId ?? e.audioAssetId) };
        }),
      }
    : { totalDurationMs: row.runtimeMs ?? 0, blocks: [], silences: [], takes: [] };

  const alternatives: CostAlternativeView[] = content.alternatives.map((a) => {
    let apply: EditorialAction = c.editorial.edit;
    if (apply.allowed && facts) {
      try {
        applyEdits(loaded.draft, [{ op: 'applyAlternative', alternativeId: a.id }], facts, { alternatives: content.alternatives });
      } catch (err) {
        if (!(err instanceof EditError)) throw err;
        apply = { allowed: false, reason: err.message };
      }
    }
    return { ...a, apply };
  });

  const newer = c.newer ? await newerOf(db, c.newer, planned.shots) : null;
  const versionDecisions = decisions.filter((d) => !d.shotId).reverse();
  const summary = summaryOf(row, content, { stale: qa.stale, approval: qa.approval });
  return {
    ...summary,
    inputs: content.inputs,
    scopeInfo: content.scope,
    narrationLane,
    cutPoints: facts ? facts.spine.points.map((p) => ({ id: displayId(p), kind: p.kind, blockKey: p.blockKey, atMs: p.atMs, silence: p.silence, midSentence: p.midSentence })) : [],
    beats,
    shots,
    continuity,
    costs: { ...content.costs, catalogVersion: content.inputs.pricing.catalogVersion, pricingChanged: content.inputs.pricing.catalogVersion !== c.catalog.version, actualCostUsd: null },
    approaches: content.approaches.options.map((o) => ({ ...o, label: VISUAL_APPROACH_LABELS[o.approach], chosen: o.approach === content.approaches.chosen })),
    alternatives,
    rhythm: content.rhythm,
    evidenceCoverage: content.evidenceCoverage,
    qa: { saved: planned.qa, live: qa.findings },
    normalization: content.normalization,
    changes: content.changes,
    decisions: versionDecisions.map((d) => decisionView(d, d.shotId ? (shotKeyOf.get(d.shotId) ?? null) : null, versionOf)),
    newer,
    statusNote: await statusNote(db, row, newer, versionDecisions[0]),
  };
}

/** How many shots a newer version changes from this one (added, removed, or with other content or length). */
async function newerOf(db: Db, newer: { id: string; version: number; status: string }, shots: readonly PlannedShot[]): Promise<StoryboardVersionView['newer']> {
  const theirs = await db.shot.findMany({ where: { storyboardId: newer.id }, select: { shotKey: true, contentHash: true, startMs: true, endMs: true } });
  const mine = new Map(shots.map((s) => [s.key, s]));
  let changed = theirs.filter((t) => {
    const m = t.shotKey ? mine.get(t.shotKey) : undefined;
    return !m || m.contentHash !== t.contentHash || m.startMs !== t.startMs || m.endMs !== t.endMs;
  }).length;
  changed += shots.filter((s) => !theirs.some((t) => t.shotKey === s.key)).length;
  return { version: newer.version, status: newer.status as StoryboardVersionView['status'], changedShots: changed };
}

/**
 * "Approved by X on D, superseded by vN on D'": the version's last decision
 * (`last`, version-level), and the save or approval that superseded it, as
 * recorded when it happened.
 */
async function statusNote(db: Db, row: LoadedStoryboard['row'], newer: StoryboardVersionView['newer'], last: StoryboardDecision | undefined): Promise<string | null> {
  const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? '';
  const decided = row.decidedBy ? ` by ${row.decidedBy} on ${day(row.decidedAt)}` : '';
  switch (row.status) {
    case 'APPROVED':
      return `Approved${decided}${newer ? `; the approval applies to v${row.version}: v${newer.version} differs in ${newer.changedShots} shot(s)` : ''}`;
    case 'REJECTED':
      return `Rejected${decided}`;
    case 'CHANGES_REQUESTED':
      return `Changes requested${decided}`;
    case 'SUPERSEDED': {
      const event = await db.projectEvent.findFirst({ where: { projectId: row.projectId, type: EVENT.STORYBOARD_SUPERSEDED, data: { path: ['superseded'], array_contains: [row.version] } }, orderBy: { createdAt: 'asc' }, select: { data: true, createdAt: true } });
      const by = z.object({ by: z.number().int() }).safeParse(event?.data);
      const decision = last?.decision === 'APPROVED' ? 'Approved' : last?.decision === 'CHANGES_REQUESTED' ? 'Changes requested' : null;
      return `${decision ? `${decision}${decided}, superseded` : 'Superseded'}${by.success ? ` by v${by.data.by} on ${day(event!.createdAt)}` : ''}`;
    }
    case 'DRAFT':
      return 'A draft: the project was rewound while it was planned, so it is not reviewed';
    default:
      return null;
  }
}

// ── The page ─────────────────────────────────────────────────────────────────

export interface StoryboardViewDeps {
  db: Database;
  catalog: VisualCatalog;
  /** VISUAL_PLAN and STORYBOARD_PREVIEW are real stages here (the AI provider is configured). */
  realStage: boolean;
  /** The planning job's ceiling, in USD. */
  planningCeilingUsd: number;
  toJobView: (job: never) => JobView;
}

/** Where a new storyboard request may run now: a preview (side job), the phase job, or nothing. */
export const PREVIEW_STATUSES: readonly ProjectStatus[] = SIDE_JOBS.STORYBOARD_PREVIEW ?? [];
export const PHASE_STATUSES: readonly ProjectStatus[] = ['VOICE_COMPLETE', 'VISUAL_PLANNING', 'STORYBOARD_REVIEW', 'STORYBOARD_APPROVED'];
export const phaseAllowed = (p: Pick<Project, 'status' | 'failedFromStatus'>) => PHASE_STATUSES.includes(p.status as ProjectStatus) || (p.status === 'FAILED' && p.failedFromStatus === 'VISUAL_PLANNING');

const ok: EditorialAction = { allowed: true, reason: null };
const no = (reason: string): EditorialAction => ({ allowed: false, reason });

/** What the editor can do on the page now, and why not. */
function editorialOf(o: { project: Project; realStage: boolean; activeJob: { type: string } | null; approved: boolean; loaded: LoadedStoryboard | null; newest: number; underReview: string | null; canRetime: boolean }): StoryboardEditorialActions {
  const { project, loaded } = o;
  const busy = o.activeJob ? no(`A storyboard job (${o.activeJob.type}) is running: wait for it to finish`) : null;
  const notReal = o.realStage ? null : no('The storyboard is planned by the model, which is not configured here (MOCK): nothing would be planned');
  const generate = busy ?? notReal ?? (!o.approved ? no('Approve a script version and narrate it first: a storyboard is planned on the approved script\'s narration') : PREVIEW_STATUSES.includes(project.status as ProjectStatus) || phaseAllowed(project) ? ok : no(`A storyboard is planned while the narration is reviewed or after it is approved, and before visual generation (the project is ${project.status})`));
  if (!loaded) {
    const none = no('No storyboard version yet');
    return { generate, regenerateBeats: none, approach: none, edit: none, retime: none, restore: none, decide: none, decideShots: none };
  }
  const row = loaded.row;
  const newest = row.version === o.newest;
  const kindAllowed = row.scope === 'FULL' ? phaseAllowed(project) : PREVIEW_STATUSES.includes(project.status as ProjectStatus);
  const replan = busy ?? notReal ?? (!newest ? no(`v${o.newest} is the newest version: re-plan from it`) : !kindAllowed ? no(`A ${row.scope === 'FULL' ? 'whole-script storyboard' : 'preview'} is re-planned ${row.scope === 'FULL' ? 'from VOICE_COMPLETE until visual generation' : 'while the narration is reviewed or just approved'} (the project is ${project.status})`) : ok);
  const edit = busy ?? (!newest ? no(`v${o.newest} is the newest version: edit it, or restore this one first`) : ok);
  const reviewable = row.status === 'IN_REVIEW' || row.status === 'CHANGES_REQUESTED';
  // The version in review is decided even when a newer draft exists (an overtaken phase job's draft displaces no review).
  const decide =
    row.scope === 'FULL'
      ? project.status !== 'STORYBOARD_REVIEW'
        ? no(`A whole-script storyboard is decided at the STORYBOARD gate, open in STORYBOARD_REVIEW (the project is ${project.status})`)
        : o.underReview !== row.id
          ? no('Another version is under review at the gate')
          : ok
      : !reviewable
        ? no(`v${row.version} is ${row.status.toLowerCase().replace(/_/g, ' ')}: only a version under review is decided`)
        : o.underReview !== row.id
          ? no('A newer version is under review')
          : ok;
  return {
    generate,
    regenerateBeats: replan,
    approach: replan,
    edit,
    retime: busy ?? (!newest ? no(`v${o.newest} is the newest version`) : o.canRetime ? ok : no('Its voice run has no newer assembly to re-time it onto')),
    restore: busy ?? (newest ? no('It is the newest version') : ok),
    decide,
    decideShots: reviewable ? ok : no(`v${row.version} is ${row.status.toLowerCase().replace(/_/g, ' ')}: its shots are decided while it is under review`),
  };
}

/** The Storyboard page: the versions, one version in full (the newest by default), what can be done, and the running job. */
export async function loadStoryboardView(deps: StoryboardViewDeps, project: Project, version?: number): Promise<StoryboardView> {
  const { db, catalog } = deps;
  const versions = await storyboardSummaries(db, project.id, catalog);
  const newest = versions[0]?.version ?? 0;
  const chosen = version !== undefined ? versions.find((v) => v.version === version) : versions[0];
  const row = chosen ? await db.storyboard.findUnique({ where: { id: chosen.id }, include: STORYBOARD_INCLUDE }) : null;
  const loaded = row ? toLoaded(row) : null;
  const activeJob = await db.job.findFirst({ where: { projectId: project.id, type: { in: ['VISUAL_PLAN', 'STORYBOARD_PREVIEW'] }, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
  const approved = !!(await approvedScript(db, project.id));
  const underReview = await db.storyboard.findFirst({ where: { projectId: project.id, status: { in: ['IN_REVIEW', 'CHANGES_REQUESTED'] } }, orderBy: { version: 'desc' }, select: { id: true } });
  let canRetime = false;
  if (loaded?.row.voiceRunId) {
    const latest = await db.voiceAssembly.findFirst({ where: { runId: loaded.row.voiceRunId }, orderBy: { version: 'desc' }, select: { id: true, entries: true } });
    const entries = z.array(AssemblyEntry).min(1).safeParse(latest?.entries);
    canRetime = !!latest && latest.id !== loaded.row.voiceAssemblyId && entries.success && narrationFingerprint(entries.data) !== loaded.row.narrationFingerprint;
  }
  const editorial = editorialOf({ project, realStage: deps.realStage, activeJob, approved, loaded, newest, underReview: underReview?.id ?? null, canRetime });
  let storyboard: StoryboardVersionView | null = null;
  if (loaded) {
    const qa = await liveQa(db, loaded, catalog);
    const newerRow = loaded.row.version < newest ? versions[0]! : null;
    storyboard = await versionView({ db, catalog, loaded, qa, newer: newerRow ? { id: newerRow.id, version: newerRow.version, status: newerRow.status } : null, editorial });
  }
  return {
    project: { id: project.id, slug: project.slug, title: project.title, status: project.status },
    versions,
    storyboard,
    editorial,
    realStage: deps.realStage,
    activeJob: activeJob ? deps.toJobView(activeJob as never) : null,
  };
}

// ── What a new storyboard would be planned from ──────────────────────────────

/**
 * The approved script and architecture, the project's voice runs with their
 * assemblies (fingerprint, takes approved, mock, whether the VOICE gate
 * approved it), the visual profile, the planning ceiling, and whether a
 * request now would be a preview or the phase job — or why neither.
 */
export async function loadStoryboardInputs(deps: StoryboardViewDeps, project: Project): Promise<StoryboardInputsView> {
  const { db } = deps;
  const approved = await approvedScript(db, project.id);
  const script = approved ? await db.script.findUnique({ where: { id: approved.id }, select: { id: true, version: true, status: true, storyId: true } }) : null;
  const architecture = script?.storyId ? await db.storyArchitecture.findUnique({ where: { id: script.storyId }, select: { id: true, version: true, status: true } }) : null;
  const gate = await gateAssemblyId(db, project.id);
  const runs = await db.voiceRun.findMany({ where: { projectId: project.id }, orderBy: { number: 'desc' }, include: { assemblies: { orderBy: { version: 'desc' } } } });
  const takeIds = new Set<string>();
  const entriesOf = new Map<string, AssemblyEntry[]>();
  for (const r of runs)
    for (const a of r.assemblies) {
      const e = z.array(AssemblyEntry).safeParse(a.entries);
      const entries = e.success ? e.data : [];
      entriesOf.set(a.id, entries);
      for (const x of entries) takeIds.add(x.generationId);
    }
  const takes = await db.voiceGeneration.findMany({ where: { id: { in: [...takeIds] } }, select: { id: true, status: true, alignment: true, audioAsset: { select: { isMock: true } } } });
  const takeOf = new Map(takes.map((t) => [t.id, t]));
  const mockTake = (t: (typeof takes)[number] | undefined) => !t || !!t.audioAsset?.isMock || (t.alignment as { source?: unknown } | null)?.source === 'MOCK';
  const production = await loadVisualProduction({ db, catalog: deps.catalog }, project.id);
  const activeJob = await db.job.findFirst({ where: { projectId: project.id, type: { in: ['VISUAL_PLAN', 'STORYBOARD_PREVIEW'] }, status: { in: ['QUEUED', 'RUNNING'] } }, select: { type: true } });
  const runViews: StoryboardInputsView['runs'] = runs.map((r) => {
    const scope = z.object({ blockKeys: z.array(z.string()) }).safeParse(r.scope);
    return {
      id: r.id,
      number: r.number,
      kind: r.kind,
      label: `${r.kind === 'FULL' ? 'Full narration' : r.kind === 'AUDITION' ? 'Audition' : r.kind.charAt(0) + r.kind.slice(1).toLowerCase()} — run ${r.number}${r.experiment ? ` (${r.experiment}${r.variant ? `: ${r.variant}` : ''})` : ''}`,
      scopeBlockKeys: scope.success ? scope.data.blockKeys : [],
      current: !!approved && r.scriptId === approved.id,
      assemblies: r.assemblies.map((a): StoryboardAssemblyOptionView => {
        const entries = entriesOf.get(a.id) ?? [];
        const statuses = entries.map((e) => (takeOf.get(e.generationId)?.status ?? 'FAILED') as VoiceGenerationStatus);
        const gateApproved = a.id === gate;
        return {
          id: a.id,
          version: a.version,
          status: a.status as ArtifactStatus,
          complete: a.complete,
          totalDurationMs: a.totalDurationMs,
          fingerprint: entries.length ? narrationFingerprint(entries) : '',
          takes: { approved: statuses.filter((s) => s === 'APPROVED').length, total: statuses.length },
          mock: entries.some((e) => mockTake(takeOf.get(e.generationId))),
          approval: a.status === 'APPROVED' && gateApproved ? 'GATE_APPROVED' : statuses.length && statuses.every((s) => s === 'APPROVED') ? 'TAKES_APPROVED' : 'UNREVIEWED',
          gateApproved,
        };
      }),
    };
  });
  const gateRun = runs.find((r) => r.assemblies.some((a) => a.id === gate));
  const kind: StoryboardInputsView['kind'] = gateRun && phaseAllowed(project) ? 'PHASE' : PREVIEW_STATUSES.includes(project.status as ProjectStatus) ? 'PREVIEW' : null;
  const blocked = !deps.realStage
    ? 'The storyboard is planned by the model, which is not configured here (MOCK)'
    : !approved
      ? 'No approved script: a storyboard is planned on the approved script\'s narration'
      : !runViews.some((r) => r.current && r.assemblies.length)
        ? `No narration of script v${approved.version} yet: generate one on the Voice page`
        : activeJob
          ? `A storyboard job (${activeJob.type}) is running`
          : !kind
            ? `A storyboard is planned while the narration is reviewed or after it is approved, and before visual generation (the project is ${project.status})`
            : null;
  return {
    script: script ? { id: script.id, version: script.version, status: script.status as ArtifactStatus } : null,
    architecture: architecture ? { id: architecture.id, version: architecture.version, status: architecture.status as ArtifactStatus } : null,
    runs: runViews,
    profile: production,
    planningCeilingUsd: deps.planningCeilingUsd,
    kind,
    blocked,
  };
}

// ── The visual profile library ───────────────────────────────────────────────

/** What the library and production views read with. */
export interface VisualProfileViewDeps {
  db: Db;
  catalog: VisualCatalog;
}

/** Views of profile versions: current or not, what changed from the version before, unknown preferences, storyboards made with it. */
export async function profileViews(deps: VisualProfileViewDeps, versions: readonly VisualProfile[]): Promise<VisualProfileView[]> {
  const { db, catalog } = deps;
  const familyIds = [...new Set(versions.map((v) => v.familyId))];
  const siblings = familyIds.length ? await db.visualProfile.findMany({ where: { familyId: { in: familyIds } }, orderBy: { version: 'asc' } }) : [];
  const ids = versions.map((v) => v.id);
  const used = ids.length ? await db.storyboard.groupBy({ by: ['visualProfileId'], where: { visualProfileId: { in: ids } }, _count: { _all: true } }) : [];
  return versions.map((v) => {
    const family = siblings.filter((s) => s.familyId === v.familyId);
    const previous = family.filter((s) => s.version < v.version).at(-1);
    const config = profileConfig(v);
    return {
      id: v.id,
      familyId: v.familyId,
      name: v.name,
      version: v.version,
      config,
      current: family.at(-1)?.id === v.id,
      origin: originOf(v),
      changes: previous ? configDifferences(profileConfig(previous), config) : [],
      unknownPreferences: unknownPreferences(config, catalog),
      notes: v.notes,
      createdBy: v.createdBy,
      createdAt: v.createdAt.toISOString(),
      storyboards: used.find((u) => u.visualProfileId === v.id)?._count._all ?? 0,
    };
  });
}

async function familyViews(deps: VisualProfileViewDeps, families: readonly VisualProfileFamily[]): Promise<VisualProfileFamilyView[]> {
  const { db } = deps;
  if (!families.length) return [];
  const ids = families.map((f) => f.id);
  const versions = await db.visualProfile.findMany({ where: { familyId: { in: ids } }, orderBy: { version: 'asc' } });
  const ofFamily = (id: string) => versions.filter((v) => v.familyId === id);
  const currents = families.map((f) => ofFamily(f.id).at(-1)).filter((v): v is VisualProfile => !!v);
  const currentViews = new Map((await profileViews(deps, currents)).map((v) => [v.id, v]));
  const used = await db.storyboard.groupBy({ by: ['visualProfileId'], where: { visualProfileId: { in: versions.map((v) => v.id) } }, _count: { _all: true } });
  const usedOf = new Map(used.map((u) => [u.visualProfileId, u._count._all]));
  const uses = await db.visualSelection.findMany({ where: { familyId: { in: ids } }, orderBy: { updatedAt: 'desc' }, include: { project: { select: { id: true, slug: true, title: true } }, pinnedVersion: { select: { version: true } } } });
  return families.map((f) => {
    const own = ofFamily(f.id);
    const current = own.at(-1) ?? null;
    const first = own[0];
    const origin = first ? originOf(first) : null;
    const usedBy: VisualProfileUseView[] = uses.filter((u) => u.familyId === f.id).map((u) => ({ projectId: u.project.id, slug: u.project.slug, title: u.project.title, mode: u.pinnedVersionId ? 'PIN' : 'FOLLOW', pinnedVersion: u.pinnedVersion?.version ?? null }));
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      isDefault: f.isDefault,
      archived: !!f.archivedAt,
      preset: origin?.kind === 'PRESET' ? origin.preset : null,
      current: current ? (currentViews.get(current.id) ?? null) : null,
      versions: own.length,
      usedBy,
      storyboards: own.reduce((n, v) => n + (usedOf.get(v.id) ?? 0), 0),
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    };
  });
}

/** Library families, the default first, then by name (archived ones only when asked for). */
const listFamilies = (db: Db, archived: boolean) => db.visualProfileFamily.findMany({ where: archived ? {} : { archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });

/** The visual profile library, with a new profile's starting point. */
export async function loadVisualLibrary(deps: VisualProfileViewDeps, opts: { archived: boolean }): Promise<VisualProfileLibraryView> {
  return { defaults: structuredClone(DEFAULT_VISUAL_PROFILE_CONFIG), families: await familyViews(deps, await listFamilies(deps.db, opts.archived)) };
}

/** A visual profile with every version, newest first (null: no such profile). */
export async function loadVisualProfileHistory(deps: VisualProfileViewDeps, familyId: string): Promise<VisualProfileHistoryView | null> {
  const family = await deps.db.visualProfileFamily.findUnique({ where: { id: familyId } });
  if (!family) return null;
  const [view] = await familyViews(deps, [family]);
  const versions = await deps.db.visualProfile.findMany({ where: { familyId }, orderBy: { version: 'desc' } });
  return { ...view!, history: await profileViews(deps, versions) };
}

/** A production profile as a view. */
export async function productionView(deps: VisualProfileViewDeps, p: VisualProduction): Promise<VisualProductionView> {
  const [profile] = p.version ? await profileViews(deps, [p.version]) : [];
  const effective = p.effective ?? (p.mode === 'DEFAULT' && !p.version ? structuredClone(DEFAULT_VISUAL_PROFILE_CONFIG) : null);
  return {
    mode: p.mode,
    revision: p.revision,
    family: p.family ? { id: p.family.id, name: p.family.name, archived: !!p.family.archivedAt, isDefault: p.family.isDefault } : null,
    profile: profile ?? null,
    newer: p.newer ? { id: p.newer.id, version: p.newer.version } : null,
    overrides: p.overrides,
    effective,
    provenance: p.provenance,
    notices: [...p.notices, ...(effective ? unknownPreferences(effective, deps.catalog) : [])],
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt?.toISOString() ?? null,
  };
}

/** What a project's storyboards are planned with now (a read: the presets are not made here). */
export async function loadVisualProduction(deps: VisualProfileViewDeps, projectId: string): Promise<VisualProductionView> {
  return productionView(deps, await resolveVisualProduction(deps.db, projectId));
}
