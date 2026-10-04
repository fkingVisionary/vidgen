import { STAGE_LABELS, type StageView } from '@docengine/core';
import { STAGE_TONE, StageStateLabel } from './badges.tsx';

/** The nine dashboard stages, derived server-side from the project status. */
export function StagePipeline({ stages }: { stages: StageView[] }) {
  return (
    <ol className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9">
      {stages.map((s, i) => (
        <li key={s.stage} className={`rounded-md border px-2 py-2 text-center ${STAGE_TONE[s.state]}`}>
          <div className="text-[10px] uppercase tracking-wide opacity-70">{i + 1}</div>
          <div className="text-sm font-medium">{STAGE_LABELS[s.stage]}</div>
          <div className="text-[11px]">
            <StageStateLabel state={s.state} />
          </div>
        </li>
      ))}
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
