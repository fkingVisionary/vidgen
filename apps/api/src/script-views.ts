import {
  QualityReport,
  ScriptContent,
  StoryArchitectureContentV2,
  runtimeTarget,
  scriptTiming,
  type ArtifactCostView,
  type ProjectStatus,
  type ScriptBlockClass,
  type ScriptScore,
  type ScriptVersionFacts,
  type ScriptCompareView,
  type ScriptEditorialActions,
  type ScriptSectionView,
  type ScriptSummaryView,
  type ScriptVersionView,
  type ScriptView,
  type VoiceRenderPlan,
} from '@docengine/core';
import type { Database } from '@docengine/database';
import { SCRIPT_INCLUDE, blockingDetails, compareDrafts, evidenceChanges, toDraft, voicePlan, type ScriptDraft, type ScriptRow } from '@docengine/script';
import { jobCost } from './research-views.ts';
import { evidenceFor } from './story-views.ts';

/** Read models for the script page: versions, the shown version with its sections and blocks, comparisons and the voice plan. */

type Project = { id: string; status: ProjectStatus; failedFromStatus: ProjectStatus | null; targetMinutesMin: number; targetMinutesMax: number };

const SUMMARY_INCLUDE = { story: { select: { version: true } }, revisionOf: { select: { version: true } } } as const;

function summary(row: { id: string; version: number; status: ScriptSummaryView['status']; content: unknown; qualityPassed: boolean; wordCount: number | null; estimatedDurationSec: number | null; targetDurationSec: number | null; createdAt: Date; story: { version: number } | null; revisionOf: { version: number } | null }): ScriptSummaryView {
  const content = ScriptContent.safeParse(row.content);
  const provenance = content.success ? content.data.provenance : null;
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    origin: provenance?.origin ?? 'DRAFT',
    revisionOfVersion: row.revisionOf?.version ?? null,
    sectionsWritten: provenance?.sections ?? [],
    architectureVersion: row.story?.version ?? null,
    qualityPassed: row.qualityPassed,
    wordCount: row.wordCount ?? 0,
    estimatedDurationSec: row.estimatedDurationSec ?? 0,
    targetDurationSec: row.targetDurationSec,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadScriptSummary(db: Database, projectId: string): Promise<ScriptSummaryView | null> {
  const row = await db.script.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: SUMMARY_INCLUDE });
  return row ? summary(row) : null;
}

async function loadVersionView(db: Database, project: Project, row: ScriptRow & { story: { version: number } | null; revisionOf: { version: number } | null }): Promise<ScriptVersionView> {
  const { draft, content } = toDraft(row);
  const report = QualityReport.safeParse(row.qualityReport);
  const architecture = row.storyId ? await db.storyArchitecture.findUnique({ where: { id: row.storyId }, select: { content: true, dossierId: true } }) : null;
  const arch = architecture ? StoryArchitectureContentV2.safeParse(architecture.content) : null;
  const blocks = draft.sections.flatMap((s) => s.blocks);
  const [cost, approvals, evidence] = await Promise.all([
    jobCost(db, row.jobId),
    db.approval.findMany({ where: { scriptId: row.id }, orderBy: { createdAt: 'asc' } }),
    architecture?.dossierId
      ? evidenceFor(db, architecture.dossierId, [...new Set(blocks.flatMap((b) => [...b.claimKeys, ...b.visual.mustShow.flatMap((m) => m.claimKeys)]))], [])
      : Promise.resolve({ claims: [], sources: [] }),
  ]);
  const sections: ScriptSectionView[] = draft.sections.map((s) => ({
    id: s.rowId!,
    key: s.key,
    sequenceNumber: s.sequence,
    title: s.title,
    plan: s.plan,
    reviewStatus: s.reviewStatus,
    editorNotes: s.editorNotes,
    reviewedBy: s.reviewedBy,
    reviewedAt: s.reviewedAt,
    targetDurationSec: s.targetDurationSec,
    estimatedDurationSec: Math.round(s.blocks.reduce((n, b) => n + b.estimatedDurationSec, 0) * 10) / 10,
    wordCount: s.blocks.reduce((n, b) => n + b.wordCount, 0),
    blocks: s.blocks.map(({ rowId, centralQuestion: _cq, ...b }) => ({ ...b, id: rowId! })),
  }));
  const plan = voicePlan(draft);
  return {
    ...summary(row),
    content,
    sections,
    timing: scriptTiming(blocks, runtimeTarget(project)),
    qualityReport: report.success ? report.data : null,
    blocking: blockingDetails(report.success ? report.data : null),
    stats: (row.stats ?? {}) as Record<string, unknown>,
    notes: row.notes,
    cost,
    approvals: approvals.map((x) => ({ id: x.id, gate: x.gate, decision: x.decision, notes: x.notes, decidedBy: x.decidedBy, createdAt: x.createdAt.toISOString() })),
    evidence,
    cast: arch?.success ? arch.data.cast.map((m) => ({ id: m.id, name: m.name, kind: m.kind })) : [],
    voice: { provider: plan.provider, characters: plan.characters, segments: plan.segments.length, pendingPronunciations: plan.pendingPronunciations.length },
  };
}

export async function loadScriptView(db: Database, project: Project, opts: { version?: number }, realStage: boolean): Promise<ScriptView | null> {
  const [rows, approved, running] = await Promise.all([
    db.script.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: SUMMARY_INCLUDE }),
    db.storyArchitecture.findFirst({ where: { projectId: project.id, status: 'APPROVED' }, orderBy: { version: 'desc' } }),
    db.job.count({ where: { projectId: project.id, type: 'SCRIPT', status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);
  const chosen = opts.version === undefined ? rows[0] : rows.find((r) => r.version === opts.version);
  if (opts.version !== undefined && !chosen) return null;
  const full = chosen ? await db.script.findUniqueOrThrow({ where: { id: chosen.id }, include: { ...SCRIPT_INCLUDE, ...SUMMARY_INCLUDE } }) : null;
  const script = full ? await loadVersionView(db, project, full) : null;
  const archContent = approved ? StoryArchitectureContentV2.safeParse(approved.content) : null;
  return {
    scripts: rows.map(summary),
    script,
    architecture: approved
      ? {
          id: approved.id,
          version: approved.version,
          status: approved.status,
          engineVersion: approved.engineVersion === 2 ? 2 : 1,
          logline: archContent?.success ? archContent.data.logline : null,
          centralQuestion: archContent?.success ? archContent.data.centralQuestion : null,
          estimatedDurationSec: approved.estimatedDurationSec,
        }
      : null,
    editorial: editorialActions(project, script, approved ? { id: approved.id, version: approved.version, engineVersion: approved.engineVersion } : null, running > 0, realStage),
    realStage,
  };
}

function editorialActions(project: Project, shown: ScriptVersionView | null, approved: { id: string; version: number; engineVersion: number } | null, running: boolean, realStage: boolean): ScriptEditorialActions {
  const failedScript = project.status === 'FAILED' && project.failedFromStatus === 'SCRIPT_DRAFT';
  const scriptPhase = ['STORY_APPROVED', 'SCRIPT_DRAFT', 'SCRIPT_REVIEW', 'SCRIPT_APPROVED'].includes(project.status) || failedScript;
  const base = !realStage
    ? 'The script stage is a MOCK here: writing a script needs the real AI provider'
    : running
      ? 'A script job is running'
      : !scriptPhase
        ? `Not while the project is in ${project.status}: the script is written once the story architecture is approved`
        : !approved
          ? 'No approved story architecture'
          : approved.engineVersion !== 2
            ? `Architecture v${approved.version} was built by story engine 1; the script engine needs a Story Engine 2.0 architecture`
            : null;
  const current = shown && approved ? shown.content?.architecture.id === approved.id : false;
  const reviseReason = base ?? (!shown ? 'No script yet' : !current ? `Script v${shown.version} tells an earlier architecture: write a new draft` : null);
  const editReason =
    !shown ? 'No script yet' : project.status !== 'SCRIPT_REVIEW' ? `The script is edited while it is under review (the project is ${project.status})` : shown.status !== 'IN_REVIEW' ? `Script v${shown.version} is ${shown.status.toLowerCase()}: only the version under review can be changed` : null;
  const rejected = shown?.sections.filter((s) => s.reviewStatus === 'REJECTED').map((s) => s.sequenceNumber) ?? [];
  const approveReason = editReason ?? (!shown!.qualityPassed ? 'Blocking quality findings: fix them before approving' : rejected.length ? `Rejected section(s) ${rejected.join(', ')}: rewrite or approve them first` : null);
  const restoreReason = !shown
    ? 'No script yet'
    : project.status !== 'SCRIPT_REVIEW'
      ? 'An earlier version can be restored while a version is under review'
      : shown.status === 'IN_REVIEW'
        ? 'This is the version under review'
        : !current
          ? `Script v${shown.version} tells an earlier architecture`
          : null;
  return {
    generate: { allowed: base === null, reason: base },
    revise: { allowed: reviseReason === null, reason: reviseReason },
    refine: { allowed: reviseReason === null, reason: reviseReason },
    edit: { allowed: editReason === null, reason: editReason },
    approve: { allowed: approveReason === null, reason: approveReason },
    restore: { allowed: restoreReason === null, reason: restoreReason },
  };
}

/** What a version is like next to another: its gate, cost, the script editor's scores, words by class. */
async function versionFacts(db: Database, row: ScriptRow, draft: ScriptDraft, content: ScriptContent | null): Promise<ScriptVersionFacts> {
  const report = QualityReport.safeParse(row.qualityReport);
  const checks = report.success ? report.data.checks : [];
  const cost: ArtifactCostView = await jobCost(db, row.jobId);
  const blocks = draft.sections.flatMap((s) => s.blocks);
  const classWords: Partial<Record<ScriptBlockClass, number>> = {};
  for (const b of blocks) classWords[b.infoClass] = (classWords[b.infoClass] ?? 0) + b.wordCount;
  const scores: Partial<Record<ScriptScore, number>> = {};
  for (const [k, v] of Object.entries(content?.editor?.scores ?? {})) if (v) scores[k as ScriptScore] = v.score;
  return {
    gate: { passed: row.qualityPassed, failed: checks.filter((c) => c.status === 'FAIL').map((c) => c.id), warned: checks.filter((c) => c.status === 'WARN').map((c) => c.id) },
    cost,
    scores,
    classWords,
    blocks: blocks.length,
  };
}

export async function loadScriptCompare(db: Database, projectId: string, a: number, b: number): Promise<ScriptCompareView | null> {
  const [ra, rb] = await Promise.all([
    db.script.findUnique({ where: { projectId_version: { projectId, version: a } }, include: { ...SCRIPT_INCLUDE, ...SUMMARY_INCLUDE } }),
    db.script.findUnique({ where: { projectId_version: { projectId, version: b } }, include: { ...SCRIPT_INCLUDE, ...SUMMARY_INCLUDE } }),
  ]);
  if (!ra || !rb) return null;
  const [la, lb] = [toDraft(ra), toDraft(rb)];
  const cmp = compareDrafts(la.draft, lb.draft);
  const [fa, fb] = await Promise.all([versionFacts(db, ra, la.draft, la.content), versionFacts(db, rb, lb.draft, lb.content)]);
  return {
    a: summary(ra),
    b: summary(rb),
    facts: { a: fa, b: fb },
    ...cmp,
    changeLog: lb.content?.provenance.changeLog ?? null,
    assessment: lb.content?.editor?.assessment ?? [],
    evidence: evidenceChanges(la.draft, lb.draft),
  };
}

export async function loadVoicePlan(db: Database, projectId: string, version: number | undefined): Promise<VoiceRenderPlan | null> {
  const row =
    version === undefined
      ? await db.script.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: SCRIPT_INCLUDE })
      : await db.script.findUnique({ where: { projectId_version: { projectId, version } }, include: SCRIPT_INCLUDE });
  return row ? voicePlan(toDraft(row).draft) : null;
}

/** The project and script version a block or section belongs to (for returning the updated view). */
export async function ownerOfBlock(db: Database, blockId: string) {
  return db.scriptBlock.findUnique({ where: { id: blockId }, select: { script: { select: { projectId: true, version: true } } } });
}
export async function ownerOfSection(db: Database, sectionId: string) {
  return db.scene.findUnique({ where: { id: sectionId }, select: { script: { select: { projectId: true, version: true } } } });
}
