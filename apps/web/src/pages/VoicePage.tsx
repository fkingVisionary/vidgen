import {
  CHUNK_BOUNDARY_LABELS,
  CHUNK_SECONDS,
  DEFAULT_VOICE_PROFILE_CONFIG,
  PERFORMANCE_STRATEGIES,
  PERFORMANCE_STRATEGY_HELP,
  PERFORMANCE_STRATEGY_LABELS,
  PRONUNCIATION_METHODS,
  PRONUNCIATION_METHOD_LABELS,
  PRONUNCIATION_STATUSES,
  PRONUNCIATION_STATUS_LABELS,
  PRONUNCIATION_TERM_KIND_LABELS,
  SELECTION_MODE_LABELS,
  VOICE_ACCEPTANCE_EXPERIMENT,
  VOICE_RUN_KIND_LABELS,
  type EffectiveVoiceConfig,
  type PerformanceStrategy,
  type PronunciationMethod,
  type PronunciationStatus,
  type VoicePlanChunkView,
  type VoicePlanView,
  type VoiceProductionView,
  type VoiceProfileView,
  type VoicePronunciationView,
  type VoiceRunOptions,
  type VoiceRunView,
  type VoiceScope,
  type VoiceSettingDescriptor,
  type VoiceView,
} from '@docengine/core';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { Section } from '../components/evidence.tsx';
import { ProjectNav } from '../components/ProjectNav.tsx';
import { AssemblyStatus, ChunkCard, choiceProblem, choiceRequest, Findings, Length, NumberedText, Player, RUN_CHOICE, TakeChoiceFields, button, clock, link, pill, secondary, seconds, useVoiceRequest, type ChunkContext, type TakeChoice } from '../components/voice.tsx';
import { ConfigTable, isConflict, OverridesEditor, SaveAsProfile, type OverrideField } from '../components/voice-profiles.tsx';
import { formatDate, formatUsd } from '../format.ts';
import {
  CHUNK_SIZES,
  CONTEXTS,
  NO_CONTEXT,
  contextLabel,
  costText,
  costWords,
  describeOverrides,
  experimentRuns,
  isEmptyOverrides,
  outsideNatural,
  overrideProblems,
  plansEstimate,
  productionMode,
  profileLabel,
  profileNameFor,
  pruneOverrides,
  sameOverrides,
  sizeLabel,
  takesEstimate,
  versionEffective,
  type EditedOverrides,
} from '../voice-plan.ts';

type Tab = 'run' | 'generate' | 'pronunciation' | 'profile';

/**
 * Narration: an approved script read aloud in small chunks of natural
 * speech, each take reviewed on its own, assembled on the clock of the audio
 * itself. Audition first; the whole narration needs a human approval. The
 * project narrates with its production profile (a saved voice profile, with
 * the project's own overrides); every run and take keeps what it was made
 * with.
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
  const queryClient = useQueryClient();
  const last = useRef<string | null>(null);
  // A voice job started or finished: read every run shown again (a comparison shows several).
  useEffect(() => {
    if (stamp !== null && last.current !== null && last.current !== stamp) void queryClient.invalidateQueries({ queryKey: ['voice'] });
    last.current = stamp;
  }, [stamp, queryClient]);

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
  const pending = v.pronunciations.filter((x) => x.status !== 'APPROVED' && !x.withdrawn).length;
  const tabs: [Tab, string][] = [
    ['run', v.run ? `Voice run ${v.run.number}` : 'Runs'],
    ['generate', 'Audition & generate'],
    ['pronunciation', `Pronunciation${pending ? ` (${pending} to check)` : ''}`],
    ['profile', 'Production profile'],
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
      {running && (
        <p className="rounded-md bg-sky-50 p-3 text-sm text-sky-900" role="status">
          Generating takes… this page updates as each chunk is done.
        </p>
      )}
      <Gate view={v} projectId={p.id} />

      <div role="tablist" aria-label="Voice" className="flex flex-wrap gap-1 border-b border-stone-200">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            id={`voice-tab-${t}`}
            aria-selected={tab === t}
            aria-controls="voice-panel"
            onClick={() => setTab(t)}
            className={`-mb-px min-h-6 border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="voice-panel" aria-labelledby={`voice-tab-${tab}`}>
        {tab === 'run' && (v.run ? <RunTab key={v.run.id} view={v} run={v.run} projectId={p.id} projectRef={id} running={running} onOpen={showRun} /> : <p className="text-sm text-stone-500">No voice run yet: start with an audition of the opening.</p>)}
        {tab === 'generate' && <GenerateTab view={v} projectId={p.id} onQueued={showRun} />}
        {tab === 'pronunciation' && <PronunciationTab items={v.pronunciations} />}
        {tab === 'profile' && <ProductionTab view={v} projectId={p.id} />}
      </div>
    </div>
  );
}

/** "Tulip narrator v1", as production names its version (with the family's name now after a rename). */
const productionName = (p: VoiceProductionView) => (p.profile ? profileLabel({ name: p.profile.name, version: p.profile.version, familyName: p.family?.name ?? null }) : null);

function ProviderStrip({ view: v }: { view: VoiceView }) {
  const active = v.production.profile;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-3 text-xs text-stone-600">
      <span className="font-semibold text-stone-800">{v.provider.name}</span>
      {v.provider.mock && <span className={`${pill} bg-amber-100 text-amber-900`}>MOCK voice: a beep and silence, no speech</span>}
      <span>model {active?.modelId ?? v.provider.defaultModel}</span>
      <span className="break-all">voice {active?.voiceId ?? v.provider.defaultVoiceId ?? 'not set'}</span>
      {active && (
        <span>
          {productionName(v.production)} · {active.language} · {active.outputFormat} · {productionMode(v.production)}
        </span>
      )}
      <span className={`${pill} ${v.provider.durableStorage ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-100 text-amber-900'}`}>{v.provider.durableStorage ? `storage: ${v.provider.storage}` : 'storage in memory (lost on restart)'}</span>
      <Link to="/voice-profiles" className={link}>
        Voice profiles
      </Link>
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

function RunTab({ view: v, run: r, projectId, projectRef, running, onOpen }: { view: VoiceView; run: VoiceRunView; projectId: string; projectRef: string; running: boolean; onOpen: (run: number) => void }) {
  const approveAll = useVoiceRequest(() => api.approveAllTakes(r.id));
  const blocking = r.qa.filter((f) => f.severity === 'BLOCKING');
  const canGenerate = v.editorial.generate.allowed && !r.stale;
  const [at, setAt] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [versions, setVersions] = useState(false);
  const moment = useQuery({ queryKey: ['voice', 'moment', projectId, r.number, at], queryFn: () => api.voiceMoment(projectId, r.number, at), enabled: false, retry: false });
  const earlier = r.assemblies.filter((a) => a.id !== r.assembly?.id);
  const cfg = r.configuration;
  const context: ChunkContext = { run: r, production: v.production, settings: v.provider.settings, projectId, projectTitle: v.project.title };
  return (
    <div className="space-y-4">
      {r.staleNote && <p className="rounded-md bg-red-50 p-3 text-sm text-red-900">{r.staleNote}. Stale audio is never reused: start a new run for the current script.</p>}
      <Section title={`Voice run ${r.number} — ${VOICE_RUN_KIND_LABELS[r.kind]}${r.variant ? ` · ${r.variant}` : ''}`}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Stat label="Script" value={`v${r.scriptVersion}`} />
          <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[r.strategy]} />
          <Stat label="Chunks" value={`${r.chunkCount} · ${sizeLabel(r.settings.chunking)}`} />
          <Stat label="Characters sent" value={r.characters.toLocaleString()} />
          <Stat label="Cost" value={`${formatUsd(r.cost.totalUsd)}${r.cost.basis ? ` (${r.cost.basis.toLowerCase()})` : ''}`} />
          <Stat label="Generated audio" value={seconds(r.durationMs)} />
          <Stat label="Chunk length" value={r.stats.averageChunkMs ? `avg ${seconds(r.stats.averageChunkMs)} · ${seconds(r.stats.shortestChunkMs)}–${seconds(r.stats.longestChunkMs)}` : '—'} />
          <Stat label="Timestamps" value={`${r.stats.withAlignment} of ${r.chunkCount}`} />
          <Stat label="Regenerations" value={String(r.stats.regenerations)} />
          <Stat label="Failures" value={String(r.stats.failures)} />
          <Stat
            label="Voice"
            value={
              <span data-run-profile>
                {profileLabel(cfg.profile)} · {cfg.effective.model}
                {cfg.reconstructed && (
                  <span className={`${pill} ml-1 bg-stone-200 text-stone-700`} title="Made before saved profiles: read back from its profile version, strategy and settings">
                    reconstructed
                  </span>
                )}
              </span>
            }
          />
          <Stat label="Context" value={contextLabel(r.settings.context)} />
        </dl>
        <p className="mt-2 text-xs text-stone-500" data-run-cost>
          {costText(r.characters, r.cost.reported)}
          {r.cost.reestimated ? ' · re-estimated from the characters sent (before 2026-10-06 the ledger priced the provider’s own figure)' : ''}
        </p>
        <p className="mt-1 text-xs text-stone-500">
          {r.label} · created {formatDate(r.createdAt)}
        </p>
        <details className="mt-2" data-run-configuration>
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Configuration{cfg.reconstructed ? ' (reconstructed)' : ''}</summary>
          <div className="mt-2 space-y-2">
            <p className="text-xs text-stone-600">
              {cfg.selection ? `${profileLabel(cfg.profile)}, ${SELECTION_MODE_LABELS[cfg.selection.mode]} (project choice revision ${cfg.selection.revision})` : `Reconstructed: made before saved profiles, read back from ${profileLabel(cfg.profile)} and the run's own strategy and settings`}
              . Project overrides: {describeOverrides(cfg.projectOverrides)}; this run's own: {describeOverrides(cfg.runOptions)}.
            </p>
            <ConfigTable config={cfg.effective} provenance={cfg.provenance} settings={v.provider.settings} ignored={cfg.ignored} />
          </div>
        </details>
        <div className="mt-2">
          <SaveAsProfile runId={r.id} projectId={projectId} production={v.production} defaultName={profileNameFor(v.project.title)} />
        </div>
      </Section>
      {r.experiment && <ExperimentComparison view={v} run={r} projectRef={projectRef} running={running} onOpen={onOpen} />}
      {r.assembly && (
        <Section title={`Assembled narration v${r.assembly.version} — ${clock(r.assembly.totalDurationMs)}`}>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-stone-500">
            <AssemblyStatus status={r.assembly.status} />
            <span>assembled {formatDate(r.assembly.createdAt)}</span>
          </div>
          <Player src={r.assembly.audioUrl} label={`Voice run ${r.number}, assembled`} />
          <p className="mt-1 text-xs text-stone-500">
            {r.assembly.entries.length} takes in order on their measured durations, with the scripted pauses between them{r.assembly.complete ? ' · the whole script' : ''}. A new version is assembled whenever a current take changes; nothing is approved by assembling.
          </p>
          {earlier.length > 0 && (
            <button onClick={() => setVersions((x) => !x)} aria-expanded={versions} className={`${link} mt-1`}>
              {versions ? 'Hide earlier versions' : `Earlier versions (${earlier.length})`}
            </button>
          )}
          {versions && (
            <ul className="mt-1 space-y-2">
              {earlier.map((a) => (
                <li key={a.id} className="rounded-md border border-stone-200 p-2 text-xs text-stone-600">
                  <p className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-stone-800">v{a.version}</span>
                    <span>{clock(a.totalDurationMs)}</span>
                    <AssemblyStatus status={a.status} />
                    <span>{formatDate(a.createdAt)}</span>
                  </p>
                  <Player src={a.audioUrl} label={`Voice run ${r.number}, assembly v${a.version}`} />
                </li>
              ))}
            </ul>
          )}
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
      {canGenerate && <RegeneratePanel context={context} selected={selected} mock={v.provider.mock} onDone={() => setSelected([])} />}
      <div className="space-y-3">
        {r.chunks.map((c) => (
          <ChunkCard
            key={c.id}
            chunk={c}
            context={context}
            canGenerate={canGenerate}
            {...(canGenerate ? { selected: selected.includes(c.id), onSelect: (on: boolean) => setSelected((s) => (on ? [...s, c.id] : s.filter((x) => x !== c.id))) } : {})}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="break-words text-stone-900">{value}</dd>
    </div>
  );
}

/**
 * Every run of the selected run's comparison side by side: what each variant
 * changed, what it measured, and its assembled audio to hear whole; each
 * variant's configuration can be saved as a voice profile.
 */
function ExperimentComparison({ view: v, run: r, projectRef, running, onOpen }: { view: VoiceView; run: VoiceRunView; projectRef: string; running: boolean; onOpen: (run: number) => void }) {
  const group = experimentRuns(v.runs, r.number);
  const views = useQueries({ queries: group.map((g) => ({ queryKey: ['voice', projectRef, g.number], queryFn: () => api.voice(projectRef, g.number), refetchInterval: running ? 4_000 : (false as const) })) });
  const questions = new Map(r.experiment === VOICE_ACCEPTANCE_EXPERIMENT.name ? VOICE_ACCEPTANCE_EXPERIMENT.variants.map((x) => [x.label, x.question]) : []);
  if (group.length < 2) return null;
  return (
    <Section title={`Comparison “${r.experiment}” — ${group.length} variants`}>
      <p className="mb-2 text-xs text-stone-500">The same passage narrated {group.length} ways in one job. Hear each variant whole, then open one to review its chunks. Lengths are measured from the audio. A variant you prefer can be saved as a voice profile, then used for this project.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {group.map((g, i) => {
          const full = views[i]?.data?.run ?? (g.number === r.number ? r : null);
          const meanMs = g.durationMs !== null && g.chunkCount ? g.durationMs / g.chunkCount : null;
          return (
            <div key={g.id} className={`min-w-0 rounded-md border p-2 text-xs ${g.number === r.number ? 'border-stone-900' : 'border-stone-200'}`} data-variant={g.variant ?? ''} aria-current={g.number === r.number ? 'true' : undefined}>
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-stone-900">{g.variant}</span>
                <span className="text-stone-500">run {g.number}</span>
                {g.number === r.number && <span className={`${pill} bg-stone-900 text-white`}>shown</span>}
              </p>
              {questions.get(g.variant ?? '') && <p className="text-stone-500">{questions.get(g.variant ?? '')}</p>}
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[g.strategy]} />
                <Stat label="Profile" value={full ? `${profileLabel(full.configuration.profile)}${full.configuration.reconstructed ? ' (reconstructed)' : ''}` : '…'} />
                <Stat label="Chunk size" value={full ? sizeLabel(full.settings.chunking) : '…'} />
                <Stat label="Context" value={full ? contextLabel(full.settings.context) : '…'} />
                <Stat label="Chunks" value={String(g.chunkCount)} />
                <Stat label="Measured length" value={g.durationMs !== null ? clock(g.durationMs) : 'not all generated'} />
                <Stat label="Mean chunk" value={meanMs !== null ? seconds(meanMs) : '—'} />
                <Stat label="Characters sent" value={g.characters.toLocaleString()} />
                <Stat label="Cost" value={`${formatUsd(g.cost.totalUsd)}${g.cost.basis ? ` (${g.cost.basis.toLowerCase()})` : ''}`} />
              </dl>
              <p className="mt-1 break-words text-stone-500" data-variant-cost>
                {costText(g.characters, g.cost.reported)}
                {g.cost.reestimated ? ' · re-estimated from the characters sent' : ''}
              </p>
              <div className="mt-1">{full?.assembly ? <Player src={full.assembly.audioUrl} label={`${g.variant ?? `Run ${g.number}`}, assembled`} /> : <p className="text-stone-500">{full ? 'Not assembled yet.' : 'Loading…'}</p>}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3">
                {g.number !== r.number && (
                  <button onClick={() => onOpen(g.number)} className={link}>
                    Open run {g.number} to review its chunks
                  </button>
                )}
              </div>
              <SaveAsProfile runId={g.id} projectId={v.project.id} production={v.production} defaultName={profileNameFor(v.project.title)} />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const PANEL_FIELDS: OverrideField[] = ['context', 'numberStyle', 'rules', 'settings'];

/**
 * New takes for several chunks in one job — the chosen ones, a section or
 * every chunk — or an A/B of the chosen ones kept beside their current
 * takes, made with the run's configuration, the production profile now, or
 * a temporary override. Always confirmed against what it would send and
 * cost.
 */
function RegeneratePanel({ context, selected, mock, onDone }: { context: ChunkContext; selected: string[]; mock: boolean; onDone: () => void }) {
  const r = context.run;
  const sections = [...new Set(r.chunks.map((c) => c.sectionKey))];
  const [what, setWhat] = useState<'selected' | 'section' | 'all'>('selected');
  const [section, setSection] = useState(sections[0] ?? '');
  const [ab, setAb] = useState(false);
  const [strategy, setStrategy] = useState<PerformanceStrategy | ''>('');
  const [a, setA] = useState<PerformanceStrategy>('RESTRAINED');
  const [b, setB] = useState<PerformanceStrategy>('EXPRESSIVE');
  const [choice, setChoice] = useState<TakeChoice>(RUN_CHOICE);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const chunks = what === 'selected' ? r.chunks.filter((c) => selected.includes(c.id)) : what === 'section' ? r.chunks.filter((c) => c.sectionKey === section) : r.chunks;
  const variants = what === 'selected' && ab ? [a, b] : null;
  const estimate = takesEstimate(chunks, variants?.length ?? 1, r, mock);
  const made = choiceRequest(choice, context.production);
  const problem = choiceProblem(choice, context);
  // The tick belongs to exactly this request and the estimate it was given: any change asks again.
  const key = JSON.stringify({ what, chunks: chunks.map((c) => c.id), variants, strategy, made, estimate });
  const send = useVoiceRequest(
    () =>
      api.regenerateVoice(r.id, {
        ...(what === 'selected' ? { chunkIds: chunks.map((c) => c.id) } : what === 'section' ? { section: Number(section.replace(/\D/g, '')) } : { all: true }),
        ...(variants ? { variants: variants.map((s, i) => ({ label: `${'AB'[i]} ${s.toLowerCase()}`, strategy: s })) } : strategy ? { strategy } : {}),
        ...made,
        ...(note.trim() ? { note: note.trim() } : {}),
        confirm: true,
      }),
    () => {
      setConfirmed(null);
      setNote('');
      setChoice(RUN_CHOICE);
      onDone();
    },
  );
  const pick = (letter: string, value: PerformanceStrategy, set: (s: PerformanceStrategy) => void) => (
    <label className="min-w-0 flex-1">
      <span className="block text-xs text-stone-500">Take {letter}</span>
      <select value={value} onChange={(e) => set(e.target.value as PerformanceStrategy)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
        {PERFORMANCE_STRATEGIES.map((x) => (
          <option key={x} value={x}>
            {PERFORMANCE_STRATEGY_LABELS[x]}
          </option>
        ))}
      </select>
    </label>
  );
  const label = what === 'selected' ? (variants ? `Generate the A/B takes (${chunks.length} chunk${chunks.length === 1 ? '' : 's'})` : `Regenerate selected (${chunks.length})`) : what === 'section' ? `Regenerate section ${section}` : `Regenerate every chunk (${chunks.length})`;
  return (
    <Section title="Regenerate several chunks">
      <p className="mb-2 text-xs text-stone-500">One job, new takes only for these chunks; earlier takes are kept and the others are untouched. A/B takes stay beside the current take until you pick one with “Use this take”.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-xs text-stone-500">Which chunks</span>
          <select value={what} onChange={(e) => setWhat(e.target.value as typeof what)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
            <option value="selected">The chunks selected below ({selected.length})</option>
            <option value="section">One section</option>
            <option value="all">Every chunk of this run ({r.chunks.length})</option>
          </select>
        </label>
        {what === 'section' && (
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Section</span>
            <select value={section} onChange={(e) => setSection(e.target.value)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              {sections.map((s) => (
                <option key={s} value={s}>
                  {s} ({r.chunks.filter((c) => c.sectionKey === s).length} chunks)
                </option>
              ))}
            </select>
          </label>
        )}
        {what === 'selected' && (
          <label className="flex min-h-6 items-center gap-2 text-sm sm:self-end">
            <input type="checkbox" checked={ab} onChange={(e) => setAb(e.target.checked)} /> As an A/B comparison
          </label>
        )}
        {variants ? (
          <div className="flex gap-2 text-sm sm:col-span-2">
            {pick('A', a, setA)}
            {pick('B', b, setB)}
          </div>
        ) : (
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Performance of the new takes</span>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as PerformanceStrategy | '')} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value="">{choice.base === 'PRODUCTION' && context.production.effective ? `As the production profile (${PERFORMANCE_STRATEGY_LABELS[context.production.effective.strategy]})` : `As this run (${PERFORMANCE_STRATEGY_LABELS[r.strategy]})`}</option>
              {PERFORMANCE_STRATEGIES.map((x) => (
                <option key={x} value={x}>
                  {PERFORMANCE_STRATEGY_LABELS[x]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="sm:col-span-2">
          <TakeChoiceFields context={context} value={choice} onChange={setChoice} fields={PANEL_FIELDS} name="made-with-several" />
        </div>
        <label className="text-sm sm:col-span-2">
          <span className="block text-xs text-stone-500">Note (kept with each new take)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1" />
        </label>
      </div>
      {chunks.length ? (
        <div className="mt-3 space-y-2">
          {problem && choice.base !== 'PRODUCTION' && <p className="text-xs text-red-700">{problem}</p>}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirmed === key} onChange={(e) => setConfirmed(e.target.checked ? key : null)} />
            <span>
              I confirm {estimate.takes} new take{estimate.takes === 1 ? '' : 's'} of {chunks.length} chunk{chunks.length === 1 ? '' : 's'}: about {estimate.characters.toLocaleString()} characters, {costWords(estimate)} (from what these chunks sent last time).
            </span>
          </label>
          <button disabled={send.isPending || confirmed !== key || !!problem} onClick={() => send.mutate(undefined)} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
            {label}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-stone-500">Select chunks with their “Select” box below.</p>
      )}
      {send.error && <p className="mt-2 text-sm text-red-700">{send.error.message}</p>}
    </Section>
  );
}

// ── Planning and generating ─────────────────────────────────────────────────

interface VariantRequest {
  label: string;
  options: VoiceRunOptions;
  question?: string;
  /** Another saved profile version this variant narrates with (a comparison of saved profiles); heard as saved. */
  profileId?: string;
}
interface VariantPlan extends VariantRequest {
  plan: VoicePlanView;
}

/**
 * Plans and a confirmation that belong to one exact request: when the
 * request changes they are dropped before the next render, so a plan or a
 * tick made for other inputs can never queue them. What was planned is what
 * is generated: each variant is generated on the profile version it was
 * planned with (a version made since, in another tab, cannot change it), and
 * at the project's selection revision of the first plan (a change of the
 * production profile or its overrides since refuses it: plan again).
 */
function usePlans(projectId: string, key: string, scope: VoiceScope, variants: readonly VariantRequest[], profileId?: string) {
  const [state, setState] = useState<{ key: string; plans: VariantPlan[] | null; confirmed: boolean }>({ key, plans: null, confirmed: false });
  if (state.key !== key) setState({ key, plans: null, confirmed: false });
  const current = state.key === key ? state : { key, plans: null, confirmed: false };
  const plan = useVoiceRequest(async () => {
    const plans: VariantPlan[] = [];
    // One after another: each plan brings the pronunciation list up to date; the first fixes the production version and the revision.
    let pinned = profileId;
    let revision: number | undefined;
    for (const v of variants) {
      const named = v.profileId ?? pinned;
      const made = await api.voiceRunPlan(projectId, { scope, options: v.options, ...(named ? { profileId: named } : {}), ...(revision !== undefined ? { selectionRevision: revision } : {}) });
      revision ??= made.configuration.selectionRevision;
      if (!v.profileId) pinned ??= made.profile.id;
      plans.push({ ...v, plan: made });
    }
    setState((s) => (s.key === key ? { ...s, plans } : s));
  });
  const setConfirmed = (confirmed: boolean) => setState((s) => (s.key === key ? { ...s, confirmed } : s));
  const plans = current.plans;
  return { plans, revision: plans?.[0]?.plan.configuration.selectionRevision, confirmed: current.confirmed, setConfirmed, plan };
}

/** A comparison's request: every variant on the version it was planned with, at the plans' revision. */
const experimentRequest = (plans: readonly VariantPlan[]) => ({
  selectionRevision: plans[0]!.plan.configuration.selectionRevision,
  variants: plans.map((x) => ({ label: x.label, ...x.options, profileId: x.plan.profile.id })),
});

type Compare = 'none' | 'direction' | 'context' | 'size' | 'profiles';

/** A profile a comparison of saved profiles can hear: '' is the production profile (with the project's overrides). */
interface ProfileChoice {
  id: string;
  name: string;
  label: string;
}

/** The variants of a comparison: the options chosen above, with the compared setting (or profile) spelled out per variant. */
function comparison(compare: Compare, options: VoiceRunOptions, overDirected: boolean, profiles: readonly ProfileChoice[]): { name: string; variants: VariantRequest[] } | null {
  if (compare === 'direction') {
    const arms: [string, PerformanceStrategy][] = [
      ['A plain', 'PLAIN'],
      ['B restrained', 'RESTRAINED'],
      ['C expressive', 'EXPRESSIVE'],
      ...(overDirected ? ([['D over-directed', 'DIRECTED']] as [string, PerformanceStrategy][]) : []),
    ];
    return { name: 'Performance direction', variants: arms.map(([label, strategy]) => ({ label, options: { ...options, strategy } })) };
  }
  if (compare === 'context') return { name: 'Continuity', variants: [{ label: 'A no context', options: { ...options, context: NO_CONTEXT } }, { label: 'B neighbouring text', options: { ...options, context: CONTEXTS[0]!.context } }] };
  if (compare === 'size') return { name: 'Chunk size', variants: CHUNK_SIZES.map((s, i) => ({ label: `${'ABC'[i]} ${s.label}`, options: { ...options, chunking: s.chunking } })) };
  if (compare === 'profiles') return { name: 'Saved profiles', variants: profiles.map((p, i) => ({ label: `${'ABCD'[i]} ${p.name}`.slice(0, 40), options, ...(p.id ? { profileId: p.id } : {}) })) };
  return null;
}

/** The house default as a configuration, before any profile exists (the first plan makes the house profile). */
function houseDefault(v: VoiceView): EffectiveVoiceConfig {
  return {
    ...DEFAULT_VOICE_PROFILE_CONFIG,
    providerSettings: Object.fromEntries(v.provider.settings.map((d) => [d.key, d.default])),
    provider: v.provider.name,
    voiceId: v.provider.defaultVoiceId ?? '',
    model: v.provider.defaultModel,
    language: v.production.language,
    outputFormat: '—',
  };
}

const RUN_FIELDS: OverrideField[] = ['numberStyle', 'settings'];

function GenerateTab({ view: v, projectId, onQueued }: { view: VoiceView; projectId: string; onQueued: (run: number) => void }) {
  const production = v.production;
  // Another saved profile, heard as saved at its current version (an audition); '' is the production profile. Any version of
  // production's own family takes this project's overrides, so a newer one (production pinned) is not "another": it is chosen on the Production profile tab.
  const others = v.library.filter((f): f is typeof f & { current: VoiceProfileView } => !!f.current && f.id !== production.family?.id && f.current.id !== production.profile?.id);
  const [familyId, setFamilyId] = useState('');
  const chosen = others.find((f) => f.id === familyId) ?? null;
  const config = chosen ? versionEffective(chosen.current) : (production.effective ?? houseDefault(v));
  const named = productionName(production) ?? 'the house profile, made at the first plan';
  const defaultWord = chosen ? `${chosen.name} v${chosen.current.version}` : 'Production profile';
  const [kind, setKind] = useState<VoiceScope['kind']>('AUDITION');
  const [secondsWanted, setSeconds] = useState(100);
  const [section, setSection] = useState(1);
  const [blocks, setBlocks] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // '' and -1: the profile's own setting (nothing is sent over it).
  const [strategy, setStrategy] = useState<PerformanceStrategy | ''>('');
  const [size, setSize] = useState(-1);
  const [context, setContext] = useState(-1);
  const [runSettings, setRunSettings] = useState<EditedOverrides>({});
  const [compare, setCompare] = useState<Compare>('none');
  const [overDirected, setOverDirected] = useState(false);
  const candidates: ProfileChoice[] = [{ id: '', name: production.family?.name ?? 'Production', label: `Production profile (${named})` }, ...others.map((f) => ({ id: f.current.id, name: f.name, label: `${f.name} v${f.current.version}` }))];
  const [picked, setPicked] = useState<string[]>([]);
  const profiles = candidates.filter((c) => picked.includes(c.id));
  const scope: VoiceScope =
    kind === 'AUDITION' ? { kind, seconds: secondsWanted } : kind === 'SECTION' ? { kind, section } : kind === 'BLOCKS' ? { kind, blockKeys: blocks.split(/[\s,]+/).filter(Boolean) } : kind === 'RANGE' ? { kind, from, to } : { kind: 'FULL' };
  const options: VoiceRunOptions = pruneOverrides({ ...runSettings, ...(strategy ? { strategy } : {}), ...(size >= 0 ? { chunking: CHUNK_SIZES[size]!.chunking } : {}), ...(context >= 0 ? { context: CONTEXTS[context]!.context } : {}) });
  const problems = overrideProblems(runSettings, v.provider.settings, 'RUN');
  const compared = comparison(compare, options, overDirected, profiles);
  const variants = compared?.variants ?? [{ label: 'run', options }];
  const requested = compare === 'profiles' ? undefined : chosen?.current.id;
  const p = usePlans(projectId, JSON.stringify({ scope, variants, requested }), scope, variants, requested);
  const create = useVoiceRequest(async () => {
    const plans = p.plans!;
    const run = compared
      ? (await api.createVoiceExperiment(projectId, { scope, name: compared.name, ...experimentRequest(plans), confirm: p.confirmed })).runs[0]!
      : (await api.createVoiceRun(projectId, { scope, profileId: plans[0]!.plan.profile.id, selectionRevision: plans[0]!.plan.configuration.selectionRevision, options, confirm: p.confirmed })).run;
    onQueued(run);
  });
  if (!v.editorial.generate.allowed) return <p className="text-sm text-stone-600">{v.editorial.generate.reason}</p>;
  const effective = strategy || config.strategy;
  const ready = !problems.length && (compare !== 'profiles' || (picked.length >= 2 && picked.length <= 4));
  return (
    <div className="space-y-4">
      <Section title="Voice profile">
        <label className="block text-sm">
          <span className="block text-xs text-stone-500">Narrate with</span>
          <select value={chosen ? familyId : ''} onChange={(e) => setFamilyId(e.target.value)} aria-label="Profile" className="mt-1 w-full max-w-full rounded-md border border-stone-300 px-2 py-1 sm:w-auto">
            <option value="">
              Production profile ({named} — {production.mode === 'FOLLOW' ? 'follows' : production.mode === 'PIN' ? 'pinned' : 'library default'})
            </option>
            {others.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} v{f.current.version}
                {f.isDefault ? ' (library default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-stone-500" data-heard-as>
          {chosen ? "Heard as saved: this project's overrides apply to its production profile only." : `With this project's overrides: ${describeOverrides(production.overrides)}.`} The acceptance experiment below and the runs planned here narrate with it.
          {!chosen && production.newer && production.family ? ` ${production.family.name} v${production.newer.version} is its current version: follow it on the Production profile tab to narrate with it.` : ''}
        </p>
      </Section>
      <AcceptanceExperiment view={v} projectId={projectId} onQueued={onQueued} profileId={chosen?.current.id} profileName={chosen ? `${chosen.name} v${chosen.current.version}` : named} model={config.model} />
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
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as PerformanceStrategy | '')} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value="">
                {defaultWord} ({PERFORMANCE_STRATEGY_LABELS[config.strategy]})
              </option>
              {PERFORMANCE_STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {PERFORMANCE_STRATEGY_LABELS[s]}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-stone-500">{PERFORMANCE_STRATEGY_HELP[effective]}</span>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Chunk size (natural boundaries come first)</span>
            <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value={-1}>
                {defaultWord} ({sizeLabel(config.chunking)})
              </option>
              {CHUNK_SIZES.map((s, i) => (
                <option key={s.label} value={i}>
                  {s.label} ({s.chunking.minWords}–{s.chunking.maxWords} words)
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Continuity between chunks</span>
            <select value={context} onChange={(e) => setContext(Number(e.target.value))} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value={-1}>
                {defaultWord} ({contextLabel(config.context)})
              </option>
              {CONTEXTS.map((c, i) => (
                <option key={c.label} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-stone-500">Generate as</span>
            <select value={compare} onChange={(e) => setCompare(e.target.value as Compare)} className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
              <option value="none">One run</option>
              <option value="direction">A comparison of direction: plain / restrained / expressive</option>
              <option value="context">A comparison of continuity: no context / neighbouring text</option>
              <option value="size">A comparison of chunk size: {CHUNK_SIZES.map((s) => s.label.replace(/ s$/, '')).join(' / ')} s</option>
              <option value="profiles">A comparison of saved profiles (2–4)</option>
            </select>
          </label>
          {compare === 'direction' && (
            <label className="flex min-h-6 items-center gap-2 text-sm sm:self-end">
              <input type="checkbox" checked={overDirected} onChange={(e) => setOverDirected(e.target.checked)} /> Add the over-directed reference (D)
            </label>
          )}
          {compare === 'profiles' && (
            <fieldset className="min-w-0 text-sm sm:col-span-2" data-compare-profiles>
              <legend className="text-xs text-stone-500">Profiles to compare (2–4): each is heard as saved, the production profile with this project's overrides</legend>
              {candidates.map((c) => (
                <label key={c.id || 'production'} className="flex min-h-6 items-center gap-2">
                  <input type="checkbox" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && picked.length >= 4} onChange={(e) => setPicked((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))} /> <span className="min-w-0 break-words">{c.label}</span>
                </label>
              ))}
              {candidates.length < 2 && (
                <p className="text-xs text-stone-500">
                  Only one profile can be chosen: make another in the <Link to="/voice-profiles" className="underline">voice profile library</Link>.
                </p>
              )}
            </fieldset>
          )}
        </div>
        <details className="mt-3">
          <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Voice settings for this run{isEmptyOverrides(runSettings) ? '' : ` (${describeOverrides(pruneOverrides(runSettings))})`}</summary>
          <div className="mt-2">
            <OverridesEditor base={config} value={runSettings} onChange={setRunSettings} settings={v.provider.settings} scope="RUN" fields={RUN_FIELDS} />
          </div>
        </details>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={p.plan.isPending || !ready} onClick={() => p.plan.mutate(undefined)} className={secondary}>
            Plan (nothing is generated)
          </button>
        </div>
        {p.plan.error && <p className="mt-2 text-sm text-red-700">{p.plan.error.message}</p>}
      </Section>

      {p.plans && !compared && <PlanView plan={p.plans[0]!.plan} settings={v.provider.settings} />}
      {p.plans && compared && (
        <Section title={`Plan — ${compared.name}, ${p.plans.length} variants`}>
          <VariantPlans plans={p.plans} />
        </Section>
      )}
      {p.plans && (
        <Section title="Generate">
          <GenerateBox plans={p.plans} multi={!!compared} confirmed={p.confirmed} setConfirmed={p.setConfirmed} create={create} label={compared ? `Generate the comparison (${p.plans.length} runs)` : kind === 'AUDITION' ? 'Generate the audition' : 'Generate'} />
        </Section>
      )}
    </div>
  );
}

/**
 * The acceptance experiment in one job: the opening narrated seven ways,
 * each its own run and assembly, with the profile chosen above (so a new
 * voice can be auditioned the same way, and the winner saved from its
 * variant). Planned first; one confirmation for the total it would send and
 * cost.
 */
function AcceptanceExperiment({ view: v, projectId, onQueued, profileId, profileName, model }: { view: VoiceView; projectId: string; onQueued: (run: number) => void; profileId: string | undefined; profileName: string; model: string }) {
  const preset = VOICE_ACCEPTANCE_EXPERIMENT;
  const variants: VariantRequest[] = preset.variants.map(({ label, question, ...options }) => ({ label, question, options }));
  const p = usePlans(projectId, JSON.stringify({ preset: preset.name, script: v.script?.id ?? null, profileId }), preset.scope, variants, profileId);
  const create = useVoiceRequest(async () => {
    const r = await api.createVoiceExperiment(projectId, { scope: preset.scope, name: preset.name, ...experimentRequest(p.plans!), confirm: p.confirmed });
    onQueued(r.runs[0]!);
  });
  const opening = preset.scope.kind === 'AUDITION' ? preset.scope.seconds : null;
  return (
    <Section title={`${preset.name} — ${profileName} · ${model}`}>
      <p className="text-sm text-stone-600">
        The opening{opening ? ` (about ${opening} s)` : ''} narrated {variants.length} ways in one job with {profileName}, each its own run with its own assembled audio to hear whole: direction (A–D), neighbouring context (E against B) and chunk size (F and G against B). B is the house default. The variant you prefer can be saved as a voice profile from its card.
      </p>
      <ul className="mt-2 grid gap-1 text-xs text-stone-600 sm:grid-cols-2">
        {variants.map((x) => (
          <li key={x.label}>
            <span className="font-semibold text-stone-800">{x.label}</span> — {x.question}
          </li>
        ))}
      </ul>
      <button disabled={p.plan.isPending} onClick={() => p.plan.mutate(undefined)} className={`${secondary} mt-3`}>
        {p.plan.isPending ? 'Planning…' : 'Plan the acceptance experiment (nothing is generated)'}
      </button>
      {p.plan.error && <p className="mt-2 text-sm text-red-700">{p.plan.error.message}</p>}
      {p.plans && (
        <div className="mt-3 space-y-3">
          <VariantPlans plans={p.plans} />
          <GenerateBox plans={p.plans} multi confirmed={p.confirmed} setConfirmed={p.setConfirmed} create={create} label={`Generate the acceptance experiment (${p.plans.length} runs, one job)`} />
        </div>
      )}
    </Section>
  );
}

/** What generating the plans would send and cost, and the confirmation: always for a comparison, above the threshold for one run. */
function GenerateBox({ plans, multi, confirmed, setConfirmed, create, label }: { plans: VariantPlan[]; multi: boolean; confirmed: boolean; setConfirmed: (on: boolean) => void; create: { isPending: boolean; error: Error | null; mutate: (arg: undefined) => void }; label: string }) {
  const blocked = [...new Set(plans.map((x) => x.plan.blocked).filter((x): x is string => !!x))];
  const total = plansEstimate(plans.map((x) => x.plan));
  const first = plans[0]!.plan;
  const needs = multi || first.estimate.needsConfirmation;
  const profiles = [...new Set(plans.map((x) => `${x.plan.profile.name} v${x.plan.profile.version}`))];
  if (blocked.length) return <p className="text-sm text-red-800">{blocked.join('; ')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-600">
        {multi ? `${plans.length} runs in one job` : 'One run'} of {first.description.toLowerCase()} with {profiles.length === 1 ? `${profiles[0]} (${first.profile.provider} ${first.profile.modelId})` : `${profiles.length} saved profiles`}: {total.takes} takes, about {total.characters.toLocaleString()} characters, {costWords(total)}.
      </p>
      {needs && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            I confirm {multi ? `all ${plans.length} runs (each variant is generated in full)` : 'this generation'}: {total.characters.toLocaleString()} characters, {costWords(total)}.
          </span>
        </label>
      )}
      <button disabled={create.isPending || (needs && !confirmed)} onClick={() => create.mutate(undefined)} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
        {label}
      </button>
      {create.error && <p className="text-sm text-red-700">{create.error.message}</p>}
    </div>
  );
}

const lengthRange = (chunks: readonly VoicePlanChunkView[]) => {
  const secs = chunks.map((c) => c.estimatedSec);
  const outside = secs.filter(outsideNatural).length;
  return secs.length ? `≈${Math.min(...secs).toFixed(0)}–${Math.max(...secs).toFixed(0)} s each${outside ? `, ${outside} outside ${CHUNK_SECONDS.natural.min}–${CHUNK_SECONDS.natural.max} s` : ''}` : '—';
};

function VariantPlans({ plans }: { plans: VariantPlan[] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {plans.map(({ label, question, plan }) => (
        <div key={label} className="min-w-0 rounded-md border border-stone-200 p-2 text-xs" data-variant={label}>
          <p className="font-semibold text-stone-900">{label}</p>
          {question && <p className="text-stone-500">{question}</p>}
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
            <Stat label="Voice" value={`${plan.profile.name} v${plan.profile.version}${plan.configuration.mode === 'EXPLICIT' ? ' (as saved)' : ''}`} />
            <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[plan.strategy]} />
            <Stat label="Chunk size" value={sizeLabel(plan.chunking)} />
            <Stat label="Context" value={contextLabel(plan.context)} />
            <Stat label="Chunks" value={`${plan.estimate.chunks} · ${lengthRange(plan.chunks)}`} />
            <Stat label="Planned length" value={`~${clock(plan.estimate.plannedSec * 1000)}`} />
            <Stat label="Characters" value={plan.estimate.characters.toLocaleString()} />
            <Stat label="Cost" value={plan.estimate.estimatedCostUsd !== null ? `${formatUsd(plan.estimate.estimatedCostUsd)} (${plan.estimate.costBasis.toLowerCase()})` : 'unpriced'} />
          </dl>
          {plan.blocked && <p className="mt-1 text-red-800">{plan.blocked}</p>}
          <details className="mt-1">
            <summary className="inline-flex min-h-6 cursor-pointer items-center text-stone-600 underline">The {plan.chunks.length} chunks</summary>
            <PlanChunks chunks={plan.chunks} />
          </details>
        </div>
      ))}
    </div>
  );
}

function PlanChunks({ chunks }: { chunks: VoicePlanChunkView[] }) {
  return (
    <ol className="mt-2 space-y-2">
      {chunks.map((ch) => (
        <li key={ch.index} className="rounded-md border border-stone-200 p-2 text-xs" data-plan-chunk={ch.index + 1}>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-stone-500">
            <span>
              #{ch.index + 1} · {ch.sectionKey} · blocks {ch.blockKeys.join(', ')}
            </span>
            <span>{ch.words} words</span>
            <Length sec={ch.estimatedSec} prefix="≈" />
            <span>{ch.characters} chars</span>
            <span>ends at {CHUNK_BOUNDARY_LABELS[ch.boundary]}</span>
            {!ch.checksPassed && <span className="text-red-700">✗ checks</span>}
          </p>
          <NumberedText text={ch.text} className="mt-1 text-stone-900" />
          {ch.performanceText !== ch.text && <p className="mt-1 font-mono break-words whitespace-pre-wrap text-stone-600">Sent: {ch.performanceText}</p>}
        </li>
      ))}
    </ol>
  );
}

function PlanView({ plan, settings }: { plan: VoicePlanView; settings: readonly VoiceSettingDescriptor[] }) {
  const c = plan.coverage;
  const covered: [boolean, string][] = [
    [c.dramaticOpening, 'the opening'],
    [c.explanatory, 'an explanatory passage'],
    [c.rhetoricalQuestion, 'a rhetorical question'],
    [c.number, 'a number or date'],
    [c.nameOrPlace, 'a name or place'],
    [c.performanceMoment, 'a performance moment'],
  ];
  const cfg = plan.configuration;
  return (
    <Section title={`Plan — ${plan.description}`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <Stat label="Chunks" value={String(plan.estimate.chunks)} />
        <Stat label="Chunk length (planned)" value={lengthRange(plan.chunks)} />
        <Stat label="Chunk size" value={sizeLabel(plan.chunking)} />
        <Stat label="Context" value={contextLabel(plan.context)} />
        <Stat label="Words" value={plan.estimate.words.toLocaleString()} />
        <Stat label="Characters sent" value={plan.estimate.characters.toLocaleString()} />
        <Stat label="Estimated cost" value={plan.estimate.estimatedCostUsd !== null ? `${formatUsd(plan.estimate.estimatedCostUsd)} (${plan.estimate.costBasis.toLowerCase()})` : 'unpriced'} />
        <Stat label="Planned length" value={`~${clock(plan.estimate.plannedSec * 1000)} (estimate)`} />
        <Stat label="Voice" value={`${plan.profile.name} v${plan.profile.version} · ${plan.profile.modelId} · ${SELECTION_MODE_LABELS[cfg.mode]}`} />
        <Stat label="Performance" value={PERFORMANCE_STRATEGY_LABELS[plan.strategy]} />
        <Stat label="Pronunciations to check" value={plan.unresolvedPronunciations.length ? plan.unresolvedPronunciations.join(', ') : 'none'} />
      </dl>
      <p className="mt-2 text-xs text-stone-500">{plan.estimate.costNote}</p>
      <p className="mt-2 text-xs text-stone-600">
        Covers: {covered.map(([ok, label]) => `${ok ? '✓' : '✗'} ${label}`).join(' · ')}
      </p>
      <details className="mt-2" data-plan-configuration>
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-xs text-stone-600 underline">Configuration</summary>
        <p className="mt-2 text-xs text-stone-600">
          Project overrides: {describeOverrides(cfg.projectOverrides)}; this run's own: {describeOverrides(cfg.runOptions)}. Generated at the project's choice revision {cfg.selectionRevision}; a change of the production profile or its overrides before then asks to plan again.
        </p>
        <div className="mt-2">
          <ConfigTable config={cfg.effective} provenance={cfg.provenance} settings={settings} ignored={cfg.ignored} />
        </div>
      </details>
      <p className="mt-2 text-xs text-stone-500">Seconds are planned from spoken words at the narration rate and the chunk's pace; the audio's own length replaces them. Sentence numbers are what “Regenerate with…” directions address.</p>
      <PlanChunks chunks={plan.chunks} />
    </Section>
  );
}

function PronunciationTab({ items }: { items: VoicePronunciationView[] }) {
  if (!items.length) return <p className="text-sm text-stone-500">No term in the narration planned so far needs a pronunciation decision (the list fills in as runs are planned).</p>;
  const withdrawn = items.filter((x) => x.withdrawn);
  return (
    <div className="space-y-2">
      <p className="text-xs text-stone-500">
        Names, places, foreign words and abbreviations in the narration. Nothing is assumed right: approve the voice's own reading, give an alias (spoken instead of the written term), or phonemes for the voice's pronunciation dictionary. The script keeps its spelling. The whole narration is generated only once every term is decided.
      </p>
      {items
        .filter((x) => !x.withdrawn)
        .map((x) => (
          <PronunciationRow key={x.id} item={x} />
        ))}
      {withdrawn.length > 0 && (
        <Section title={`No longer detected (${withdrawn.length})`}>
          <p className="text-xs text-stone-500">Terms the detector no longer finds in the approved script. Never decided, they no longer block the narration; nothing was deleted.</p>
          <ul className="mt-1 space-y-1 text-sm">
            {withdrawn.map((x) => (
              <li key={x.id} data-withdrawn={x.term}>
                <span className="font-medium text-stone-700">{x.term}</span> <span className="text-xs text-stone-500">— no longer detected: replaced by {x.withdrawn}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
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

// ── The production profile ───────────────────────────────────────────────────

const PROJECT_FIELDS: OverrideField[] = ['strategy', 'chunking', 'context', 'numberStyle', 'rules', 'settings'];

function ProductionTab({ view: v, projectId }: { view: VoiceView; projectId: string }) {
  const p = v.production;
  return (
    <div className="space-y-4">
      <ProductionCard view={v} />
      <ChooseProduction key={`${p.revision}:${p.profile?.id ?? ''}`} view={v} projectId={projectId} />
    </div>
  );
}

/** What a new run of the master language narrates with now: the version, how it is chosen, and the effective configuration with where each setting came from. */
function ProductionCard({ view: v }: { view: VoiceView }) {
  const p = v.production;
  return (
    <Section title={`Production profile — ${productionName(p) ?? 'none yet'}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-production-mode={p.mode}>
        <span className="text-stone-800">{productionMode(p)}</span>
        {p.family?.isDefault && p.mode !== 'DEFAULT' && <span className={`${pill} bg-emerald-100 text-emerald-800`}>library default</span>}
        {p.family?.archived && <span className={`${pill} bg-stone-200 text-stone-700`}>archived</span>}
        {p.family && (
          <Link to={`/voice-profiles/${p.family.id}`} className={link}>
            Edit this profile
          </Link>
        )}
        <Link to="/voice-profiles" className={link}>
          All voice profiles
        </Link>
      </div>
      {p.problem && <p className="mt-2 rounded-md bg-red-50 p-2 text-sm text-red-800">{p.problem}</p>}
      {p.notices.map((n) => (
        <p key={n} className="mt-2 text-sm text-amber-900">
          {n}
        </p>
      ))}
      <p className="mt-2 text-xs text-stone-500">
        What a new run of {p.language} narrates with: the saved profile's version, with this project's overrides over it ({describeOverrides(p.overrides)}). Runs already made keep what they were made with.
        {p.updatedAt ? ` Chosen ${formatDate(p.updatedAt)}${p.updatedBy ? ` by ${p.updatedBy}` : ''}.` : ''}
      </p>
      {p.effective && (
        <div className="mt-2">
          <ConfigTable config={p.effective} provenance={p.provenance} settings={v.provider.settings} ignored={p.ignored} />
        </div>
      )}
    </Section>
  );
}

/**
 * Choose the production profile — a saved profile following its current
 * version or pinned to one, or the library default — and the project's
 * overrides. Saved at the revision shown: a change made in another tab
 * since is refused, and the form stays as it was until Reload reads the
 * project's choice again. Editing the profile itself is the library's.
 */
function ChooseProduction({ view: v, projectId }: { view: VoiceView; projectId: string }) {
  const p = v.production;
  const queryClient = useQueryClient();
  const [familyId, setFamilyId] = useState(p.mode === 'DEFAULT' ? '' : (p.family?.id ?? ''));
  const [pin, setPin] = useState(p.mode === 'PIN');
  const [versionId, setVersionId] = useState(p.mode === 'PIN' ? (p.profile?.id ?? '') : '');
  const [overrides, setOverrides] = useState<EditedOverrides>(p.overrides);
  // The production family stays choosable when this list leaves it out: archived, or not usable now (the problem above says why).
  const families = [
    ...v.library.map((f) => ({ id: f.id, name: f.name, current: f.current })),
    ...(p.family && !v.library.some((f) => f.id === p.family!.id) ? [{ id: p.family.id, name: `${p.family.name}${p.family.archived ? ' (archived)' : p.problem ? ' (not usable now)' : ''}`, current: p.mode === 'FOLLOW' ? p.profile : null }] : []),
  ];
  const history = useQuery({ queryKey: ['voice-profile', familyId], queryFn: () => api.voiceProfile(familyId), enabled: !!familyId && pin });
  const family = families.find((f) => f.id === familyId) ?? null;
  const libraryDefault = v.library.find((f) => f.isDefault) ?? null;
  const version: VoiceProfileView | null = familyId
    ? pin
      ? (history.data?.history.find((x) => x.id === versionId) ?? (versionId === p.profile?.id ? p.profile : null))
      : (family?.current ?? null)
    : (libraryDefault?.current ?? (p.mode === 'DEFAULT' ? p.profile : null));
  const base = version ? versionEffective(version) : null;
  const next = { familyId: familyId || null, versionId: familyId && pin ? versionId || null : null };
  const unchanged = next.familyId === (p.mode === 'DEFAULT' ? null : (p.family?.id ?? null)) && next.versionId === (p.mode === 'PIN' ? (p.profile?.id ?? null) : null) && sameOverrides(overrides, p.overrides);
  const problems = overrideProblems(overrides, v.provider.settings, 'PROJECT');
  const reload = () => {
    for (const key of ['voice', 'voice-profiles', 'voice-profile']) void queryClient.invalidateQueries({ queryKey: [key] });
  };
  // Read again on success only: a refusal keeps what the editor set, beside the reason.
  const save = useMutation<VoiceProductionView, Error, void>({ mutationFn: () => api.setVoiceSelection(projectId, { ...next, overrides: pruneOverrides(overrides), revision: p.revision }), onSuccess: reload });
  return (
    <Section title="Choose the production profile">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block min-w-0 text-sm">
          <span className="block text-xs text-stone-500">Saved profile</span>
          <select
            value={familyId}
            onChange={(e) => {
              setFamilyId(e.target.value);
              setVersionId('');
            }}
            aria-label="Production profile"
            className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1"
          >
            <option value="">The library default{libraryDefault?.current ? ` (${libraryDefault.name} v${libraryDefault.current.version})` : ''}</option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
                {f.current ? ` (v${f.current.version})` : ''}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-stone-500">Profiles of this provider and language; make or edit them in the <Link to="/voice-profiles" className="underline">library</Link>.</span>
        </label>
        {familyId && (
          <fieldset className="min-w-0 text-sm">
            <legend className="text-xs text-stone-500">Version</legend>
            <label className="flex min-h-6 items-center gap-2">
              <input type="radio" name="production-version" checked={!pin} onChange={() => setPin(false)} /> Follow the current version{family?.current ? ` (now v${family.current.version})` : ''}
            </label>
            <label className="flex min-h-6 items-center gap-2">
              <input type="radio" name="production-version" checked={pin} onChange={() => setPin(true)} /> Pin a version
            </label>
            {pin && (
              <select value={versionId} onChange={(e) => setVersionId(e.target.value)} aria-label="Pinned version" className="mt-1 w-full rounded-md border border-stone-300 px-2 py-1">
                <option value="">{history.isPending ? 'Loading versions…' : 'Choose a version'}</option>
                {(history.data?.history ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    v{x.version}
                    {x.current ? ' (current)' : ''} — {PERFORMANCE_STRATEGY_LABELS[x.config.strategy]}, {x.modelId}
                  </option>
                ))}
              </select>
            )}
          </fieldset>
        )}
      </div>
      <h3 className="mt-4 text-sm font-medium text-stone-800">Project overrides</h3>
      <p className="text-xs text-stone-500">Overrides apply to this project's new runs only; the saved profile is unchanged.</p>
      <div className="mt-2">{base ? <OverridesEditor base={base} value={overrides} onChange={setOverrides} settings={v.provider.settings} scope="PROJECT" fields={PROJECT_FIELDS} /> : <p className="text-xs text-stone-500">{pin ? 'Choose the version to pin.' : 'There is no profile to override yet: the house profile is made at the first plan.'}</p>}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button disabled={save.isPending || unchanged || !!problems.length || (!!familyId && pin && !versionId)} onClick={() => save.mutate()} className={`${button} bg-stone-900 text-white hover:bg-stone-800`}>
          Save the production profile
        </button>
        <span className="text-xs text-stone-500">revision {p.revision}</span>
      </div>
      {save.error && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-red-700">
          <span>{save.error.message}</span>
          {isConflict(save.error) && (
            <button onClick={reload} className={secondary}>
              Reload
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
