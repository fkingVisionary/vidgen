import { STAGE_STATE_LABELS, STATUS_LABELS, type JobStatus, type ProjectStatus, type StageState } from '@docengine/core';

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const tone =
    status === 'FAILED'
      ? 'bg-red-100 text-red-800'
      : status === 'PUBLISHED' || status === 'APPROVED'
        ? 'bg-emerald-100 text-emerald-800'
        : status.endsWith('_REVIEW') || status === 'QA'
          ? 'bg-violet-100 text-violet-800'
          : status === 'IDEA'
            ? 'bg-stone-100 text-stone-700'
            : 'bg-sky-100 text-sky-800';
  return <span className={`${pill} ${tone}`}>{STATUS_LABELS[status]}</span>;
}

export const STAGE_TONE: Record<StageState, string> = {
  NOT_STARTED: 'border-stone-200 bg-white text-stone-400',
  IN_PROGRESS: 'border-sky-300 bg-sky-50 text-sky-800',
  AWAITING_APPROVAL: 'border-violet-300 bg-violet-50 text-violet-800',
  COMPLETE: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  FAILED: 'border-red-300 bg-red-50 text-red-800',
};

export function StageStateLabel({ state }: { state: StageState }) {
  return <span>{STAGE_STATE_LABELS[state]}</span>;
}

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const tone: Record<JobStatus, string> = {
    QUEUED: 'bg-stone-100 text-stone-700',
    RUNNING: 'bg-sky-100 text-sky-800',
    SUCCEEDED: 'bg-emerald-100 text-emerald-800',
    FAILED: 'bg-red-100 text-red-800',
    CANCELLED: 'bg-stone-100 text-stone-500 line-through',
  };
  return <span className={`${pill} ${tone[status]}`}>{status}</span>;
}

export function MockBadge() {
  return <span className={`${pill} bg-amber-100 text-amber-900`} title="Produced by MOCK providers/handlers: a placeholder, not real work">MOCK</span>;
}
