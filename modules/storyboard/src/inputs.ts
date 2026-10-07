import {
  AssemblyEntry,
  BlockPresentation,
  ScriptDelivery,
  ScriptVisual,
  StoryArchitectureContentV2,
  StoryDesign,
  type ArtifactStatus,
  type ClaimVerdict,
  type NarrationApproval,
  type NarrationSpine,
  type StoryboardContent,
  type StoryboardInputs,
  type StoryboardScope,
  type VisualCatalog,
  type VisualProfileSnapshot,
  type VoiceGenerationStatus,
} from '@docengine/core';
import type { Database, Tx } from '@docengine/database';
import { SCRIPT_INCLUDE, buildScope, toDraft, type ScriptDraft, type ScriptScope } from '@docengine/script';
import { EvidenceBase } from '@docengine/story/shared';
import { SpineError, approvedScript, narrationFingerprint, narrationSpine } from '@docengine/voice';
import { z } from 'zod';
import type { StoryboardFacts } from './draft.ts';
import { productionSnapshot, resolveVisualProduction } from './profiles.ts';
import { SpineIntegrityError, buildSpine } from './spine.ts';
import { narrationApprovalOf, type LiveFacts, type PinnedFacts } from './stale.ts';
import type { StoryboardPins } from './store.ts';

/**
 * What a storyboard is planned against, resolved and pinned (§2.2, step S0):
 * the voice run's narration (one assembly version, read strictly), the
 * approved script it narrates in the master language, the approved
 * architecture that script tells, a fresh read of the evidence (never a
 * cached scope), the project's visual profile at the revision the request
 * was made at, the catalog that prices it, and the story candidates behind
 * the sequences. Anything that does not hold is refused with the reason.
 * Also the live facts a saved version's staleness is judged against.
 */

type Db = Database | Tx;

/** A storyboard that cannot be planned from these inputs, and why: the stage fails without retrying, a request is refused (409). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** The evidence, read fresh (it only reads, in the caller's transaction or not). */
export const loadEvidence = (db: Db, dossierId: string) => EvidenceBase.load(db as Database, dossierId);

/** The narration of an assembly version, read strictly (null: no such assembly). */
export async function readNarration(db: Db, assemblyId: string): Promise<NarrationSpine | null> {
  try {
    return await narrationSpine(db, assemblyId);
  } catch (err) {
    throw err instanceof SpineError ? new InputError(err.message) : err;
  }
}

/** The assembly the newest VOICE gate approval names (null: none). */
export async function gateAssemblyId(db: Db, projectId: string): Promise<string | null> {
  const a = await db.approval.findFirst({ where: { projectId, gate: 'VOICE', decision: 'APPROVED' }, orderBy: { createdAt: 'desc' }, select: { voiceAssemblyId: true } });
  return a?.voiceAssemblyId ?? null;
}

export interface ResolveArgs {
  projectId: string;
  runId: string;
  assemblyId: string;
  /** The phase job (a whole-script storyboard) or a preview. A phase plan that leaves blocks out is PARTIAL all the same. */
  phase: boolean;
  catalog: VisualCatalog;
  /** The profile to plan with (a version's own); else the project's selection now, which must be at `selectionRevision`. */
  profile?: VisualProfileSnapshot;
  selectionRevision?: number;
  actor: string;
}

export interface ResolvedInputs {
  facts: StoryboardFacts;
  pins: StoryboardPins;
  /** content.inputs, but the pricing snapshot (frozen once the version is planned). */
  inputs: Omit<StoryboardInputs, 'pricing'>;
  script: { id: string; version: number; storyId: string };
  architecture: { id: string; version: number; dossierId: string; content: StoryArchitectureContentV2 };
}

/** A script version's blocks as the storyboard reads them: every visual direction, delivery and presentation must parse (never a silent default). */
function strictBlocks(row: { version: number; scenes: { sceneKey: string; narrations: { languageVersionId: string; blocks: { blockKey: string; visual: unknown; delivery: unknown; presentation: unknown }[] }[] }[] }, languageVersionId: string): void {
  for (const scene of row.scenes) {
    const narration = scene.narrations.find((n) => n.languageVersionId === languageVersionId);
    if (!narration) throw new InputError(`Script v${row.version}, section ${scene.sceneKey}: no narration in the master language`);
    for (const b of narration.blocks) {
      for (const [what, schema, value] of [
        ['visual direction', ScriptVisual, b.visual],
        ['delivery', ScriptDelivery, b.delivery],
        ['presentation', z.array(BlockPresentation), b.presentation],
      ] as const) {
        const r = (schema as z.ZodType).safeParse(value);
        if (!r.success) throw new InputError(`Script v${row.version}, block ${b.blockKey}: its ${what} cannot be read (${r.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')})`);
      }
    }
  }
}

/** The approved script a narration narrates, in the master language, and the approved architecture it tells. */
async function scriptAndArchitecture(db: Db, projectId: string, scriptId: string, languageVersionId: string) {
  const approved = await approvedScript(db, projectId);
  const row = await db.script.findUnique({ where: { id: scriptId }, include: SCRIPT_INCLUDE });
  if (!row || row.projectId !== projectId) throw new InputError(`Script ${scriptId} is not this project's`);
  if (!approved) throw new InputError('No approved script: a storyboard is planned from the approved script and its narration');
  if (approved.id !== row.id || row.status !== 'APPROVED') throw new InputError(`The narration was made from script v${row.version}, but the approved script is v${approved.version}: narrate the approved script first`);
  strictBlocks(row, languageVersionId);
  if (!row.storyId) throw new InputError(`Script v${row.version} records no story architecture`);
  const arch = await db.storyArchitecture.findUnique({ where: { id: row.storyId } });
  if (!arch) throw new InputError(`The architecture script v${row.version} tells no longer exists`);
  if (arch.status !== 'APPROVED') throw new InputError(`Architecture v${arch.version}, which script v${row.version} tells, is ${arch.status.toLowerCase()}: approve a script of the approved architecture first`);
  if (arch.engineVersion !== 2) throw new InputError(`Architecture v${arch.version} was built by story engine 1; the storyboard needs a Story Engine 2.0 architecture`);
  const content = StoryArchitectureContentV2.safeParse(arch.content);
  if (!content.success) throw new InputError(`Architecture v${arch.version} cannot be read`);
  if (!arch.dossierId) throw new InputError(`Architecture v${arch.version} has no research dossier`);
  return {
    draft: toDraft(row, languageVersionId).draft,
    script: { id: row.id, version: row.version, storyId: arch.id },
    architecture: { id: arch.id, version: arch.version, dossierId: arch.dossierId, content: content.data },
  };
}

/** The story candidates the architecture's sequences were built from: their period, setting and what is on screen. */
async function candidatesOf(db: Db, architecture: StoryArchitectureContentV2): Promise<StoryboardInputs['candidates']> {
  const ids = [...new Set(architecture.sequences.flatMap((s) => s.candidateIds))];
  if (!ids.length) return [];
  const rows = await db.storyCandidate.findMany({ where: { id: { in: ids } }, select: { id: true, candidateKey: true, timePeriod: true, setting: true, storyDesign: true }, orderBy: { candidateKey: 'asc' } });
  return rows.map((c) => {
    const design = StoryDesign.safeParse(c.storyDesign);
    return { id: c.id, key: c.candidateKey, timePeriod: c.timePeriod, setting: c.setting, visualEnvironment: design.success ? design.data.visualEnvironment : null };
  });
}

/**
 * S0: the inputs of a storyboard of a voice run's narration, pinned. Refused
 * (InputError) when the run, the assembly or the script is not this
 * project's, the script is not the approved one, the narration is not in the
 * master language or cannot be read, the architecture is not approved, or
 * the visual selection changed since the request.
 */
export async function resolveInputs(db: Db, a: ResolveArgs): Promise<ResolvedInputs> {
  const project = await db.project.findUnique({ where: { id: a.projectId } });
  if (!project) throw new InputError(`Project ${a.projectId} not found`);
  const run = await db.voiceRun.findFirst({ where: { id: a.runId, projectId: a.projectId } });
  if (!run) throw new InputError(`Voice run ${a.runId} is not this project's`);
  const master = await db.languageVersion.findUnique({ where: { projectId_language: { projectId: a.projectId, language: project.masterLanguage } } });
  if (!master) throw new InputError(`Project ${project.slug} has no ${project.masterLanguage} language version`);
  if (run.languageVersionId !== master.id) throw new InputError(`Voice run ${run.number} is not in the master language (${project.masterLanguage}): a storyboard is timed by the master narration`);
  const narration = await readNarration(db, a.assemblyId);
  if (!narration || narration.run.id !== run.id) throw new InputError(`Assembly ${a.assemblyId} is not an assembly of voice run ${run.number}`);
  if (narration.assembly.scriptId !== run.scriptId) throw new InputError(`Assembly v${narration.assembly.version} of voice run ${run.number} was made from another script than its run`);
  const { draft, script, architecture } = await scriptAndArchitecture(db, a.projectId, run.scriptId, master.id);
  const evidence = await loadEvidence(db, architecture.dossierId);
  const scope: ScriptScope = buildScope({ architectureId: architecture.id, architectureVersion: architecture.version, architecture: architecture.content, evidence });
  let spine: StoryboardFacts['spine'];
  try {
    spine = buildSpine(narration, draft as ScriptDraft);
  } catch (err) {
    throw err instanceof SpineIntegrityError ? new InputError(`Assembly v${narration.assembly.version} of voice run ${run.number} does not fit script v${script.version}: ${err.message}`) : err;
  }
  let profile = a.profile;
  if (!profile) {
    const production = await resolveVisualProduction(db, a.projectId, { create: true, actor: a.actor });
    if (a.selectionRevision !== undefined && a.selectionRevision !== production.revision) {
      throw new InputError(`The project's visual profile or its overrides changed since this was requested (revision ${a.selectionRevision}, now ${production.revision}): request it again`);
    }
    profile = productionSnapshot(production);
  }
  const approval: NarrationApproval = narrationApprovalOf({
    assemblyId: narration.assembly.id,
    assemblyStatus: narration.assembly.status,
    gateAssemblyId: await gateAssemblyId(db, a.projectId),
    takeStatuses: narration.takes.map((t) => t.status),
  });
  const scopeKind: StoryboardScope = a.phase && spine.outOfScope.length === 0 && narration.assembly.complete ? 'FULL' : 'PARTIAL';
  return {
    facts: { projectId: a.projectId, script: draft, scope, spine, profile, catalog: a.catalog, scopeKind, narrationApproval: approval },
    pins: {
      scriptId: script.id,
      storyId: architecture.id,
      languageVersionId: master.id,
      voiceRunId: run.id,
      voiceAssemblyId: narration.assembly.id,
      assemblyVersion: narration.assembly.version,
      narrationFingerprint: narration.assembly.fingerprint,
      visualProfileId: profile.profileId,
    },
    inputs: {
      script: { id: script.id, version: script.version },
      architecture: { id: architecture.id, version: architecture.version, dossierId: architecture.dossierId },
      narration: narrationInputs(narration, approval, master),
      profile,
      candidates: await candidatesOf(db, architecture.content),
    },
    script,
    architecture,
  };
}

/**
 * The facts a saved version is judged and edited against: its own script,
 * architecture and narration (or another assembly of the same run, to
 * re-time it), a fresh read of the evidence, the profile given (its own, or
 * a new snapshot) and the catalog given. Nothing has to be approved still:
 * staleness is reported, not refused. Refused (InputError) only when what
 * it pinned can no longer be read.
 */
export async function versionFacts(
  db: Db,
  v: { projectId: string; scriptId: string; storyId: string | null; languageVersionId: string | null; voiceAssemblyId: string | null; scope: StoryboardScope },
  o: { catalog: VisualCatalog; profile: VisualProfileSnapshot; assemblyId?: string },
): Promise<StoryboardFacts> {
  const assemblyId = o.assemblyId ?? v.voiceAssemblyId;
  if (!assemblyId) throw new InputError('The narration this version is timed against no longer exists');
  const narration = await readNarration(db, assemblyId);
  if (!narration) throw new InputError(`Assembly ${assemblyId} no longer exists`);
  const languageVersionId = v.languageVersionId ?? narration.assembly.languageVersionId;
  const row = await db.script.findUnique({ where: { id: v.scriptId }, include: SCRIPT_INCLUDE });
  if (!row) throw new InputError(`Script ${v.scriptId} no longer exists`);
  strictBlocks(row, languageVersionId);
  const arch = await db.storyArchitecture.findUnique({ where: { id: v.storyId ?? row.storyId ?? '' } });
  const content = StoryArchitectureContentV2.safeParse(arch?.content);
  if (!arch || !content.success || !arch.dossierId) throw new InputError(`The architecture script v${row.version} tells cannot be read`);
  const draft = toDraft(row, languageVersionId).draft;
  const evidence = await loadEvidence(db, arch.dossierId);
  const scope = buildScope({ architectureId: arch.id, architectureVersion: arch.version, architecture: content.data, evidence });
  let spine: StoryboardFacts['spine'];
  try {
    spine = buildSpine(narration, draft);
  } catch (err) {
    throw err instanceof SpineIntegrityError ? new InputError(`Assembly v${narration.assembly.version} of voice run ${narration.run.number} does not fit script v${row.version}: ${err.message}`) : err;
  }
  const approval = narrationApprovalOf({ assemblyId: narration.assembly.id, assemblyStatus: narration.assembly.status, gateAssemblyId: await gateAssemblyId(db, v.projectId), takeStatuses: narration.takes.map((t) => t.status) });
  return { projectId: v.projectId, script: draft, scope, spine, profile: o.profile, catalog: o.catalog, scopeKind: v.scope, narrationApproval: approval };
}

/** content.inputs.narration for a narration now: its run, assembly, takes and their approval. */
export function narrationInputs(narration: NarrationSpine, approval: NarrationApproval, language: { id: string; language: string }): StoryboardInputs['narration'] {
  const chunkIndex = new Map(narration.chunks.map((c) => [c.id, c.index]));
  return {
    runId: narration.run.id,
    runNumber: narration.run.number,
    runKind: narration.run.kind,
    assemblyId: narration.assembly.id,
    assemblyVersion: narration.assembly.version,
    fingerprint: narration.assembly.fingerprint,
    languageVersionId: language.id,
    language: language.language,
    totalDurationMs: narration.assembly.totalDurationMs,
    complete: narration.assembly.complete,
    voiceProfileId: narration.assembly.profileId,
    takes: narration.takes.map((t) => ({ id: t.id, chunkIndex: chunkIndex.get(t.chunkId) ?? 0, status: t.status, mock: t.mock })),
    approval,
  };
}

// ── Staleness: what a version pinned and what is true now ────────────────────

/** What a saved version pinned. */
export function pinnedFacts(row: { scriptId: string; storyId: string | null; voiceAssemblyId: string | null; narrationFingerprint: string | null }, content: StoryboardContent, shots: readonly { key: string; evidence: PinnedFacts['shots'][number]['evidence'] }[]): PinnedFacts {
  return {
    scriptId: row.scriptId,
    storyId: row.storyId,
    voiceAssemblyId: row.voiceAssemblyId ?? content.inputs.narration.assemblyId,
    fingerprint: row.narrationFingerprint ?? content.inputs.narration.fingerprint,
    takes: content.inputs.narration.takes,
    profile: { profileId: content.inputs.profile.profileId, overrides: content.inputs.profile.overrides },
    catalogVersion: content.inputs.pricing.catalogVersion,
    shots,
  };
}

/** The fingerprints of these runs' newest assemblies (a run with none, or whose clips cannot be read, is left out). */
async function latestFingerprints(db: Db, runIds: readonly string[]): Promise<Map<string, string>> {
  if (!runIds.length) return new Map();
  const rows = await db.voiceAssembly.findMany({ where: { runId: { in: [...runIds] } }, orderBy: [{ runId: 'asc' }, { version: 'desc' }], distinct: ['runId'], select: { runId: true, entries: true } });
  return new Map(
    rows.flatMap((r) => {
      const entries = z.array(AssemblyEntry).min(1).safeParse(r.entries);
      return entries.success ? [[r.runId, narrationFingerprint(entries.data)] as const] : [];
    }),
  );
}

/** What is true now about what these versions of a project pinned (a few queries for all of them). */
export async function liveFactsMany(db: Db, projectId: string, items: readonly { pinned: PinnedFacts; voiceRunId: string | null }[], catalog: VisualCatalog): Promise<LiveFacts[]> {
  const pinned = items.map((i) => i.pinned);
  const approved = await approvedScript(db, projectId);
  const gate = await gateAssemblyId(db, projectId);
  const production = await resolveVisualProduction(db, projectId);
  const ids = <T>(f: (p: PinnedFacts) => T | null | undefined) => [...new Set(pinned.flatMap((p) => (f(p) ? [f(p)!] : [])))];
  const scripts = await db.script.findMany({ where: { id: { in: ids((p) => p.scriptId) } }, select: { id: true, status: true } });
  const architectures = await db.storyArchitecture.findMany({ where: { id: { in: ids((p) => p.storyId) } }, select: { id: true, status: true } });
  const assemblies = await db.voiceAssembly.findMany({ where: { id: { in: ids((p) => p.voiceAssemblyId) } }, select: { id: true, status: true } });
  const takes = await db.voiceGeneration.findMany({ where: { id: { in: [...new Set(pinned.flatMap((p) => p.takes.map((t) => t.id)))] } }, select: { id: true, status: true } });
  const claimIds = [...new Set(pinned.flatMap((p) => p.shots.flatMap((s) => s.evidence?.claims.map((c) => c.claimId) ?? [])))];
  const claims = claimIds.length ? await db.researchClaim.findMany({ where: { id: { in: claimIds } }, select: { id: true, verdict: true } }) : [];
  const fingerprints = await latestFingerprints(db, [...new Set(items.flatMap((i) => (i.voiceRunId ? [i.voiceRunId] : [])))]);
  const status = <T extends { id: string; status: string }>(rows: readonly T[], id: string | null) => (rows.find((r) => r.id === id)?.status ?? null) as ArtifactStatus | null;
  const takeStatuses = new Map(takes.map((t) => [t.id, t.status as VoiceGenerationStatus]));
  const verdicts = new Map(claims.map((c) => [c.id, c.verdict as ClaimVerdict]));
  return items.map(({ pinned: p, voiceRunId }) => ({
    approvedScriptId: approved?.id ?? null,
    scriptStatus: status(scripts, p.scriptId),
    architectureStatus: status(architectures, p.storyId),
    latestFingerprint: voiceRunId ? (fingerprints.get(voiceRunId) ?? null) : null,
    pinnedAssemblyStatus: status(assemblies, p.voiceAssemblyId),
    gateAssemblyId: gate,
    takeStatuses,
    verdicts,
    profile: production.version ? { profileId: production.version.id, overrides: production.overrides } : null,
    catalogVersion: catalog.version,
  }));
}

/** What is true now about what a version pinned. */
export async function liveFacts(db: Db, pinned: PinnedFacts, row: { projectId: string; voiceRunId: string | null }, catalog: VisualCatalog): Promise<LiveFacts> {
  return (await liveFactsMany(db, row.projectId, [{ pinned, voiceRunId: row.voiceRunId }], catalog))[0]!;
}

/** How far the pinned narration is approved now. */
export function liveNarrationApproval(pinned: PinnedFacts, live: LiveFacts, assemblyStatus: ArtifactStatus | null): NarrationApproval {
  if (!pinned.voiceAssemblyId || !assemblyStatus) return 'UNREVIEWED';
  return narrationApprovalOf({ assemblyId: pinned.voiceAssemblyId, assemblyStatus, gateAssemblyId: live.gateAssemblyId, takeStatuses: pinned.takes.map((t) => live.takeStatuses.get(t.id) ?? 'FAILED') });
}
