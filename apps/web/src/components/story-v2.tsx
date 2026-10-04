import {
  APPEAL_HISTORY_FLOOR,
  CAST_KIND_LABELS,
  FICTIONAL_CAST_KINDS,
  HISTORICAL_VALUE_KEYS,
  HISTORICAL_VALUE_LABELS,
  HISTORICAL_VALUE_WEIGHTS,
  INFORMATION_CLASSES,
  INFORMATION_CLASS_HELP,
  INFORMATION_CLASS_LABELS,
  NARRATIVE_MODES,
  NARRATIVE_MODE_LABELS,
  POV_STRATEGIES,
  POV_STRATEGY_LABELS,
  PRESENTATION_LABELS,
  RECONSTRUCTION_LEVEL_LABELS,
  STORY_VALUE_KEYS,
  STORY_VALUE_LABELS,
  storyValueWeights,
  type CastKind,
  type InformationClass,
  type NarrativeMode,
  type PovStrategy,
  type Presentation,
  type ReconstructionLevel,
  type StoryCandidateView,
  type StoryScoresV2,
  type UpdateStoryCandidateInput,
} from '@docengine/core';
import { useEffect, useState, type ReactNode } from 'react';

/** Story Engine 2.0 building blocks shared by the candidate cards and the architecture view. */

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap';
const button = 'rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';

/** Colours of the four information classes: the viewer must always know which is which. */
export const CLASS_STYLE: Record<InformationClass, { badge: string; row: string }> = {
  DOCUMENTED: { badge: 'bg-emerald-600 text-white', row: 'border-l-emerald-500 bg-white' },
  RECONSTRUCTION: { badge: 'bg-sky-600 text-white', row: 'border-l-sky-500 bg-sky-50/60' },
  UNCERTAIN: { badge: 'bg-amber-400 text-amber-950', row: 'border-l-amber-400 bg-amber-50/70' },
  FICTION: { badge: 'bg-fuchsia-700 text-white', row: 'border-l-fuchsia-600 border-dashed bg-fuchsia-50/70' },
};

export function ClassBadge({ basis }: { basis: InformationClass }) {
  return (
    <span className={`${pill} font-semibold ${CLASS_STYLE[basis].badge}`} title={INFORMATION_CLASS_HELP[basis]}>
      {INFORMATION_CLASS_LABELS[basis]}
    </span>
  );
}

export function ClassLegend() {
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-2">
      {INFORMATION_CLASSES.map((c) => (
        <div key={c} className={`rounded border border-l-4 border-stone-200 p-2 ${CLASS_STYLE[c].row}`}>
          <ClassBadge basis={c} />
          <p className="mt-1 text-stone-700">{INFORMATION_CLASS_HELP[c]}</p>
        </div>
      ))}
    </div>
  );
}

export const isFictional = (kind: CastKind) => FICTIONAL_CAST_KINDS.includes(kind);

export function CastKindBadge({ kind }: { kind: CastKind }) {
  return isFictional(kind) ? (
    <span className={`${pill} bg-fuchsia-700 font-semibold text-white`} title="A narrative device, not a historical person">
      FICTIONAL · {CAST_KIND_LABELS[kind].replace(/^Fictional /, '')}
    </span>
  ) : (
    <span className={`${pill} bg-stone-200 text-stone-800`}>{CAST_KIND_LABELS[kind]}</span>
  );
}

const PRESENTATION_TONE: Record<Presentation, string> = {
  STATE: 'bg-emerald-100 text-emerald-800',
  HEDGE: 'bg-sky-100 text-sky-800',
  PRESENT_AS_DISPUTED: 'bg-orange-500 text-white',
  PRESENT_AS_UNCONFIRMED: 'bg-yellow-300 text-yellow-950',
  INVESTIGATE_AS_MYTH: 'bg-rose-600 text-white',
};

export function PresentationBadge({ presentation }: { presentation: Presentation }) {
  return <span className={`${pill} font-semibold ${PRESENTATION_TONE[presentation]}`}>{PRESENTATION_LABELS[presentation]}</span>;
}

const LEVEL_TONE: Record<ReconstructionLevel, string> = {
  NONE: 'bg-emerald-100 text-emerald-800',
  LOW: 'bg-sky-100 text-sky-800',
  MEDIUM: 'bg-amber-100 text-amber-900',
  HIGH: 'bg-fuchsia-100 text-fuchsia-900',
};

export function ReconstructionBadge({ level }: { level: ReconstructionLevel }) {
  return <span className={`${pill} ${LEVEL_TONE[level]}`}>Reconstruction: {RECONSTRUCTION_LEVEL_LABELS[level].toLowerCase()}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-xs font-medium text-stone-500 uppercase sm:w-32">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

// ── Candidates ───────────────────────────────────────────────────────────────

/** The human story of a candidate and how it could be told (engine 2). */
export function CandidateStory({ candidate: c }: { candidate: StoryCandidateView }) {
  const h = c.humanStakes;
  const d = c.storyDesign;
  return (
    <div className="space-y-2">
      {h && (
        <div className="rounded-md border border-violet-200 bg-violet-50/60 p-2">
          <p className="text-xs font-semibold tracking-wide text-violet-800 uppercase">Human stakes{d && !d.humanStory ? ' — no protagonist found' : ''}</p>
          <dl className="mt-1 space-y-0.5 text-sm">
            <Field label="Protagonist">{h.protagonist || '—'}</Field>
            <Field label="Wants">{c.desire}</Field>
            <Field label="Could gain">{h.couldGain || '—'}</Field>
            <Field label="Could lose">{h.couldLose || '—'}</Field>
            <Field label="Problem">{h.immediateProblem || '—'}</Field>
          </dl>
        </div>
      )}
      {d && (
        <div className="space-y-1 text-sm">
          <p>
            <ClassBadge basis={d.coldOpen.basis} /> <span className="font-medium">Cold open: </span>
            <span className="italic">{d.coldOpen.text}</span>
          </p>
          <dl className="space-y-0.5">
            <Field label="Reveal">{d.reveal}</Field>
            <Field label="On screen">{d.visualEnvironment}</Field>
          </dl>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {c.narrativeMode && <span className={`${pill} bg-stone-800 text-white`}>{NARRATIVE_MODE_LABELS[c.narrativeMode]}</span>}
        {c.povStrategy && (
          <span className={`${pill} bg-stone-100 text-stone-700`} title={c.povStrategy.description}>
            POV: {POV_STRATEGY_LABELS[c.povStrategy.type]}
          </span>
        )}
        {c.reconstructionLevel && <ReconstructionBadge level={c.reconstructionLevel} />}
      </div>
      {c.povStrategy?.description && <p className="text-xs text-stone-600">POV: {c.povStrategy.description}</p>}
    </div>
  );
}

function Bars({ rows }: { rows: { key: string; label: string; weight: number | null; value: number; reason?: string }[] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} title={r.reason}>
            <td className="w-40 py-0.5 pr-2 text-stone-600">
              {r.label} {r.weight !== null && <span className="text-stone-400">×{r.weight.toFixed(2)}</span>}
              {r.weight === null && <span className="text-stone-400">(n/a)</span>}
            </td>
            <td className="py-0.5">
              <div className="h-2 rounded bg-stone-100">
                <div className={`h-2 rounded ${r.weight === null ? 'bg-stone-300' : 'bg-sky-600'}`} style={{ width: `${r.value * 10}%` }} />
              </div>
            </td>
            <td className="w-8 py-0.5 text-right tabular-nums">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** STORY VALUE and HISTORICAL VALUE, separately, and how they combine into STORY APPEAL. */
export function DualScores({ candidate: c, scores: s }: { candidate: StoryCandidateView; scores: StoryScoresV2 }) {
  const weights = storyValueWeights(s.mythApplicable);
  const reasons = new Map(s.reasons.map((r) => [r.dimension, r.reason]));
  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
          Story value <span className="text-base text-stone-900 tabular-nums">{s.storyValue.toFixed(1)}</span>
        </p>
        <Bars rows={STORY_VALUE_KEYS.map((k) => ({ key: k, label: STORY_VALUE_LABELS[k], weight: k === 'mythInvestigation' && !s.mythApplicable ? null : weights[k], value: s.story[k], reason: reasons.get(k) }))} />
      </div>
      <div>
        <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">
          Historical value <span className="text-base text-stone-900 tabular-nums">{s.historicalValue.toFixed(1)}</span>
        </p>
        <Bars rows={HISTORICAL_VALUE_KEYS.map((k) => ({ key: k, label: HISTORICAL_VALUE_LABELS[k], weight: HISTORICAL_VALUE_WEIGHTS[k], value: s.history[k], reason: k === 'evidenceQuality' ? 'Computed from the verdicts and sources of the claims' : reasons.get(k) }))} />
      </div>
      <p className="text-xs text-stone-600">
        Story appeal = story value {s.storyValue.toFixed(1)} × ({APPEAL_HISTORY_FLOOR} + {(1 - APPEAL_HISTORY_FLOOR).toFixed(1)} × historical value {s.historicalValue.toFixed(1)} / 10) = <strong>{c.rankScore.toFixed(2)}</strong>. A gripping story on weak evidence ranks below the same story on strong evidence, but is never hidden.
      </p>
      {s.reasons.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-stone-600">Why the critic scored it so</summary>
          <ul className="mt-1 space-y-0.5">
            {s.reasons.map((r, i) => (
              <li key={i}>
                <span className="font-medium">{STORY_VALUE_LABELS[r.dimension as keyof typeof STORY_VALUE_LABELS] ?? HISTORICAL_VALUE_LABELS[r.dimension as keyof typeof HISTORICAL_VALUE_LABELS] ?? r.dimension}:</span> {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.rationale && <p className="text-xs text-stone-500 italic">Critic: {s.rationale}</p>}
    </div>
  );
}

/** The three strongest story dimensions, as a short "why it is compelling" line. */
export function WhyCompelling({ scores: s }: { scores: StoryScoresV2 }) {
  const weights = storyValueWeights(s.mythApplicable);
  const top = STORY_VALUE_KEYS.filter((k) => weights[k] > 0)
    .map((k) => ({ k, contribution: weights[k] * s.story[k] }))
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);
  const reasons = new Map(s.reasons.map((r) => [r.dimension, r.reason]));
  return (
    <p className="text-sm text-stone-700">
      <span className="font-semibold text-violet-800">Why it is compelling: </span>
      {top.map(({ k }, i) => (
        <span key={k}>
          {i > 0 && ' · '}
          <span className="font-medium">{STORY_VALUE_LABELS[k]}</span> {s.story[k]}/10{reasons.get(k) ? ` — ${reasons.get(k)}` : ''}
        </span>
      ))}
    </p>
  );
}

/** The editor's angle on a unit: title, narrative mode, central question and POV, beside the AI's. */
export function AngleEditor({ candidate: c, pending, onSave }: { candidate: StoryCandidateView; pending: boolean; onSave: (input: UpdateStoryCandidateInput) => void }) {
  const [title, setTitle] = useState(c.title);
  const [mode, setMode] = useState<NarrativeMode | ''>(c.narrativeMode ?? '');
  const [question, setQuestion] = useState(c.centralQuestion ?? '');
  const [pov, setPov] = useState<PovStrategy | ''>(c.povStrategy?.type ?? '');
  const [povText, setPovText] = useState(c.povStrategy?.description ?? '');
  useEffect(() => {
    setTitle(c.title);
    setMode(c.narrativeMode ?? '');
    setQuestion(c.centralQuestion ?? '');
    setPov(c.povStrategy?.type ?? '');
    setPovText(c.povStrategy?.description ?? '');
  }, [c.title, c.narrativeMode, c.centralQuestion, c.povStrategy?.type, c.povStrategy?.description]);

  const input: UpdateStoryCandidateInput = {};
  if (title.trim() && title.trim() !== c.title) input.title = title.trim();
  if (mode && mode !== c.narrativeMode) input.narrativeMode = mode;
  if (question.trim() && question.trim() !== (c.centralQuestion ?? '')) input.centralQuestion = question.trim();
  if (pov && (pov !== c.povStrategy?.type || povText.trim() !== (c.povStrategy?.description ?? ''))) input.povStrategy = { type: pov, description: povText.trim() };
  const changed = Object.keys(input).length > 0;
  const o = c.editorOverrides;
  const restore = (field: keyof UpdateStoryCandidateInput) => onSave({ [field]: null });
  const field = 'w-full rounded-md border border-stone-300 px-2 py-1 text-sm';

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-stone-600">
        Edit the angle: title, narrative mode, central question, POV
        {Object.keys(o).length > 0 && <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-800">edited by the editor</span>}
      </summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="space-y-0.5">
          <span className="text-xs text-stone-500">Title {o.title !== undefined && <Restore onClick={() => restore('title')} ai={c.aiTitle} disabled={pending} />}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={field} />
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-stone-500">
            Narrative mode {o.narrativeMode !== undefined && <Restore onClick={() => restore('narrativeMode')} ai={c.aiNarrativeMode ? NARRATIVE_MODE_LABELS[c.aiNarrativeMode] : 'none'} disabled={pending} />}
          </span>
          <select value={mode} onChange={(e) => setMode(e.target.value as NarrativeMode | '')} className={field}>
            {!mode && <option value="">—</option>}
            {NARRATIVE_MODES.map((m) => (
              <option key={m} value={m}>
                {NARRATIVE_MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 sm:col-span-2">
          <span className="text-xs text-stone-500">
            Central question {o.centralQuestion !== undefined && <Restore onClick={() => restore('centralQuestion')} ai={c.aiCentralQuestion ?? 'none'} disabled={pending} />}
          </span>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} className={field} />
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-stone-500">POV strategy {o.povStrategy !== undefined && <Restore onClick={() => restore('povStrategy')} ai={c.aiPovStrategy ? POV_STRATEGY_LABELS[c.aiPovStrategy.type] : 'none'} disabled={pending} />}</span>
          <select value={pov} onChange={(e) => setPov(e.target.value as PovStrategy | '')} className={field}>
            {!pov && <option value="">—</option>}
            {POV_STRATEGIES.map((m) => (
              <option key={m} value={m}>
                {POV_STRATEGY_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5">
          <span className="text-xs text-stone-500">How the POV is used</span>
          <input value={povText} onChange={(e) => setPovText(e.target.value)} className={field} />
        </label>
      </div>
      <button disabled={pending || !changed} onClick={() => onSave(input)} className={`${button} mt-2 bg-stone-800 text-white`}>
        Save angle
      </button>
      <p className="mt-1 text-xs text-stone-500">The AI's suggestions are kept; your choices are what the architect works from. Changing the angle never changes the evidence.</p>
    </details>
  );
}

function Restore({ onClick, ai, disabled }: { onClick: () => void; ai: string; disabled: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="ml-1 text-violet-700 underline disabled:opacity-40" title={`AI suggestion: ${ai}`}>
      restore AI's
    </button>
  );
}
