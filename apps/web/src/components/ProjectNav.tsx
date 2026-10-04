import type { ProjectDetailView, ProjectStatus } from '@docengine/core';
import { NavLink } from 'react-router';

const STORY_STATUSES: readonly ProjectStatus[] = ['RESEARCH_COMPLETE', 'STORY_MINING', 'STORY_SELECTION', 'STORY_ARCHITECTING', 'STORY_REVIEW', 'STORY_APPROVED'];

/** True when the project has story work to show, or story mining can start. */
export function hasStoryPage(p: ProjectDetailView): boolean {
  if (p.story.pack || p.story.architecture) return true;
  const status = p.status === 'FAILED' ? p.failedFromStatus : p.status;
  return status !== null && STORY_STATUSES.includes(status);
}

function storyNote(p: ProjectDetailView): string | null {
  switch (p.status) {
    case 'RESEARCH_COMPLETE':
      return 'ready to mine';
    case 'STORY_MINING':
      return 'mining…';
    case 'STORY_SELECTION':
      return 'choose 5–10';
    case 'STORY_ARCHITECTING':
      return 'building…';
    case 'STORY_REVIEW':
      return 'approval needed';
    default:
      return p.story.pack ? `${p.story.pack.candidateCount} candidates` : null;
  }
}

interface NavItem {
  to: string;
  label: string;
  note: string | null;
  /** The page holds the next human step. */
  attention: boolean;
  end?: boolean;
}

/** Links between a project's pages (overview, research dossier, story), shown under each page's title. */
export function ProjectNav({ project: p }: { project: ProjectDetailView }) {
  const base = `/projects/${p.slug}`;
  const items: NavItem[] = [{ to: base, label: 'Overview', note: null, attention: false, end: true }];
  if (p.research) {
    const review = p.status === 'RESEARCH_REVIEW';
    items.push({ to: `${base}/research`, label: 'Research dossier', note: review ? 'approval needed' : `v${p.research.version}`, attention: review });
  }
  if (hasStoryPage(p)) {
    items.push({ to: `${base}/story`, label: 'Story', note: storyNote(p), attention: p.status === 'STORY_SELECTION' || p.status === 'STORY_REVIEW' || p.status === 'RESEARCH_COMPLETE' });
  }
  return (
    <nav aria-label="Project pages" className="mt-3 flex flex-wrap gap-2">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          className={({ isActive }) =>
            `inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ring-1 ${isActive ? 'bg-stone-900 text-white ring-stone-900' : 'bg-white text-stone-700 ring-stone-300 hover:bg-stone-50'}`
          }
        >
          {({ isActive }) => (
            <>
              {i.label}
              {i.note && (
                <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-normal ${isActive ? 'bg-white/20 text-white' : i.attention ? 'bg-amber-100 text-amber-900' : 'bg-stone-100 text-stone-500'}`}>
                  {i.note}
                </span>
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
