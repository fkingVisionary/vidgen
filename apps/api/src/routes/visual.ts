import {
  CreateVisualProfileFamilyInput,
  DuplicateVisualProfileInput,
  NewVisualProfileVersionInput,
  UpdateVisualProfileFamilyInput,
  VisualSelectionInput,
  type VisualCatalogView,
  type VisualProductionView,
  type VisualProfileHistoryView,
  type VisualProfileLibraryView,
} from '@docengine/core';
import { NotFoundError } from '@docengine/pipeline';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../auth.ts';
import type { AppContainer } from '../container.ts';
import { findProject } from '../views.ts';

const ProjectParams = z.object({ id: z.string().trim().min(1).max(100) });
const IdParams = z.object({ id: z.uuid() });
const LibraryQuery = z.object({ archived: z.enum(['true', 'false']).optional() });

/**
 * Visual style profiles and the forecast catalog. The library is global,
 * not a project's: its five presets are made at its first use, an edit is
 * always a new version (storyboards keep the version they used), and a
 * profile can be duplicated. A project chooses a profile (following it or
 * pinned to a version) or the library default, with its own overrides,
 * never stored on the profile. The catalog lists the methods, cards, models
 * and rates forecasts are priced from, each with its source, check date and
 * confidence; nothing in it is called or bought. Library operations write
 * no project event, so they are logged here.
 */
export async function visualRoutes(app: FastifyInstance, c: AppContainer): Promise<void> {
  const requireProject = async (raw: unknown) => {
    const { id } = ProjectParams.parse(raw);
    const project = await findProject(c.db, id);
    if (!project) throw new NotFoundError('Project', id);
    return project;
  };

  app.get('/api/visual/catalog', async (): Promise<VisualCatalogView> => c.storyboards.catalog());

  /** The library (archived profiles with ?archived=true). */
  app.get('/api/visual/profiles', async (req): Promise<VisualProfileLibraryView> => {
    const q = LibraryQuery.parse(req.query ?? {});
    return c.storyboards.library({ archived: q.archived === 'true' }, actorOf(req));
  });

  /** A new profile (its v1): the defaults with the fields given over them. */
  app.post('/api/visual/profiles', async (req, reply) => {
    const input = CreateVisualProfileFamilyInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.storyboards.createProfile(input, actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: 1 }, 'visual profile created');
    return reply.code(201).send(await c.storyboards.profileHistory(r.familyId));
  });

  /** A profile and every version, newest first. */
  app.get('/api/visual/profiles/:id', async (req): Promise<VisualProfileHistoryView> => {
    const { id } = IdParams.parse(req.params);
    return c.storyboards.profileHistory(id);
  });

  /** Rename, describe, archive or unarchive a profile, or make it the library default (its versions are not touched). */
  app.patch('/api/visual/profiles/:id', async (req): Promise<VisualProfileHistoryView> => {
    const { id } = IdParams.parse(req.params);
    const input = UpdateVisualProfileFamilyInput.parse(req.body ?? {});
    const actor = actorOf(req);
    await c.storyboards.updateProfileFamily(id, input);
    const h = await c.storyboards.profileHistory(id);
    req.log.info({ actor, familyId: id, versionId: h.current?.id ?? null, version: h.current?.version ?? null, change: input }, 'visual profile updated');
    return h;
  });

  /** An edit: always a new version (refused when the profile changed since the editor opened it, or nothing changed). */
  app.post('/api/visual/profiles/:id/versions', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = NewVisualProfileVersionInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.storyboards.newProfileVersion(id, input, actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: r.version }, 'visual profile version saved');
    return reply.code(201).send(await c.storyboards.profileHistory(r.familyId));
  });

  /** A new profile from any version of this one. */
  app.post('/api/visual/profiles/:id/duplicate', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const input = DuplicateVisualProfileInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.storyboards.duplicateProfile(id, input, actor);
    req.log.info({ actor, familyId: r.familyId, versionId: r.versionId, version: 1, from: id }, 'visual profile duplicated');
    return reply.code(201).send(await c.storyboards.profileHistory(r.familyId));
  });

  /** What the project's storyboards are planned with now: the profile, the overrides, the effective settings and their provenance. */
  app.get('/api/projects/:id/visual/selection', async (req): Promise<VisualProductionView> => {
    const project = await requireProject(req.params);
    return c.storyboards.production(project.id);
  });

  /** Choose a profile (following its current version or pinned to one) or the library default, and the project's overrides (409 when changed elsewhere). */
  app.put('/api/projects/:id/visual/selection', async (req): Promise<VisualProductionView> => {
    const project = await requireProject(req.params);
    const input = VisualSelectionInput.parse(req.body ?? {});
    const actor = actorOf(req);
    const r = await c.storyboards.setSelection(project.id, input, actor);
    req.log.info({ actor, projectId: project.id, familyId: input.familyId, versionId: input.versionId ?? null, revision: r.revision }, 'visual profile selected');
    return c.storyboards.production(project.id);
  });
}
