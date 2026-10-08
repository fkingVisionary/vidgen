import {
  DEFAULT_VOICE_PROFILE_CONFIG,
  DirectorMark,
  PreparedNarration,
  VoiceProfileOrigin,
  VoiceScope,
  chosenRun,
  runTakes,
  type CostBasis,
  type JobView,
  type NarrationRunView,
  type NarrationSummaryView,
  type VoiceAssemblyVersionView,
  type VoiceAssemblyView,
  type VoiceChunkView,
  type VoiceCostView,
  type VoiceGenerationStatus,
  type VoiceGenerationView,
  type VoiceProductionView,
  type VoiceProfileFamilyView,
  type VoiceProfileHistoryView,
  type VoiceProfileLibraryView,
  type VoiceProfileUseView,
  type VoiceRunConfig,
  type VoiceRunSummaryView,
  type VoiceRunView,
  type VoiceTakeConfigView,
  type VoiceView,
} from '@docengine/core';
import type { Database, Project, VoiceGeneration, VoiceProfile, VoiceProfileFamily } from '@docengine/database';
import type { ProviderSet, VoiceProvider } from '@docengine/providers';
import { z } from 'zod';
import { newRunConfig, runConfig, takeConfig, type ProfileRow } from './config.ts';
import { LEDGER, sumReported, takeCost, type LedgerRow, type TakeCost } from './cost.ts';
import { profileViews, resolveProduction, type Production } from './profiles.ts';
import { withdrawnTerms, type LexiconEntry } from './pronunciation.ts';
import { readAlignment, readPerformance, readQa, readSpans, staleChunk, takeStatus } from './runs.ts';
import { liveRunQa } from './service.ts';
import { approvedScript, loadScriptForVoice } from './script.ts';

/**
 * The Voice page's read model, the profile library and a language
 * version's production profile. Reads never write: no profile is made or
 * adopted here, and a voice's name is not looked up (no network on a read).
 * Runs and takes show what they were made with (stored, or reconstructed
 * for those made before saved profiles) and what they cost, estimated from
 * the characters sent with the provider's own figures beside it.
 */

const audioUrl = (assetId: string | null) => (assetId ? `/api/voice/audio/${assetId}` : null);

type TakeRow = VoiceGeneration & {
  profile: ProfileRow;
  audioAsset: { mimeType: string; isMock: boolean } | null;
  providerCall: (LedgerRow & { costNote: string | null }) | null;
};

/** What a take's cost reads as: the ledger's, or re-estimated from the characters sent (and the ledger's own note kept after it). */
function costView(cost: TakeCost, note: string | null): VoiceCostView {
  return {
    estimatedUsd: cost.estimatedUsd,
    actualUsd: cost.reportedUsd,
    basis: cost.basis as CostBasis | null,
    note: cost.reestimated ? `Re-estimated from the ${cost.characters} characters sent: the ledger row (before 2026-10-06) priced the provider's own figure${note ? ` (${note})` : ''}` : note,
    characters: cost.characters,
    reported: cost.reported,
    reestimated: cost.reestimated,
  };
}

function toGenerationView(g: TakeRow, currentId: string | null, run: VoiceRunConfig, voice: VoiceProvider): VoiceGenerationView {
  const alignment = readAlignment(g.alignment);
  const prepared = PreparedNarration.nullable().catch(null).parse(g.prepared ?? null);
  const config = takeConfig(g, run);
  const configuration: VoiceTakeConfigView = { base: config.base, override: config.override, profile: config.profile, reconstructed: config.reconstructed, differs: config.differs, identityDiffers: config.identityDiffers };
  const cost = takeCost(g.providerCall, g.characters, voice);
  return {
    id: g.id,
    generation: g.generation,
    status: takeStatus(g, currentId),
    current: g.id === currentId,
    provider: g.provider,
    model: g.model,
    voiceId: g.voiceId,
    profile: { id: g.profile.id, name: g.profile.name, version: g.profile.version, familyId: g.profile.familyId, familyName: g.profile.family?.name ?? null },
    configuration,
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
    cost: cost ? costView(cost, g.providerCall?.costNote ?? null) : null,
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
  profile: { include: { family: true } },
  script: { select: { version: true } },
  chunks: { orderBy: { chunkIndex: 'asc' as const }, include: { current: true } },
  generations: {
    orderBy: { generation: 'desc' as const },
    include: {
      profile: { include: { family: true } },
      audioAsset: { select: { mimeType: true, isMock: true } },
      providerCall: { select: { ...LEDGER.select, costNote: true } },
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

function summary(r: RunRow, approved: { id: string } | null, voice: VoiceProvider): VoiceRunSummaryView {
  const takes: Partial<Record<VoiceGenerationStatus, number>> = {};
  for (const c of r.chunks) {
    if (!c.current) continue;
    const status = takeStatus(c.current, c.currentGenerationId);
    takes[status] = (takes[status] ?? 0) + 1;
  }
  const pending = r.chunks.filter((c) => !c.current).length;
  if (pending) takes.PENDING = (takes.PENDING ?? 0) + pending;
  const attempts = r.generations.filter((g) => g.providerCall);
  const costs = attempts.map((g) => takeCost(g.providerCall, g.characters, voice)!);
  const bases = new Set(costs.map((c) => c.basis as CostBasis | null).filter((b): b is CostBasis => !!b));
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
    profile: { id: r.profile.id, name: r.profile.name, version: r.profile.version, modelId: r.profile.modelId, voiceId: r.profile.voiceId, familyId: r.profile.familyId, familyName: r.profile.family?.name ?? null },
    chunkCount: r.chunks.length,
    takes,
    durationMs: durations.every((d) => d !== null) && durations.length ? durations.reduce<number>((n, d) => n + d!, 0) : null,
    characters: attempts.reduce((n, g) => n + (g.characters ?? 0), 0),
    cost: {
      totalUsd: Math.round(costs.reduce((n, c) => n + (c.reportedUsd ?? c.estimatedUsd ?? 0), 0) * 1e6) / 1e6,
      basis: bases.size === 0 ? null : bases.size === 1 ? [...bases][0]! : 'MIXED',
      reported: sumReported(costs).map((s) => ({ name: s.name, quantity: s.total })),
      reestimated: costs.some((c) => c.reestimated),
    },
    stale: !!approved && approved.id !== r.scriptId,
    createdAt: r.createdAt.toISOString(),
  };
}

async function runView(db: Database, r: RunRow, approved: { id: string; version: number } | null, voice: VoiceProvider): Promise<VoiceRunView> {
  const script = await loadScriptForVoice(db, r.scriptId);
  const approvedText = approved && approved.id !== r.scriptId ? await loadScriptForVoice(db, approved.id) : null;
  const titles = new Map((script?.sections ?? []).map((s) => [s.key, s.title]));
  const configuration = runConfig(r, voice);
  const chunks: VoiceChunkView[] = r.chunks.map((c) => {
    const takes = r.generations.filter((g) => g.chunkId === c.id).map((g) => toGenerationView(g, c.currentGenerationId, configuration, voice));
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
  return {
    ...summary(r, approved, voice),
    scope: VoiceScope.catch({ kind: 'FULL' }).parse(r.scope),
    configuration,
    settings: { chunking: configuration.effective.chunking, context: configuration.effective.context },
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

// ── The profile library and production ───────────────────────────────────────

/** What the library and production views read with: the database and the configured voice provider. */
export interface ProfileViewDeps {
  db: Database;
  providers: Pick<ProviderSet, 'voice'>;
}

/** Families as the library shows them: their current version, how many versions, who uses them, and their runs (a few queries for all of them). */
async function familyViews(db: Database, voice: VoiceProvider, families: readonly VoiceProfileFamily[]): Promise<VoiceProfileFamilyView[]> {
  if (!families.length) return [];
  const ids = families.map((f) => f.id);
  const versions = await db.voiceProfile.findMany({ where: { familyId: { in: ids } }, orderBy: { version: 'asc' } });
  const ofFamily = (id: string) => versions.filter((v) => v.familyId === id);
  const currents = families.map((f) => ofFamily(f.id).at(-1)).filter((v): v is VoiceProfile => !!v);
  const currentViews = new Map((await profileViews(db, voice, currents)).map((v) => [v.id, v]));
  const runs = await db.voiceRun.groupBy({ by: ['profileId'], where: { profileId: { in: versions.map((v) => v.id) } }, _count: { _all: true } });
  const runsOf = new Map(runs.map((r) => [r.profileId, r._count._all]));
  const uses = await db.voiceSelection.findMany({
    where: { familyId: { in: ids } },
    orderBy: { updatedAt: 'desc' },
    include: { project: { select: { id: true, slug: true, title: true } }, languageVersion: { select: { language: true } }, pinnedVersion: { select: { version: true } } },
  });
  return families.map((f) => {
    const own = ofFamily(f.id);
    const current = own.at(-1) ?? null;
    const usedBy: VoiceProfileUseView[] = uses
      .filter((u) => u.familyId === f.id)
      .map((u) => ({ projectId: u.project.id, slug: u.project.slug, title: u.project.title, language: u.languageVersion.language, mode: u.pinnedVersionId ? 'PIN' : 'FOLLOW', pinnedVersion: u.pinnedVersion?.version ?? null }));
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      isDefault: f.isDefault,
      archived: !!f.archivedAt,
      provider: current?.provider ?? null,
      language: current?.language ?? null,
      current: current ? (currentViews.get(current.id) ?? null) : null,
      versions: own.length,
      usedBy,
      runs: own.reduce((n, v) => n + (runsOf.get(v.id) ?? 0), 0),
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    };
  });
}

/** Library families, the default first, then by name (archived ones only when asked for). */
const listFamilies = (db: Database, archived: boolean) => db.voiceProfileFamily.findMany({ where: archived ? {} : { archivedAt: null }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });

/** The profile library, with what a form needs to make or edit a profile for the configured provider. Profiles of another provider are listed as they are (their `provider` says so). */
export async function loadProfileLibrary(deps: ProfileViewDeps, opts: { archived: boolean }): Promise<VoiceProfileLibraryView> {
  const { db } = deps;
  const voice = deps.providers.voice;
  return {
    provider: { name: voice.info.name, mock: voice.info.mock, defaultModel: voice.defaults.model, defaultVoiceId: voice.defaults.voiceId, defaultOutputFormat: voice.defaults.outputFormat, models: [...voice.models] },
    settings: [...voice.settings],
    defaults: { ...structuredClone(DEFAULT_VOICE_PROFILE_CONFIG), providerSettings: voice.normalizeSettings({}).settings },
    families: await familyViews(db, voice, await listFamilies(db, opts.archived)),
  };
}

/** A saved profile with every version, newest first (null: no such profile). */
export async function loadProfileHistory(deps: ProfileViewDeps, familyId: string): Promise<VoiceProfileHistoryView | null> {
  const { db } = deps;
  const voice = deps.providers.voice;
  const family = await db.voiceProfileFamily.findUnique({ where: { id: familyId } });
  if (!family) return null;
  const [view] = await familyViews(db, voice, [family]);
  const versions = await db.voiceProfile.findMany({ where: { familyId }, orderBy: { version: 'desc' } });
  return { ...view!, history: await profileViews(db, voice, versions) };
}

/** Production as a view: its version, and the effective configuration a new run would start from (the project's overrides over the version). */
async function productionView(db: Database, voice: VoiceProvider, p: Production): Promise<VoiceProductionView> {
  const [profile] = p.version ? await profileViews(db, voice, [p.version]) : [];
  const config = p.version ? newRunConfig({ version: p.version, selection: { mode: p.mode, revision: p.revision }, projectOverrides: p.overrides, runOptions: {} }, voice) : null;
  return {
    language: p.language,
    mode: p.mode,
    revision: p.revision,
    family: p.family ? { id: p.family.id, name: p.family.name, archived: !!p.family.archivedAt, isDefault: p.family.isDefault } : null,
    profile: profile ?? null,
    newer: p.newer ? { id: p.newer.id, version: p.newer.version } : null,
    overrides: p.overrides,
    effective: config?.effective ?? null,
    provenance: config?.provenance ?? {},
    sent: config?.sent ?? {},
    ignored: config?.ignored ?? [],
    problem: p.problem,
    notices: p.notices,
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt?.toISOString() ?? null,
  };
}

/** What a project's language version narrates with now (the master language by default; null: the project has no such language version). */
export async function loadProduction(deps: ProfileViewDeps, project: Pick<Project, 'id' | 'masterLanguage'>, language?: string): Promise<VoiceProductionView | null> {
  const { db } = deps;
  const voice = deps.providers.voice;
  const lv = await db.languageVersion.findUnique({ where: { projectId_language: { projectId: project.id, language: language ?? project.masterLanguage } }, select: { id: true, language: true, projectId: true } });
  if (!lv) return null;
  return productionView(db, voice, await resolveProduction(db, voice, lv));
}

/**
 * A project's voice runs in brief, for its next step: how many, the chosen
 * one (chosenRun: the run its production profile was saved from, else the
 * newest with every take approved, else the newest) and the newest full run
 * of the approved script. A read: no profile is made or adopted.
 */
export async function loadNarrationSummary(deps: ProfileViewDeps, project: Pick<Project, 'id' | 'masterLanguage'>): Promise<NarrationSummaryView> {
  const { db } = deps;
  const approved = await approvedScript(db, project.id);
  const rows = await db.voiceRun.findMany({
    where: { projectId: project.id },
    orderBy: { number: 'desc' },
    select: {
      id: true,
      number: true,
      kind: true,
      experiment: true,
      variant: true,
      scope: true,
      scriptId: true,
      chunks: { select: { currentGenerationId: true, current: { select: { id: true, status: true } } } },
      assemblies: { orderBy: { version: 'desc' }, take: 1, select: { totalDurationMs: true } },
    },
  });
  const runs = rows.map((r) => {
    const takes: Partial<Record<VoiceGenerationStatus, number>> = {};
    for (const c of r.chunks) {
      const status = c.current ? takeStatus(c.current, c.currentGenerationId) : 'PENDING';
      takes[status] = (takes[status] ?? 0) + 1;
    }
    const stale = !!approved && approved.id !== r.scriptId;
    const brief: NarrationRunView = { id: r.id, number: r.number, kind: r.kind, label: runLabel(r), variant: r.variant, takes: runTakes({ chunkCount: r.chunks.length, takes }), durationMs: r.assemblies[0]?.totalDurationMs ?? null, stale };
    return { brief, input: { id: r.id, number: r.number, stale, chunkCount: r.chunks.length, takes } };
  });
  const lv = await db.languageVersion.findUnique({ where: { projectId_language: { projectId: project.id, language: project.masterLanguage } }, select: { id: true, language: true, projectId: true } });
  const production = lv && runs.length ? await resolveProduction(db, deps.providers.voice, lv) : null;
  const origin = VoiceProfileOrigin.nullable().catch(null).parse(production?.version?.origin ?? null);
  const chosen = chosenRun(runs.map((r) => r.input), origin, project.id);
  const full = approved ? rows.find((r) => r.kind === 'FULL' && r.scriptId === approved.id) : undefined;
  const brief = (id: string) => runs.find((r) => r.brief.id === id)!.brief;
  return {
    runs: runs.length,
    chosen: chosen ? { ...brief(chosen.run.id), reason: chosen.reason } : null,
    full: full ? brief(full.id) : null,
  };
}

// ── The Voice page ───────────────────────────────────────────────────────────

export interface VoiceViewDeps {
  db: Database;
  providers: ProviderSet;
  confirmCharacters: number;
  toJobView: (job: never) => JobView;
}

export async function loadVoiceView(deps: VoiceViewDeps, project: Project, runNumber: number | undefined): Promise<VoiceView> {
  const { db, providers } = deps;
  const voice = providers.voice;
  const approved = await approvedScript(db, project.id);
  const production = await loadProduction(deps, project);
  if (!production) throw new Error(`Project ${project.slug} has no ${project.masterLanguage} language version`);
  const library = (await familyViews(db, voice, await listFamilies(db, false))).filter((f) => f.provider === voice.info.name && f.language === project.masterLanguage);
  const runsRows = await db.voiceRun.findMany({ where: { projectId: project.id }, orderBy: { number: 'desc' }, include: RUN_INCLUDE });
  const selected = runNumber !== undefined ? runsRows.find((r) => r.number === runNumber) : runsRows[0];
  const pronunciations = await db.voicePronunciation.findMany({ where: { projectId: project.id, language: project.masterLanguage }, orderBy: [{ status: 'asc' }, { term: 'asc' }] });
  // Entries the term detector has replaced in the approved script's text ("Meet Thijs" → Thijs): no longer to decide.
  const approvedScriptText = approved ? await loadScriptForVoice(db, approved.id) : null;
  const withdrawn = approvedScriptText
    ? withdrawnTerms(
        [...approvedScriptText.blocks.values()].map((b) => b.text).join('\n'),
        pronunciations.map((p) => ({ term: p.term, source: p.source as LexiconEntry['source'], status: p.status, edited: p.updatedBy !== null })),
      )
    : new Map<string, string>();
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
  return {
    project: { id: project.id, slug: project.slug, title: project.title, status: project.status },
    script: approved,
    provider: {
      name: voice.info.name,
      mock: voice.info.mock,
      defaultModel: voice.defaults.model,
      defaultVoiceId: voice.defaults.voiceId,
      storage: providers.storage.info.name,
      durableStorage: !providers.storage.info.mock,
      settings: [...voice.settings],
      models: [...voice.models],
    },
    production,
    library,
    runs: runsRows.map((r) => summary(r, approved, voice)),
    run: selected ? await runView(db, selected, approved, voice) : null,
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
      withdrawn: withdrawn.get(p.term) ?? null,
    })),
    editorial: { generate, approve },
    confirmCharacters: deps.confirmCharacters,
    activeJob: activeJob ? deps.toJobView(activeJob as never) : null,
  };
}

export { loadRun };
