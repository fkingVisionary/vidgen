import { AI_PATTERN_LABELS, BLOCK_CHANGE_STATUS_LABELS, MONEY_COMPARISON_TYPE_LABELS, RUBRIC_DIMENSION_LABELS, SCRIPT_ORIGIN_LABELS, type BlockChange, type NarrationRecord, type RubricScore, type ScriptChangeReport, type ScriptEditorialView } from '@docengine/core';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { Section } from './evidence.tsx';

/**
 * Writing Engine 2 in the dashboard: the change report between two versions
 * (ORIGINAL → REVISED → WHY, block by block, with what each change did), the
 * record of the narration pass, the diagnostics measured now, money context,
 * names and the semantic layers of every block.
 */

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
const yes = 'bg-emerald-100 text-emerald-800';
const no = 'bg-red-100 text-red-800';
const info = 'bg-sky-100 text-sky-900';
const muted = 'bg-stone-100 text-stone-600';

const STATUS_TONE: Record<BlockChange['status'], string> = { UNCHANGED: muted, REWRITTEN: 'bg-violet-100 text-violet-900', REMOVED: no, ADDED: yes };
const REVIEWER: Record<string, string> = { NARRATION: 'narration pass', SCRIPT_EDITOR: 'script editor', FACT_CHECKER: 'fact checker', PERFORMANCE: 'performance' };

function Flag({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  if (ok === null) return null;
  return (
    <span className={`${pill} ${ok ? yes : no}`} title={detail}>
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

/** One block, a → b: the original, the revision and why, with what the change did. */
export function BlockChangeCard({ b, from, to }: { b: BlockChange; from: number; to: number }) {
  return (
    <li className="rounded-md border border-stone-200 bg-white p-3 text-sm" data-testid="block-change">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-stone-500">
          {b.baseRef ?? '—'} → {b.ref ?? '—'}
        </span>
        <span className={`${pill} ${STATUS_TONE[b.status]}`}>{BLOCK_CHANGE_STATUS_LABELS[b.status]}</span>
        {b.changedBy.map((r) => (
          <span key={r} className={`${pill} ${muted}`}>
            {REVIEWER[r] ?? r}
          </span>
        ))}
      </div>
      {b.original !== null && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Original v{from}</p>
          <p className={b.status === 'UNCHANGED' ? 'text-stone-700' : 'text-stone-500'}>{b.original}</p>
        </div>
      )}
      {b.revised !== null && b.status !== 'UNCHANGED' && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-violet-700">Revised v{to}</p>
          <p className="text-stone-900">{b.revised}</p>
        </div>
      )}
      {b.reasons.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">Why</p>
          <ul className="list-disc pl-5 text-stone-700">
            {b.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {b.status !== 'UNCHANGED' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Flag ok={b.evidencePreserved} label="Evidence preserved" detail={b.claimsRemoved.length ? `no longer cites ${b.claimsRemoved.join(', ')}` : b.claimsAdded.length ? `also cites ${b.claimsAdded.join(', ')}` : 'the same claims, class and beats'} />
          <Flag ok={b.uncertaintyPreserved} label="Uncertainty preserved" />
          {b.moneyContext.length > 0 && <span className={`${pill} ${info}`}>New historical context: {b.moneyContext.join(', ')}</span>}
          {b.aiPatternsRemoved.length > 0 && <span className={`${pill} ${yes}`}>AI pattern removed: {b.aiPatternsRemoved.map((p) => AI_PATTERN_LABELS[p].toLowerCase()).join(', ')}</span>}
          {b.aiPatternsAdded.length > 0 && <span className={`${pill} ${no}`}>AI pattern added: {b.aiPatternsAdded.map((p) => AI_PATTERN_LABELS[p].toLowerCase()).join(', ')}</span>}
          {b.visualDuplicationRemoved && <span className={`${pill} ${yes}`}>Visual duplication removed</span>}
          {b.pronunciationCandidates.length > 0 && <span className={`${pill} bg-amber-100 text-amber-900`}>Pronunciation candidate: {b.pronunciationCandidates.join(', ')}</span>}
        </div>
      )}
    </li>
  );
}

function Tile({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-2">
      <p className="text-[11px] uppercase tracking-wide text-stone-500">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      {detail && <p className="text-xs text-stone-500">{detail}</p>}
    </div>
  );
}

/** The change report: totals, claim coverage flags, then the blocks (changed ones by default). */
export function ChangeReportView({ report: r }: { report: ScriptChangeReport }) {
  const [all, setAll] = useState(false);
  const t = r.totals;
  const shown = r.blocks.filter((b) => all || b.status !== 'UNCHANGED');
  return (
    <div className="space-y-3" data-testid="change-report">
      <p className="text-sm text-stone-600">
        ORIGINAL v{r.base.version} → REVISED v{r.revised.version} → WHY. {r.pairing === 'EXACT' ? 'Blocks paired by the run’s own lineage.' : 'Blocks paired by their evidence and wording (no lineage between these versions).'}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Blocks changed" value={t.rewritten + t.removed + t.added} detail={`${t.rewritten} rewritten · ${t.removed} removed · ${t.added} added`} />
        <Tile label="Blocks unchanged" value={t.unchanged} detail={`of ${t.blocksBefore} in v${r.base.version}`} />
        <Tile label="Sentences" value={`${t.sentencesRewritten} / ${t.sentencesRemoved}`} detail="rewritten / removed" />
        <Tile label="AI-pattern warnings" value={`${t.aiSignalsBefore} → ${t.aiSignalsAfter}`} detail={`score ${r.fingerprint.before} → ${r.fingerprint.after}`} />
        <Tile label="Money context added" value={t.moneyContextAdded} />
        <Tile label="Visual descriptions removed" value={t.visualDescriptionsRemoved} />
        <Tile label="Evidence preserved" value={`${t.evidencePreserved.kept}/${t.evidencePreserved.of}`} detail="blocks keeping their claims and class" />
        <Tile label="Uncertainty preserved" value={`${t.uncertaintyPreserved.kept}/${t.uncertaintyPreserved.of}`} detail={`${t.pronunciationCandidates} name(s) to confirm`} />
      </div>
      {r.provenance.flags.length > 0 ? (
        <div className="rounded-md bg-amber-50 p-2 text-sm text-amber-900">
          <p className="font-medium">Claim coverage changed — check these</p>
          <ul className="list-disc pl-5">
            {r.provenance.flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-emerald-800">Claim coverage: the same claims cited and the same figures said.</p>
      )}
      <label className="flex items-center gap-2 text-xs text-stone-600">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show unchanged blocks too
      </label>
      <ul className="space-y-2">
        {shown.map((b, i) => (
          <BlockChangeCard key={`${b.baseRef}-${b.ref}-${i}`} b={b} from={r.base.version} to={r.revised.version} />
        ))}
        {!shown.length && <li className="text-sm text-stone-500">No block changed.</li>}
      </ul>
    </div>
  );
}

function RubricTable({ now, made, before }: { now: RubricScore[]; made: RubricScore[] | null; before: RubricScore[] | null }) {
  const at = (r: RubricScore[] | null, d: RubricScore['dimension']) => r?.find((x) => x.dimension === d);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[18rem] text-sm">
        <thead className="text-xs text-stone-500">
          <tr>
            <th className="pb-1 text-left font-medium">Dimension</th>
            {before && <th className="pb-1 text-left font-medium">Before the pass</th>}
            {made && <th className="pb-1 text-left font-medium">When made</th>}
            <th className="pb-1 text-left font-medium">Now</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100">
          {now.map((x) => (
            <tr key={x.dimension}>
              <td className="py-1 pr-2">{RUBRIC_DIMENSION_LABELS[x.dimension]}</td>
              {before && <td className="py-1 pr-2 tabular-nums">{at(before, x.dimension)?.score ?? '—'}</td>}
              {made && <td className="py-1 pr-2 tabular-nums">{at(made, x.dimension)?.score ?? '—'}</td>}
              <td className="py-1 tabular-nums" title={x.reasons.join('\n')}>
                {x.score}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordSection({ record: n }: { record: NarrationRecord }) {
  return (
    <Section title="The narration pass that made this version">
      {n.unavailable ? (
        <p className="text-sm text-amber-800">The pass did not run: {n.unavailable}</p>
      ) : (
        <div className="space-y-2 text-sm">
          {n.verdict && <p className="text-stone-700">“{n.verdict}” <span className="text-xs text-stone-500">— the narration editor (model judgment)</span></p>}
          <p className="text-stone-600">
            {n.counts.flagged} block(s) needed work · {n.counts.kept} edit(s) kept · {n.counts.rejected} rejected by the invariants · {n.counts.skipped} skipped ({n.counts.settled} on settled blocks) · corpus {n.corpusVersion} · {n.styleBibleVersion}
          </p>
          {n.retrieved.length > 0 && (
            <details>
              <summary className="cursor-pointer text-stone-700">{n.retrieved.length} corpus example(s) retrieved for it</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-stone-600">
                {n.retrieved.map((r) => (
                  <li key={r.id}>
                    <span className="font-mono">{r.id}@{r.version}</span> — {r.category}, {r.quality} — for {r.refs.slice(0, 6).join(', ')} ({r.reason})
                  </li>
                ))}
              </ul>
            </details>
          )}
          {n.visualMoved.length > 0 && (
            <details>
              <summary className="cursor-pointer text-stone-700">{n.visualMoved.length} picture description(s) moved to the visual layer</summary>
              <ul className="mt-1 list-disc pl-5 text-xs text-stone-600">
                {n.visualMoved.map((v, i) => (
                  <li key={i}>
                    {v.ref}: {v.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </Section>
  );
}

function MoneySection({ record: n }: { record: NarrationRecord }) {
  if (!n.money.contexts.length && !n.money.gaps.length) return null;
  return (
    <Section title="Money context — from the evidence only">
      <ul className="space-y-2 text-sm">
        {n.money.contexts.map((c) => (
          <li key={c.id}>
            <span className="font-mono text-xs">{c.id}</span> {c.amountText} {c.currency}
            {c.item ? ` (${c.item})` : ''} — <span className="font-medium">{c.explanation}</span>
            <div className="text-xs text-stone-500">
              {MONEY_COMPARISON_TYPE_LABELS[c.comparisonType]} · rests on {c.sourceClaimKeys.join(', ')} ({c.verdict.toLowerCase()}) · confidence {c.confidence.toLowerCase()}
              {c.approximate ? ' · approximate' : ''}
              {n.money.used.some((u) => u.contextId === c.id) ? ` · used in ${n.money.used.filter((u) => u.contextId === c.id).map((u) => u.ref).join(', ')}` : ' · not used'}
            </div>
            <div className="text-xs text-stone-500">Method: {c.methodology}</div>
          </li>
        ))}
        {n.money.gaps.map((g, i) => (
          <li key={`g${i}`} className="text-amber-900">
            {g.ref}: {g.amountText} {g.currency} — {g.note}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function NamesSection({ record: n }: { record: NarrationRecord }) {
  if (!n.names.length) return null;
  return (
    <Section title="Names — historical, display, spoken">
      <p className="mb-2 text-xs text-stone-500">A historical name keeps its spelling in the narration, subtitles, citations and on-screen text. How it is said is decided in the pronunciation list (the Voice page), never guessed here.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[20rem] text-sm">
          <thead className="text-xs text-stone-500">
            <tr>
              <th className="pb-1 text-left font-medium">Historical</th>
              <th className="pb-1 text-left font-medium">Display</th>
              <th className="pb-1 text-left font-medium">Spoken</th>
              <th className="pb-1 text-left font-medium">Pronunciation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {n.names.map((x) => (
              <tr key={x.id}>
                <td className="py-1 pr-2">
                  {x.historicalName}
                  {x.fictional && <span className="ml-1 text-xs text-fuchsia-700">fictional</span>}
                </td>
                <td className="py-1 pr-2">{x.displayName}</td>
                <td className="py-1 pr-2">{x.spokenForm ?? '—'}</td>
                <td className="py-1 text-xs">{x.candidate ? <span className="text-amber-800">to decide: {x.candidateReasons.join('; ')}</span> : x.pronunciation ? `${x.pronunciation.confidence.toLowerCase()} (${x.pronunciation.source.toLowerCase()})` : 'no note needed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function LayersSection({ view: v }: { view: ScriptEditorialView }) {
  const leaks = v.layers.filter((l) => l.leaks.length);
  return (
    <Section title="Semantic layers — only the narration is spoken">
      {leaks.length > 0 ? <p className="mb-2 text-sm text-red-800">Directions inside the narration: {leaks.map((l) => `${l.key} (${l.leaks.join('; ')})`).join(' · ')}</p> : <p className="mb-2 text-sm text-emerald-800">No production metadata inside the narration.</p>}
      <details>
        <summary className="cursor-pointer text-sm text-stone-700">Every block in its layers ({v.layers.length})</summary>
        <ul className="mt-2 space-y-2">
          {v.layers.map((l) => (
            <li key={l.key} className="rounded border border-stone-200 p-2 text-sm">
              <p>
                <span className="font-mono text-xs text-stone-500">{l.key}</span> <span className="text-xs text-stone-500">NARRATION</span> {l.narration}
              </p>
              <p className="text-xs text-stone-600">
                <span className="text-stone-500">DELIVERY</span> {l.delivery.mark ? `[${l.delivery.mark}] ` : ''}
                {l.delivery.pace.toLowerCase()}/{l.delivery.energy.toLowerCase()}/{l.delivery.emotion.toLowerCase()}
                {l.delivery.pauses.length ? ` · pause ${l.delivery.pauses.join(', ')}` : ''}
              </p>
              <p className="text-xs text-stone-600">
                <span className="text-stone-500">VISUAL</span> {l.visual.intent.toLowerCase().replace(/_/g, ' ')}
                {l.visual.note ? ` — ${l.visual.note}` : ''}
                {l.visual.mustShow.length ? ` · show: ${l.visual.mustShow.join('; ')}` : ''}
              </p>
              <p className="text-xs text-stone-600">
                <span className="text-stone-500">EVIDENCE</span> {l.evidence.claimKeys.join(', ') || 'none'}
                {l.evidence.presentation.length ? ` · ${l.evidence.presentation.join('; ')}` : ''}
              </p>
              {l.editorial.length > 0 && (
                <p className="text-xs text-stone-600">
                  <span className="text-stone-500">EDITORIAL</span> {l.editorial.join(' · ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </details>
    </Section>
  );
}

/** The Editorial tab: a version through Writing Engine 2. */
export function EditorialTab({ projectId, version }: { projectId: string; version: number }) {
  const q = useQuery({ queryKey: ['script-editorial', projectId, version], queryFn: () => api.scriptEditorial(projectId, version) });
  if (q.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-700">Could not load the editorial view: {q.error.message}</p>;
  const v = q.data;
  const fp = v.diagnostics.fingerprint;
  return (
    <div className="space-y-4" data-testid="editorial-tab">
      <p className="text-sm text-stone-600">
        v{v.version} — {SCRIPT_ORIGIN_LABELS[v.origin]}
        {v.baseVersion ? `, made from v${v.baseVersion}` : ''}. The writing engine's measurements are editorial telemetry: they never gate a version and never override the factual checks.
      </p>
      <Section title="Measured now — from the text as it stands">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="AI-pattern score" value={`${fp.score}/100`} detail={`${fp.signals} signal(s)${v.record?.diagnostics.before ? ` · ${v.record.diagnostics.before.fingerprint.score} before the pass` : ''}`} />
          <Tile label="Sentence length" value={`${v.diagnostics.rhythm.meanWords} words`} detail={`spread ${v.diagnostics.rhythm.variation}`} />
          <Tile label="Fragments" value={`${Math.round(v.diagnostics.rhythm.fragmentShare * 100)}%`} detail={`longest run ${v.diagnostics.rhythm.longestFragmentRun}`} />
          <Tile label="Tongue-twisters" value={v.diagnostics.rhythm.tongueTwisters.length} />
        </div>
        {Object.keys(fp.perPattern).length > 0 && (
          <p className="mt-2 text-xs text-stone-600">
            Signals:{' '}
            {Object.entries(fp.perPattern)
              .map(([k, n]) => `${AI_PATTERN_LABELS[k as keyof typeof AI_PATTERN_LABELS]} ${n}${fp.overThreshold.includes(k as never) ? ' (warns)' : ''}`)
              .join(' · ')}
          </p>
        )}
        <div className="mt-3">
          <RubricTable now={v.diagnostics.rubric} made={v.record?.diagnostics.after.rubric ?? null} before={v.record?.diagnostics.before?.rubric ?? null} />
        </div>
      </Section>
      {v.report && (
        <Section title={`Before and after — v${v.report.base.version} → v${v.report.revised.version}`}>
          <ChangeReportView report={v.report} />
        </Section>
      )}
      {v.record && <RecordSection record={v.record} />}
      {v.record && <MoneySection record={v.record} />}
      {v.record && <NamesSection record={v.record} />}
      <LayersSection view={v} />
    </div>
  );
}
