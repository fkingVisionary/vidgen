export const formatDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export const formatDuration = (fromIso: string | null, toIso: string | null) => {
  if (!fromIso || !toIso) return '—';
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

export const formatRuntime = (p: { runtimeSec: number | null; targetMinutesMin: number; targetMinutesMax: number }) =>
  p.runtimeSec !== null
    ? `${Math.floor(p.runtimeSec / 60)}:${String(p.runtimeSec % 60).padStart(2, '0')}`
    : `target ${p.targetMinutesMin}–${p.targetMinutesMax} min`;

export const formatUsd = (v: number) => `$${v.toFixed(v < 1 ? 4 : 2)}`;

/** "1:50": a length to the second. */
export const formatLength = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
