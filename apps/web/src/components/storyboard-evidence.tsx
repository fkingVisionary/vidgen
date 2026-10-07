import {
  CAST_KIND_LABELS,
  CONTINUITY_KIND_LABELS,
  DETAIL_BASES,
  DETAIL_BASIS_LABELS,
  DETAIL_BASIS_TONES,
  SHOT_CLAIM_ROLE_LABELS,
  STORYBOARD_LIMITS,
  type ContinuitySubjectView,
  type DetailBasis,
  type StoryboardClaimView,
  type StoryboardVersionView,
} from '@docengine/core';
import { useState, type ReactNode } from 'react';
import { designDetailsFrom, detailRows, evidenceRows, findingCounts, rangeText, rhythmRows, sameSettings, type DetailRow, type EvidenceState } from '../storyboard-plan.ts';
import { VerdictBadge } from './badges.tsx';
import { ClassBadge } from './script.tsx';
import { PresentationBadge } from './story-v2.tsx';
import { DepictionBadge, RaceNotice, Stat, StoryboardFindings, ToneChip, TreatmentBadge, useEdits, type EditContext } from './storyboard.tsx';
import { input, link, primary, secondary } from './ui.ts';

/**
 * The Evidence, Continuity and QA tabs: what each picture rests on (the
 * shot's beat, words, script blocks, architecture, claims with their
 * verdicts now, and the sources that trace them), the recurring characters,
 * places and objects with what must stay the same and the reference assets
 * they need, and every finding — live and as saved — with the rhythm and
 * what code changed in the model's output.
 */

const STATE: Record<EvidenceState, { label: string; tone: 'SUCCESS' | 'DANGER' | 'NEUTRAL' }> = {
  TRACED: { label: 'Traced', tone: 'SUCCESS' },
  UNTRACED: { label: 'Untraced: blocks approval', tone: 'DANGER' },
  NOT_FACTUAL: { label: 'Shows no fact', tone: 'NEUTRAL' },
};

function ClaimLine({ claim: c }: { claim: StoryboardClaimView }) {
  return (
    <li className="flex flex-wrap items-center gap-1">
      <span className="font-mono text-stone-500">{c.key}</span>
      <VerdictBadge verdict={c.verdict} />
      {c.savedVerdict && <span className="text-amber-900">(was {c.savedVerdict.toLowerCase()} when saved)</span>}
      {c.presentation && <PresentationBadge presentation={c.presentation} />}
      {c.role && <span className="text-stone-600">{SHOT_CLAIM_ROLE_LABELS[c.role].toLowerCase()}</span>}
      <span className="text-stone-500">· {c.sourceIds.length ? `${c.sourceIds.length} source${c.sourceIds.length === 1 ? '' : 's'}` : 'no traceable source'}</span>
    </li>
  );
}

/** Coverage, then each shot's chain to its evidence, then the untraced factual shots. */
export function EvidenceTab({ version: v, onOpenShot }: { version: StoryboardVersionView; onOpenShot: (key: string) => void }) {
  const rows = evidenceRows(v);
  const cov = v.evidenceCoverage;
  return (
    <div className="space-y-4">
      <div className="rounded-md bg-stone-100 p-3 text-sm text-stone-800" data-coverage>
        <p className="font-medium">
          {cov.traced}/{cov.factualShots} factual shots traced to a retrieved source
        </p>
        <p className="mt-1 text-xs text-stone-600">A shot that shows a fact must rest on claims whose sources were retrieved and quoted. A picture never looks more certain than its evidence: disputed or probable material is shown as such.</p>
      </div>
      <div className="overflow-x-auto" data-evidence>
        <table className="w-full text-left text-xs">
          <thead className="text-stone-500">
            <tr>
              {['Shot', 'Visual beat', 'Narration', 'Script blocks', 'Architecture', 'Claims', 'Evidence'].map((h) => (
                <th key={h} className="py-1 pr-3 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 align-top">
            {rows.map(({ shot: s, state, sources }) => (
              <tr key={s.id} data-evidence-row={s.key}>
                <td className="py-2 pr-3">
                  <button type="button" onClick={() => onOpenShot(s.key)} className={`${link} font-semibold text-stone-900`}>
                    {s.key}
                  </button>
                  <div className="mt-0.5 flex flex-col items-start gap-0.5">
                    <TreatmentBadge treatment={s.treatment} />
                    <DepictionBadge depiction={s.spec.depiction} />
                    {s.infoClass && <ClassBadge cls={s.infoClass} />}
                  </div>
                </td>
                <td className="min-w-32 py-2 pr-3 break-words">
                  {s.why.beat.key} · {s.why.beat.title}
                </td>
                <td className="min-w-40 py-2 pr-3 break-words">
                  {s.why.narration.startMs !== null && s.why.narration.endMs !== null ? <span className="font-mono text-stone-500">{rangeText(s.why.narration.startMs, s.why.narration.endMs)} </span> : <span className="text-stone-500">a silence </span>}
                  {s.why.narration.text && <span>“{s.why.narration.text}”</span>}
                </td>
                <td className="py-2 pr-3">
                  <ul className="space-y-0.5">
                    {s.why.blocks.map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center gap-1">
                        {b.key} <ClassBadge cls={b.infoClass} />
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="min-w-32 py-2 pr-3 break-words">
                  {s.why.architecture.beats.map((b) => b.id).join(', ') || '—'}
                  {s.why.architecture.sequence ? ` · sequence ${s.why.architecture.sequence.number}` : ''}
                </td>
                <td className="min-w-48 py-2 pr-3">
                  {s.claims.length ? (
                    <ul className="space-y-0.5">
                      {s.claims.map((c) => (
                        <ClaimLine key={`${c.key}:${c.role}`} claim={c} />
                      ))}
                    </ul>
                  ) : (
                    <span className="text-stone-500">none</span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <ToneChip tone={STATE[state].tone}>{STATE[state].label}</ToneChip>
                  <div className="mt-0.5 text-stone-500">
                    {sources} source{sources === 1 ? '' : 's'}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section data-untraced>
        <h3 className="text-sm font-medium text-stone-800">Untraced factual shots</h3>
        {cov.untraced.length ? (
          <ul className="mt-1 flex flex-wrap gap-2 text-xs">
            {cov.untraced.map((k) => (
              <li key={k}>
                <button type="button" onClick={() => onOpenShot(k)} className={link}>
                  {k}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-emerald-700">None: every factual shot is traced.</p>
        )}
        {cov.untraced.length > 0 && <p className="mt-1 text-xs text-stone-500">Each blocks approval: give it another treatment, or a claim that is traced, with an edit.</p>}
      </section>
    </div>
  );
}

// ── Continuity ───────────────────────────────────────────────────────────────

/** Recurring characters, places and objects: what stays the same, where they appear, and the reference asset each needs. */
export function ContinuityTab({ version: v, ctx, onOpenShot }: { version: StoryboardVersionView; ctx: EditContext; onOpenShot: (key: string) => void }) {
  if (!v.continuity.length) return <p className="text-sm text-stone-500">No recurring subject: no character, place or object appears in more than one shot or needs to stay the same.</p>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {v.continuity.map((c) => (
        <SubjectCard key={c.id} subject={c} ctx={ctx} onOpenShot={onOpenShot} />
      ))}
    </div>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="break-words">
      <span className="text-stone-500">{label}: </span>
      {children}
    </p>
  );
}

function SubjectCard({ subject: c, ctx, onOpenShot }: { subject: ContinuitySubjectView; ctx: EditContext; onOpenShot: (key: string) => void }) {
  const [editing, setEditing] = useState(false);
  const s = c.spec;
  return (
    <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-700" data-subject={c.key}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold break-words text-stone-900">{c.name}</span>
        <span className="font-mono text-stone-500">{c.key}</span>
        <span>{CONTINUITY_KIND_LABELS[c.kind]}</span>
        <ClassBadge cls={c.infoClass} />
        <span className="text-stone-500">basis {s.basis.toLowerCase()}</span>
      </header>
      {c.requirement && <p className="mt-1 font-medium text-amber-900">{c.requirement}</p>}
      <p className="mt-1 text-sm break-words text-stone-800">{s.description}</p>
      <div className="mt-1 space-y-0.5">
        <Line label="Cast">{c.castId ? `${c.castId}${s.castKind ? ` (${CAST_KIND_LABELS[s.castKind].toLowerCase()})` : ''}` : s.anonymous ? 'anonymous (never a named character)' : 'not a character'}</Line>
        {s.era && <Line label="Era">{s.era}</Line>}
        {s.location && <Line label="Location">{s.location}</Line>}
        {s.approximateAge && <Line label="Approximate age">{s.approximateAge}</Line>}
        {s.clothing && <Line label="Clothing">{s.clothing}</Line>}
        {s.physicalDescription && <Line label="Physical description">{s.physicalDescription}</Line>}
        {(s.visualIdentity.palette.length > 0 || s.visualIdentity.silhouette || s.visualIdentity.props.length > 0) && (
          <Line label="Visual identity">{[s.visualIdentity.palette.length ? `palette ${s.visualIdentity.palette.join(', ')}` : null, s.visualIdentity.silhouette, s.visualIdentity.props.length ? `props ${s.visualIdentity.props.join(', ')}` : null].filter(Boolean).join(' · ')}</Line>
        )}
      </div>
      {s.designDetails.length > 0 && (
        <ul className="mt-1 space-y-0.5" data-design-details>
          {s.designDetails.map((d, i) => (
            <li key={i} className="flex flex-wrap items-center gap-1">
              <span className="break-words">{d.detail}</span>
              <ToneChip tone={DETAIL_BASIS_TONES[d.basis]}>{DETAIL_BASIS_LABELS[d.basis]}</ToneChip>
              {d.claimKeys.length > 0 && <span className="text-stone-500">[{d.claimKeys.join(', ')}]</span>}
            </li>
          ))}
        </ul>
      )}
      {s.rules.length > 0 && (
        <ul className="mt-1 list-disc pl-5" data-rules>
          {s.rules.map((r) => (
            <li key={r} className="break-words">
              {r}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2">
        <span className="text-stone-500">Appears in:</span>
        {c.appearances.length
          ? c.appearances.map((k) => (
              <button key={k} type="button" onClick={() => onOpenShot(k)} className={link}>
                {k}
              </button>
            ))
          : 'no shot'}
      </p>
      <p className="mt-1 text-stone-500">Reference asset: {s.referenceAsset.required ? `required, missing (none exists yet)${s.referenceAsset.note ? ` — ${s.referenceAsset.note}` : ''}` : 'not required'}</p>
      {ctx.allowed.allowed && (
        <button type="button" onClick={() => setEditing((x) => !x)} aria-expanded={editing} className={`${link} mt-1`}>
          {editing ? 'Close the form' : `Edit ${c.key}`}
        </button>
      )}
      {editing && <SubjectForm subject={c} ctx={ctx} onClose={() => setEditing(false)} />}
    </article>
  );
}

/**
 * What stays the same for a subject, as a new version: its description,
 * look, rules and design details, each detail with its basis (one said to
 * rest on a claim names it; an invented one stays labelled so). Its cast
 * link is the architecture's, never changed here; its basis follows its
 * design details.
 */
function SubjectForm({ subject: c, ctx, onClose }: { subject: ContinuitySubjectView; ctx: EditContext; onClose: () => void }) {
  const s = c.spec;
  const [description, setDescription] = useState(s.description);
  const [age, setAge] = useState(s.approximateAge ?? '');
  const [clothing, setClothing] = useState(s.clothing ?? '');
  const [physical, setPhysical] = useState(s.physicalDescription ?? '');
  const [rules, setRules] = useState(s.rules.join('\n'));
  const [rows, setRows] = useState<DetailRow[]>(() => detailRows(s.designDetails));
  const edits = useEdits(ctx, onClose);
  const lines = rules
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const opt = (x: string) => (x.trim() ? x.trim() : null);
  const details = designDetailsFrom(rows);
  const patch = {
    ...(description.trim() !== s.description ? { description: description.trim() } : {}),
    ...(opt(age) !== s.approximateAge ? { approximateAge: opt(age) } : {}),
    ...(opt(clothing) !== s.clothing ? { clothing: opt(clothing) } : {}),
    ...(opt(physical) !== s.physicalDescription ? { physicalDescription: opt(physical) } : {}),
    ...(JSON.stringify(lines) !== JSON.stringify(s.rules) ? { rules: lines } : {}),
    ...(!sameSettings(details.details, s.designDetails) ? { designDetails: details.details } : {}),
  };
  const setRow = (i: number, change: Partial<DetailRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...change } : x)));
  const changed = Object.keys(patch).length > 0 && !!description.trim() && lines.length <= 8 && !details.problems.length;
  return (
    <form
      className="mt-2 space-y-2 rounded-md border border-stone-200 bg-stone-50 p-2 text-sm"
      data-subject-form={c.key}
      onSubmit={(e) => {
        e.preventDefault();
        if (changed) edits.submit([{ op: 'updateContinuity', subjectKey: c.key, patch }]);
      }}
    >
      <p className="text-xs text-stone-600">Saving makes a new version; v{ctx.version} is kept as it is.</p>
      <label className="block text-xs text-stone-600">
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={STORYBOARD_LIMITS.description} rows={2} className={input} />
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block min-w-0 text-xs text-stone-600">
          Approximate age
          <input value={age} onChange={(e) => setAge(e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </label>
        <label className="block min-w-0 text-xs text-stone-600">
          Clothing
          <input value={clothing} onChange={(e) => setClothing(e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </label>
        <label className="block min-w-0 text-xs text-stone-600">
          Physical description
          <input value={physical} onChange={(e) => setPhysical(e.target.value)} maxLength={STORYBOARD_LIMITS.field} className={input} />
        </label>
      </div>
      <label className="block text-xs text-stone-600">
        Rules (one a line, at most 8)
        <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={2} className={input} />
      </label>
      <fieldset className="min-w-0 space-y-1" data-design-details-form>
        <legend className="text-xs text-stone-500">Design details, each with its basis (an invented one stays labelled as invented)</legend>
        {rows.map((r, i) => (
          <div key={i} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,8rem)_auto]">
            <input value={r.detail} onChange={(e) => setRow(i, { detail: e.target.value })} maxLength={STORYBOARD_LIMITS.field} placeholder="Detail" aria-label={`Design detail ${i + 1}`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs" />
            <select value={r.basis} onChange={(e) => setRow(i, { basis: e.target.value as DetailBasis })} aria-label={`Design detail ${i + 1} basis`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 text-xs">
              {DETAIL_BASES.map((b) => (
                <option key={b} value={b}>
                  {DETAIL_BASIS_LABELS[b]}
                </option>
              ))}
            </select>
            <input value={r.claimKeys} onChange={(e) => setRow(i, { claimKeys: e.target.value })} placeholder="Claims" aria-label={`Design detail ${i + 1} claims`} className="min-w-0 rounded-md border border-stone-300 px-2 py-1 font-mono text-xs" />
            <button type="button" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} className={link}>
              Remove
            </button>
          </div>
        ))}
        {rows.length < STORYBOARD_LIMITS.specifics && (
          <button type="button" onClick={() => setRows((x) => [...x, { detail: '', basis: 'PERIOD_GENERIC', claimKeys: '' }])} className={link}>
            Add a design detail
          </button>
        )}
        {details.problems.map((p) => (
          <p key={p} className="text-xs break-words text-red-700">
            {p}
          </p>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!changed || edits.pending || edits.race !== null} className={primary}>
          Save {c.key} as a new version
        </button>
        <button type="button" onClick={onClose} className={secondary}>
          Cancel
        </button>
      </div>
      {edits.race !== null && <RaceNotice race={edits.race} pending={edits.pending} onSaveAnyway={edits.saveAnyway} onReload={ctx.onReload} />}
      {edits.error && <p className="text-xs break-words text-red-700">{edits.error.message}</p>}
    </form>
  );
}

// ── QA ───────────────────────────────────────────────────────────────────────

/** Every finding — blocking ones stop approval, warnings are for a person to check — live and as saved, the rhythm, and what code changed in the model's output. */
export function QaTab({ version: v }: { version: StoryboardVersionView }) {
  const live = findingCounts(v.qa.live);
  const saved = findingCounts(v.qa.saved);
  return (
    <div className="space-y-6">
      <section className="space-y-2" data-qa-live>
        <h3 className="text-sm font-medium text-stone-800">
          Now: {live.blocking} blocking, {live.warnings} to check
        </h3>
        <p className="text-xs text-stone-500">Judged again on every read, against the script, narration, verdicts, profile and prices as they are now: approval is for this version as it stands.</p>
        <StoryboardFindings findings={v.qa.live} />
      </section>
      <details>
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">
          As saved: {saved.blocking} blocking, {saved.warnings} to check
        </summary>
        <div className="mt-2">
          <StoryboardFindings findings={v.qa.saved} />
        </div>
      </details>
      <section className="space-y-2" data-rhythm>
        <h3 className="text-sm font-medium text-stone-800">Rhythm</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          {rhythmRows(v.rhythm).map((r) => (
            <Stat key={r.label} label={r.label} value={r.value} />
          ))}
        </dl>
      </section>
      <section className="space-y-1" data-normalization>
        <h3 className="text-sm font-medium text-stone-800">What code changed in the model's output</h3>
        <p className="text-xs text-stone-500">Every reference the planner made (a cut point, block, beat, claim, cast member or subject) is checked by code; what could not be resolved is dropped and listed here, never guessed.</p>
        {v.normalization.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-stone-700">
            {v.normalization.map((n, i) => (
              <li key={i} className="break-words">
                {n}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-emerald-700">Nothing: the planner's output was used as it was.</p>
        )}
      </section>
    </div>
  );
}
