import { describe, expect, it } from 'vitest';
import { tulipInput, useTestDatabase } from '../../../test/helpers.ts';
import { ConflictError, NotFoundError } from './errors.ts';
import { ProjectService, slugify } from './project-service.ts';

const db = useTestDatabase();
const service = new ProjectService({ db });

describe('ProjectService (PostgreSQL)', () => {
  it('creates a project with its master language version and an audit event', async () => {
    const p = await service.createProject(tulipInput, 'test');
    expect(p).toMatchObject({ slug: 'tulip-mania', status: 'IDEA', phaseSeq: 0, masterLanguage: 'en', targetMinutesMin: 10, targetMinutesMax: 15 });
    const lvs = await db.languageVersion.findMany({ where: { projectId: p.id } });
    expect(lvs).toHaveLength(1);
    expect(lvs[0]).toMatchObject({ language: 'en', status: 'IN_PRODUCTION' });
    expect(await db.projectEvent.count({ where: { projectId: p.id, type: 'PROJECT_CREATED' } })).toBe(1);
  });

  it('generates unique slugs', async () => {
    await service.createProject(tulipInput, 'test');
    const second = await service.createProject(tulipInput, 'test');
    expect(second.slug).toBe('tulip-mania-2');
    expect(slugify('Économie de la Rome antique!')).toBe('economie-de-la-rome-antique');
  });

  it('starts the research phase when the first RESEARCH job is enqueued', async () => {
    const p = await service.createProject(tulipInput, 'test');
    const job = await service.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    const after = await db.project.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ status: 'RESEARCHING', phaseSeq: 1 });
    expect(job).toMatchObject({ type: 'RESEARCH', status: 'QUEUED', phaseSeq: 1, attempts: 0, maxAttempts: 3 });
    const lv = await db.languageVersion.findFirstOrThrow({ where: { projectId: p.id } });
    expect(job.languageVersionId).toBe(lv.id);
  });

  it('refuses jobs outside the current phase and duplicate active jobs', async () => {
    const p = await service.createProject(tulipInput, 'test');
    await expect(service.enqueueJob(p.id, { type: 'SCRIPT' }, 'test')).rejects.toBeInstanceOf(ConflictError);
    await service.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await expect(service.enqueueJob(p.id, { type: 'RESEARCH' }, 'test')).rejects.toThrow(/already queued or running/);
  });

  it('refuses unknown projects and language versions from other projects', async () => {
    await expect(service.enqueueJob('01990000-0000-7000-8000-000000000000', { type: 'RESEARCH' }, 'test')).rejects.toBeInstanceOf(NotFoundError);
    const a = await service.createProject(tulipInput, 'test');
    const b = await service.createProject({ ...tulipInput, title: 'South Sea Bubble' }, 'test');
    const bLv = await db.languageVersion.findFirstOrThrow({ where: { projectId: b.id } });
    await expect(service.enqueueJob(a.id, { type: 'RESEARCH', languageVersionId: bLv.id }, 'test')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('only accepts the approval gate matching the current status', async () => {
    const p = await service.createProject(tulipInput, 'test');
    await expect(service.recordApproval(p.id, { gate: 'RESEARCH', decision: 'APPROVED' }, 'test')).rejects.toThrow(/not an approval gate/);
  });

  it('records a rewind, starts a new phase run and cancels obsolete queued jobs', async () => {
    const p = await service.createProject(tulipInput, 'test');
    const job = await service.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    const rewound = await service.rewind(p.id, { to: 'IDEA', reason: 'Start over' }, 'test');
    expect(rewound).toMatchObject({ status: 'IDEA', phaseSeq: 2 });
    expect(await db.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED' });
    await expect(service.rewind(p.id, { to: 'RESEARCH_REVIEW', reason: 'forward' }, 'test')).rejects.toThrow(/Illegal/);
  });

  it('enforces one language version per language', async () => {
    const p = await service.createProject(tulipInput, 'test');
    await db.languageVersion.create({ data: { projectId: p.id, language: 'es' } });
    await expect(db.languageVersion.create({ data: { projectId: p.id, language: 'es' } })).rejects.toThrow();
  });

  it('deletes a project with all of its rows (cascade)', async () => {
    const p = await service.createProject(tulipInput, 'test');
    await service.enqueueJob(p.id, { type: 'RESEARCH' }, 'test');
    await db.project.delete({ where: { id: p.id } });
    expect(await db.job.count()).toBe(0);
    expect(await db.languageVersion.count()).toBe(0);
    expect(await db.projectEvent.count()).toBe(0);
  });
});
