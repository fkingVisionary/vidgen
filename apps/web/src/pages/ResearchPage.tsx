import {
  CLAIM_IMPORTANCES,
  CLAIM_VERDICTS,
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  type ApprovalDecision,
  type ClaimVerdict,
  type DossierView,
} from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../api.ts';
import { SourceTypeBadge, VerdictBadge } from '../components/badges.tsx';
import { ClaimCard, ClaimRefs, QualityReportView, Section } from '../components/evidence.tsx';
import { formatDate, formatUsd } from '../format.ts';

type Tab = 'claims' | 'sources' | 'story' | 'questions' | 'quality';

export function ResearchPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const version = params.get('v') ? Number(params.get('v')) : undefined;
  const research = useQuery({ queryKey: ['research', id, version], queryFn: () => api.research(id, version) });
  const project = useQuery({ queryKey: ['project', id], queryFn: () => api.project(id) });
  const [tab, setTab] = useState<Tab>('claims');

  if (research.isPending || project.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (research.isError) return <p className="text-sm text-red-700">Could not load the dossier: {research.error.message}</p>;
  if (project.isError) return <p className="text-sm text-red-700">{project.error.message}</p>;
  const p = project.data;
  const d = research.data.dossier;

  if (!d) {
    return (
      <div className="space-y-2">
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">← {p.title}</Link>
        <h1 className="text-2xl font-semibold">Research dossier</h1>
        <p className="text-sm text-stone-500">No dossier yet. Run the Research stage from the project page.</p>
      </div>
    );
  }

  const tabs: [Tab, string][] = [
    ['claims', `Claims (${d.claims.length})`],
    ['sources', `Sources (${d.sources.filter((s) => s.citationCount > 0).length} cited / ${d.sources.length})`],
    ['story', 'Story material'],
    ['questions', `Questions & gaps`],
    ['quality', `Quality gate ${d.qualityReport?.passed ? '✓' : '✗'}`],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link to={`/projects/${p.slug}`} className="text-sm text-stone-500 hover:underline">← {p.title}</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Research dossier v{d.version}</h1>
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium">{d.status.replace('_', ' ')}</span>
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${d.qualityReport?.passed ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
            Quality gate {d.qualityReport?.passed ? 'passed' : 'FAILED'}
          </span>
          {research.data.versions.length > 1 && (
            <select
              value={d.version}
              onChange={(e) => setParams({ v: e.target.value })}
              className="rounded-md border border-stone-300 px-2 py-1 text-sm"
            >
              {research.data.versions.map((v) => (
                <option key={v.id} value={v.version}>
                  v{v.version} — {v.status.toLowerCase()} — {formatDate(v.createdAt)}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Generated {formatDate(d.createdAt)} · {String(d.stats.models ? (d.stats.models as string[]).join(', ') : '')} · research cost {formatUsd(d.cost.totalUsd)}
          {d.cost.includesEstimates ? ' (estimated)' : ''} over {d.cost.calls} provider calls
        </p>
      </div>

      {p.status === 'RESEARCH_REVIEW' && d.status === 'IN_REVIEW' && <ApprovalPanel projectId={p.id} version={d.version} />}

      <VerdictSummary dossier={d} />

      {d.summary && (
        <section className="rounded-lg border border-stone-200 bg-white p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">Research summary</h2>
          <div className="max-w-4xl space-y-3 text-sm leading-relaxed whitespace-pre-line">{d.summary}</div>
        </section>
      )}

      <div className="flex flex-wrap gap-1 border-b border-stone-200">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'claims' && <ClaimsTab dossier={d} />}
      {tab === 'sources' && <SourcesTab dossier={d} />}
      {tab === 'story' && <StoryTab dossier={d} />}
      {tab === 'questions' && <QuestionsTab dossier={d} />}
      {tab === 'quality' && <QualityTab dossier={d} />}
    </div>
  );
}

function VerdictSummary({ dossier: d }: { dossier: DossierView }) {
  const counts = Object.fromEntries(CLAIM_VERDICTS.map((v) => [v, d.claims.filter((c) => c.verdict === v).length])) as Record<ClaimVerdict, number>;
  const byType = SOURCE_TYPES.map((t) => [t, d.sources.filter((s) => s.citationCount > 0 && s.sourceType === t).length] as const).filter(([, n]) => n > 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-3">
        {CLAIM_VERDICTS.map((v) => (
          <span key={v} className="flex items-center gap-1 text-sm">
            <VerdictBadge verdict={v} /> <span className="tabular-nums">{counts[v]}</span>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-3 text-sm">
        <span className="text-stone-500">Cited sources:</span>
        {byType.map(([t, n]) => (
          <span key={t} className="flex items-center gap-1">
            <SourceTypeBadge type={t} /> {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function ApprovalPanel({ projectId, version }: { projectId: string; version: number }) {
  const [notes, setNotes] = useState('');
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) => api.approve(projectId, { gate: 'RESEARCH', decision, notes: notes || undefined }),
    onSuccess: () => {
      setNotes('');
      void queryClient.invalidateQueries();
    },
  });
  return (
    <section className="rounded-lg border-2 border-violet-300 bg-violet-50 p-4">
      <h2 className="font-semibold text-violet-900">Human approval required — research dossier v{version}</h2>
      <p className="text-sm text-violet-800">
        Automated checks are not an approval. Review the claims (especially disputed, unverified and myth claims) and the sources before approving.
      </p>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
        placeholder="Notes — what you checked, what needs more research"
        className="mt-2 w-full rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button disabled={decide.isPending} onClick={() => decide.mutate('APPROVED')} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40">
          Approve research
        </button>
        <button disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-red-700 ring-1 ring-red-300 hover:bg-red-50 disabled:opacity-40">
          Reject → research again
        </button>
        <button disabled={decide.isPending} onClick={() => decide.mutate('FLAGGED')} className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-stone-700 ring-1 ring-stone-300 hover:bg-stone-50 disabled:opacity-40">
          Flag (no status change)
        </button>
      </div>
      {decide.isError && <p className="mt-2 text-sm text-red-700">{decide.error.message}</p>}
    </section>
  );
}

function ClaimsTab({ dossier: d }: { dossier: DossierView }) {
  const [verdicts, setVerdicts] = useState<Set<ClaimVerdict>>(new Set());
  const [importance, setImportance] = useState<string>('');
  const [question, setQuestion] = useState<string>('');
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const [text, setText] = useState('');
  const sources = useMemo(() => new Map(d.sources.map((s) => [s.id, s])), [d.sources]);

  const shown = d.claims.filter(
    (c) =>
      (verdicts.size === 0 || verdicts.has(c.verdict)) &&
      (!importance || c.importance === importance) &&
      (!question || c.category === question) &&
      (!onlyFlagged || c.needsVerification) &&
      (!text || `${c.statement} ${c.popularVersion ?? ''} ${c.notes ?? ''}`.toLowerCase().includes(text.toLowerCase())),
  );
  const toggle = (v: ClaimVerdict) => setVerdicts((s) => (s.has(v) ? new Set([...s].filter((x) => x !== v)) : new Set([...s, v])));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {CLAIM_VERDICTS.map((v) => (
          <button key={v} onClick={() => toggle(v)} className={`rounded-full ${verdicts.has(v) ? 'ring-2 ring-stone-900' : 'opacity-70 hover:opacity-100'}`}>
            <VerdictBadge verdict={v} />
          </button>
        ))}
        <select value={importance} onChange={(e) => setImportance(e.target.value)} className="rounded-md border border-stone-300 px-2 py-1">
          <option value="">All importance</option>
          {CLAIM_IMPORTANCES.map((i) => (
            <option key={i} value={i}>{i.toLowerCase()}</option>
          ))}
        </select>
        <select value={question} onChange={(e) => setQuestion(e.target.value)} className="max-w-xs rounded-md border border-stone-300 px-2 py-1">
          <option value="">All questions</option>
          {d.content.questions.map((q) => (
            <option key={q.id} value={q.id}>{q.id}: {q.question.slice(0, 60)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> needs verification
        </label>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search claims" className="rounded-md border border-stone-300 px-2 py-1" />
        <span className="text-stone-500">{shown.length} shown</span>
      </div>
      {shown.map((c) => (
        <ClaimCard key={c.id} claim={c} sources={sources} question={d.content.questions.find((q) => q.id === c.category)?.question} />
      ))}
    </div>
  );
}

function SourcesTab({ dossier: d }: { dossier: DossierView }) {
  const [showAll, setShowAll] = useState(false);
  const titleOf = new Map(d.sources.map((s) => [s.id, s.title]));
  const list = [...d.sources]
    .filter((s) => showAll || s.citationCount > 0)
    .sort((a, b) => SOURCE_TYPES.indexOf(a.sourceType) - SOURCE_TYPES.indexOf(b.sourceType) || b.citationCount - a.citationCount);
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Also show sources that were not cited, failed to retrieve, or duplicate another
      </label>
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Reliability</th>
              <th className="px-3 py-2 font-medium">Retrieval</th>
              <th className="px-3 py-2 font-medium">Citations</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 align-top">
            {list.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2"><SourceTypeBadge type={s.sourceType} /></td>
                <td className="px-3 py-2">
                  {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">{s.title}</a> : s.title}
                  <div className="text-xs text-stone-500">
                    {[s.author, s.publisher, s.publishedDate, s.domain].filter(Boolean).join(' · ')}
                  </div>
                  {s.summary && <div className="mt-0.5 max-w-2xl text-xs text-stone-600">{s.summary}</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {s.reliability ?? '—'}
                  {s.reliabilityNotes && <div className="max-w-xs text-stone-500">{s.reliabilityNotes}</div>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {s.duplicateOfId ? (
                    <span className="text-stone-500">duplicate of “{titleOf.get(s.duplicateOfId)}”</span>
                  ) : s.retrievalStatus === 'RETRIEVED' ? (
                    <span className="text-emerald-700">full text</span>
                  ) : (
                    <span className="text-red-700" title={s.retrievalError ?? ''}>{s.retrievalStatus.toLowerCase()}{s.retrievalError ? `: ${s.retrievalError}` : ''}</span>
                  )}
                </td>
                <td className="px-3 py-2 tabular-nums">{s.citationCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">
        Types: {SOURCE_TYPES.map((t) => SOURCE_TYPE_LABELS[t]).join(' › ')} (strongest first).
      </p>
    </div>
  );
}

function StoryTab({ dossier: d }: { dossier: DossierView }) {
  const c = d.content;
  const claims = d.claims;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Timeline">
        <ol className="space-y-1.5 text-sm">
          {c.timeline.map((t, i) => (
            <li key={i}>
              <span className="font-mono text-xs text-stone-500">{t.approximate ? '≈ ' : ''}{t.date}</span> — {t.event}
              <ClaimRefs keys={t.claimKeys} claims={claims} />
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Myths vs evidence">
        <ul className="space-y-2 text-sm">
          {c.myths.map((m, i) => (
            <li key={i} className="rounded border border-rose-200 bg-rose-50 p-2">
              <p><span className="font-semibold text-rose-700">Popular version: </span>{m.popularVersion}</p>
              <p><span className="font-semibold text-emerald-800">The evidence: </span>{m.whatTheEvidenceShows}</p>
              <p className="text-xs text-stone-600">Origin: {m.origin} <ClaimRefs keys={m.claimKeys} claims={claims} /></p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Price evidence">
        <table className="w-full text-left text-xs">
          <thead className="text-stone-500">
            <tr><th className="py-1">Item</th><th>Price</th><th>Date</th><th>Context / reliability</th></tr>
          </thead>
          <tbody className="divide-y divide-stone-100 align-top">
            {c.priceEvidence.map((pr, i) => (
              <tr key={i}>
                <td className="py-1 pr-2">{pr.item}</td>
                <td className="pr-2 tabular-nums">{pr.price} {pr.currency}</td>
                <td className="pr-2">{pr.date}</td>
                <td>{pr.context} — <span className="text-stone-500">{pr.reliability}</span><ClaimRefs keys={pr.claimKeys} claims={claims} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <Section title="Competing interpretations">
        <ul className="space-y-2 text-sm">
          {c.interpretations.map((it, i) => (
            <li key={i}>
              <p className="font-medium">{it.position}</p>
              <p className="text-xs text-stone-500">{it.proponents.join(', ')}</p>
              <p>{it.summary} <ClaimRefs keys={it.claimKeys} claims={claims} /></p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Was it a bubble?">
        <p className="text-sm">{c.bubbleAssessment.summary} <ClaimRefs keys={c.bubbleAssessment.claimKeys} claims={claims} /></p>
        <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
          <div><h3 className="text-xs font-semibold text-stone-500">For</h3><ul className="list-disc pl-4">{c.bubbleAssessment.argumentsFor.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          <div><h3 className="text-xs font-semibold text-stone-500">Against</h3><ul className="list-disc pl-4">{c.bubbleAssessment.argumentsAgainst.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
        </div>
      </Section>
      <Section title="How the story was told">
        <p className="text-sm">{c.narrativeHistory.summary} <ClaimRefs keys={c.narrativeHistory.claimKeys} claims={claims} /></p>
        <ul className="mt-2 space-y-1 text-sm">
          {c.narrativeHistory.milestones.map((m, i) => (
            <li key={i}><span className="font-mono text-xs text-stone-500">{m.date}</span> {m.work} — {m.contribution}</li>
          ))}
        </ul>
      </Section>
      <Section title="Key figures">
        <ul className="space-y-1.5 text-sm">
          {c.keyFigures.map((k, i) => (
            <li key={i}><span className="font-medium">{k.name}</span> <span className="text-stone-500">({k.role})</span> — {k.description}<ClaimRefs keys={k.claimKeys} claims={claims} /></li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function QuestionsTab({ dossier: d }: { dossier: DossierView }) {
  const c = d.content;
  return (
    <div className="space-y-4">
      <Section title="Research questions">
        <ul className="space-y-3 text-sm">
          {c.questions.map((q) => (
            <li key={q.id}>
              <p className="font-medium">{q.id}. {q.question} <span className="text-xs font-normal text-stone-500">({q.category}{q.confidence ? `, confidence ${q.confidence.toLowerCase()}` : ''})</span></p>
              {q.answerSummary && <p className="text-stone-700">{q.answerSummary}</p>}
              <p className="text-xs text-stone-400">Searched: {q.queries.join(' · ')}</p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Unresolved questions">
        <ul className="space-y-2 text-sm">
          {c.openQuestions.map((q, i) => (
            <li key={i} className="rounded border border-yellow-300 bg-yellow-50 p-2">
              <p className="font-medium">{q.question}</p>
              <p className="text-xs">Why unresolved: {q.whyUnresolved}</p>
              <p className="text-xs">Would resolve it: {q.whatWouldResolveIt}</p>
              {q.claimKeys.length > 0 && <ClaimRefs keys={q.claimKeys} claims={d.claims} />}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Missing evidence">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {c.missingEvidence.map((m, i) => (
            <li key={i}><span className="font-medium">{m.topic}:</span> {m.description}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function QualityTab({ dossier: d }: { dossier: DossierView }) {
  if (!d.qualityReport) return <p className="text-sm text-stone-500">No quality report.</p>;
  return (
    <div className="space-y-4">
      <QualityReportView report={d.qualityReport} claims={d.claims} />
      <Section title="Run statistics">
        <pre className="overflow-x-auto text-xs text-stone-600">{JSON.stringify(d.stats, null, 2)}</pre>
      </Section>
    </div>
  );
}
