import {
  BEAT_FUNCTION_LABELS,
  INFORMATION_CLASSES,
  INFORMATION_CLASS_LABELS,
  NARRATIVE_MODE_LABELS,
  POV_STRATEGY_LABELS,
  RECONSTRUCTION_BUDGET,
  SPEECH_KIND_LABELS,
  TIME_JUMP_LABELS,
  type ClaimView,
  type StoryArchitectureContentV2,
  type StoryArchitectureView,
  type StoryCastMember,
  type StorySequenceV2,
} from '@docengine/core';
import { useMemo } from 'react';
import { ClaimCard, ClaimRefs, Section, type SourceLike } from './evidence.tsx';
import { HistoricalBadge, SourceTypeBadge } from './badges.tsx';
import { CLASS_STYLE, CastKindBadge, ClassBadge, ClassLegend, Field, PresentationBadge, ReconstructionBadge, isFictional } from './story-v2.tsx';

const mmss = (sec: number | null) => (sec === null ? '—' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The story editor's verdict, as the architecture job recorded it in its stats. */
interface EditorVerdict {
  scores?: Record<string, number>;
  qualityBar?: Record<string, { pass: boolean; why: string }>;
  unavailable?: string;
}

const QUALITY_BAR_QUESTIONS: Record<string, string> = {
  storyWithoutCitations: 'If every citation were removed, would there still be an engaging story?',
  compellingDocumentary: 'Could this become a compelling 10–15 minute documentary?',
  truthAndExperience: 'Would a viewer understand the historical truth while feeling they experienced a story?',
};

/** A Story Engine 2.0 architecture: the cinematic blueprint, with every fact traceable and every device labelled. */
export function ArchitectureV2({ architecture: a, content: c }: { architecture: StoryArchitectureView; content: StoryArchitectureContentV2 }) {
  const sources = useMemo(() => new Map<string, SourceLike>(a.evidence.sources.map((s) => [s.id, s])), [a.evidence.sources]);
  const cast = useMemo(() => new Map(c.cast.map((m) => [m.id, m])), [c.cast]);
  const editor = (a.stats.storyEditor ?? null) as EditorVerdict | null;
  return (
    <div className="space-y-4">
      <Section title="The documentary">
        <p className="text-lg font-semibold">{c.logline}</p>
        <p className="mt-3 text-xl font-semibold text-violet-900">{c.centralQuestion}</p>
        <p className="text-xs text-stone-500">Central question (Q0)</p>
        <dl className="mt-3 space-y-1 text-sm">
          <Field label="Human stakes">{c.centralHumanStakes}</Field>
          <Field label="Thesis">{c.thesis}</Field>
          <Field label="Spine">{c.narrativeSpine}</Field>
          <Field label="Resolution">{c.resolution || '—'}</Field>
          <Field label="Told as">
            <span className="font-medium">{NARRATIVE_MODE_LABELS[c.narrativeMode]}</span>
            {c.secondaryModes.length > 0 && <span className="text-stone-600"> with {c.secondaryModes.map((m) => NARRATIVE_MODE_LABELS[m].toLowerCase()).join(', ')}</span>}
          </Field>
          <Field label="Point of view">
            <span className="font-medium">{POV_STRATEGY_LABELS[c.povStrategy.type]}</span>
            {c.povStrategy.description && <span className="text-stone-600"> — {c.povStrategy.description}</span>}
          </Field>
          {c.orderNote && <Field label="Order">{c.orderNote}</Field>}
        </dl>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Reconstruction content={c} />
        <QualityBar editor={editor} />
      </div>

      <Section title={`Cast (${c.cast.length})`}>
        <ul className="space-y-2 text-sm">
          {c.cast.map((m) => (
            <li key={m.id} className={`rounded border p-2 ${isFictional(m.kind) ? 'border-dashed border-fuchsia-300 bg-fuchsia-50/60' : 'border-stone-200'}`}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs text-stone-500">{m.id}</span>
                <span className="font-medium">{m.name}</span>
                <CastKindBadge kind={m.kind} />
                <ClaimRefs keys={m.claimKeys} claims={a.evidence.claims} link={false} />
              </div>
              <p className="text-stone-700">{m.description}</p>
              {m.justification && <p className="text-xs text-fuchsia-900">Why a fictional device: {m.justification}</p>}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-stone-500">Fictional characters may observe real people but never speak to, touch or trade with them, and real people are never given invented words.</p>
      </Section>

      <details className="rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <summary className="cursor-pointer font-medium text-stone-700">What the colours mean: the four information classes</summary>
        <div className="mt-2">
          <ClassLegend />
        </div>
      </details>

      <Runtime sequences={c.sequences} target={a.targetDurationSec} />

      {c.sequences.map((s) => (
        <SequenceV2Card key={s.number} sequence={s} cast={cast} claims={a.evidence.claims} sources={sources} />
      ))}

      {c.unusedCandidates.length > 0 && (
        <Section title="Selected units left out">
          <ul className="space-y-1 text-sm">
            {c.unusedCandidates.map((u) => (
              <li key={u.candidateKey}>
                <span className="font-mono text-xs">{u.candidateKey}</span> — {u.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Reconstruction({ content: c }: { content: StoryArchitectureContentV2 }) {
  const r = c.reconstruction;
  const creative = r.shares.RECONSTRUCTION + r.shares.FICTION;
  const over = creative > RECONSTRUCTION_BUDGET.creative || r.shares.FICTION > RECONSTRUCTION_BUDGET.fiction;
  return (
    <Section title="Creative reconstruction">
      <div className="flex flex-wrap items-center gap-2">
        <ReconstructionBadge level={r.level} />
        <span className="text-xs text-stone-500">{r.beats} beats</span>
        {over && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">over the budget — the editor decides</span>}
      </div>
      <div className="mt-2 flex h-5 overflow-hidden rounded border border-stone-200" aria-label="Share of beats by information class">
        {INFORMATION_CLASSES.filter((k) => r.shares[k] > 0).map((k) => (
          <div key={k} className={`${CLASS_STYLE[k].badge} flex items-center justify-center text-[10px]`} style={{ width: pct(r.shares[k]) }} title={`${INFORMATION_CLASS_LABELS[k]}: ${pct(r.shares[k])}`}>
            {r.shares[k] >= 0.12 ? pct(r.shares[k]) : ''}
          </div>
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-2 gap-1 text-xs">
        {INFORMATION_CLASSES.map((k) => (
          <li key={k} className="flex items-center gap-1">
            <ClassBadge basis={k} /> {pct(r.shares[k])}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-stone-500">
        Budget (warning only): reconstruction and fiction together up to {pct(RECONSTRUCTION_BUDGET.creative)} of beats, fiction alone up to {pct(RECONSTRUCTION_BUDGET.fiction)}.
      </p>
    </Section>
  );
}

function QualityBar({ editor }: { editor: EditorVerdict | null }) {
  return (
    <Section title="Story editor: is it a story?">
      {!editor ? (
        <p className="text-sm text-stone-500">No story editor verdict recorded.</p>
      ) : editor.unavailable ? (
        <p className="text-sm text-amber-800">The story editor was unavailable: {editor.unavailable}</p>
      ) : (
        <>
          <ul className="space-y-1.5 text-sm">
            {Object.entries(editor.qualityBar ?? {}).map(([k, v]) => (
              <li key={k} className="flex gap-2">
                <span className={`mt-0.5 h-4 w-4 shrink-0 rounded-full text-center text-[10px] leading-4 font-bold text-white ${v.pass ? 'bg-emerald-600' : 'bg-amber-500'}`}>{v.pass ? '✓' : '!'}</span>
                <span>
                  <span className="font-medium">{QUALITY_BAR_QUESTIONS[k] ?? k}</span> <span className="text-stone-600">{v.why}</span>
                </span>
              </li>
            ))}
          </ul>
          {editor.scores && (
            <p className="mt-2 text-xs text-stone-600">
              {Object.entries(editor.scores)
                .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${v}/10`)
                .join(' · ')}
            </p>
          )}
          <p className="mt-1 text-xs text-stone-500">The story editor's opinion; it never passes or fails the gate. You decide.</p>
        </>
      )}
    </Section>
  );
}

function Runtime({ sequences, target }: { sequences: StorySequenceV2[]; target: number | null }) {
  const total = sequences.reduce((n, s) => n + s.estimatedDurationSec, 0) || 1;
  return (
    <div>
      <div className="flex h-6 overflow-hidden rounded-md border border-stone-200 text-[10px]">
        {sequences.map((s, i) => (
          <div key={s.number} className={`flex items-center justify-center truncate px-1 text-white ${i % 2 ? 'bg-sky-700' : 'bg-sky-600'}`} style={{ width: `${(s.estimatedDurationSec / total) * 100}%` }} title={`${s.number}. ${s.title} — ${mmss(s.estimatedDurationSec)}`}>
            {s.number}
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-stone-500">
        Running order and estimated narration time per sequence (total {mmss(total)}
        {target ? `, target ${mmss(target)}` : ''}).
      </p>
    </div>
  );
}

function SequenceV2Card({ sequence: s, cast, claims, sources }: { sequence: StorySequenceV2; cast: Map<string, StoryCastMember>; claims: ClaimView[]; sources: Map<string, SourceLike> }) {
  const seqClaims = claims.filter((x) => s.claimKeys.includes(x.key));
  const contextKeys = s.contextClaims.map((c) => c.claimKey);
  const name = (id: string) => cast.get(id)?.name ?? id;
  return (
    <article data-sequence={s.number} className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-stone-900 text-sm font-semibold text-white">{s.number}</span>
        <h3 className="text-lg font-semibold">{s.title}</h3>
        <span className="text-sm text-stone-500 tabular-nums">{mmss(s.estimatedDurationSec)}</span>
        <span className="rounded-full bg-stone-800 px-2 py-0.5 text-xs text-white">{NARRATIVE_MODE_LABELS[s.mode]}</span>
        <HistoricalBadge status={s.historicalStatus} confidence={s.historicalConfidence} />
        {s.candidateKeys.map((k) => (
          <span key={k} className="rounded bg-sky-100 px-1.5 py-0.5 font-mono text-xs text-sky-900">
            {k}
          </span>
        ))}
      </div>
      <p className="mt-1 text-sm text-stone-600">{s.purpose}</p>

      <dl className="mt-3 space-y-1 text-sm">
        <Field label="Opening hook">{s.openingHook}</Field>
        <Field label="Question">{s.question}</Field>
        <Field label="Conflict">{s.conflict || '—'}</Field>
        <Field label="Escalation">{s.escalation || '—'}</Field>
        <Field label="Reveal">{s.reveal || '—'}</Field>
        <Field label="Consequence">{s.consequence || '—'}</Field>
        <Field label="Ending beat">{s.endingBeat}</Field>
        {s.transition && <Field label="Transition">{s.transition}</Field>}
      </dl>

      <div className="mt-3">
        <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Beats</p>
        <ol className="mt-1 space-y-1.5">
          {s.beats.map((b) => (
            <li key={b.id} data-beat={b.id} className={`rounded border border-l-4 border-stone-200 p-2 text-sm ${CLASS_STYLE[b.basis].row}`}>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="font-mono text-stone-500">{b.id}</span>
                <ClassBadge basis={b.basis} />
                <span className="font-medium text-stone-700">{BEAT_FUNCTION_LABELS[b.function]}</span>
                {b.castIds.map((id) => (
                  <span key={id} className={`rounded-full px-1.5 py-0.5 ${cast.get(id) && isFictional(cast.get(id)!.kind) ? 'bg-fuchsia-100 text-fuchsia-900' : 'bg-stone-100 text-stone-700'}`}>
                    {name(id)}
                  </span>
                ))}
                <ClaimRefs keys={b.claimKeys} claims={claims} link={false} />
              </div>
              <p className="mt-1">{b.description}</p>
              {b.speech.map((x, i) => (
                <p key={i} className={`mt-1 rounded px-2 py-1 text-sm ${x.kind === 'INVENTED' ? 'bg-fuchsia-100/70 text-fuchsia-950' : 'bg-emerald-50 text-emerald-950'}`}>
                  <span className="text-xs font-semibold uppercase">
                    {SPEECH_KIND_LABELS[x.kind]}
                    {x.kind === 'INVENTED' ? ' — fiction, never a historical quote' : x.claimKey ? ` — verified in ${x.claimKey}` : ''}
                  </span>{' '}
                  {name(x.speakerId)}: “{x.text}”
                </p>
              ))}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded border border-stone-200 p-2 text-sm">
          <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Setting</p>
          <dl className="mt-1 space-y-0.5">
            {(['location', 'date', 'timeOfDay'] as const).map((k) => (
              <Field key={k} label={k === 'timeOfDay' ? 'Time of day' : k[0]!.toUpperCase() + k.slice(1)}>
                {s.setting[k].value ? (
                  <>
                    {s.setting[k].value} <ClassBadge basis={s.setting[k].basis} />
                  </>
                ) : (
                  '—'
                )}
              </Field>
            ))}
          </dl>
          <p className="mt-2 text-xs font-semibold tracking-wide text-stone-500 uppercase">Continuity</p>
          <dl className="mt-1 space-y-0.5">
            <Field label="Time">{TIME_JUMP_LABELS[s.continuity.timeJump]}</Field>
            {s.continuity.carriesIn.length > 0 && <Field label="Carries in">{s.continuity.carriesIn.join('; ')}</Field>}
            {s.continuity.carriesOut.length > 0 && <Field label="Carries out">{s.continuity.carriesOut.join('; ')}</Field>}
            {s.continuity.opens.length > 0 && <Field label="Opens">{s.continuity.opens.map((o) => `${o.id}: ${o.question}`).join(' · ')}</Field>}
            {s.continuity.resolves.length > 0 && <Field label="Resolves">{s.continuity.resolves.join(', ')}</Field>}
          </dl>
        </div>
        <div className="rounded border border-stone-200 p-2 text-sm">
          <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Visual thinking</p>
          <dl className="mt-1 space-y-0.5">
            <Field label="Environment">{s.visual.environment || '—'}</Field>
            {s.visual.keyObjects.length > 0 && <Field label="Key objects">{s.visual.keyObjects.join('; ')}</Field>}
            {s.visual.physicalActions.length > 0 && <Field label="Actions">{s.visual.physicalActions.join('; ')}</Field>}
            {s.visual.emotionalState && <Field label="Emotion">{s.visual.emotionalState}</Field>}
            {s.visual.visualMetaphor && <Field label="Metaphor">{s.visual.visualMetaphor}</Field>}
            {s.visual.mustShow.length > 0 && (
              <Field label="Must show">
                {s.visual.mustShow.map((m, i) => (
                  <span key={i} className="mr-2">
                    {m.detail} <ClaimRefs keys={m.claimKeys} claims={claims} link={false} />
                  </span>
                ))}
              </Field>
            )}
            {s.visual.mustAvoid.length > 0 && <Field label="Must avoid">{s.visual.mustAvoid.join('; ')}</Field>}
            {s.visual.shotIdeas.length > 0 && <Field label="Shot ideas">{s.visual.shotIdeas.join('; ')}</Field>}
          </dl>
        </div>
      </div>

      {s.presentation.length > 0 && (
        <div className="mt-3 rounded border border-orange-200 bg-orange-50 p-2 text-sm">
          <p className="text-xs font-semibold tracking-wide text-orange-800 uppercase">How to present uncertain material</p>
          <ul className="mt-1 space-y-1">
            {s.presentation.map((x) => (
              <li key={x.claimKey} className="flex flex-wrap items-center gap-1.5">
                <ClaimRefs keys={[x.claimKey]} claims={claims} link={false} /> <PresentationBadge presentation={x.presentation} /> {x.instruction}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.contextClaims.length > 0 && (
        <div className="mt-3 rounded border border-dashed border-stone-300 bg-stone-50 p-2 text-sm" data-context-claims>
          <p className="text-xs font-semibold tracking-wide text-stone-500 uppercase">Background only — other dossier claims, not story evidence</p>
          <ul className="mt-1 space-y-0.5 text-stone-600">
            {s.contextClaims.map((x) => (
              <li key={x.claimKey}>
                <ClaimRefs keys={[x.claimKey]} claims={claims} link={false} /> {x.purpose}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-stone-600">
          Story evidence: {s.claimKeys.length} claim(s) of the selected units, {s.sourceIds.length} source(s) <ClaimRefs keys={s.claimKeys} claims={claims} link={false} />
        </summary>
        <SourceList ids={[...s.sourceIds, ...s.contextSourceIds]} sources={sources} />
        <div className="mt-2 space-y-2">
          {[...seqClaims, ...claims.filter((x) => contextKeys.includes(x.key))].map((x) => (
            <ClaimCard key={x.id} claim={x} sources={sources} anchor={false} />
          ))}
        </div>
      </details>
    </article>
  );
}

export function SourceList({ ids, sources }: { ids: string[]; sources: Map<string, SourceLike> }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {[...new Set(ids)].map((id) => {
        const src = sources.get(id);
        return (
          <li key={id} className="flex flex-wrap items-center gap-1">
            {src && <SourceTypeBadge type={src.sourceType} />}
            {src?.url ? (
              <a href={src.url} target="_blank" rel="noreferrer" className="hover:underline">
                {src.title}
              </a>
            ) : (
              <span>{src?.title ?? id}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
