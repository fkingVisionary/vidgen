import type { CreateProjectInput } from '@docengine/core';
import type { Database } from '@docengine/database';
import type { ProjectService } from '@docengine/pipeline';

/**
 * The first test episode. Seeded so the architecture can be exercised against
 * the real target subject. It is NOT researched or written yet — that is
 * milestone 2+.
 */
export const DEMO_PROJECT_SLUG = 'tulip-mania';

export const DEMO_PROJECT: CreateProjectInput = {
  title: 'Tulip Mania',
  workingTitle: 'The Bubble That Became a Legend',
  topic: 'The Dutch tulip bulb market of 1636–37, its collapse, and how the story of it became the archetypal tale of a financial bubble',
  description:
    'Test project for the V1 architecture. Editorial brief: the finished documentary must distinguish WHAT WE KNOW from WHAT IS COMMONLY CLAIMED, and must not blindly repeat the exaggerated popular version of the story.',
  category: 'Economic History',
  style: 'Premium Historical Documentary',
  targetMinutesMin: 10,
  targetMinutesMax: 15,
  masterLanguage: 'en',
};

export const DEMO_METADATA = {
  seed: 'milestone-1',
  purpose: 'architecture test project',
  editorialBrief: [
    'Separate established evidence from popular retellings; label myths as myths.',
    'Every economic figure needs a source; flag estimates as estimates.',
    'Audio-first: the narration must hold up with eyes closed.',
  ],
};

/** Idempotent: creates the demo project once and never touches it afterwards. */
export async function seedDemoProject(db: Database, projects: ProjectService): Promise<{ created: boolean; projectId: string }> {
  const existing = await db.project.findUnique({ where: { slug: DEMO_PROJECT_SLUG }, select: { id: true } });
  if (existing) return { created: false, projectId: existing.id };
  const project = await projects.createProject(DEMO_PROJECT, 'seed', { slug: DEMO_PROJECT_SLUG, metadata: DEMO_METADATA });
  return { created: true, projectId: project.id };
}
