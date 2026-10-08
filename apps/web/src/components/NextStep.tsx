import type { ProjectDetailView } from '@docengine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { api } from '../api.ts';
import { nextStep, stepPage, type NextStep } from '../next-step.ts';

const TONE: Record<NextStep['tone'], { box: string; head: string; button: string }> = {
  TODO: { box: 'border-sky-300 bg-sky-50', head: 'text-sky-800', button: 'bg-sky-700 text-white hover:bg-sky-600' },
  WAIT: { box: 'border-stone-300 bg-stone-50', head: 'text-stone-600', button: 'bg-white text-stone-800 ring-1 ring-stone-300 hover:bg-stone-100' },
  DONE: { box: 'border-emerald-300 bg-emerald-50', head: 'text-emerald-800', button: 'bg-white text-emerald-900 ring-1 ring-emerald-300 hover:bg-emerald-100' },
};

/**
 * The project's next step under a page's title, where a phone shows it
 * without scrolling: one plain sentence and one button that goes there —
 * the page, the voice run and the part of the page (next-step.ts); "↓"
 * when that part is further down this page. Nothing where the stage keeps
 * its own next actions.
 */
export function NextStepCard({ project }: { project: ProjectDetailView }) {
  const health = useQuery({ queryKey: ['health'], queryFn: api.health });
  const { pathname } = useLocation();
  if (!health.data) return null;
  const step = nextStep(project, health.data.realStages);
  if (!step) return null;
  const tone = TONE[step.tone];
  const below = step.action.to.includes('#') && stepPage(step) === pathname;
  return (
    <section className={`mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border-2 p-3 ${tone.box}`} aria-label="Next step" data-next-step={step.tone}>
      <div className="min-w-0 flex-1 basis-60">
        <p className={`text-xs font-semibold uppercase tracking-wide ${tone.head}`}>{step.tone === 'DONE' ? 'Done' : step.tone === 'WAIT' ? 'In progress' : 'Next step'}</p>
        <p className="text-sm break-words text-stone-900">{step.text}</p>
      </div>
      <Link to={step.action.to} className={`inline-flex min-h-10 items-center rounded-md px-4 py-2 text-sm font-semibold ${tone.button}`}>
        {step.action.label} {below ? '↓' : '→'}
      </Link>
    </section>
  );
}

/** The ring a part of the page wears for a moment when a link opens it: where the button went, even when it was already in view. */
const ARRIVED = ['ring-4', 'ring-sky-300'];

/**
 * Opens a page at the part its link names (#takes, #plan…) once what it
 * shows has loaded, and again whenever a link names it anew — after the
 * layout's own scroll to the top — and rings it for a moment.
 */
export function useAnchor(ready: boolean) {
  const { hash, key } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    let el: HTMLElement | null = null;
    const t = window.setTimeout(() => {
      el = document.getElementById(decodeURIComponent(hash.slice(1)));
      el?.scrollIntoView({ block: 'start' });
      el?.classList.add(...ARRIVED);
    }, 0);
    const off = window.setTimeout(() => el?.classList.remove(...ARRIVED), 1_600);
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(off);
      el?.classList.remove(...ARRIVED);
    };
  }, [ready, hash, key]);
}
