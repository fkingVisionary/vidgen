import {
  CreateVoiceRunInput,
  DecideVoiceGenerationInput,
  PlanVoiceRunInput,
  RegenerateVoiceInput,
  UpdatePronunciationInput,
  VoiceExperimentInput,
  estimateCost,
  type CreateVoiceProfileInput,
  type DirectorMark,
  type NarrationTimelineEntry,
  type NarrationTimelineView,
  type PerformanceStrategy,
  type VoiceGenerationStatus,
  type VoiceMomentView,
  type VoicePlanView,
  type VoiceQaFinding,
  type VoiceRunOptions,
  type VoiceScope,
} from '@docengine/core';
import type { Database, Job, Prisma, Project, Tx, VoiceChunk, VoiceProfile } from '@docengine/database';
import { ConflictError, EVENT, NotFoundError, type ProjectService } from '@docengine/pipeline';
import { joinClips, buildAssetKey, type ProviderSet, type VoiceProvider } from '@docengine/providers';
import { createHash, randomUUID } from 'node:crypto';
import { clipDrift, formatClock, whatIsSaidAt } from './assembly.ts';
import { blockingCount } from './qa.ts';
import { auditionCoverage, planRun, type RunSettings } from './plan.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';
import { activeProfile, createProfileVersion, profileConfig, ProfileError, toProfileView } from './profiles.ts';
import { rulesFor } from './pronunciation.ts';
import { assemblyMismatch, lexicon, readEntries, readPerformance, readQa, rebuildAssembly, runQa, syncLexicon, unresolvedIn } from './runs.ts';
import { approvedScript, loadScriptForVoice, resolveScope, ScopeError, type VoiceScript } from './script.ts';
import { chunkSentences } from './stage.ts';
import { sha256 } from './text.ts';

/**
 * The editor's side of the Voice Engine: plan a run, generate it (an
 * audition, a section, chosen blocks, the whole script, or a comparison of
 * several ways of narrating the same passage), regenerate chunks, approve,
 * reject or restore takes, decide pronunciations, and version profiles.
 * Every generation goes through a VOICE job; nothing here calls a voice.
 */

export interface VoiceServiceConfig {
  /** Above this many characters (and always for the whole script) a request must be confirmed. */
  confirmCharacters: number;
  /** Ceiling on what one job may send. */
  maxCharacters: number;
}

export interface VoiceServiceDeps {
  db: Database;
  projects: ProjectService;
  providers: ProviderSet;
  config: VoiceServiceConfig;
}

const LABEL: Record<VoiceScope['kind'], string> = { AUDITION: 'Audition', SECTION: 'Section', BLOCKS: 'Blocks', RANGE: 'Range', FULL: 'Full narration' };

/** A chunk's current take, decided or not: to review (or GENERATED, made before IN_REVIEW existed), or approved. */
const APPROVABLE = new Set<VoiceGenerationStatus>(['IN_REVIEW', 'GENERATED', 'APPROVED']);
/** Takes with audio a decision can be taken back from. */
const REJECTABLE = new Set<VoiceGenerationStatus>([...APPROVABLE, 'SUPERSEDED']);

/** What sending this many characters would cost, in words for a confirmation (never a made-up figure). */
function costWords(voice: VoiceProvider, model: string, characters: number): string {
  if (voice.info.mock) return 'no cost: MOCK voice';
  const cost = estimateCost(voice.info.name, model, [{ unit: 'CHARACTERS', quantity: characters }], voice.info.rates);
  if (cost.unpriced.length) return `cost unknown: no price configured for ${model}`;
  return cost.costUsd < 0.01 ? 'under $0.01 estimated' : `about $${cost.costUsd.toFixed(2)} estimated`;
}

function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof ScopeError || err instanceof ProfileError) throw new ConflictError(err.message);
    throw err;
  });
}

export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** A project by id or slug. */
  private async project(ref: string): Promise<Project> {
    const p = /^[0-9a-f-]{36}$/i.test(ref) ? await this.db.project.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] } }) : await this.db.project.findUnique({ where: { slug: ref } });
    if (!p) throw new NotFoundError('Project', ref);
    return p;
  }

  private async approved(project: Project): Promise<VoiceScript> {
    const a = await approvedScript(this.db, project.id);
    if (!a) throw new ConflictError('No approved script: narration is made from an approved script version');
    const script = await loadScriptForVoice(this.db, a.id);
    if (!script) throw new NotFoundError('Script', a.id);
    return script;
  }

  private settingsFor(profile: VoiceProfile, options: VoiceRunOptions | undefined): RunSettings {
    const config = profileConfig(profile);
    return { strategy: options?.strategy ?? config.strategy, chunking: options?.chunking ?? config.chunking, context: options?.context ?? config.context };
  }

  private async profileFor(project: Project, profileId: string | undefined): Promise<VoiceProfile> {
    const { voice } = this.deps.providers;
    if (profileId) {
      const p = await this.db.voiceProfile.findUnique({ where: { id: profileId } });
      if (!p) throw new NotFoundError('Voice profile', profileId);
      if (p.provider !== voice.info.name) throw new ConflictError(`Profile ${p.name} v${p.version} is for ${p.provider}; the configured voice provider is ${voice.info.name}`);
      return p;
    }
    return activeProfile(this.db, voice, project.masterLanguage);
  }

  /** Why a plan cannot be generated (null when it can). */
  private blockedReason(kind: VoiceScope['kind'], characters: number, unresolved: readonly string[], checksFailed: number): string | null {
    const { voice, storage } = this.deps.providers;
    if (!voice.info.mock && storage.info.mock) return 'Real narration needs durable storage: set STORAGE_PROVIDER=s3 (a Railway bucket) so paid audio is not lost on restart';
    if (characters > this.deps.config.maxCharacters) return `${characters} characters is over the ceiling of ${this.deps.config.maxCharacters} per job (VOICE_MAX_CHARACTERS)`;
    if (kind === 'FULL' && unresolved.length) return `Decide the pronunciation list before generating the whole narration: ${unresolved.join(', ')}`;
    if (checksFailed) return `${checksFailed} chunk(s) fail their performance checks`;
    return null;
  }

  /** What a run would be: chunks, what each sends, cost, coverage. Nothing is generated (the pronunciation list is brought up to date). */
  async plan(projectRef: string, raw: PlanVoiceRunInput): Promise<VoicePlanView> {
    const input = PlanVoiceRunInput.parse(raw);
    return wrap(async () => {
      const project = await this.project(projectRef);
      const script = await this.approved(project);
      const profile = await this.profileFor(project, input.profileId);
      const settings = this.settingsFor(profile, input.options);
      const scope = resolveScope(script, input.scope);
      await syncLexicon(this.db, project.id, profile.language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const words = await lexicon(this.db, project.id, profile.language);
      const planned = planRun(script, scope.blocks, profile, settings, this.deps.providers.voice, words);
      const unresolved = unresolvedIn(scope.blocks.map((b) => b.text).join('\n'), words);
      const needsConfirmation = input.scope.kind === 'FULL' || planned.estimate.characters > this.deps.config.confirmCharacters;
      const runs = await this.db.voiceRun.count({ where: { profileId: profile.id } });
      return {
        scope: input.scope,
        description: scope.description,
        profile: toProfileView(profile, runs),
        strategy: settings.strategy,
        chunking: settings.chunking,
        context: settings.context,
        chunks: planned.views,
        estimate: { ...planned.estimate, needsConfirmation },
        coverage: auditionCoverage(script, scope.blocks, words),
        unresolvedPronunciations: unresolved,
        blocked: this.blockedReason(input.scope.kind, planned.estimate.characters, unresolved, planned.takes.filter((t) => !t.passed).length),
      };
    });
  }

  /** Create a run's rows (chunks and their first takes) inside the job's transaction. */
  private async createRunRows(tx: Tx, project: Project, script: VoiceScript, profile: VoiceProfile, scope: VoiceScope, settings: RunSettings, extra: { experiment?: string; variant?: string; notes?: string }, actor: string): Promise<{ id: string; number: number; characters: number }> {
    const resolved = resolveScope(script, scope);
    const words = await lexicon(tx, project.id, profile.language);
    const planned = planRun(script, resolved.blocks, profile, settings, this.deps.providers.voice, words);
    const blocked = this.blockedReason(scope.kind, planned.estimate.characters, unresolvedIn(resolved.blocks.map((b) => b.text).join('\n'), words), planned.takes.filter((t) => !t.passed).length);
    if (blocked) throw new ConflictError(blocked);
    const last = await tx.voiceRun.findFirst({ where: { projectId: project.id }, orderBy: { number: 'desc' }, select: { number: true } });
    const lv = await tx.languageVersion.findUniqueOrThrow({ where: { projectId_language: { projectId: project.id, language: project.masterLanguage } } });
    const run = await tx.voiceRun.create({
      data: {
        projectId: project.id,
        languageVersionId: lv.id,
        scriptId: script.id,
        profileId: profile.id,
        number: (last?.number ?? 0) + 1,
        kind: scope.kind,
        scope: { ...scope, description: resolved.description, blockKeys: resolved.blocks.map((b) => b.key) } as unknown as Prisma.InputJsonValue,
        strategy: settings.strategy,
        settings: { chunking: settings.chunking, context: settings.context } as unknown as Prisma.InputJsonValue,
        experiment: extra.experiment ?? null,
        variant: extra.variant ?? null,
        notes: extra.notes ?? null,
        createdBy: actor,
      },
    });
    for (const c of planned.chunks) {
      const blockHashes = Object.fromEntries(c.spans.map((s) => [s.blockKey, sha256(script.blocks.get(s.blockKey)!.text)]));
      const textHash = sha256(c.text);
      const chunk = await tx.voiceChunk.create({
        data: {
          runId: run.id,
          sceneId: c.sectionId,
          chunkIndex: c.index,
          sectionKey: c.sectionKey,
          blockKeys: c.spans.map((s) => s.blockKey),
          sourceBlockId: c.spans[0]!.blockId,
          spans: c.spans as unknown as Prisma.InputJsonValue,
          sourceText: c.text,
          textHash,
          blockHashes,
          words: c.words,
          boundary: c.boundary,
          performance: c.performance as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.voiceGeneration.create({
        data: { chunkId: chunk.id, runId: run.id, projectId: project.id, generation: 1, status: 'PENDING', profileId: profile.id, provider: profile.provider, model: profile.modelId, voiceId: profile.voiceId, strategy: settings.strategy, canonicalText: c.text, textHash, createdBy: actor },
      });
    }
    return { id: run.id, number: run.number, characters: planned.estimate.characters };
  }

  private async event(db: Database | Tx, projectId: string, type: string, message: string, data: Record<string, unknown>) {
    await db.projectEvent.create({ data: { projectId, type, message, data: data as Prisma.InputJsonValue } });
  }

  /** Generate a run: an audition, a section, chosen blocks, a range, or the whole script. */
  async createRun(projectRef: string, raw: CreateVoiceRunInput, actor: string): Promise<{ job: Job; run: number }> {
    const input = CreateVoiceRunInput.parse(raw);
    return wrap(async () => {
      const project = await this.project(projectRef);
      const script = await this.approved(project);
      const profile = await this.profileFor(project, input.profileId);
      const settings = this.settingsFor(profile, input.options);
      const scope = resolveScope(script, input.scope);
      await syncLexicon(this.db, project.id, profile.language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const out: { number?: number } = {};
      const job = await this.deps.projects.voiceJob(project.id, actor, `${LABEL[input.scope.kind]} of script v${script.version}`, async (tx, p) => {
        const created = await this.createRunRows(tx, p, script, profile, input.scope, settings, { ...(input.notes ? { notes: input.notes } : {}) }, actor);
        out.number = created.number;
        if ((input.scope.kind === 'FULL' || created.characters > this.deps.config.confirmCharacters) && !input.confirm) {
          throw new ConflictError(`${LABEL[input.scope.kind]}: ${created.characters} characters to generate — confirm to go ahead`);
        }
        await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Voice run ${created.number}: ${scope.description} (${profile.provider} ${profile.modelId}, ${settings.strategy.toLowerCase()})`, { actor, run: created.number, scope: input.scope, profile: `${profile.name} v${profile.version}`, characters: created.characters });
        return { runIds: [created.id] };
      });
      return { job, run: out.number! };
    });
  }

  /** A comparison: the same passage narrated 2–8 ways (each variant its own run and assembly, generated in one job; always confirmed). */
  async createExperiment(projectRef: string, raw: VoiceExperimentInput, actor: string): Promise<{ job: Job; runs: number[] }> {
    const input = VoiceExperimentInput.parse(raw);
    if (input.scope.kind === 'FULL') throw new ConflictError('A comparison narrates a passage, not the whole script');
    return wrap(async () => {
      const project = await this.project(projectRef);
      const script = await this.approved(project);
      const profile = await this.profileFor(project, input.profileId);
      const scope = resolveScope(script, input.scope);
      await syncLexicon(this.db, project.id, profile.language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const numbers: number[] = [];
      const job = await this.deps.projects.voiceJob(project.id, actor, `Comparison "${input.name}" of script v${script.version}`, async (tx, p) => {
        const ids: string[] = [];
        let characters = 0;
        for (const v of input.variants) {
          const r = await this.createRunRows(tx, p, script, profile, input.scope, this.settingsFor(profile, v), { experiment: input.name, variant: v.label }, actor);
          ids.push(r.id);
          numbers.push(r.number);
          characters += r.characters;
        }
        if (characters > this.deps.config.maxCharacters) throw new ConflictError(`The comparison would send ${characters} characters, over the ceiling of ${this.deps.config.maxCharacters}`);
        // A comparison buys several narrations of the same passage: always confirmed, whatever its size.
        if (!input.confirm) throw new ConflictError(`Comparison: ${characters} characters (${costWords(this.deps.providers.voice, profile.modelId, characters)}) across ${input.variants.length} variants — confirm to go ahead`);
        await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Comparison "${input.name}": ${input.variants.map((v) => v.label).join(' / ')} — ${scope.description}`, { actor, runs: numbers, characters });
        return { runIds: ids };
      });
      return { job, runs: numbers };
    });
  }

  /**
   * New takes for chosen chunks of a run (earlier takes are kept): one per
   * chunk, made current when it is ready — or, for an A/B comparison, one per
   * variant per chunk, kept beside the current take until the editor
   * restores one. An A/B, every chunk, or more than the confirmation
   * threshold must be confirmed.
   */
  async regenerate(runId: string, raw: RegenerateVoiceInput, actor: string): Promise<{ job: Job; takes: number }> {
    const input = RegenerateVoiceInput.parse(raw);
    const run = await this.db.voiceRun.findUnique({ where: { id: runId }, include: { profile: true, chunks: { orderBy: { chunkIndex: 'asc' } } } });
    if (!run) throw new NotFoundError('Voice run', runId);
    const project = await this.db.project.findUniqueOrThrow({ where: { id: run.projectId } });
    const approved = await approvedScript(this.db, project.id);
    if (!approved || approved.id !== run.scriptId) throw new ConflictError(`Voice run ${run.number} was made from a script version that is no longer the approved one: start a new run (stale audio is never reused)`);
    const chunks = run.chunks.filter((c) =>
      input.all ? true : input.chunkIds?.length ? input.chunkIds.includes(c.id) : input.section ? c.sectionKey === `SC${String(input.section).padStart(2, '0')}` : (input.blockKeys ?? []).some((k) => c.blockKeys.includes(k)),
    );
    if (!chunks.length) throw new ConflictError('No chunk of this run matches');
    const variants: { label: string | null; strategy: PerformanceStrategy; marks: DirectorMark[] }[] = input.variants
      ? input.variants.map((v) => ({ label: v.label, strategy: v.strategy ?? run.strategy, marks: v.marks ?? [] }))
      : [{ label: null, strategy: input.strategy ?? run.strategy, marks: input.marks ?? [] }];
    const script = await loadScriptForVoice(this.db, run.scriptId);
    if (!script) throw new NotFoundError('Script', run.scriptId);
    const characters = await this.sentCharacters(project.id, run.profile, script, chunks, variants);
    const takes = chunks.length * variants.length;
    if (characters > this.deps.config.maxCharacters) throw new ConflictError(`${takes} new take(s) would send ${characters} characters, over the ceiling of ${this.deps.config.maxCharacters} per job (VOICE_MAX_CHARACTERS)`);
    if ((input.all || input.variants || characters > this.deps.config.confirmCharacters) && !input.confirm) {
      throw new ConflictError(`${input.variants ? `A/B (${variants.map((v) => v.label).join(' / ')}) of` : 'Regenerating'} ${chunks.length} chunk(s): ${takes} take(s), ${characters} characters (${costWords(this.deps.providers.voice, run.profile.modelId, characters)}) — confirm to go ahead`);
    }
    const job = await this.deps.projects.voiceJob(project.id, actor, `New takes for ${chunks.length} chunk(s) of voice run ${run.number}${input.variants ? ` (A/B: ${variants.map((v) => v.label).join(' / ')})` : ''}`, async (tx, p) => {
      const ids: string[] = [];
      for (const c of chunks) {
        const last = await tx.voiceGeneration.findFirst({ where: { chunkId: c.id }, orderBy: { generation: 'desc' }, select: { generation: true } });
        let generation = last?.generation ?? 0;
        for (const v of variants) {
          const g = await tx.voiceGeneration.create({
            data: {
              chunkId: c.id,
              runId: run.id,
              projectId: p.id,
              generation: ++generation,
              status: 'PENDING',
              profileId: run.profileId,
              provider: run.profile.provider,
              model: run.profile.modelId,
              voiceId: run.profile.voiceId,
              strategy: v.strategy,
              variant: v.label,
              canonicalText: c.sourceText,
              textHash: c.textHash,
              ...(v.marks.length ? { directions: v.marks as unknown as Prisma.InputJsonValue } : {}),
              ...(input.note ? { note: input.note } : {}),
              createdBy: actor,
            },
          });
          ids.push(g.id);
        }
      }
      await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Voice run ${run.number}: new takes for chunk(s) ${chunks.map((c) => c.chunkIndex + 1).join(', ')}${input.variants ? ` (A/B: ${variants.map((v) => v.label).join(' / ')})` : ''}`, {
        actor,
        run: run.number,
        chunks: chunks.map((c) => c.chunkIndex + 1),
        variants: input.variants ? variants.map((v) => v.label) : null,
        directions: variants.reduce((n, v) => n + v.marks.length, 0),
        characters,
      });
      return { runIds: [run.id], generationIds: ids };
    });
    return { job, takes };
  }

  /** Characters new takes of these chunks would send: prepared as the stage prepares them (spoken forms, approved aliases, markup), not the script's text. */
  private async sentCharacters(projectId: string, profile: VoiceProfile, script: VoiceScript, chunks: readonly VoiceChunk[], variants: readonly { strategy: PerformanceStrategy; marks: readonly DirectorMark[] }[]): Promise<number> {
    const config = profileConfig(profile);
    const words = await lexicon(this.db, projectId, profile.language);
    const blocks = new Map<string, TakeBlock>([...script.blocks.values()].map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
    let characters = 0;
    for (const c of chunks) {
      const rules = rulesFor(c.sourceText, words);
      for (const v of variants) {
        const prepared = prepareTake({
          chunk: { text: c.sourceText, sentences: chunkSentences(c), performance: readPerformance(c.performance) },
          blocks,
          strategy: v.strategy,
          ...(v.marks.length ? { director: v.marks } : {}),
          numberStyle: config.numberStyle,
          aliases: rules.aliases,
          phonemes: rules.phonemes,
          provider: this.deps.providers.voice,
          model: profile.modelId,
          settings: config.settings,
          context: { previousText: null, nextText: null },
          seed: null,
        });
        characters += prepared.rendered.text.length;
      }
    }
    return characters;
  }

  /** Approve a take, reject it (no regeneration is forced), or make an earlier take current again. */
  async decide(generationId: string, raw: DecideVoiceGenerationInput, actor: string): Promise<{ runId: string }> {
    const input = DecideVoiceGenerationInput.parse(raw);
    const take = await this.db.voiceGeneration.findUnique({ where: { id: generationId }, include: { chunk: true, run: true } });
    if (!take) throw new NotFoundError('Take', generationId);
    const isCurrent = take.chunk.currentGenerationId === take.id;
    const now = new Date();
    await this.db.$transaction(async (tx) => {
      if (input.action === 'APPROVE') {
        if (!isCurrent) throw new ConflictError('Only the current take of a chunk can be approved: restore it first');
        if (!APPROVABLE.has(take.status)) throw new ConflictError(`Take ${take.generation} is ${take.status.toLowerCase()}: it cannot be approved`);
        const blocking = readQa(take.qa).filter((f) => f.severity === 'BLOCKING' && f.kind !== 'MOCK_AUDIO');
        if (blocking.length) throw new ConflictError(`Take ${take.generation} has blocking findings (${blocking.map((f) => f.detail).join('; ')}): regenerate it`);
        await tx.voiceGeneration.update({ where: { id: take.id }, data: { status: 'APPROVED', approvedAt: now, decidedBy: actor, decidedAt: now, ...(input.note ? { note: input.note } : {}) } });
      } else if (input.action === 'REJECT') {
        if (!REJECTABLE.has(take.status)) throw new ConflictError(`Take ${take.generation} is ${take.status.toLowerCase()}: nothing to reject`);
        await tx.voiceGeneration.update({ where: { id: take.id }, data: { status: 'REJECTED', approvedAt: null, decidedBy: actor, decidedAt: now, ...(input.note ? { note: input.note } : {}) } });
      } else {
        if (isCurrent) throw new ConflictError(`Take ${take.generation} is already the current take`);
        if (!take.audioAssetId || !take.durationMs) throw new ConflictError(`Take ${take.generation} has no audio to restore`);
        if (take.textHash !== take.chunk.textHash) throw new ConflictError(`Take ${take.generation} was made from other text: it cannot be reused`);
        const current = take.chunk.currentGenerationId ? await tx.voiceGeneration.findUnique({ where: { id: take.chunk.currentGenerationId } }) : null;
        if (current && APPROVABLE.has(current.status)) await tx.voiceGeneration.update({ where: { id: current.id }, data: { status: 'SUPERSEDED' } });
        // Back to the decision it had: approved if it was, else to review (an A/B variant becomes the chunk's take here).
        await tx.voiceGeneration.update({ where: { id: take.id }, data: { status: take.approvedAt ? 'APPROVED' : 'IN_REVIEW', decidedBy: actor, decidedAt: now, ...(input.note ? { note: input.note } : {}) } });
        await tx.voiceChunk.update({ where: { id: take.chunkId }, data: { currentGenerationId: take.id } });
      }
      await this.event(tx, take.projectId, EVENT.VOICE_TAKE_DECIDED, `Voice run ${take.run.number}, chunk ${take.chunk.chunkIndex + 1}: take ${take.generation} ${input.action === 'RESTORE' ? 'restored' : input.action === 'APPROVE' ? 'approved' : 'rejected'}`, { actor, take: take.generation, chunk: take.chunk.chunkIndex + 1, note: input.note ?? null });
    });
    if (input.action === 'RESTORE') {
      const script = await loadScriptForVoice(this.db, take.run.scriptId);
      if (script) await rebuildAssembly(this.db, take.runId, script, actor);
    }
    return { runId: take.runId };
  }

  /** Approve every current take of a run that has no blocking finding (the rest stay for a closer listen). */
  async approveAll(runId: string, actor: string): Promise<{ approved: number; skipped: number }> {
    const run = await this.db.voiceRun.findUnique({ where: { id: runId }, include: { chunks: { include: { current: true } } } });
    if (!run) throw new NotFoundError('Voice run', runId);
    const now = new Date();
    let approved = 0;
    let skipped = 0;
    for (const c of run.chunks) {
      const g = c.current;
      if (!g || (g.status !== 'IN_REVIEW' && g.status !== 'GENERATED')) continue;
      if (readQa(g.qa).some((f) => f.severity === 'BLOCKING' && f.kind !== 'MOCK_AUDIO')) {
        skipped++;
        continue;
      }
      await this.db.voiceGeneration.update({ where: { id: g.id }, data: { status: 'APPROVED', approvedAt: now, decidedBy: actor, decidedAt: now } });
      approved++;
    }
    await this.event(this.db, run.projectId, EVENT.VOICE_TAKE_DECIDED, `Voice run ${run.number}: ${approved} take(s) approved together${skipped ? `, ${skipped} left for review (blocking findings)` : ''}`, { actor, approved, skipped });
    return { approved, skipped };
  }

  async updatePronunciation(id: string, raw: UpdatePronunciationInput, actor: string): Promise<void> {
    const input = UpdatePronunciationInput.parse(raw);
    const row = await this.db.voicePronunciation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('Pronunciation', id);
    await this.db.voicePronunciation.update({
      where: { id },
      data: { method: input.method, pronunciation: input.method === 'DEFAULT' ? null : (input.pronunciation ?? null), status: input.status, ...(input.notes !== undefined ? { notes: input.notes } : {}), source: row.source === 'DETECTED' || row.source === 'SCRIPT' ? row.source : 'EDITOR', updatedBy: actor },
    });
    await this.event(this.db, row.projectId, EVENT.VOICE_PRONUNCIATION_UPDATED, `Pronunciation of "${row.term}": ${input.status.toLowerCase()}${input.method !== 'DEFAULT' ? ` (${input.method.toLowerCase()} ${input.pronunciation})` : " (the voice's own reading)"}`, { actor, term: row.term });
  }

  async createProfile(projectRef: string, input: CreateVoiceProfileInput, actor: string): Promise<VoiceProfile> {
    return wrap(async () => {
      const project = await this.project(projectRef);
      const p = await createProfileVersion(this.db, this.deps.providers.voice, project.masterLanguage, input, actor);
      await this.event(this.db, project.id, EVENT.VOICE_PROFILE_CREATED, `Voice profile ${p.name} v${p.version}: ${p.provider} ${p.modelId}, voice ${p.voiceId}`, { actor, profile: p.id });
      return p;
    });
  }

  /** A stored audio file (a take or an assembly) for streaming to the dashboard. */
  async audio(assetId: string): Promise<{ bytes: Uint8Array; mimeType: string; mock: boolean }> {
    const asset = await this.db.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.kind !== 'NARRATION_AUDIO') throw new NotFoundError('Narration audio', assetId);
    try {
      return { bytes: await this.deps.providers.storage.get(asset.storageKey), mimeType: asset.mimeType, mock: asset.isMock };
    } catch (err) {
      throw new ConflictError(`The audio file is not in storage (${err instanceof Error ? err.message : String(err)})${this.deps.providers.storage.info.mock ? ': MOCK storage is in memory and was emptied by a restart' : ''}`);
    }
  }

  /** The assembled narration as one file: built from its takes (with the pauses) the first time it is asked for. */
  async assemblyAudio(assemblyId: string): Promise<{ bytes: Uint8Array; mimeType: string; mock: boolean }> {
    const assembly = await this.db.voiceAssembly.findUnique({ where: { id: assemblyId }, include: { run: { include: { profile: true } } } });
    if (!assembly) throw new NotFoundError('Assembly', assemblyId);
    if (assembly.audioAssetId) return this.audio(assembly.audioAssetId);
    const entries = readEntries(assembly.entries);
    const takes = await this.db.voiceGeneration.findMany({ where: { id: { in: entries.map((e) => e.generationId) } }, select: { id: true, audioAssetId: true } });
    const clips = [];
    let mock = false;
    for (const e of entries) {
      const assetId = takes.find((t) => t.id === e.generationId)?.audioAssetId;
      if (!assetId) throw new ConflictError('A take of this assembly has no audio');
      const a = await this.audio(assetId);
      mock ||= a.mock;
      clips.push({ audio: a.bytes, mimeType: a.mimeType, gapAfterMs: e.gapAfterMs });
    }
    const joined = joinClips(clips);
    const drift = clipDrift(entries, joined.startsMs);
    if (drift) await this.db.voiceAssembly.update({ where: { id: assembly.id }, data: { qa: [...readQa(assembly.qa).filter((f) => f.kind !== drift.kind), drift] as unknown as Prisma.InputJsonValue } });
    const id = randomUUID();
    const key = buildAssetKey({ projectId: assembly.projectId, language: assembly.run.profile.language, kind: 'NARRATION_AUDIO', assetId: id, ext: joined.mimeType === 'audio/mpeg' ? 'mp3' : 'wav' });
    await this.deps.providers.storage.put(key, joined.audio, { contentType: joined.mimeType, metadata: { assembly: assembly.id } });
    await this.db.mediaAsset.create({
      data: { id, projectId: assembly.projectId, languageVersionId: assembly.run.languageVersionId, kind: 'NARRATION_AUDIO', storageKey: key, mimeType: joined.mimeType, sizeBytes: BigInt(joined.audio.byteLength), durationMs: joined.durationMs, checksumSha256: createHash('sha256').update(joined.audio).digest('hex'), provider: assembly.run.profile.provider, isMock: mock, metadata: { assemblyId: assembly.id, run: assembly.run.number, version: assembly.version } },
    });
    await this.db.voiceAssembly.updateMany({ where: { id: assembly.id, audioAssetId: null }, data: { audioAssetId: id } });
    return { bytes: joined.audio, mimeType: joined.mimeType, mock };
  }

  /** "What is being said at 02:43?" in a run's latest assembly, with the timeline's part for that moment. */
  async moment(projectRef: string, runNumber: number, ms: number): Promise<VoiceMomentView> {
    const t = await this.timeline(projectRef, runNumber);
    const hit = whatIsSaidAt(t.timeline, ms);
    if (!hit) throw new ConflictError(`Nothing is said at ${formatClock(ms)}`);
    return {
      atMs: ms,
      run: t.run,
      section: hit.entry.scriptBlock.sectionKey,
      block: hit.entry.scriptBlock.key,
      chunk: hit.entry.audioChunk.index + 1,
      generation: hit.entry.audioChunk.generation,
      word: hit.word?.word ?? null,
      text: hit.entry.text,
      between: hit.between,
      startMs: hit.entry.startMs,
      endMs: hit.entry.endMs,
      part: hit.entry,
    };
  }

  /**
   * The narration timeline of a run's latest assembly, as the storyboard
   * reads it: for each block part, its section, block, chunk, take and audio
   * file, start and end on the assembled clock, timed words and performance,
   * and whether its take is approved now (a decision after assembly counts).
   */
  async timeline(projectRef: string, runNumber: number): Promise<NarrationTimelineView> {
    const project = await this.project(projectRef);
    const run = await this.db.voiceRun.findUnique({ where: { projectId_number: { projectId: project.id, number: runNumber } }, include: { script: { select: { version: true } } } });
    if (!run) throw new NotFoundError('Voice run', String(runNumber));
    const assembly = await this.db.voiceAssembly.findFirst({ where: { runId: run.id }, orderBy: { version: 'desc' } });
    if (!assembly) throw new ConflictError(`Voice run ${runNumber} has no assembled narration yet`);
    const entries = readEntries(assembly.entries);
    const timeline = (assembly.timeline ?? []) as unknown as NarrationTimelineEntry[];
    const ids = [...new Set([...entries.map((e) => e.generationId), ...timeline.map((t) => t.audioChunk.generationId)])];
    const takes = new Map((await this.db.voiceGeneration.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, audioAssetId: true } })).map((t) => [t.id, t]));
    // Assemblies made before audio files were recorded in them get theirs from the take.
    const asset = (takeId: string, known: string | undefined) => {
      const id = known ?? takes.get(takeId)?.audioAssetId;
      return id ? { audioAssetId: id } : {};
    };
    return {
      run: run.number,
      scriptVersion: run.script.version,
      assembly: assembly.version,
      status: assembly.status,
      complete: assembly.complete,
      totalDurationMs: assembly.totalDurationMs,
      entries: entries.map((e) => ({ ...e, ...asset(e.generationId, e.audioAssetId) })),
      timeline: timeline.map((t) => ({
        ...t,
        audioChunk: { ...t.audioChunk, ...asset(t.audioChunk.generationId, t.audioChunk.audioAssetId) },
        approved: takes.get(t.audioChunk.generationId)?.status === 'APPROVED',
      })),
    };
  }

  /** The run's QA as it stands now (for the view and the gate). */
  async qaOf(runId: string): Promise<VoiceQaFinding[]> {
    const run = await this.db.voiceRun.findUniqueOrThrow({ where: { id: runId }, include: { chunks: { orderBy: { chunkIndex: 'asc' }, include: { current: true } }, profile: true, script: { select: { version: true } } } });
    return liveRunQa(this.db, run);
  }
}

/** Live QA of a run (shared by the view and the VOICE gate). */
export async function liveRunQa(
  db: Database | Tx,
  run: { id: string; projectId: string; kind: string; scriptId: string; script: { version: number }; profile: { language: string }; chunks: Parameters<typeof runQa>[0]['chunks'] },
): Promise<VoiceQaFinding[]> {
  const approved = await approvedScript(db, run.projectId);
  const script = await loadScriptForVoice(db, run.scriptId);
  const approvedText = approved && approved.id !== run.scriptId ? await loadScriptForVoice(db, approved.id) : null;
  const words = await lexicon(db, run.projectId, run.profile.language);
  const text = run.chunks.map((c) => c.sourceText).join('\n');
  const assembly = await db.voiceAssembly.findFirst({ where: { runId: run.id }, orderBy: { version: 'desc' }, select: { version: true, entries: true, qa: true } });
  const mismatch = assemblyMismatch(run.chunks, assembly);
  return [
    ...runQa({
      kind: run.kind,
      scriptVersion: run.script.version,
      approved,
      scriptId: run.scriptId,
      chunks: run.chunks,
      allBlockKeys: script ? [...script.blocks.keys()] : [],
      approvedBlockText: approvedText ? new Map([...approvedText.blocks.values()].map((b) => [b.key, b.text])) : null,
      unresolved: unresolvedIn(text, words),
    }),
    ...(mismatch ? [mismatch] : []),
    ...readQa(assembly?.qa),
  ];
}

export { blockingCount };
