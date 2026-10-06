import {
  CreateVoiceRunInput,
  DecideVoiceGenerationInput,
  PlanVoiceRunInput,
  PronunciationConfig,
  RegenerateVoiceInput,
  UpdatePronunciationInput,
  VoiceExperimentInput,
  estimateCost,
  performanceRulesProblems,
  type CreateVoiceProfileFamilyInput,
  type DirectorMark,
  type DuplicateVoiceProfileInput,
  type NarrationTimelineEntry,
  type NarrationTimelineView,
  type NewVoiceProfileVersionInput,
  type SaveRunAsProfileInput,
  type UpdateVoiceProfileFamilyInput,
  type VoiceConfigOverrides,
  type VoiceGenerationStatus,
  type VoiceMomentView,
  type VoicePlanView,
  type VoiceQaFinding,
  type VoiceRunConfig,
  type VoiceRunOptions,
  type VoiceScope,
  type VoiceSelectionInput,
  type VoiceTakeConfig,
  type VoiceTakeOverride,
} from '@docengine/core';
import type { Database, Job, Prisma, Project, Tx, VoiceChunk } from '@docengine/database';
import { ConflictError, EVENT, NotFoundError, type ProjectService } from '@docengine/pipeline';
import { joinClips, buildAssetKey, type ProviderSet, type VoiceProvider } from '@docengine/providers';
import { createHash, randomUUID } from 'node:crypto';
import { clipDrift, formatClock, whatIsSaidAt } from './assembly.ts';
import { checkOverrides, describeOverrides, mergeOverrides, newRunConfig, newTakeConfig, profileLabel, runConfig, takeSource, type ProfileRow } from './config.ts';
import { blockingCount, configurationFindings } from './qa.ts';
import { auditionCoverage, planRun } from './plan.ts';
import { prepareTake, type TakeBlock } from './prepare.ts';
import {
  ProfileError,
  createProfileFamily,
  duplicateProfile,
  isUniqueViolation,
  libraryDefault,
  newProfileVersion,
  profileViews,
  resolveProduction,
  saveRunAsProfile,
  setSelection,
  updateProfileFamily,
  type Production,
} from './profiles.ts';
import { rulesFor } from './pronunciation.ts';
import { assemblyMismatch, lexicon, readEntries, readPerformance, readQa, rebuildAssembly, runQa, syncLexicon, unresolvedIn } from './runs.ts';
import { approvedScript, loadScriptForVoice, resolveScope, ScopeError, type VoiceScript } from './script.ts';
import { chunkSentences } from './stage.ts';
import { sha256 } from './text.ts';

/**
 * The editor's side of the Voice Engine: plan a run, generate it (an
 * audition, a section, chosen blocks, the whole script, or a comparison of
 * several ways of narrating the same passage), regenerate chunks with the
 * run's configuration, the production profile or a temporary override,
 * approve, reject or restore takes, decide pronunciations, keep the profile
 * library, and choose a project's profile and overrides. Every generation
 * goes through a VOICE job; nothing here calls a voice.
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

/** What sending these characters would cost, in words for a confirmation (never a made-up figure): each part at its model's price. */
function costWords(voice: VoiceProvider, parts: readonly { model: string; characters: number }[]): string {
  if (voice.info.mock) return 'no cost: MOCK voice';
  let usd = 0;
  for (const p of parts) {
    const cost = estimateCost(voice.info.name, p.model, [{ unit: 'CHARACTERS', quantity: p.characters }], voice.info.rates);
    if (cost.unpriced.length) return `cost unknown: no price configured for ${p.model}`;
    usd += cost.costUsd;
  }
  return usd < 0.01 ? 'under $0.01 estimated' : `about $${usd.toFixed(2)} estimated`;
}

/** A refusal the editor can act on (409): a scope or profile problem, or a version, name or selection saved at the same time elsewhere. */
function wrap<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof ScopeError || err instanceof ProfileError) throw new ConflictError(err.message);
    if (isUniqueViolation(err)) throw new ConflictError('Saved at the same time somewhere else (a profile version, a name or a project\'s choice): reload and try again');
    throw err;
  });
}

/** A selection revision a plan was made at that is no longer the project's. */
const revisionChanged = (planned: number, now: number) =>
  new ConflictError(`The project's voice profile or its overrides changed since this was planned (revision ${planned}, now ${now}): plan again`);

/** How a run narrates, resolved: the version, production, and the frozen configuration. */
interface Resolved {
  production: Production;
  version: ProfileRow;
  config: VoiceRunConfig;
}

/** "Tulip narrator, follows the current version (v1); overrides: stability 0.4", "Tulip narrator, pinned to v1; overrides: none". */
function selectionText(s: { family: { name: string } | null; version: { name: string; version: number } | null; pinned: boolean; overrides: VoiceConfigOverrides }): string {
  const which = !s.family ? `the library default${s.version ? ` (${s.version.name} v${s.version.version})` : ''}` : `${s.family.name}, ${s.pinned ? `pinned to v${s.version?.version}` : `follows the current version (v${s.version?.version})`}`;
  return `${which}; overrides: ${describeOverrides(s.overrides)}`;
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

  private async masterLanguage(project: Project): Promise<{ id: string; language: string; projectId: string }> {
    const lv = await this.db.languageVersion.findUnique({ where: { projectId_language: { projectId: project.id, language: project.masterLanguage } } });
    if (!lv) throw new NotFoundError('Language version', `${project.slug} (${project.masterLanguage})`);
    return lv;
  }

  /**
   * The version a run narrates with and its frozen configuration: the one
   * named (a comparison of saved profiles, a plan pinned to a version), else
   * production's. The project's overrides apply to versions of production's
   * family only (an older version a plan pinned included); another saved
   * profile is heard as saved (EXPLICIT).
   */
  private async resolve(production: Production, profileId: string | undefined, options: VoiceRunOptions | undefined): Promise<Resolved> {
    const voice = this.deps.providers.voice;
    let version: ProfileRow;
    if (profileId) {
      const named = await this.db.voiceProfile.findUnique({ where: { id: profileId }, include: { family: true } });
      if (!named) throw new NotFoundError('Voice profile', profileId);
      if (named.provider !== voice.info.name) throw new ProfileError(`Profile ${named.name} v${named.version} is for ${named.provider}; the configured voice provider is ${voice.info.name}`);
      if (named.language !== production.language) throw new ProfileError(`Profile ${named.name} v${named.version} is for ${named.language}; this narration is ${production.language}`);
      if (named.family?.archivedAt && named.familyId !== production.family?.id) throw new ProfileError(`Profile ${named.family.name} is archived: unarchive it to narrate with it`);
      version = named;
    } else {
      if (production.problem || !production.version) throw new ProfileError(production.problem ?? 'No voice profile to narrate with');
      version = production.version;
    }
    const runOptions = options ?? {};
    const problems = checkOverrides(runOptions, voice, 'RUN');
    if (problems.length) throw new ProfileError(`Run options: ${problems.join('; ')}`);
    const own = !!production.family && version.familyId === production.family.id;
    const config = newRunConfig({ version, selection: { mode: own ? production.mode : 'EXPLICIT', revision: production.revision }, projectOverrides: own ? production.overrides : {}, runOptions }, voice);
    const rules = performanceRulesProblems(config.effective.performanceRules);
    if (rules.length) throw new ProfileError(`Performance rules (the profile's with the overrides): ${rules.join('; ')}`);
    return { production, version, config };
  }

  /** Production for the project's master language (the library default made or adopted if need be), refused when the plan was made at another revision. */
  private async production(project: Project, selectionRevision: number | undefined, actor: string): Promise<Production> {
    const production = await resolveProduction(this.db, this.deps.providers.voice, await this.masterLanguage(project), { create: true, actor });
    if (selectionRevision !== undefined && selectionRevision !== production.revision) throw revisionChanged(selectionRevision, production.revision);
    return production;
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
  async plan(projectRef: string, raw: PlanVoiceRunInput, actor = 'system'): Promise<VoicePlanView> {
    const input = PlanVoiceRunInput.parse(raw);
    return wrap(async () => {
      const project = await this.project(projectRef);
      const script = await this.approved(project);
      const { version, config, production } = await this.resolve(await this.production(project, input.selectionRevision, actor), input.profileId, input.options);
      const { effective } = config;
      const scope = resolveScope(script, input.scope);
      await syncLexicon(this.db, project.id, effective.language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const words = await lexicon(this.db, project.id, effective.language);
      const planned = planRun(script, scope.blocks, effective, this.deps.providers.voice, words);
      const unresolved = unresolvedIn(scope.blocks.map((b) => b.text).join('\n'), words, effective.pronunciation.rules);
      const needsConfirmation = input.scope.kind === 'FULL' || planned.estimate.characters > this.deps.config.confirmCharacters;
      return {
        scope: input.scope,
        description: scope.description,
        profile: (await profileViews(this.db, this.deps.providers.voice, [version]))[0]!,
        strategy: effective.strategy,
        chunking: effective.chunking,
        context: effective.context,
        chunks: planned.views,
        estimate: { ...planned.estimate, needsConfirmation },
        coverage: auditionCoverage(script, scope.blocks, words),
        unresolvedPronunciations: unresolved,
        blocked: this.blockedReason(input.scope.kind, planned.estimate.characters, unresolved, planned.takes.filter((t) => !t.passed).length),
        configuration: {
          effective,
          provenance: config.provenance,
          selectionRevision: production.revision,
          mode: config.selection?.mode ?? 'EXPLICIT',
          projectOverrides: config.projectOverrides,
          runOptions: config.runOptions,
          sent: config.sent,
          ignored: config.ignored,
        },
      };
    });
  }

  /** Create a run's rows (chunks and their first takes) inside the job's transaction, with the configuration resolved and checked before it. */
  private async createRunRows(tx: Tx, project: Project, script: VoiceScript, config: VoiceRunConfig, scope: VoiceScope, extra: { experiment?: string; variant?: string; notes?: string }, actor: string): Promise<{ id: string; number: number; characters: number }> {
    const { effective } = config;
    const resolved = resolveScope(script, scope);
    const words = await lexicon(tx, project.id, effective.language);
    const planned = planRun(script, resolved.blocks, effective, this.deps.providers.voice, words);
    const blocked = this.blockedReason(scope.kind, planned.estimate.characters, unresolvedIn(resolved.blocks.map((b) => b.text).join('\n'), words, effective.pronunciation.rules), planned.takes.filter((t) => !t.passed).length);
    if (blocked) throw new ConflictError(blocked);
    const last = await tx.voiceRun.findFirst({ where: { projectId: project.id }, orderBy: { number: 'desc' }, select: { number: true } });
    const lv = await tx.languageVersion.findUniqueOrThrow({ where: { projectId_language: { projectId: project.id, language: effective.language } } });
    const run = await tx.voiceRun.create({
      data: {
        projectId: project.id,
        languageVersionId: lv.id,
        scriptId: script.id,
        profileId: config.profile.versionId,
        number: (last?.number ?? 0) + 1,
        kind: scope.kind,
        scope: { ...scope, description: resolved.description, blockKeys: resolved.blocks.map((b) => b.key) } as unknown as Prisma.InputJsonValue,
        // Still written, with their meaning (the effective strategy, chunking and context): code from before saved profiles reads them.
        strategy: effective.strategy,
        settings: { chunking: effective.chunking, context: effective.context } as unknown as Prisma.InputJsonValue,
        config: config as unknown as Prisma.InputJsonValue,
        experiment: extra.experiment ?? null,
        variant: extra.variant ?? null,
        notes: extra.notes ?? null,
        createdBy: actor,
      },
    });
    const take: VoiceTakeConfig = { reconstructed: false, base: 'RUN', override: null, profile: config.profile, effective, provenance: config.provenance, differs: [], identityDiffers: false };
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
        data: {
          chunkId: chunk.id,
          runId: run.id,
          projectId: project.id,
          generation: 1,
          status: 'PENDING',
          profileId: config.profile.versionId,
          provider: effective.provider,
          model: effective.model,
          voiceId: effective.voiceId,
          strategy: effective.strategy,
          config: take as unknown as Prisma.InputJsonValue,
          canonicalText: c.text,
          textHash,
          createdBy: actor,
        },
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
      const { config } = await this.resolve(await this.production(project, input.selectionRevision, actor), input.profileId, input.options);
      const { effective } = config;
      const scope = resolveScope(script, input.scope);
      await syncLexicon(this.db, project.id, effective.language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const out: { number?: number } = {};
      const job = await this.deps.projects.voiceJob(project.id, actor, `${LABEL[input.scope.kind]} of script v${script.version}`, async (tx, p) => {
        const created = await this.createRunRows(tx, p, script, config, input.scope, { ...(input.notes ? { notes: input.notes } : {}) }, actor);
        out.number = created.number;
        if ((input.scope.kind === 'FULL' || created.characters > this.deps.config.confirmCharacters) && !input.confirm) {
          throw new ConflictError(`${LABEL[input.scope.kind]}: ${created.characters} characters to generate — confirm to go ahead`);
        }
        await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Voice run ${created.number}: ${scope.description} (${profileLabel(config.profile)}: ${effective.provider} ${effective.model}, ${effective.strategy.toLowerCase()})`, {
          actor,
          run: created.number,
          scope: input.scope,
          profile: profileLabel(config.profile),
          selection: config.selection,
          overrides: describeOverrides(mergeOverrides(config.projectOverrides, config.runOptions)),
          characters: created.characters,
        });
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
      const production = await this.production(project, input.selectionRevision, actor);
      // Each variant narrates with its own profile version when it names one (a comparison of saved profiles), else the request's or production's.
      const variants: (Resolved & { label: string })[] = [];
      for (const { label, profileId, ...options } of input.variants) variants.push({ label, ...(await this.resolve(production, profileId ?? input.profileId, options)) });
      const scope = resolveScope(script, input.scope);
      for (const language of new Set(variants.map((v) => v.config.effective.language))) await syncLexicon(this.db, project.id, language, scope.blocks.map((b) => b.text).join('\n'), script.pronunciations);
      const numbers: number[] = [];
      const job = await this.deps.projects.voiceJob(project.id, actor, `Comparison "${input.name}" of script v${script.version}`, async (tx, p) => {
        const ids: string[] = [];
        const parts: { model: string; characters: number }[] = [];
        for (const v of variants) {
          const r = await this.createRunRows(tx, p, script, v.config, input.scope, { experiment: input.name, variant: v.label }, actor);
          ids.push(r.id);
          numbers.push(r.number);
          parts.push({ model: v.config.effective.model, characters: r.characters });
        }
        const characters = parts.reduce((n, x) => n + x.characters, 0);
        if (characters > this.deps.config.maxCharacters) throw new ConflictError(`The comparison would send ${characters} characters, over the ceiling of ${this.deps.config.maxCharacters}`);
        // A comparison buys several narrations of the same passage: always confirmed, whatever its size.
        if (!input.confirm) throw new ConflictError(`Comparison: ${characters} characters (${costWords(this.deps.providers.voice, parts)}) across ${input.variants.length} variants — confirm to go ahead`);
        await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Comparison "${input.name}": ${variants.map((v) => v.label).join(' / ')} — ${scope.description}`, {
          actor,
          runs: numbers,
          characters,
          variants: variants.map((v) => ({ label: v.label, profile: profileLabel(v.config.profile), mode: v.config.selection?.mode ?? null, overrides: describeOverrides(mergeOverrides(v.config.projectOverrides, v.config.runOptions)) })),
        });
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
   * threshold must be confirmed. A take is made with the run's
   * configuration (as the run stored it), or with the project's production
   * profile now (the chunk is still the run's: same output format and
   * language), and either may take a temporary override; each take records
   * what it was made with, and no profile is changed.
   */
  async regenerate(runId: string, raw: RegenerateVoiceInput, actor: string): Promise<{ job: Job; takes: number }> {
    const input = RegenerateVoiceInput.parse(raw);
    return wrap(() => this.regenerateRun(runId, input, actor));
  }

  private async regenerateRun(runId: string, input: ReturnType<typeof RegenerateVoiceInput.parse>, actor: string): Promise<{ job: Job; takes: number }> {
    const voice = this.deps.providers.voice;
    const run = await this.db.voiceRun.findUnique({ where: { id: runId }, include: { profile: { include: { family: true } }, languageVersion: true, chunks: { orderBy: { chunkIndex: 'asc' } } } });
    if (!run) throw new NotFoundError('Voice run', runId);
    const project = await this.db.project.findUniqueOrThrow({ where: { id: run.projectId } });
    const approved = await approvedScript(this.db, project.id);
    if (!approved || approved.id !== run.scriptId) throw new ConflictError(`Voice run ${run.number} was made from a script version that is no longer the approved one: start a new run (stale audio is never reused)`);
    const chunks = run.chunks.filter((c) =>
      input.all ? true : input.chunkIds?.length ? input.chunkIds.includes(c.id) : input.section ? c.sectionKey === `SC${String(input.section).padStart(2, '0')}` : (input.blockKeys ?? []).some((k) => c.blockKeys.includes(k)),
    );
    if (!chunks.length) throw new ConflictError('No chunk of this run matches');
    const base = input.configuration ?? 'RUN';
    const override: VoiceTakeOverride = { ...input.override, ...(input.strategy ? { strategy: input.strategy } : {}) };
    const problems = checkOverrides(override, voice, 'TAKE');
    if (problems.length) throw new ConflictError(`Temporary override: ${problems.join('; ')}`);
    const config = runConfig(run, voice);
    let production: { version: ProfileRow; overrides: VoiceConfigOverrides } | undefined;
    if (base === 'PRODUCTION') {
      const p = await resolveProduction(this.db, voice, run.languageVersion, { create: true, actor });
      if (p.problem || !p.version) throw new ConflictError(`The production profile cannot be used: ${p.problem ?? 'there is none'}`);
      if (input.selectionRevision !== undefined && input.selectionRevision !== p.revision) throw revisionChanged(input.selectionRevision, p.revision);
      const label = `${p.version.name} v${p.version.version}`;
      if (p.version.outputFormat !== config.effective.outputFormat) throw new ConflictError(`The production profile ${label} makes ${p.version.outputFormat} and voice run ${run.number} is ${config.effective.outputFormat}: clips of one run share a format — start a new run with the production profile`);
      if (p.version.language !== config.effective.language) throw new ConflictError(`The production profile ${label} is for ${p.version.language} and voice run ${run.number} is ${config.effective.language}`);
      production = { version: p.version, overrides: p.overrides };
    }
    // An A/B variant's strategy is its own TAKE override; the rest of the override applies to every variant.
    const variants: { label: string | null; marks: DirectorMark[]; config: VoiceTakeConfig }[] = (input.variants ?? [{ label: null, strategy: undefined, marks: input.marks }]).map((v) => ({
      label: v.label ?? null,
      marks: v.marks ?? [],
      config: newTakeConfig({ run: config, base, ...(production ? { production } : {}), override: v.strategy ? { ...override, strategy: v.strategy } : override }, voice),
    }));
    const rules = performanceRulesProblems(variants[0]!.config.effective.performanceRules);
    if (rules.length) throw new ConflictError(`Performance rules (the take's with the override): ${rules.join('; ')}`);
    const script = await loadScriptForVoice(this.db, run.scriptId);
    if (!script) throw new NotFoundError('Script', run.scriptId);
    const sent = await this.sentCharacters(project.id, script, chunks, variants);
    const characters = sent.reduce((n, x) => n + x.characters, 0);
    const takes = chunks.length * variants.length;
    const made = variants[0]!.config;
    const what = base === 'PRODUCTION' ? ` with the production profile ${profileLabel(made.profile)}` : '';
    const overridden = made.override && !input.variants ? ` (temporary override: ${describeOverrides(made.override)})` : '';
    if (characters > this.deps.config.maxCharacters) throw new ConflictError(`${takes} new take(s) would send ${characters} characters, over the ceiling of ${this.deps.config.maxCharacters} per job (VOICE_MAX_CHARACTERS)`);
    if ((input.all || input.variants || characters > this.deps.config.confirmCharacters) && !input.confirm) {
      throw new ConflictError(`${input.variants ? `A/B (${variants.map((v) => v.label).join(' / ')}) of` : 'Regenerating'} ${chunks.length} chunk(s)${what}${overridden}: ${takes} take(s), ${characters} characters (${costWords(voice, sent)}) — confirm to go ahead`);
    }
    const job = await this.deps.projects.voiceJob(project.id, actor, `New takes for ${chunks.length} chunk(s) of voice run ${run.number}${input.variants ? ` (A/B: ${variants.map((v) => v.label).join(' / ')})` : ''}${what}`, async (tx, p) => {
      const ids: string[] = [];
      for (const c of chunks) {
        const last = await tx.voiceGeneration.findFirst({ where: { chunkId: c.id }, orderBy: { generation: 'desc' }, select: { generation: true } });
        let generation = last?.generation ?? 0;
        for (const v of variants) {
          const { effective } = v.config;
          const g = await tx.voiceGeneration.create({
            data: {
              chunkId: c.id,
              runId: run.id,
              projectId: p.id,
              generation: ++generation,
              status: 'PENDING',
              profileId: v.config.profile.versionId,
              provider: effective.provider,
              model: effective.model,
              voiceId: effective.voiceId,
              strategy: effective.strategy,
              config: v.config as unknown as Prisma.InputJsonValue,
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
      await this.event(tx, p.id, EVENT.VOICE_RUN_REQUESTED, `Voice run ${run.number}: new takes for chunk(s) ${chunks.map((c) => c.chunkIndex + 1).join(', ')}${input.variants ? ` (A/B: ${variants.map((v) => v.label).join(' / ')})` : ''}${what}${overridden}`, {
        actor,
        run: run.number,
        chunks: chunks.map((c) => c.chunkIndex + 1),
        variants: input.variants ? variants.map((v) => v.label) : null,
        directions: variants.reduce((n, v) => n + v.marks.length, 0),
        configuration: { base, source: takeSource(made), profile: profileLabel(made.profile), override: input.variants ? null : made.override, differs: made.differs },
        characters,
      });
      return { runIds: [run.id], generationIds: ids };
    });
    return { job, takes };
  }

  /** Characters new takes of these chunks would send, per take's model: prepared as the stage prepares them (each take's configuration, spoken forms, approved aliases, markup), not the script's text. */
  private async sentCharacters(projectId: string, script: VoiceScript, chunks: readonly VoiceChunk[], takes: readonly { config: VoiceTakeConfig; marks: readonly DirectorMark[] }[]): Promise<{ model: string; characters: number }[]> {
    const blocks = new Map<string, TakeBlock>([...script.blocks.values()].map((b) => [b.key, { delivery: b.delivery, infoClass: b.infoClass }]));
    const out: { model: string; characters: number }[] = [];
    for (const t of takes) {
      const { effective } = t.config;
      const words = await lexicon(this.db, projectId, effective.language);
      let characters = 0;
      for (const c of chunks) {
        const rules = rulesFor(c.sourceText, words, effective.pronunciation.rules);
        const prepared = prepareTake({
          chunk: { text: c.sourceText, sentences: chunkSentences(c), performance: readPerformance(c.performance) },
          blocks,
          strategy: effective.strategy,
          ...(t.marks.length ? { director: t.marks } : {}),
          numberStyle: effective.numberStyle,
          aliases: rules.aliases,
          phonemes: rules.phonemes,
          provider: this.deps.providers.voice,
          model: effective.model,
          settings: effective.providerSettings,
          rules: effective.performanceRules,
          context: { previousText: null, nextText: null },
          seed: null,
        });
        characters += prepared.rendered.text.length;
      }
      out.push({ model: effective.model, characters });
    }
    return out;
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

  // ── The profile library and a project's choice ───────────────────────────
  // Library operations are global (no project event; the routes log them). A project's choice and save-from-run write project events.

  /** A new saved profile (v1). */
  async createProfileFamily(input: CreateVoiceProfileFamilyInput, actor: string): Promise<{ familyId: string; versionId: string }> {
    return wrap(async () => {
      const v = await createProfileFamily(this.db, this.deps.providers.voice, input, actor);
      return { familyId: v.familyId!, versionId: v.id };
    });
  }

  /** An edit: a new version of a saved profile (runs and takes keep the version they used). */
  async newProfileVersion(familyId: string, input: NewVoiceProfileVersionInput, actor: string): Promise<{ familyId: string; versionId: string; version: number }> {
    return wrap(async () => {
      const v = await newProfileVersion(this.db, this.deps.providers.voice, familyId, input, actor);
      return { familyId, versionId: v.id, version: v.version };
    });
  }

  /** A new saved profile from any version of another. */
  async duplicateProfile(familyId: string, input: DuplicateVoiceProfileInput, actor: string): Promise<{ familyId: string; versionId: string }> {
    return wrap(async () => {
      const v = await duplicateProfile(this.db, this.deps.providers.voice, familyId, input, actor);
      return { familyId: v.familyId!, versionId: v.id };
    });
  }

  /** Rename, describe, archive or unarchive a saved profile, or make it the library default. */
  async updateProfileFamily(familyId: string, input: UpdateVoiceProfileFamilyInput, _actor: string): Promise<{ familyId: string }> {
    return wrap(async () => ({ familyId: (await updateProfileFamily(this.db, familyId, input)).id }));
  }

  /**
   * A run's configuration (or one of its takes') saved as a profile: a new
   * one, or a new version of one; with `use`, the run's language version
   * follows it and the project's overrides are cleared (and returned).
   */
  async saveRunAsProfile(runId: string, input: SaveRunAsProfileInput, actor: string): Promise<{ familyId: string; versionId: string; version: number; selected: boolean; clearedOverrides: VoiceConfigOverrides | null }> {
    return wrap(async () => {
      const saved = await saveRunAsProfile(this.db, this.deps.providers.voice, runId, input, actor);
      const { version, run } = saved;
      const label = `${version.name} v${version.version}`;
      await this.event(this.db, run.projectId, EVENT.VOICE_PROFILE_CREATED, `Voice profile ${label} saved from voice run ${run.number}${run.variant ? ` (${run.variant})` : ''}: ${version.provider} ${version.modelId}`, {
        actor,
        familyId: version.familyId,
        versionId: version.id,
        version: version.version,
        run: run.number,
        generationId: input.generationId ?? null,
      });
      if (saved.selected) {
        const cleared = saved.clearedOverrides ? ` (project overrides cleared: ${describeOverrides(saved.clearedOverrides)}; they are part of the saved profile)` : '';
        await this.event(this.db, run.projectId, EVENT.VOICE_PROFILE_SELECTED, `Voice profile for ${version.language}: ${version.name}, follows the current version (v${version.version})${cleared}`, {
          actor,
          language: version.language,
          familyId: version.familyId,
          mode: 'FOLLOW',
          revision: saved.revision,
          clearedOverrides: saved.clearedOverrides,
        });
      }
      return { familyId: version.familyId!, versionId: version.id, version: version.version, selected: saved.selected, clearedOverrides: saved.clearedOverrides };
    });
  }

  /** A project's choice of profile for one language version (the master language by default), and its overrides; refused at another revision than the editor saw. */
  async setSelection(projectRef: string, input: VoiceSelectionInput, actor: string): Promise<{ languageVersionId: string; revision: number }> {
    return wrap(async () => {
      const project = await this.project(projectRef);
      const voice = this.deps.providers.voice;
      const saved = await setSelection(this.db, voice, project, input, actor);
      const version = saved.version ?? (await libraryDefault(this.db, voice, saved.language, { create: false, actor }));
      await this.event(this.db, project.id, EVENT.VOICE_PROFILE_SELECTED, `Voice profile for ${saved.language}: ${selectionText({ ...saved, version })}`, {
        actor,
        language: saved.language,
        familyId: saved.family?.id ?? null,
        mode: !saved.family ? 'DEFAULT' : saved.pinned ? 'PIN' : 'FOLLOW',
        versionId: saved.pinned ? saved.version?.id : null,
        overrides: saved.overrides,
        revision: saved.revision,
      });
      return { languageVersionId: saved.languageVersionId, revision: saved.revision };
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
  run: { id: string; projectId: string; kind: string; scriptId: string; config?: Prisma.JsonValue; script: { version: number }; profile: { language: string }; chunks: Parameters<typeof runQa>[0]['chunks'] },
): Promise<VoiceQaFinding[]> {
  const approved = await approvedScript(db, run.projectId);
  const script = await loadScriptForVoice(db, run.scriptId);
  const approvedText = approved && approved.id !== run.scriptId ? await loadScriptForVoice(db, approved.id) : null;
  const words = await lexicon(db, run.projectId, run.profile.language);
  const text = run.chunks.map((c) => c.sourceText).join('\n');
  // The profile's own pronunciation rules count as decided, as they did when the run was made (a run from before saved profiles has none).
  const rules = (run.config as { effective?: { pronunciation?: { rules?: unknown } } } | null)?.effective?.pronunciation?.rules;
  const profileRules = PronunciationConfig.shape.rules.catch([]).parse(rules ?? []);
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
      unresolved: unresolvedIn(text, words, profileRules),
    }),
    ...(mismatch ? [mismatch] : []),
    ...readQa(assembly?.qa),
    // From what each current take stored (no provider is needed: the VOICE gate has none).
    ...configurationFindings(run.chunks),
  ];
}

export { blockingCount };
