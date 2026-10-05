import {
  PERFORMANCE_STRATEGIES,
  PERFORMANCE_STRATEGY_HELP,
  PERFORMANCE_STRATEGY_LABELS,
  PRONUNCIATION_METHODS,
  PRONUNCIATION_METHOD_LABELS,
  PRONUNCIATION_STATUSES,
  PRONUNCIATION_STATUS_LABELS,
  PRONUNCIATION_TERM_KIND_LABELS,
  VOICE_RUN_KIND_LABELS,
  type ContextSettings,
  type PerformanceStrategy,
  type PronunciationMethod,
  type PronunciationStatus,
  type VoicePlanView,
  type VoicePronunciationView,
  type VoiceRunView,
  type VoiceScope,
  type VoiceView,
} from '@docengine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { Section } from '../components/evidence.tsx';
import { ProjectNav } from '../components/ProjectNav.tsx';
import { ChunkCard, Findings, Player, button, clock, pill, secondary, seconds, useVoiceRequest } from '../components/voice.tsx';
import { formatDate, formatUsd } from '../format.ts';

type Tab = 'run' | 'generate' | 'pronunciation' | 'profile';

/**
 * Narration: an approved script read aloud in small chunks of natural
 * speech, each take reviewed on its own, assembled on the clock of the audio
 * itself. Audition first; the whole narration needs a human approval.
 */
export function VoicePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const runNumber = params.get('run') ? Number(params.get('run')) : undefined;
  const project = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 1_500 : 10_000),
  });
  const running = project.data?.jobs.some((j) => j.type === 'VOICE' && (j.status === 'QUEUED' || j.status === 'RUNNING')) ?? false;
  const voice = useQuery({ queryKey: ['voice', id, runNumber], queryFn: () => api.voice(id, runNumber), refetchInterval: running ? 2_000 : false });
  const [tab, setTab] = useState<Tab>('run');
  const stamp = project.data ? `${project.data.status}|${project.data.jobs.filter((j) => j.type === 'VOICE').map((j) => `${j.id}:${j.status}`).join(',')}` : null;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (stamp !== null && last.current !== null && last.current !== stamp) void voice.refetch();
    last.current = stamp;
  }, [stamp, voice]);

  if (project.isPending || voice.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (project.isError) return <p className="text-sm text-red-700">Could not load the project: {project.error.message}</p>;
  if (voice.isError) return <p className="text-sm text-red-700">Could not load the narration: {voice.error.message}</p>;
  const p = project.data;
  const v = voice.data;
  const showRun = (n: number) => {
    const next = new URLSearchParams(params);
    next.set('run', String(n));
    setParams(next);
    setTab('run');
  };
  const pending = v.pronunciations.filter((x) => x.status !== 'APPROVED').length;
  const tabs: [Tab, string][] = [
    ['run', v.run ? `Voice run ${v.run.number}` : 'Runs'],
    ['generate', 'Audition & generate'],
    ['pronunciation', `Pronunciation${pending ? ` (${pending} to check)` : ''}`],
    ['profile', 'Voice profile'],
  ];
  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">
          ← {p.title}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Voice</h1>
          <StatusBadge status={p.status} />
          {v.runs.length > 0 && (
            <select value={v.run?.number ?? ''} onChange={(e) => showRun(Number(e.target.value))} className="max-w-full min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label="Voice run">
              {v.runs.map((r) => (
                <option key={r.id} value={r.number}>
                  Run {r.number} — {r.label}
                  {r.stale ? ' (stale)' : ''}
                </option>
              ))}
            </select>
          )}
        </div>
        <ProjectNav project={p} />
        <p className="mt-2 text-xs text-stone-500">
          {v.script ? `Narration of the approved script v${v.script.version}.` : 'No approved script yet.'} Generated in small chunks of natural speech, each take kept and reviewed on its own; the script is never changed — spoken forms and performance directions are derived and shown beside it. Real audio timing, not a words-per-minute estimate, is what the storyboard will be timed against.
        </p>
      </div>

      <ProviderStrip view={v} />
      {running && <p className="rounded-md bg-sky-50 p-3 text-sm text-sky-900">Generating takes… this page updates as each chunk is done.</p>}
      <Gate view={v} projectId={p.id} />

      <div className="flex flex-wrap gap-1 border-b border-stone-200">
        {tabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'run' && (v.run ? <RunTab view={v} run={v.run} projectId={p.id} /> : <p className="text-sm text-stone-500">No voice run yet: start with an audition of the opening.</p>)}
      {tab === 'generate' && <GenerateTab view={v} projectId={p.id} onQueued={(n) => showRun(n)} />}
      {tab === 'pronunciation' && <PronunciationTab items={v.pronunciations} />}
      {tab === 'profile' && <ProfileTab view={v} projectId={p.id} />}
    </div>
  );
}

function ProviderStrip({ view: v }: { view: VoiceView }) {
  const active = v.profiles.find((x) => x.id === v.activeProfileId);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-600">
      <span className="font-semibold text-stone-800">{v.provider.name}</span>
      {v.provider.mock && <span className={`${pill} bg-amber-100 text-amber-900`}>MOCK voice: a beep and silence, no speech</span>}
      <span>model {active?.modelId ?? v.provider.defaultModel}</span>
      <span className="break-all">voice {active?.voiceId ?? v.provider.defaultVoiceId ?? 'not set'}</span>
      {active && (
        <span>
          {active.name} v{active.version} · {active.language} · {active.outputFormat}
        </span>
      )}
      <span className={`${pill} ${v.provider.durableStorage ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>{v.provider.durableStorage ? `storage: ${v.provider.storage}` : 'storage in memory (lost on restart)'}</span>
    </div>
  );
}

function Gate({ view: v, projectId }: { view: VoiceView; projectId: string }) {
  const [notes, setNotes] = useState('');
  const decide = useVoiceRequest((decision: 'APPROVED' | 'REJECTED') => api.approve(projectId, { gate: 'VOICE', decision, ...(notes ? { notes } : {}) }));
  if (v.project.status !== 'VOICE_REVIEW' && v.project.status !== 'VOICE_COMPLETE') return null;
  return (
    <Section title="Narration approval (VOICE gate)">
      {v.project.status === 'VOICE_COMPLETE' ? (
        <p className="text-sm text-emerald-800">The narration is approved.</p>
      ) : !v.editorial.approve.allowed ? (
        <p className="text-sm text-stone-600">{v.editorial.approve.reason}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-stone-600">Approve the assembled narration of the whole approved script: every chunk's current take approved, nothing blocking. An audition is not the narration.</p>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="w-full max-w-md rounded-md border border-stone-300 px-2 py-1 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')} className={`${button} bg-emerald-600 text-white hover:bg-emerald-700`}>
              Approve narration
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className={`${button} bg-white text-red-700 ring-1 ring-red-300 hover:bg-red-50`}>
              Send back
            </button>
          </div>
          {decide.error && <p className="text-sm text-red-700">{decide.error.message}</p>}
        </div>
      )}
    </Section>
  );
}

function RunTab({ view: v, run: r, projectId }: { view: VoiceView; run: VoiceRunView; projectId: string }) {
  const approveAll = useVoiceRequest(() => api.approveAllTakes(r.id));
  const blocking = r.qa.filter((f) => f.severity === 'BLOCKING');
  const canGenerate = v.editorial.generate.allowed && !r.stale;
  const [at, setAt] = useState('');
  const moment = useQuery({ queryKey: ['voice', 'moment', projectId, r.number, at], queryFn: () => api.voiceMoment(projectId, r.number, at), enabled: false, retry: false });
  return (
    <div className="space-y-4">
      {r.staleNote && <p className="rounded-md bg-red-50 p-3 text-sm text-red-900">{r.staleNote}. Stale audio is never reused: start a new run for the current script.</p>}
      <Section title={`Voice run ${r.number} — ${VOICE_RUN_KIND_LABELS[r.kind]}${r.variant ? ` · ${r.variant}` : ''}`}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Script" value={`v${r.scriptVersion}`} />
          <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[r.strategy]} />
          <Stat label="Chunks" value={`${r.chunkCount} (${r.settings.chunking.minWords}–${r.settings.chunking.maxWords} words)`} />
          <Stat label="Characters" value={r.characters.toLocaleString()} />
          <Stat label="Cost" value={`${formatUsd(r.cost.totalUsd)}${r.cost.basis ? ` (${r.cost.basis.toLowerCase()})` : ''}`} />
          <Stat label="Generated audio" value={seconds(r.durationMs)} />
          <Stat label="Chunk length" value={r.stats.averageChunkMs ? `avg ${seconds(r.stats.averageChunkMs)} · ${seconds(r.stats.shortestChunkMs)}–${seconds(r.stats.longestChunkMs)}` : '—'} />
          <Stat label="Timestamps" value={`${r.stats.withAlignment} of ${r.chunkCount}`} />
          <Stat label="Regenerations" value={String(r.stats.regenerations)} />
          <Stat label="Failures" value={String(r.stats.failures)} />
          <Stat label="Voice" value={`${r.profile.name} v${r.profile.version} · ${r.profile.modelId}`} />
          <Stat label="Context" value={r.settings.context.stitch ? 'stitched to the previous take' : r.settings.context.previousChars || r.settings.context.nextChars ? `neighbouring text (${r.settings.context.previousChars}/${r.settings.context.nextChars} chars)` : 'none'} />
        </dl>
        <p className="mt-2 text-xs text-stone-500">
          {r.label} · created {formatDate(r.createdAt)}
        </p>
      </Section>
      {r.assembly && (
        <Section title={`Assembled narration v${r.assembly.version} — ${clock(r.assembly.totalDurationMs)}`}>
          <Player src={r.assembly.audioUrl} label={`Voice run ${r.number}, assembled`} />
          <p className="mt-1 text-xs text-stone-500">
            {r.assembly.entries.length} takes in order on their measured durations, with the scripted pauses between them{r.assembly.complete ? ' · the whole script' : ''}.
          </p>
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (at.trim()) void moment.refetch();
            }}
          >
            <label htmlFor="moment" className="text-xs text-stone-600">
              What is said at
            </label>
            <input id="moment" value={at} onChange={(e) => setAt(e.target.value)} placeholder="02:43" className="w-24 rounded-md border border-stone-300 px-2 py-1 text-sm" />
            <button className={secondary} type="submit">
              Find
            </button>
          </form>
          {moment.data && (
            <p className="mt-1 text-sm">
              <span className="text-stone-500">
                {clock(moment.data.atMs)} — {moment.data.section}, block {moment.data.block}, chunk {moment.data.chunk} (take {moment.data.generation}){moment.data.between ? ', in a pause before' : ''}:
              </span>{' '}
              {moment.data.word && <span className="rounded bg-yellow-100 px-1 font-medium">{moment.data.word}</span>} <span className="text-stone-700">“{moment.data.text}”</span>
            </p>
          )}
          {moment.error && <p className="mt-1 text-xs text-red-700">{moment.error.message}</p>}
        </Section>
      )}
      <Section title={`Voice QA (${blocking.length} blocking, ${r.qa.length - blocking.length} to check)`}>
        <Findings findings={r.qa} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button disabled={approveAll.isPending} onClick={() => approveAll.mutate(undefined)} className={secondary}>
            Approve all takes without blocking findings
          </button>
          {approveAll.data && (
            <span className="text-xs text-stone-600">
              {approveAll.data.approved} approved{approveAll.data.skipped ? `, ${approveAll.data.skipped} left for a closer listen` : ''}
            </span>
          )}
        </div>
      </Section>
      <div className="space-y-3">
        {r.chunks.map((c) => (
          <ChunkCard key={c.id} chunk={c} runId={r.id} canGenerate={canGenerate} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="break-words text-stone-900">{value}</dd>
    </div>
  );
}

const SIZES: { label: string; minWords: number; maxWords: number }[] = [
  { label: 'House default (25–80 words)', minWords: 25, maxWords: 80 },
  { label: 'Small (20–40 words)', minWords: 20, maxWords: 40 },
  { label: 'Medium (40–80 words)', minWords: 40, maxWords: 80 },
  { label: 'Large (80–120 words)', minWords: 80, maxWords: 120 },
];
const CONTEXTS: { label: string; context: ContextSettings }[] = [
  { label: 'Neighbouring text (a sentence or two)', context: { previousChars: 200, nextChars: 120, stitch: false } },
  { label: 'No context', context: { previousChars: 0, nextChars: 0, stitch: false } },
  { label: 'Stitched to the previous take (request ids)', context: { previousChars: 200, nextChars: 120, stitch: true } },
];

function GenerateTab({ view: v, projectId, onQueued }: { view: VoiceView; projectId: string; onQueued: (run: number) => void }) {
  const [kind, setKind] = useState<VoiceScope['kind']>('AUDITION');
  const [secondsWanted, setSeconds] = useState(100);
  const [section, setSection] = useState(1);
  const [blocks, setBlocks] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [strategy, setStrategy] = useState<PerformanceStrategy>('RESTRAINED');
  const [size, setSize] = useState(0);
  const [context, setContext] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [compare, setCompare] = useState<'none' | 'direction' | 'size'>('none');
  const scope: VoiceScope =
    kind === 'AUDITION' ? { kind, seconds: secondsWanted } : kind === 'SECTION' ? { kind, section } : kind === 'BLOCKS' ? { kind, blockKeys: blocks.split(/[\s,]+/).filter(Boolean) } : kind === 'RANGE' ? { kind, from, to } : { kind: 'FULL' };
  const options = { strategy, chunking: { minWords: SIZES[size]!.minWords, maxWords: SIZES[size]!.maxWords }, context: CONTEXTS[context]!.context };
  const [plan, setPlan] = useState<VoicePlanView | null>(null);
  const planReq = useVoiceRequest(() => api.voiceRunPlan(projectId, { scope, options }).then(setPlan));
  const create = useVoiceRequest(
    () =>
      compare === 'none'
        ? api.createVoiceRun(projectId, { scope, options, confirm }).then((r) => r.run)
        : api
            .createVoiceExperiment(projectId, {
              scope,
              name: compare === 'direction' ? 'Performance direction' : 'Chunk size',
              variants:
                compare === 'direction'
                  ? [
                      { label: 'A plain', ...options, strategy: 'PLAIN' },
                      { label: 'B restrained', ...options, strategy: 'RESTRAINED' },
                      { label: 'C over-directed', ...options, strategy: 'DIRECTED' },
                    ]
                  : SIZES.slice(1).map((s, i) => ({ label: `${'ABC'[i]} ${s.minWords}–${s.maxWords} words`, ...options, chunking: { minWords: s.minWords, maxWords: s.maxWords } })),
              confirm,
            })
            .then((r) => r.runs[0]!),
    undefined,
  );
  useEffect(() => {
    if (create.data !== undefined) onQueued(create.data as number);
  }, [create.data, onQueued]);
  if (!v.editorial.generate.allowed) return <p className="text-sm text-stone-600">{v.editorial.generate.reason}</p>;
  return (
    <div className="space-y-4">
      <Section title="What to narrate">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Scope</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as VoiceScope['kind'])} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value="AUDITION">Opening audition</option>
              <option value="SECTION">One section</option>
              <option value="BLOCKS">Chosen blocks</option>
              <option value="RANGE">A range of blocks</option>
              <option value="FULL">The whole script</option>
            </select>
          </label>
          {kind === 'AUDITION' && (
            <label className="text-sm">
              <span className="block text-xs text-stone-500">About how long (seconds, whole blocks)</span>
              <input type="number" min={20} max={300} value={secondsWanted} onChange={(e) => setSeconds(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
            </label>
          )}
          {kind === 'SECTION' && (
            <label className="text-sm">
              <span className="block text-xs text-stone-500">Section number</span>
              <input type="number" min={1} value={section} onChange={(e) => setSection(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
            </label>
          )}
          {kind === 'BLOCKS' && (
            <label className="text-sm">
              <span className="block text-xs text-stone-500">Block keys (e.g. 1.1, 1.2, 3.4)</span>
              <input value={blocks} onChange={(e) => setBlocks(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
            </label>
          )}
          {kind === 'RANGE' && (
            <div className="flex gap-2 text-sm">
              <label className="min-w-0 flex-1">
                <span className="block text-xs text-stone-500">From block</span>
                <input value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
              </label>
              <label className="min-w-0 flex-1">
                <span className="block text-xs text-stone-500">To block</span>
                <input value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
              </label>
            </div>
          )}
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Performance</span>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as PerformanceStrategy)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              {PERFORMANCE_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {PERFORMANCE_STRATEGY_LABELS[s]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-stone-500">{PERFORMANCE_STRATEGY_HELP[strategy]}</span>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Chunk size</span>
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              {SIZES.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Continuity between chunks</span>
            <select value={context} onChange={(e) => setContext(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              {CONTEXTS.map((c, i) => (
                <option key={c.label} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Generate as</span>
            <select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value="none">One run</option>
              <option value="direction">A comparison: plain / restrained / over-directed</option>
              <option value="size">A comparison: 20–40 / 40–80 / 80–120 words</option>
            </select>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={planReq.isPending} onClick={() => planReq.mutate(undefined)} className={secondary}>
            Plan (nothing is generated)
          </button>
        </div>
        {planReq.error && <p className="mt-2 text-sm text-red-700">{planReq.error.message}</p>}
      </Section>

      {plan && <PlanView plan={plan} />}

      {plan && (
        <Section title="Generate">
          {plan.blocked ? (
            <p className="text-sm text-red-800">{plan.blocked}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-stone-600">
                {compare === 'none' ? 'One run' : 'A comparison of 3 runs'} of {plan.description.toLowerCase()} with {plan.profile.provider} {plan.profile.modelId}.{' '}
                {plan.estimate.costBasis === 'MOCK' ? 'MOCK voice: no cost.' : `About ${plan.estimate.characters.toLocaleString()} characters${compare === 'none' ? '' : ' per run'}, ${plan.estimate.estimatedCostUsd !== null ? `~${formatUsd(plan.estimate.estimatedCostUsd)}` : 'unpriced'}.`}
              </p>
              {(plan.estimate.needsConfirmation || compare !== 'none') && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I confirm this generation{compare !== 'none' ? ' (each variant is generated in full)' : ''}.
                </label>
              )}
              <button disabled={create.isPending || ((plan.estimate.needsConfirmation || compare !== 'none') && !confirm)} onClick={() => create.mutate(undefined)} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
                {compare === 'none' ? (kind === 'AUDITION' ? 'Generate the audition' : 'Generate') : 'Generate the comparison'}
              </button>
              {create.error && <p className="text-sm text-red-700">{create.error.message}</p>}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function PlanView({ plan }: { plan: VoicePlanView }) {
  const c = plan.coverage;
  const covered: [boolean, string][] = [
    [c.dramaticOpening, 'the opening'],
    [c.explanatory, 'an explanatory passage'],
    [c.rhetoricalQuestion, 'a rhetorical question'],
    [c.number, 'a number or date'],
    [c.nameOrPlace, 'a name or place'],
    [c.performanceMoment, 'a performance moment'],
  ];
  return (
    <Section title={`Plan — ${plan.description}`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Chunks" value={String(plan.estimate.chunks)} />
        <Stat label="Words" value={plan.estimate.words.toLocaleString()} />
        <Stat label="Characters sent" value={plan.estimate.characters.toLocaleString()} />
        <Stat label="Estimated cost" value={plan.estimate.estimatedCostUsd !== null ? `${formatUsd(plan.estimate.estimatedCostUsd)} (${plan.estimate.costBasis.toLowerCase()})` : 'unpriced'} />
        <Stat label="Planned length" value={`~${clock(plan.estimate.plannedSec * 1000)} (estimate)`} />
        <Stat label="Voice" value={`${plan.profile.name} v${plan.profile.version} · ${plan.profile.modelId}`} />
        <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[plan.strategy]} />
        <Stat label="Pronunciations to check" value={plan.unresolvedPronunciations.length ? plan.unresolvedPronunciations.join(', ') : 'none'} />
      </dl>
      <p className="mt-2 text-xs text-stone-500">{plan.estimate.costNote}</p>
      <p className="mt-2 text-xs text-stone-600">
        Covers: {covered.map(([ok, label]) => `${ok ? '✓' : '✗'} ${label}`).join(' · ')}
      </p>
      <ol className="mt-3 space-y-2">
        {plan.chunks.map((ch) => (
          <li key={ch.index} className="rounded-md border border-stone-200 p-2 text-xs">
            <p className="text-stone-500">
              #{ch.index + 1} · {ch.sectionKey} · blocks {ch.blockKeys.join(', ')} · {ch.words} words · {ch.characters} chars{ch.checksPassed ? '' : ' · ✗ checks'}
            </p>
            <p className="mt-1 font-mono break-words whitespace-pre-wrap text-stone-800">{ch.performanceText}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function PronunciationTab({ items }: { items: VoicePronunciationView[] }) {
  if (!items.length) return <p className="text-sm text-stone-500">No term in the narration planned so far needs a pronunciation decision (the list fills in as runs are planned).</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-stone-500">
        Names, places, foreign words and abbreviations in the narration. Nothing is assumed right: approve the voice's own reading, give an alias (spoken instead of the written term), or phonemes for the voice's pronunciation dictionary. The script keeps its spelling. The whole narration is generated only once every term is decided.
      </p>
      {items.map((x) => (
        <PronunciationRow key={x.id} item={x} />
      ))}
    </div>
  );
}

function PronunciationRow({ item: x }: { item: VoicePronunciationView }) {
  const [method, setMethod] = useState<PronunciationMethod>(x.method);
  const [value, setValue] = useState(x.pronunciation ?? '');
  const [status, setStatus] = useState<PronunciationStatus>(x.status);
  const save = useVoiceRequest(() => api.updatePronunciation(x.id, { method, pronunciation: method === 'DEFAULT' ? null : value, status }));
  const dirty = method !== x.method || (x.pronunciation ?? '') !== value || status !== x.status;
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-stone-900">{x.term}</span>
        <span className="text-xs text-stone-500">{PRONUNCIATION_TERM_KIND_LABELS[x.kind]}</span>
        <span className={`${pill} ${x.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800' : x.status === 'FLAGGED' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>{PRONUNCIATION_STATUS_LABELS[x.status]}</span>
      </div>
      {x.hint && <p className="mt-1 text-xs text-stone-500">{x.hint}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select value={method} onChange={(e) => setMethod(e.target.value as PronunciationMethod)} className="max-w-full min-w-0 rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label={`How ${x.term} is said`}>
          {PRONUNCIATION_METHODS.map((m) => (
            <option key={m} value={m}>
              {PRONUNCIATION_METHOD_LABELS[m]}
            </option>
          ))}
        </select>
        {method !== 'DEFAULT' && (
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={method === 'ALIAS' ? 'Tessel' : method === 'IPA' ? 'ˈɦaːrlɛm' : 'HH AA1 R L EH0 M'} className="min-w-0 flex-1 rounded-md border border-stone-300 px-2 py-1 font-mono text-sm" aria-label={`Pronunciation of ${x.term}`} />
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value as PronunciationStatus)} className="rounded-md border border-stone-300 px-2 py-1 text-sm" aria-label={`Status of ${x.term}`}>
          {PRONUNCIATION_STATUSES.map((st) => (
            <option key={st} value={st}>
              {PRONUNCIATION_STATUS_LABELS[st]}
            </option>
          ))}
        </select>
        <button disabled={!dirty || save.isPending} onClick={() => save.mutate(undefined)} className={secondary}>
          Save
        </button>
      </div>
      {save.error && <p className="mt-1 text-xs text-red-700">{save.error.message}</p>}
    </div>
  );
}

function ProfileTab({ view: v, projectId }: { view: VoiceView; projectId: string }) {
  const active = v.profiles.find((x) => x.id === v.activeProfileId) ?? null;
  const [voiceId, setVoiceId] = useState(active?.voiceId ?? v.provider.defaultVoiceId ?? '');
  const [modelId, setModelId] = useState(active?.modelId ?? v.provider.defaultModel);
  const [stability, setStability] = useState(active?.config.settings.stability ?? 0.5);
  const [similarity, setSimilarity] = useState(active?.config.settings.similarity ?? 0.75);
  const [notes, setNotes] = useState('');
  const create = useVoiceRequest(() => api.createVoiceProfile(projectId, { ...(active ? { basedOn: active.id } : {}), voiceId, modelId, settings: { stability, similarity }, ...(notes ? { notes } : {}) }));
  return (
    <div className="space-y-4">
      <Section title={active ? `Active profile — ${active.name} v${active.version}` : 'No profile yet'}>
        {active ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
            <Stat label="Provider" value={active.provider} />
            <Stat label="Model" value={active.modelId} />
            <Stat label="Voice" value={active.voiceId} />
            <Stat label="Language" value={active.language} />
            <Stat label="Output" value={active.outputFormat} />
            <Stat label="Stability / similarity" value={`${active.config.settings.stability} / ${active.config.settings.similarity}`} />
            <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[active.config.strategy]} />
            <Stat label="Chunks" value={`${active.config.chunking.minWords}–${active.config.chunking.maxWords} words`} />
          </dl>
        ) : (
          <p className="text-sm text-stone-600">The first plan creates one from the configured defaults.</p>
        )}
        <p className="mt-2 text-xs text-stone-500">A profile is never edited: a change makes a new version, so every take keeps the exact settings that made it.</p>
      </Section>
      <Section title="New version">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Voice id</span>
            <input value={voiceId} onChange={(e) => setVoiceId(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1 font-mono" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Model</span>
            <input value={modelId} onChange={(e) => setModelId(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1 font-mono" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Stability ({stability})</span>
            <input type="range" min={0} max={1} step={0.05} value={stability} onChange={(e) => setStability(Number(e.target.value))} className="mt-1 w-full" />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Similarity ({similarity})</span>
            <input type="range" min={0} max={1} step={0.05} value={similarity} onChange={(e) => setSimilarity(Number(e.target.value))} className="mt-1 w-full" />
          </label>
          <label className="text-sm sm:col-span-2">
            <span className="block text-xs text-stone-500">Notes</span>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
          </label>
        </div>
        <button disabled={create.isPending || !voiceId || !modelId} onClick={() => create.mutate(undefined)} className={`${button} mt-3 bg-stone-900 text-white hover:bg-stone-800`}>
          Create the new version
        </button>
        {create.error && <p className="mt-2 text-sm text-red-700">{create.error.message}</p>}
      </Section>
      <Section title={`All versions (${v.profiles.length})`}>
        <ul className="space-y-1 text-sm">
          {v.profiles.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {x.name} v{x.version}
              </span>
              <span className="text-xs text-stone-500 break-all">
                {x.provider} · {x.modelId} · {x.voiceId} · {x.runs} run(s)
              </span>
              {x.active && <TakeStatusPill />}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function TakeStatusPill() {
  return <span className={`${pill} bg-emerald-100 text-emerald-800`}>active</span>;
}

