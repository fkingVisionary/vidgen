import {
  AnyStoryArchitectureContent,
  AnyStoryScores,
  CandidateOverrides,
  ContentOpportunityContent,
  HumanStakes,
  MythThread,
  PovChoice,
  QualityReport,
  STORY_LIMITS,
  StoryCharacter,
  StoryDesign,
  StoryPackContent,
  isArchitectureV2,
  selectionProblem,
  type ContentOpportunityView,
  type ContentPackageRequest,
  type ContentPackageView,
  type ProjectStatus,
  type StoryArchitectureSummaryView,
  type StoryArchitectureView,
  type StoryCandidateView,
  type StoryEngineVersion,
  type StoryEvidenceView,
  type StoryPackSummaryView,
  type StoryPackView,
  type StorySummaryView,
  type StoryView,
} from '@docengine/core';
import type { ContentOpportunity, Database, StoryArchitecture, StoryPack } from '@docengine/database';
import { EvidenceBase } from '@docengine/story';
import { z } from 'zod';
import { jobCost, toClaimView } from './research-views.ts';

/** Read model for the story page: candidate packs, architectures, content opportunities and the evidence they cite. */

const EMPTY_PACK_CONTENT: StoryPackContent = {
  selection: { candidateKeys: [], workingPremise: '', rationale: '', alternates: [], centralQuestion: '', narrativeMode: null, povStrategy: null },
  removed: [],
  carriedOver: [],
  editorNotes: null,
};

const Characters = z.array(StoryCharacter);
const engine = (v: number): StoryEngineVersion => (v === 2 ? 2 : 1);
const parsed = <T>(schema: z.ZodType<T>, value: unknown): T | null => {
  if (value === null || value === undefined) return null;
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
};

type OpportunityCounts = StoryArchitectureSummaryView['opportunities'];
const NO_OPPORTUNITIES: OpportunityCounts = { shorts: 0, longForm: 0, approved: 0 };

function packSummary(p: StoryPack & { _count: { candidates: number } }, selectedCount: number): StoryPackSummaryView {
  return {
    id: p.id,
    version: p.version,
    engineVersion: engine(p.engineVersion),
    status: p.status,
    qualityPassed: p.qualityPassed,
    candidateCount: p._count.candidates,
    selectedCount,
    createdAt: p.createdAt.toISOString(),
  };
}

function architectureSummary(a: StoryArchitecture & { pack: { version: number } | null }, counts: OpportunityCounts): StoryArchitectureSummaryView {
  const content = AnyStoryArchitectureContent.safeParse(a.content);
  return {
    id: a.id,
    version: a.version,
    engineVersion: engine(a.engineVersion),
    opportunities: counts,
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

/** Opportunity counts per architecture. */
async function opportunityCounts(db: Database, projectId: string): Promise<Map<string, OpportunityCounts>> {
  const rows = await db.contentOpportunity.groupBy({ by: ['architectureId', 'format', 'status'], where: { projectId }, _count: { _all: true } });
  const out = new Map<string, OpportunityCounts>();
  for (const r of rows) {
    const c = out.get(r.architectureId) ?? { ...NO_OPPORTUNITIES };
    if (r.format === 'LONG_FORM') c.longForm += r._count._all;
    else c.shorts += r._count._all;
    if (r.status === 'APPROVED') c.approved += r._count._all;
    out.set(r.architectureId, c);
  }
  return out;
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
  const [packs, counts, architectures, oppCounts] = await Promise.all([
    db.storyPack.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: { _count: { select: { candidates: true } } } }),
    selectedCounts(db, project.id),
    db.storyArchitecture.findMany({ where: { projectId: project.id }, orderBy: { version: 'desc' }, include: { pack: { select: { version: true } } } }),
    opportunityCounts(db, project.id),
  ]);
  const chosenPack = opts.pack === undefined ? packs[0] : packs.find((p) => p.version === opts.pack);
  const chosenArch = opts.architecture === undefined ? architectures[0] : architectures.find((a) => a.version === opts.architecture);
  if ((opts.pack !== undefined && !chosenPack) || (opts.architecture !== undefined && !chosenArch)) return null;

  const pack = chosenPack ? await loadPack(db, chosenPack, counts.get(chosenPack.id) ?? 0) : null;
  const architecture = chosenArch ? await loadArchitecture(db, chosenArch, oppCounts.get(chosenArch.id) ?? NO_OPPORTUNITIES) : null;
  const count = pack?.candidates.filter((c) => c.selected && c.status !== 'REJECTED').length ?? 0;
  return {
    packs: packs.map((p) => packSummary(p, counts.get(p.id) ?? 0)),
    pack,
    architectures: architectures.map((a) => architectureSummary(a, oppCounts.get(a.id) ?? NO_OPPORTUNITIES)),
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
    const overrides = parsed(CandidateOverrides, c.editorOverrides) ?? {};
    const aiPov = parsed(PovChoice, c.povStrategy);
    return {
      id: c.id,
      key: c.candidateKey,
      engineVersion: engine(p.engineVersion),
      title: overrides.title ?? c.title,
      aiTitle: c.title,
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
      scores: parsed(AnyStoryScores, c.scores),
      storyValue: c.storyValue,
      historicalValue: c.historicalValue,
      narrativeMode: overrides.narrativeMode ?? c.narrativeMode,
      aiNarrativeMode: c.narrativeMode,
      centralQuestion: overrides.centralQuestion ?? c.centralQuestion,
      aiCentralQuestion: c.centralQuestion,
      povStrategy: overrides.povStrategy ?? aiPov,
      aiPovStrategy: aiPov,
      humanStakes: parsed(HumanStakes, c.humanStakes),
      storyDesign: parsed(StoryDesign, c.storyDesign),
      reconstructionLevel: c.reconstructionLevel,
      editorOverrides: overrides,
      selectionOrder: c.selectionOrder,
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

/** Every claim key an architecture's content refers to (both engines). */
function contentClaimKeys(content: AnyStoryArchitectureContent | null): { keys: string[]; sourceIds: string[] } {
  if (!content) return { keys: [], sourceIds: [] };
  if (isArchitectureV2(content)) {
    return {
      keys: [
        ...content.cast.flatMap((m) => m.claimKeys),
        ...content.sequences.flatMap((s) => [
          ...s.claimKeys,
          ...s.contextClaims.map((c) => c.claimKey),
          ...s.beats.flatMap((b) => b.claimKeys),
          ...s.presentation.map((p) => p.claimKey),
          ...s.visual.mustShow.flatMap((m) => m.claimKeys),
        ]),
      ],
      sourceIds: content.sequences.flatMap((s) => [...s.sourceIds, ...s.contextSourceIds]),
    };
  }
  return {
    keys: content.sequences.flatMap((s) => [...s.claimKeys, ...s.contextClaims.map((c) => c.claimKey)]),
    sourceIds: content.sequences.flatMap((s) => [...s.sourceIds, ...s.contextSourceIds]),
  };
}

type OpportunityRow = ContentOpportunity & { claims: { claimId: string }[]; architecture: { version: number; status: StoryArchitecture['status'] } };

export function toOpportunityView(o: OpportunityRow): ContentOpportunityView {
  return {
    id: o.id,
    key: o.opportunityKey,
    architectureId: o.architectureId,
    architectureVersion: o.architecture.version,
    format: o.format,
    status: o.status,
    rank: o.rank,
    shortScore: o.shortScore,
    title: o.title,
    hook: o.hook,
    centralQuestion: o.centralQuestion,
    targetDurationSec: o.targetDurationSec,
    independent: o.independent,
    requiresContext: o.requiresContext,
    historicalStatus: o.historicalStatus,
    historicalConfidence: o.historicalConfidence,
    content: parsed(ContentOpportunityContent, o.content),
    claimIds: o.claims.map((c) => c.claimId),
    editorNotes: o.editorNotes,
    decidedBy: o.decidedBy,
    decidedAt: o.decidedAt?.toISOString() ?? null,
    eligible: o.status === 'APPROVED' && o.architecture.status === 'APPROVED',
    createdAt: o.createdAt.toISOString(),
  };
}

/** Opportunities of one architecture: shorts by rank, then long-form, then by key. */
async function opportunitiesOf(db: Database, architectureId: string): Promise<ContentOpportunityView[]> {
  const rows = await db.contentOpportunity.findMany({
    where: { architectureId },
    orderBy: [{ rank: { sort: 'asc', nulls: 'last' } }, { opportunityKey: 'asc' }],
    include: { claims: { select: { claimId: true } }, architecture: { select: { version: true, status: true } } },
  });
  return rows.map(toOpportunityView);
}

async function loadArchitecture(db: Database, a: StoryArchitecture & { pack: { version: number } | null }, counts: OpportunityCounts): Promise<StoryArchitectureView> {
  const parsedContent = AnyStoryArchitectureContent.safeParse(a.content);
  const content = parsedContent.success ? parsedContent.data : null;
  const report = QualityReport.safeParse(a.qualityReport);
  const refs = contentClaimKeys(content);
  const [approvals, cost, dossier, opportunityList] = await Promise.all([
    db.approval.findMany({ where: { storyId: a.id }, orderBy: { createdAt: 'asc' } }),
    jobCost(db, a.jobId),
    a.dossierId ? db.researchDossier.findUnique({ where: { id: a.dossierId }, select: { version: true } }) : Promise.resolve(null),
    opportunitiesOf(db, a.id),
  ]);
  const evidence = a.dossierId
    ? await evidenceFor(
        db,
        a.dossierId,
        [...refs.keys, ...opportunityList.flatMap((o) => o.content?.claimKeys ?? [])],
        [...refs.sourceIds, ...opportunityList.flatMap((o) => o.content?.sourceIds ?? [])],
      )
    : { claims: [], sources: [] };
  return {
    ...architectureSummary(a, counts),
    packId: a.packId,
    dossierVersion: dossier?.version ?? null,
    content,
    opportunityList,
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
  const counts = architecture ? ((await opportunityCounts(db, projectId)).get(architecture.id) ?? NO_OPPORTUNITIES) : NO_OPPORTUNITIES;
  return {
    pack: pack ? packSummary(pack, selected) : null,
    architecture: architecture ? architectureSummary(architecture, counts) : null,
  };
}

/** Why STORY_ARCHITECTURE cannot be enqueued now, or null if it can. */
export async function architecturePreflight(db: Database, projectId: string): Promise<string | null> {
  const pack = await db.storyPack.findFirst({ where: { projectId, status: 'IN_REVIEW' }, orderBy: { version: 'desc' }, select: { id: true } });
  if (!pack) return 'No story pack is open for selection: run Story Mining first';
  const count = await db.storyCandidate.count({ where: { packId: pack.id, selected: true, status: { not: 'REJECTED' } } });
  return selectionProblem(count);
}

/**
 * What a content package request would contain today, e.g. { documentary: true,
 * shorts: 6, languages: ["en", "es"] }: the latest APPROVED architecture as the
 * long-form documentary and its approved short opportunities by rank. Read-only:
 * nothing is generated, and localization is only recorded.
 */
export async function loadContentPackage(db: Database, project: { id: string; masterLanguage: string }, request: ContentPackageRequest): Promise<ContentPackageView> {
  const approved = await db.storyArchitecture.findFirst({ where: { projectId: project.id, status: 'APPROVED' }, orderBy: { version: 'desc' } });
  const latest = approved ?? (await db.storyArchitecture.findFirst({ where: { projectId: project.id }, orderBy: { version: 'desc' } }));
  const notes: string[] = ['Nothing has been generated: scripts, voice, video, captions, renders and exports are not built yet. This lists what a production request would use.'];
  const content = latest ? parsed(AnyStoryArchitectureContent, latest.content) : null;
  const v2 = content && isArchitectureV2(content) ? content : null;
  const all = approved ? await opportunitiesOf(db, approved.id) : [];
  const shortsAvailable = all.filter((o) => o.eligible && o.format !== 'LONG_FORM');
  const items = request.shorts === 'all' ? shortsAvailable : shortsAvailable.slice(0, request.shorts);
  if (!approved) notes.push(latest ? `Story architecture v${latest.version} is ${latest.status}: nothing is eligible until an architecture is approved.` : 'No story architecture yet.');
  if (request.shorts !== 'all' && request.shorts > items.length) notes.push(`${request.shorts} shorts requested; ${shortsAvailable.length} approved short opportunit${shortsAvailable.length === 1 ? 'y is' : 'ies are'} available.`);
  if (approved && approved.engineVersion !== 2) notes.push(`Architecture v${approved.version} was built by story engine 1, which does not identify content opportunities.`);
  return {
    projectId: project.id,
    request: { documentary: request.documentary, shorts: request.shorts, languages: request.languages },
    architecture: latest
      ? {
          id: latest.id,
          version: latest.version,
          status: latest.status,
          logline: v2?.logline ?? null,
          centralQuestion: content?.centralQuestion ?? null,
          estimatedDurationSec: latest.estimatedDurationSec,
        }
      : null,
    documentary: {
      included: request.documentary && approved !== null,
      eligible: approved !== null,
      reason: approved ? null : 'The long-form documentary needs an approved story architecture.',
    },
    shorts: { requested: request.shorts, available: shortsAvailable.length, returned: items.length, items },
    longForm: all.filter((o) => o.eligible && o.format === 'LONG_FORM'),
    languages: {
      requested: request.languages,
      note: `Localization is not built yet. The master language is "${project.masterLanguage}"; requested languages are only recorded.`,
    },
    generated: false,
    notes,
  };
}
