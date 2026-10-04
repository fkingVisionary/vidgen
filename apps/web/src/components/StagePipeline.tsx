import { STAGE_LABELS, type Stage, type StageView } from '@docengine/core';
import { Link } from 'react-router';
import { STAGE_TONE, StageStateLabel } from './badges.tsx';

/** The nine dashboard stages, derived server-side from the project status. Stages with a page link to it. */
export function StagePipeline({ stages, links = {} }: { stages: StageView[]; links?: Partial<Record<Stage, string>> }) {
  return (
    <ol className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
      {stages.map((s, i) => {
        const to = links[s.stage];
        const body = (
          <>
            <div className="text-[10px] uppercase tracking-wide opacity-70">{i + 1}</div>
            <div className="text-sm font-medium">{STAGE_LABELS[s.stage]}</div>
            <div className="text-[11px]">
              <StageStateLabel state={s.state} />
            </div>
            {to && <div className="mt-0.5 text-[11px] font-semibold underline">Open →</div>}
          </>
        );
        return (
          <li key={s.stage} className={`rounded-md border text-center ${STAGE_TONE[s.state]}`}>
            {to ? (
              <Link to={to} className="block rounded-md px-2 py-2 hover:bg-black/5">
                {body}
              </Link>
            ) : (
              <div className="px-2 py-2">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2" title={`${value}%`}>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-stone-200">
        <div className="h-full rounded-full bg-sky-600" style={{ width: `${value}%` }} />
      </div>
      <span className="text-xs tabular-nums text-stone-500">{value}%</span>
    </div>
  );
}
