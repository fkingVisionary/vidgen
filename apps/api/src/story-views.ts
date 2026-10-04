import {
  MythThread,
  QualityReport,
  STORY_LIMITS,
  StoryArchitectureContent,
  StoryCharacter,
  StoryPackContent,
  StoryScores,
  selectionProblem,
  type ProjectStatus,
  type StoryArchitectureSummaryView,
  type StoryArchitectureView,
  type StoryCandidateView,
  type StoryEvidenceView,
  type StoryPackSummaryView,
  type StoryPackView,
  type StorySummaryView,
  type StoryView,
} from '@docengine/core';
import type { Database, StoryArchitecture, StoryPack } from '@docengine/database';
import { EvidenceBase } from '@docengine/story';
import { z } from 'zod';
import { jobCost, toClaimView } from './research-views.ts';

/** Read model for the story page: candidate packs, architectures and the evidence they cite. */

const EMPTY_PACK_CONTENT: StoryPackContent = {
  selection: { candidateKeys: [], workingPremise: '', rationale: '', alternates: [] },
  removed: [],
  carriedOver: [],
  editorNotes: null,
};

const Characters = z.array(StoryCharacter);

function packSummary(p: StoryPack & { _count: { candidates: number } }, selectedCount: number): StoryPackSummaryView {
  return {
    id: p.id,
    version: p.version,
    status: p.status,
    qualityPassed: p.qualityPassed,
    candidateCount: p._count.candidates,
    selectedCount,
    createdAt: p.createdAt.toISOString(),
  };
}

function architectureSummary(a: StoryArchitecture & { pack: { version: number } | null }): StoryArchitectureSummaryView {
  const content = StoryArchitectureContent.safeParse(a.content);
  return {
    id: a.id,
    version: a.version,
    status: a.status,
    qualityPassed: a.qualityPassed,
    packVersion: a.pack?.version ?? null,
    sequenceCount: content.success ? content.data.sequences.length : 0,
    estimatedDurationSec: a.estimatedDurationSec,
    targetDurationSec: a.targetDurationSec,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Selected (and not rejected) candidates per pack. */
async function selectedCounts(db: Database, projectId: string): Promise<Map<string, number>> {
  const rows = await db.storyCandidate.groupBy({ by: ['packId'], where: { projectId, selected: true, status: { not: 'REJECTED' } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.packId, r._count._all]));
}

/** Claims of one dossier by key, with the sources they cite plus `extraSourceIds`. */
async function evidenceFor(db: Database, dossierId: string, keys: readonly string[], extraSourceIds: readonly string[]): Promise<StoryEvidenceView> {
  const claims = await db.researchClaim.findMany({
    where: { dossierId, claimKey: { in: [...new Set(keys)] } },
    orderBy: { sortOrder: 'asc' },
    include: { citations: true },
  });
  const sourceIds = new Set([...extraSourceIds, ...claims.flatMap((c) => c.citations.map((x) => x.sourceId))]);
  const sources = await db.source.findMany({ where: { id: { in: [...sourceIds] } }, orderBy: { createdAt: 'asc' } });
  return {
    claims: claims.map(toClaimView),
    sources: sources.map((s) => ({ id: s.id, title: s.title, url: s.url, domain: s.domain, sourceType: s.sourceType, author: s.author, publishedDate: s.publishedDate })),
  };
}

export async function loadStoryView(
  db: Database,
  project: { id: string; status: ProjectStatus },
  opts: { pack?: number; architecture?: number } = {},
): Promise<StoryView | null> {
  const [packs, counts, architectures] = await Promise.all([
    db.storyPack.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: { _count: { select: { candidates: true } } } }),
    selectedCounts(db, project.id),
    db.storyArchitecture.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: { pack: { select: { version: true } } } }),
  ]);
  const chosenPack = opts.pack === undefined ? packs[0] : packs.find((p) => p.version === opts.pack);
  const chosenArch = opts.architecture === undefined ? architectures[0] : architectures.find((a) => a.version === opts.architecture);
  if ((opts.pack !== undefined && !chosenPack) || (opts.architecture !== undefined && !chosenArch)) return null;

  const pack = chosenPack ? await loadPack(db, chosenPack, counts.get(chosenPack.id) ?? 0) : null;
  const architecture = chosenArch ? await loadArchitecture(db, chosenArch) : null;
  const count = pack?.candidates.filter((c) => c.selected && c.status !== 'REJECTED').length ?? 0;
  return {
    packs: packs.map((p) => packSummary(p, counts.get(p.id) ?? 0)),
    pack,
    architectures: architectures.map(architectureSummary),
    architecture,
    editable: project.status === 'STORY_SELECTION' && chosenPack !== undefined && chosenPack.id === packs[0]?.id && chosenPack.status === 'IN_REVIEW',
    selection: { count, min: STORY_LIMITS.selection.min, max: STORY_LIMITS.selection.max, problem: pack ? selectionProblem(count) : 'No story pack yet' },
  };
}

async function loadPack(db: Database, p: StoryPack & { _count: { candidates: number } }, selected: number): Promise<StoryPackView> {
  const [rows, dossier, cost, evidenceBase] = await Promise.all([
    db.storyCandidate.findMany({
      where: { packId: p.id },
      orderBy: { rank: 'asc' },
      include: { claims: { include: { claim: { select: { claimKey: true, sortOrder: true } } } } },
    }),
    db.researchDossier.findUniqueOrThrow({ where: { id: p.dossierId }, select: { version: true } }),
    jobCost(db, p.jobId),
    EvidenceBase.load(db, p.dossierId),
  ]);
  const candidates: StoryCandidateView[] = rows.map((c) => {
    const claimKeys = [...c.claims].sort((a, b) => a.claim.sortOrder - b.claim.sortOrder).map((x) => x.claim.claimKey);
    const characters = Characters.safeParse(c.characters);
    const myth = c.mythThread === null ? null : MythThread.safeParse(c.mythThread);
    const scores = StoryScores.safeParse(c.scores);
    return {
      id: c.id,
      key: c.candidateKey,
      title: c.title,
      hook: c.hook,
      storyType: c.storyType,
      characters: characters.success ? characters.data : [],
      setting: c.setting,
      timePeriod: c.timePeriod,
      desire: c.desire,
      conflict: c.conflict,
      stakes: c.stakes,
      escalation: c.escalation,
      turningPoint: c.turningPoint,
      payoff: c.payoff,
      whyInteresting: c.whyInteresting,
      viewerQuestion: c.viewerQuestion,
      mythThread: myth?.success ? myth.data : null,
      scores: scores.success ? scores.data : null,
      historicalStatus: c.historicalStatus,
      historicalConfidence: c.historicalConfidence,
      rankScore: c.rankScore,
      rank: c.rank,
      notes: c.notes,
      aiSelected: c.aiSelected,
      aiSelectionReason: c.aiSelectionReason,
      status: c.status,
      selected: c.selected,
      priority: c.priority,
      editorNotes: c.editorNotes,
      claimKeys,
      sourceIds: evidenceBase.sourcesFor(claimKeys),
      updatedAt: c.updatedAt.toISOString(),
    };
  });
  const content = StoryPackContent.safeParse(p.content);
  const report = QualityReport.safeParse(p.qualityReport);
  const evidence = await evidenceFor(
    db,
    p.dossierId,
    candidates.flatMap((c) => c.claimKeys),
    candidates.flatMap((c) => c.sourceIds),
  );
  return {
    ...packSummary(p, selected),
    dossierId: p.dossierId,
    dossierVersion: dossier.version,
    content: content.success ? content.data : EMPTY_PACK_CONTENT,
    qualityReport: report.success ? report.data : null,
    stats: (p.stats ?? {}) as Record<string, unknown>,
    notes: p.notes,
    cost,
    candidates,
    evidence,
  };
}

async function loadArchitecture(db: Database, a: StoryArchitecture & { pack: { version: number } | null }): Promise<StoryArchitectureView> {
  const content = StoryArchitectureContent.safeParse(a.content);
  const report = QualityReport.safeParse(a.qualityReport);
  const sequences = content.success ? content.data.sequences : [];
  const [approvals, cost, dossier, evidence] = await Promise.all([
    db.approval.findMany({ where: { storyId: a.id }, orderBy: { createdAt: 'asc' } }),
    jobCost(db, a.jobId),
    a.dossierId ? db.researchDossier.findUnique({ where: { id: a.dossierId }, select: { version: true } }) : Promise.resolve(null),
    a.dossierId
      ? evidenceFor(
          db,
          a.dossierId,
          sequences.flatMap((s) => [...s.claimKeys, ...s.contextClaims.map((c) => c.claimKey)]),
          sequences.flatMap((s) => [...s.sourceIds, ...s.contextSourceIds]),
        )
      : Promise.resolve({ claims: [], sources: [] }),
  ]);
  return {
    ...architectureSummary(a),
    packId: a.packId,
    dossierVersion: dossier?.version ?? null,
    content: content.success ? content.data : null,
    qualityReport: report.success ? report.data : null,
    stats: (a.stats ?? {}) as Record<string, unknown>,
    notes: a.notes,
    cost,
    approvals: approvals.map((x) => ({ id: x.id, gate: x.gate, decision: x.decision, notes: x.notes, decidedBy: x.decidedBy, createdAt: x.createdAt.toISOString() })),
    evidence,
  };
}

/** Latest pack and architecture, for the project page. */
export async function loadStorySummary(db: Database, projectId: string): Promise<StorySummaryView> {
  const [pack, architecture] = await Promise.all([
    db.storyPack.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: { _count: { select: { candidates: true } } } }),
    db.storyArchitecture.findFirst({ where: { projectId }, orderBy: { version: 'desc' }, include: { pack: { select: { version: true } } } }),
  ]);
  const selected = pack ? await db.storyCandidate.count({ where: { packId: pack.id, selected: true, status: { not: 'REJECTED' } } }) : 0;
  return {
    pack: pack ? packSummary(pack, selected) : null,
    architecture: architecture ? architectureSummary(architecture) : null,
  };
}

/** Why STORY_ARCHITECTURE cannot be enqueued now, or null if it can. */
export async function architecturePreflight(db: Database, projectId: string): Promise<string | null> {
  const pack = await db.storyPack.findFirst({ where: { projectId, status: 'IN_REVIEW' }, orderBy: { version: 'desc' }, select: { id: true } });
  if (!pack) return 'No story pack is open for selection: run Story Mining first';
  const count = await db.storyCandidate.count({ where: { packId: pack.id, selected: true, status: { not: 'REJECTED' } } });
  return selectionProblem(count);
}
