import { PROJECT_STATUSES, type ProjectDetailView, type ProjectStatus } from '@docengine/core';
import { NavLink } from 'react-router';

const PROJECT_ORDER: readonly ProjectStatus[] = PROJECT_STATUSES;

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

const SCRIPT_STATUSES: readonly ProjectStatus[] = ['STORY_APPROVED', 'SCRIPT_DRAFT', 'SCRIPT_REVIEW', 'SCRIPT_APPROVED'];

/** True when the project has a script, or one can be written (an approved architecture). */
export function hasScriptPage(p: ProjectDetailView): boolean {
  if (p.script) return true;
  const status = p.status === 'FAILED' ? p.failedFromStatus : p.status;
  return status !== null && SCRIPT_STATUSES.includes(status);
}

function scriptNote(p: ProjectDetailView): string | null {
  switch (p.status) {
    case 'STORY_APPROVED':
      return p.script ? `v${p.script.version}` : 'ready to write';
    case 'SCRIPT_DRAFT':
      return 'writing…';
    case 'SCRIPT_REVIEW':
      return 'approval needed';
    default:
      return p.script ? `v${p.script.version}` : null;
  }
}

const VOICE_STATUSES: readonly ProjectStatus[] = ['SCRIPT_APPROVED', 'VOICE_GENERATING', 'VOICE_REVIEW', 'VOICE_COMPLETE'];

/** True once a script is approved (narration can be generated). */
export function hasVoicePage(p: ProjectDetailView): boolean {
  const status = p.status === 'FAILED' ? p.failedFromStatus : p.status;
  return status !== null && (VOICE_STATUSES.includes(status) || PROJECT_ORDER.indexOf(status) > PROJECT_ORDER.indexOf('VOICE_COMPLETE'));
}

function voiceNote(p: ProjectDetailView): string | null {
  switch (p.status) {
    case 'SCRIPT_APPROVED':
      return 'ready to audition';
    case 'VOICE_GENERATING':
      return 'generating…';
    case 'VOICE_REVIEW':
      return 'review takes';
    case 'VOICE_COMPLETE':
      return 'approved';
    default:
      return null;
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

/** Links between a project's pages (overview, research dossier, story, script), shown under each page's title. */
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
  if (hasScriptPage(p)) {
    items.push({ to: `${base}/script`, label: 'Script', note: scriptNote(p), attention: p.status === 'SCRIPT_REVIEW' || (p.status === 'STORY_APPROVED' && !p.script) });
  }
  if (hasVoicePage(p)) {
    items.push({ to: `${base}/voice`, label: 'Voice', note: voiceNote(p), attention: p.status === 'SCRIPT_APPROVED' || p.status === 'VOICE_REVIEW' });
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
