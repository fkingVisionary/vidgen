import {
  CLAIM_VERDICT_LABELS,
  SOURCE_TYPE_LABELS,
  STAGE_STATE_LABELS,
  STATUS_LABELS,
  type ClaimVerdict,
  type JobStatus,
  type ProjectStatus,
  type SourceType,
  type StageState,
} from '@docengine/core';

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

export const VERDICT_STYLE: Record<ClaimVerdict, { badge: string; card: string; icon: string }> = {
  ESTABLISHED: { badge: 'bg-emerald-100 text-emerald-800', card: 'border-l-emerald-500 bg-white', icon: '✓' },
  PROBABLE: { badge: 'bg-sky-100 text-sky-800', card: 'border-l-sky-400 bg-white', icon: '≈' },
  DISPUTED: { badge: 'bg-orange-500 text-white', card: 'border-l-orange-500 bg-orange-50', icon: '⚠' },
  UNVERIFIED: { badge: 'bg-yellow-300 text-yellow-950', card: 'border-l-yellow-400 border-dashed bg-yellow-50', icon: '?' },
  MYTH: { badge: 'bg-rose-600 text-white', card: 'border-l-rose-600 bg-rose-50', icon: '✗' },
};

export function VerdictBadge({ verdict }: { verdict: ClaimVerdict }) {
  const s = VERDICT_STYLE[verdict];
  return (
    <span className={`${pill} font-semibold ${s.badge}`}>
      {s.icon} {CLAIM_VERDICT_LABELS[verdict]}
    </span>
  );
}

const SOURCE_TONE: Record<SourceType, string> = {
  PRIMARY: 'bg-indigo-700 text-white',
  ACADEMIC: 'bg-indigo-100 text-indigo-900',
  BOOK: 'bg-violet-100 text-violet-900',
  ARCHIVE: 'bg-teal-100 text-teal-900',
  REPUTABLE_SECONDARY: 'bg-stone-200 text-stone-800',
  GENERAL_REFERENCE: 'bg-stone-100 text-stone-600',
  GENERAL_WEB: 'bg-stone-50 text-stone-500 ring-1 ring-stone-200',
};

export function SourceTypeBadge({ type }: { type: SourceType }) {
  return <span className={`${pill} ${SOURCE_TONE[type]}`}>{SOURCE_TYPE_LABELS[type]}</span>;
}
