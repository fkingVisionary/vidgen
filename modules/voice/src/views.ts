import {
  DirectorMark,
  PreparedNarration,
  VoiceScope,
  type CostBasis,
  type JobView,
  type VoiceAssemblyVersionView,
  type VoiceAssemblyView,
  type VoiceChunkView,
  type VoiceGenerationStatus,
  type VoiceGenerationView,
  type VoiceRunSummaryView,
  type VoiceRunView,
  type VoiceView,
} from '@docengine/core';
import type { Database, Project, VoiceGeneration } from '@docengine/database';
import type { ProviderSet } from '@docengine/providers';
import { z } from 'zod';
import { profileConfig, toProfileView } from './profiles.ts';
import { readAlignment, readPerformance, readQa, readSpans, staleChunk, takeStatus } from './runs.ts';
import { liveRunQa } from './service.ts';
import { approvedScript, loadScriptForVoice } from './script.ts';

/** The Voice page's read model. */

const audioUrl = (assetId: string | null) => (assetId ? `/api/voice/audio/${assetId}` : null);

type TakeRow = VoiceGeneration & {
  profile: { id: string; name: string; version: number };
  audioAsset: { mimeType: string; isMock: boolean } | null;
  providerCall: { estimatedCostUsd: unknown; actualCostUsd: unknown; costBasis: CostBasis | null; costNote: string | null } | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toGenerationView(g: TakeRow, currentId: string | null): VoiceGenerationView {
  const alignment = readAlignment(g.alignment);
  const prepared = PreparedNarration.nullable().catch(null).parse(g.prepared ?? null);
  return {
    id: g.id,
    generation: g.generation,
    status: takeStatus(g, currentId),
    current: g.id === currentId,
    provider: g.provider,
    model: g.model,
    voiceId: g.voiceId,
    profile: { id: g.profile.id, name: g.profile.name, version: g.profile.version },
    strategy: g.strategy,
    variant: g.variant,
    performanceText: g.performanceText,
    spokenText: g.spokenText,
    prepared,
    directions: z.array(DirectorMark).nullable().catch(null).parse(g.directions ?? null),
    audioUrl: audioUrl(g.audioAssetId),
    mimeType: g.audioAsset?.mimeType ?? null,
    durationMs: g.durationMs,
    words: alignment?.words ?? [],
    alignment: alignment?.source ?? null,
    unmatchedWords: alignment?.unmatchedWords ?? 0,
    qa: readQa(g.qa),
    characters: g.characters,
    cost: g.providerCall ? { estimatedUsd: num(g.providerCall.estimatedCostUsd), actualUsd: num(g.providerCall.actualCostUsd), basis: g.providerCall.costBasis, note: g.providerCall.costNote } : null,
    providerRequestId: g.providerRequestId,
    error: g.error,
    note: g.note,
    decidedBy: g.decidedBy,
    decidedAt: g.decidedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    completedAt: g.completedAt?.toISOString() ?? null,
    mock: g.audioAsset?.isMock ?? g.provider === 'mock',
  };
}

const RUN_INCLUDE = {
  profile: true,
  script: { select: { version: true } },
  chunks: { orderBy: { chunkIndex: 'asc' as const }, include: { current: true } },
  generations: {
    orderBy: { generation: 'desc' as const },
    include: {
      profile: { select: { id: true, name: true, version: true } },
      audioAsset: { select: { mimeType: true, isMock: true } },
      providerCall: { select: { estimatedCostUsd: true, actualCostUsd: true, costBasis: true, costNote: true } },
    },
  },
};

type RunRow = NonNullable<Awaited<ReturnType<typeof loadRun>>>;
const loadRun = (db: Database, where: { id: string }) => db.voiceRun.findUnique({ where, include: RUN_INCLUDE });

function runLabel(r: { kind: string; experiment: string | null; variant: string | null; scope: unknown }): string {
  const scope = r.scope as { description?: string };
  if (r.experiment) return `${r.experiment} — ${r.variant ?? ''}`.trim();
  return scope.description ?? r.kind;
}

function summary(r: RunRow, approved: { id: string } | null): VoiceRunSummaryView {
  const takes: Partial<Record<VoiceGenerationStatus, number>> = {};
  for (const c of r.chunks) {
    if (!c.current) continue;
    const status = takeStatus(c.current, c.currentGenerationId);
    takes[status] = (takes[status] ?? 0) + 1;
  }
  const pending = r.chunks.filter((c) => !c.current).length;
  if (pending) takes.PENDING = (takes.PENDING ?? 0) + pending;
  const attempts = r.generations.filter((g) => g.providerCall);
  const bases = new Set(attempts.map((g) => g.providerCall!.costBasis).filter((b): b is CostBasis => !!b));
  const durations = r.chunks.map((c) => c.current?.durationMs ?? null);
  return {
    id: r.id,
    number: r.number,
    kind: r.kind,
    label: runLabel(r),
    experiment: r.experiment,
    variant: r.variant,
    scriptVersion: r.script.version,
    strategy: r.strategy,
    profile: { id: r.profile.id, name: r.profile.name, version: r.profile.version, modelId: r.profile.modelId, voiceId: r.profile.voiceId },
    chunkCount: r.chunks.length,
    takes,
    durationMs: durations.every((d) => d !== null) && durations.length ? durations.reduce<number>((n, d) => n + d!, 0) : null,
    characters: attempts.reduce((n, g) => n + (g.characters ?? 0), 0),
    cost: {
      totalUsd: Math.round(attempts.reduce((n, g) => n + (num(g.providerCall!.actualCostUsd) ?? num(g.providerCall!.estimatedCostUsd) ?? 0), 0) * 1e6) / 1e6,
      basis: bases.size === 0 ? null : bases.size === 1 ? [...bases][0]! : 'MIXED',
    },
    stale: !!approved && approved.id !== r.scriptId,
    createdAt: r.createdAt.toISOString(),
  };
}

async function runView(db: Database, r: RunRow, approved: { id: string; version: number } | null): Promise<VoiceRunView> {
  const script = await loadScriptForVoice(db, r.scriptId);
  const approvedText = approved && approved.id !== r.scriptId ? await loadScriptForVoice(db, approved.id) : null;
  const titles = new Map((script?.sections ?? []).map((s) => [s.key, s.title]));
  const chunks: VoiceChunkView[] = r.chunks.map((c) => {
    const takes = r.generations.filter((g) => g.chunkId === c.id).map((g) => toGenerationView(g, c.currentGenerationId));
    const spans = readSpans(c.spans);
    const stale = approvedText ? staleChunk(c, new Map([...approvedText.blocks.values()].map((b) => [b.key, b.text]))) : false;
    return {
      id: c.id,
      index: c.chunkIndex,
      sectionKey: c.sectionKey,
      sectionTitle: titles.get(c.sectionKey) ?? null,
      blockKeys: c.blockKeys,
      spans,
      text: c.sourceText,
      words: c.words,
      boundary: c.boundary as VoiceChunkView['boundary'],
      performance: readPerformance(c.performance),
      stale,
      current: takes.find((t) => t.current) ?? null,
      generations: takes,
    };
  });
  const versions = await db.voiceAssembly.findMany({ where: { runId: r.id }, orderBy: { version: 'desc' } });
  const latest = versions[0];
  const assemblies: VoiceAssemblyVersionView[] = versions.map((a) => ({ id: a.id, version: a.version, status: a.status, totalDurationMs: a.totalDurationMs, complete: a.complete, audioUrl: `/api/voice/assemblies/${a.id}/audio`, createdAt: a.createdAt.toISOString() }));
  const assembly: VoiceAssemblyView | null = latest
    ? {
        id: latest.id,
        version: latest.version,
        status: latest.status,
        totalDurationMs: latest.totalDurationMs,
        complete: latest.complete,
        entries: latest.entries as unknown as VoiceAssemblyView['entries'],
        timeline: latest.timeline as unknown as VoiceAssemblyView['timeline'],
        qa: readQa(latest.qa),
        audioUrl: `/api/voice/assemblies/${latest.id}/audio`,
        createdAt: latest.createdAt.toISOString(),
      }
    : null;
  const current = r.chunks.map((c) => c.current).filter((g): g is VoiceGeneration => !!g && !!g.durationMs);
  const durations = current.map((g) => g.durationMs!);
  const settings = (r.settings ?? {}) as Partial<VoiceRunView['settings']>;
  const config = profileConfig(r.profile);
  return {
    ...summary(r, approved),
    scope: VoiceScope.catch({ kind: 'FULL' }).parse(r.scope),
    settings: { chunking: settings.chunking ?? config.chunking, context: { ...config.context, ...(settings.context ?? {}) } },
    notes: r.notes,
    chunks,
    assembly,
    assemblies,
    qa: await liveRunQa(db, r),
    staleNote: approved && approved.id !== r.scriptId ? `Audio generated from Script v${r.script.version} — current script is v${approved.version}` : null,
    stats: {
      averageChunkMs: durations.length ? Math.round(durations.reduce((n, d) => n + d, 0) / durations.length) : null,
      longestChunkMs: durations.length ? Math.max(...durations) : null,
      shortestChunkMs: durations.length ? Math.min(...durations) : null,
      regenerations: r.generations.filter((g) => g.generation > 1).length,
      failures: r.generations.filter((g) => g.status === 'FAILED').length,
      withAlignment: current.filter((g) => g.alignment).length,
    },
  };
}

export interface VoiceViewDeps {
  db: Database;
  providers: ProviderSet;
  confirmCharacters: number;
  toJobView: (job: never) => JobView;
}

export async function loadVoiceView(deps: VoiceViewDeps, project: Project, runNumber: number | undefined): Promise<VoiceView> {
  const { db, providers } = deps;
  const approved = await approvedScript(db, project.id);
  const profiles = await db.voiceProfile.findMany({ orderBy: [{ name: 'asc' }, { version: 'desc' }], include: { _count: { select: { runs: true } } } });
  const runsRows = await db.voiceRun.findMany({ where: { projectId: project.id }, orderBy: { number: 'desc' }, include: RUN_INCLUDE });
  const selected = runNumber !== undefined ? runsRows.find((r) => r.number === runNumber) : runsRows[0];
  const pronunciations = await db.voicePronunciation.findMany({ where: { projectId: project.id, language: project.masterLanguage }, orderBy: [{ status: 'asc' }, { term: 'asc' }] });
  const activeJob = await db.job.findFirst({ where: { projectId: project.id, type: 'VOICE', status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
  const status = project.status === 'FAILED' ? project.failedFromStatus : project.status;
  const voiceStatuses = ['SCRIPT_APPROVED', 'VOICE_GENERATING', 'VOICE_REVIEW', 'VOICE_COMPLETE'];
  const generate = !approved
    ? { allowed: false, reason: 'Approve a script version first: narration is made from the approved script' }
    : !voiceStatuses.includes(status ?? '')
      ? { allowed: false, reason: `Narration is generated between script approval and visual planning (the project is ${project.status})` }
      : activeJob
        ? { allowed: false, reason: 'A voice job is running' }
        : { allowed: true, reason: null };
  const fullRun = approved ? runsRows.find((r) => r.kind === 'FULL' && r.scriptId === approved.id) : undefined;
  const approve =
    project.status !== 'VOICE_REVIEW'
      ? { allowed: false, reason: project.status === 'VOICE_COMPLETE' ? 'The narration is approved' : 'The VOICE gate opens once a voice job has finished' }
      : !fullRun
        ? { allowed: false, reason: `Generate the whole script (a full run) first: an audition is not the narration${approved ? ` of script v${approved.version}` : ''}` }
        : { allowed: true, reason: null };
  const active = profiles.find((p) => p.active && p.provider === providers.voice.info.name && p.language === project.masterLanguage) ?? null;
  return {
    project: { id: project.id, slug: project.slug, title: project.title, status: project.status },
    script: approved,
    provider: { name: providers.voice.info.name, mock: providers.voice.info.mock, defaultModel: providers.voice.defaults.model, defaultVoiceId: providers.voice.defaults.voiceId, storage: providers.storage.info.name, durableStorage: !providers.storage.info.mock },
    profiles: profiles.map((p) => toProfileView(p, p._count.runs)),
    activeProfileId: active?.id ?? null,
    runs: runsRows.map((r) => summary(r, approved)),
    run: selected ? await runView(db, selected, approved) : null,
    pronunciations: pronunciations.map((p) => ({
      id: p.id,
      term: p.term,
      kind: p.kind as VoiceView['pronunciations'][number]['kind'],
      method: p.method,
      pronunciation: p.pronunciation,
      status: p.status,
      source: p.source,
      hint: p.hint,
      notes: p.notes,
      updatedBy: p.updatedBy,
      updatedAt: p.updatedAt.toISOString(),
    })),
    editorial: { generate, approve },
    confirmCharacters: deps.confirmCharacters,
    activeJob: activeJob ? deps.toJobView(activeJob as never) : null,
  };
}

export { loadRun };
