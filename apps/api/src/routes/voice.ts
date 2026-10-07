import {
  CreateVoiceProfileFamilyInput,
  CreateVoiceRunInput,
  DecideVoiceGenerationInput,
  DuplicateVoiceProfileInput,
  NewVoiceProfileVersionInput,
  PlanVoiceRunInput,
  RegenerateVoiceInput,
  SaveRunAsProfileInput,
  UpdatePronunciationInput,
  UpdateVoiceProfileFamilyInput,
  VoiceExperimentInput,
  VoiceSelectionInput,
  type NarrationTimelineView,
  type VoiceConfigOverrides,
  type VoiceProductionView,
  type VoiceProfileHistoryView,
  type VoiceProfileLibraryView,
} from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import { loadProduction, loadProfileHistory, loadProfileLibrary, loadVoiceView, parseClock } from '@docengine/voice';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { findProject, toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const IdParams = z.object({ id: z.uuid() });
const RunQuery = z.object({ run: z.coerce.number().int().min(1).optional() });
const LibraryQuery = z.object({ archived: z.enum(['true', 'false']).optional() });
const LanguageQuery = z.object({ language: z.string().trim().min(2).max(10).optional() });

/** Audio with byte ranges (players seek with Range requests). Same-origin, behind the dashboard's auth. */
function sendAudio(req: FastifyRequest, reply: FastifyReply, bytes: Uint8Array, mimeType: string, mock: boolean) {
  reply.header('accept-ranges', 'bytes').header('cache-control', 'private, max-age=3600').header('x-audio-mock', mock ? 'true' : 'false').type(mimeType);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const size = bytes.length;
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).send(Buffer.from(bytes.subarray(start, end + 1)));
  }
  return reply.send(Buffer.from(bytes));
}

/**
 * Narration: the Voice page's read model, planning and generating runs,
 * comparisons, new takes (with the run's configuration, the production
 * profile now, or a temporary override), decisions on takes, the
 * pronunciation list, audio (takes and assemblies), the narration timeline,
 * and the lookup "what is said at 02:43". The VOICE gate goes through the
 * generic approvals route.
 *
 * Saved voice profiles: the library (global, not a project's), a profile
 * and its history, an edit (always a new version: runs and takes keep the
 * version they used), a duplicate, a run's or a take's configuration saved
 * as a profile, and a project's choice of profile per language version with
 * its own overrides (never stored on the profile). Library operations write
 * no project event, so they are logged here.
 */
export async function voiceRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = ProjectParams.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  };
  const views = { db: c.db, providers: c.providers };
  const history = async (familyId: string): Promise<VoiceProfileHistoryView> => {
    const h = await loadProfileHistory(views, familyId);
    if (!h) throw new NotFoundError('Voice profile', familyId);
    return h;
  };
  const production = async (project: Awaited<ReturnType<typeof requireProject>>, language?: string): Promise<VoiceProductionView> => {
    const p = await loadProduction(views, project, language);
    if (!p) throw new NotFoundError('Language version', `${project.slug}/${language ?? project.masterLanguage}`);
    return p;
  };
  const requireReal = () => {
    if (!c.realStages.includes('VOICE')) throw new ConflictError('The voice stage needs a real script stage here (AI_PROVIDER=anthropic): there is no script to narrate');
  };

  app.get('/api/projects/:id/voice', async (req) => {
    const project = await requireProject(req.params);
    const q = RunQuery.parse(req.query ?? {});
    return loadVoiceView({ db: c.db, providers: c.providers, confirmCharacters: c.env.VOICE_CONFIRM_CHARACTERS, toJobView: toJobView as never }, project, q.run);
  });

  /** What a run would generate and cost (nothing is generated). */
  app.post('/api/projects/:id/voice/plan', async (req) => {
    const project = await requireProject(req.params);
    requireReal();
    return c.voice.plan(project.id, PlanVoiceRunInput.parse(req.body ?? {}), actorOf(req));
  });

  /** Generate a run: an audition (the opening), a section, chosen blocks, a range, or the whole script. */
  app.post('/api/projects/:id/voice/runs', async (req, reply) => {
    const project = await requireProject(req.params);
    requireReal();
    const r = await c.voice.createRun(project.id, CreateVoiceRunInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), run: r.run });
  });

  /** A comparison: the same passage narrated 2–8 ways, one run each, in one job (always confirmed). */
  app.post('/api/projects/:id/voice/experiments', async (req, reply) => {
    const project = await requireProject(req.params);
    requireReal();
    const r = await c.voice.createExperiment(project.id, VoiceExperimentInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), runs: r.runs });
  });

  /** New takes for chosen chunks of a run, or an A/B of them (earlier takes are kept). */
  app.post('/api/voice/runs/:id/regenerate', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    requireReal();
    const r = await c.voice.regenerate(id, RegenerateVoiceInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), takes: r.takes });
  });

  app.post('/api/voice/runs/:id/approve-all', async (req) => {
    const { id } = IdParams.parse(req.params);
    return c.voice.approveAll(id, actorOf(req));
  });

  /** Approve, reject or restore a take. */
  app.post('/api/voice/generations/:id/decision', async (req) => {
    const { id } = IdParams.parse(req.params);
    return c.voice.decide(id, DecideVoiceGenerationInput.parse(req.body ?? {}), actorOf(req));
  });

  app.patch('/api/voice/pronunciations/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await c.voice.updatePronunciation(id, UpdatePronunciationInput.parse(req.body ?? {}), actorOf(req));
    return { ok: true };
  });

  /** The profile library, with what a form needs for the configured provider (archived profiles with ?archived=true). */
  app.get('/api/voice/profiles', async (req): Promise<VoiceProfileLibraryView> => {
    const q = LibraryQuery.parse(req.query ?? {});
    return loadProfileLibrary(views, { archived: q.archived === 'true' });
  });

  /** A new saved profile (its v1): the configured provider's defaults and the house default, with the fields given over them. */
  app.post('/api/voice/profiles', async (req, reply) => {
    const actor = actorOf(req);
    const r = await c.voice.createProfileFamily(CreateVoiceProfileFamilyInput.parse(req.body ?? {}), actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: 1 }, 'voice profile created');
    return reply.code(201).send(await history(r.familyId));
  });

  /** A saved profile and every version, newest first. */
  app.get('/api/voice/profiles/:id', async (req): Promise<VoiceProfileHistoryView> => {
    const { id } = IdParams.parse(req.params);
    return history(id);
  });

  /** Rename, describe, archive or unarchive a saved profile, or make it the library default (its versions are not touched). */
  app.patch('/api/voice/profiles/:id', async (req): Promise<VoiceProfileHistoryView> => {
    const { id } = IdParams.parse(req.params);
    const input = UpdateVoiceProfileFamilyInput.parse(req.body ?? {});
    const actor = actorOf(req);
    await c.voice.updateProfileFamily(id, input, actor);
    const h = await history(id);
    req.log.info({ actor, familyId: id, versionId: h.current?.id ?? null, version: h.current?.version ?? null, change: input }, 'voice profile updated');
    return h;
  });

  /** An edit: always a new version (refused when the profile changed since the editor opened it, or nothing changed). */
  app.post('/api/voice/profiles/:id/versions', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const actor = actorOf(req);
    const r = await c.voice.newProfileVersion(id, NewVoiceProfileVersionInput.parse(req.body ?? {}), actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: r.version }, 'voice profile version saved');
    return reply.code(201).send(await history(r.familyId));
  });

  /** A new saved profile from any version of this one (another language allowed). */
  app.post('/api/voice/profiles/:id/duplicate', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const actor = actorOf(req);
    const r = await c.voice.duplicateProfile(id, DuplicateVoiceProfileInput.parse(req.body ?? {}), actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: 1, from: id }, 'voice profile duplicated');
    return reply.code(201).send(await history(r.familyId));
  });

  /**
   * Save a run's configuration (or one of its takes') as a profile: a new one
   * by name, or a new version of one. With `use`, the run's language version
   * narrates with it from now on and the project's overrides are cleared
   * (they are in what was saved): they are returned.
   */
  app.post('/api/voice/runs/:id/save-profile', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = SaveRunAsProfileInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.voice.saveRunAsProfile(id, input, actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: r.version, runId: id, generationId: input.generationId ?? null, selected: r.selected }, 'voice profile saved from a run');
    const run = r.selected ? await c.db.voiceRun.findUniqueOrThrow({ where: { id }, select: { project: true, languageVersion: { select: { language: true } } } }) : null;
    const body: { profile: VoiceProfileHistoryView; production: VoiceProductionView | null; clearedOverrides: VoiceConfigOverrides | null } = {
      profile: await history(r.familyId),
      production: run ? await production(run.project, run.languageVersion.language) : null,
      clearedOverrides: r.clearedOverrides,
    };
    return reply.code(201).send(body);
  });

  /** What a language version narrates with now (default: the master language). */
  app.get('/api/projects/:id/voice/selection', async (req): Promise<VoiceProductionView> => {
    const project = await requireProject(req.params);
    const q = LanguageQuery.parse(req.query ?? {});
    return production(project, q.language);
  });

  /** Choose a saved profile (following its current version or pinned to one) or the library default, and the project's overrides. */
  app.put('/api/projects/:id/voice/selection', async (req): Promise<VoiceProductionView> => {
    const project = await requireProject(req.params);
    const input = VoiceSelectionInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.voice.setSelection(project.id, input, actor);
    req.log.info({ actor, projectId: project.id, languageVersionId: r.languageVersionId, familyId: input.familyId, versionId: input.versionId ?? null, revision: r.revision }, 'voice profile selected');
    return production(project, input.language);
  });

  /** The voices the configured provider offers (for choosing a profile's voice). */
  app.get('/api/voice/voices', async () => c.providers.voice.getVoices());

  app.get('/api/voice/audio/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const a = await c.voice.audio(id);
    return sendAudio(req, reply, a.bytes, a.mimeType, a.mock);
  });

  app.get('/api/voice/assemblies/:id/audio', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const a = await c.voice.assemblyAudio(id);
    return sendAudio(req, reply, a.bytes, a.mimeType, a.mock);
  });

  /** "What is being said at 02:43?" (?run=N&at=02:43). */
  app.get('/api/projects/:id/voice/moment', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ run: z.coerce.number().int().min(1), at: z.string().trim().min(1).max(20) }).parse(req.query ?? {});
    const ms = parseClock(q.at);
    if (ms === null) throw new ConflictError(`"${q.at}" is not a time (use mm:ss or mm:ss.s)`);
    return c.voice.moment(project.id, q.run, ms);
  });

  /** The narration timeline of a run's latest assembly: the contract the storyboard is timed against (with each part's audio file and approval). */
  app.get('/api/projects/:id/voice/timeline', async (req): Promise<NarrationTimelineView> => {
    const project = await requireProject(req.params);
    const q = z.object({ run: z.coerce.number().int().min(1) }).parse(req.query ?? {});
    return c.voice.timeline(project.id, q.run);
  });

  /** The narration timeline of one assembly version (an older one too), with the run, script, profile and language version by id. */
  app.get('/api/voice/assemblies/:id/timeline', async (req): Promise<NarrationTimelineView> => {
    const { id } = IdParams.parse(req.params);
    return c.voice.timelineOf(id);
  });
}
