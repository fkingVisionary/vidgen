import {
  CreateVoiceProfileInput,
  CreateVoiceRunInput,
  DecideVoiceGenerationInput,
  PlanVoiceRunInput,
  RegenerateVoiceInput,
  UpdatePronunciationInput,
  VoiceExperimentInput,
} from '@docengine/core';
import { ConflictError, NotFoundError } from '@docengine/pipeline';
import { loadVoiceView, parseClock } from '@docengine/voice';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { findProject, toJobView } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const IdParams = z.object({ id: z.uuid() });
const RunQuery = z.object({ run: z.coerce.number().int().min(1).optional() });

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
 * comparisons, new takes, decisions on takes, the pronunciation list, voice
 * profiles, audio (takes and assemblies), the narration timeline, and the
 * lookup "what is said at 02:43". The VOICE gate goes through the generic
 * approvals route.
 */
export async function voiceRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = ProjectParams.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
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
    return c.voice.plan(project.id, PlanVoiceRunInput.parse(req.body ?? {}));
  });

  /** Generate a run: an audition (the opening), a section, chosen blocks, a range, or the whole script. */
  app.post('/api/projects/:id/voice/runs', async (req, reply) => {
    const project = await requireProject(req.params);
    requireReal();
    const r = await c.voice.createRun(project.id, CreateVoiceRunInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), run: r.run });
  });

  /** A comparison: the same passage narrated 2–4 ways. */
  app.post('/api/projects/:id/voice/experiments', async (req, reply) => {
    const project = await requireProject(req.params);
    requireReal();
    const r = await c.voice.createExperiment(project.id, VoiceExperimentInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(202).send({ job: toJobView(r.job), runs: r.runs });
  });

  /** New takes for chosen chunks of a run (earlier takes are kept). */
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

  /** A new voice profile version (profiles are never edited in place). */
  app.post('/api/projects/:id/voice/profiles', async (req, reply) => {
    const project = await requireProject(req.params);
    const p = await c.voice.createProfile(project.id, CreateVoiceProfileInput.parse(req.body ?? {}), actorOf(req));
    return reply.code(201).send({ id: p.id, name: p.name, version: p.version });
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

  /** The narration timeline of a run's latest assembly: the contract the storyboard is timed against. */
  app.get('/api/projects/:id/voice/timeline', async (req) => {
    const project = await requireProject(req.params);
    const q = z.object({ run: z.coerce.number().int().min(1) }).parse(req.query ?? {});
    const run = await c.db.voiceRun.findUnique({ where: { projectId_number: { projectId: project.id, number: q.run } }, include: { script: { select: { version: true } } } });
    if (!run) throw new NotFoundError('Voice run', String(q.run));
    const assembly = await c.db.voiceAssembly.findFirst({ where: { runId: run.id }, orderBy: { version: 'desc' } });
    if (!assembly) throw new ConflictError(`Voice run ${q.run} has no assembled narration yet`);
    return { run: run.number, scriptVersion: run.script.version, assembly: assembly.version, status: assembly.status, complete: assembly.complete, totalDurationMs: assembly.totalDurationMs, entries: assembly.entries, timeline: assembly.timeline };
  });
}
