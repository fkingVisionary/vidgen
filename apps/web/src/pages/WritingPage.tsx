import { AI_PATTERN_LABELS, RUBRIC_DIMENSION_LABELS, WRITING_CATEGORIES, WRITING_CATEGORY_LABELS, WRITING_EXAMPLE_STATUS_LABELS, WRITING_QUALITY_LABELS, WRITING_SOURCE_TYPE_LABELS, type WritingCategory, type WritingCorpusView, type WritingExampleView } from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api.ts';
import { Section } from '../components/evidence.tsx';
import { button } from '../components/script.tsx';

type Tab = 'examples' | 'house' | 'bible' | 'rubric';
const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
const POLARITY_TONE: Record<string, string> = { positive: 'bg-emerald-100 text-emerald-800', house_style: 'bg-violet-100 text-violet-900', negative: 'bg-red-100 text-red-800', borderline: 'bg-amber-100 text-amber-900' };
const POLARITY_LABEL: Record<string, string> = { positive: 'model to follow', house_style: 'house voice', negative: 'habit to avoid', borderline: 'judgment call' };

/**
 * The house style: the editorial constitution (style bible), the read-aloud
 * rubric, the AI-pattern glossary, the corpus of examples the writing engine
 * retrieves from — and the house-style candidates from approved scripts,
 * which enter the corpus only when a person approves them.
 */
export function WritingPage() {
  const corpus = useQuery({ queryKey: ['writing-corpus'], queryFn: api.writingCorpus });
  const [tab, setTab] = useState<Tab>('examples');
  if (corpus.isPending) return <p className="text-sm text-stone-500">Loading…</p>;
  if (corpus.isError) return <p className="text-sm text-red-700">Could not load the house style: {corpus.error.message}</p>;
  const c = corpus.data;
  const candidates = c.house.filter((h) => h.status === 'CANDIDATE').length;
  const tabs: [Tab, string][] = [
    ['examples', `Examples (${c.examples.length})`],
    ['house', `From our scripts${candidates ? ` (${candidates} to decide)` : ''}`],
    ['bible', 'Style bible'],
    ['rubric', 'Rubric & AI patterns'],
  ];
  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-stone-500 hover:underline">
          ← Projects
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">House style</h1>
        <p className="mt-1 text-sm text-stone-600">
          The writing engine's editorial memory — corpus {c.version}. Every narration pass is told to work to the style bible and is shown a handful of these examples, chosen for the blocks in front of it; never the whole corpus. All examples are original house writing or the team's own approved work: no transcripts of other documentaries.
        </p>
        {c.errors.length > 0 && <p className="mt-1 text-sm text-red-700">{c.errors.length} corpus example(s) failed validation and are left out of retrieval.</p>}
      </div>
      <div className="flex flex-wrap gap-1 border-b border-stone-200">
        {tabs.map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-stone-900 font-medium text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'examples' && <ExamplesTab corpus={c} />}
      {tab === 'house' && <HouseTab corpus={c} />}
      {tab === 'bible' && <BibleTab corpus={c} />}
      {tab === 'rubric' && <RubricTab corpus={c} />}
    </div>
  );
}

function ExamplesTab({ corpus: c }: { corpus: WritingCorpusView }) {
  const [category, setCategory] = useState<WritingCategory | ''>('');
  const [polarity, setPolarity] = useState('');
  const shown = c.examples.filter((e) => (!category || e.category === category) && (!polarity || e.polarity === polarity));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm">
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as WritingCategory | '')} className="rounded-md border border-stone-300 px-2 py-1">
          <option value="">Every category</option>
          {WRITING_CATEGORIES.map((k) => (
            <option key={k} value={k}>
              {WRITING_CATEGORY_LABELS[k]}
            </option>
          ))}
        </select>
        <select aria-label="Kind" value={polarity} onChange={(e) => setPolarity(e.target.value)} className="rounded-md border border-stone-300 px-2 py-1">
          <option value="">Every kind</option>
          {Object.entries(POLARITY_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <span className="self-center text-xs text-stone-500">{shown.length} shown</span>
      </div>
      <ul className="space-y-2">
        {shown.map((e) => (
          <li key={e.id} className="rounded-md border border-stone-200 bg-white p-3 text-sm" data-testid="corpus-example">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={`${pill} ${POLARITY_TONE[e.polarity]}`}>{POLARITY_LABEL[e.polarity]}</span>
              <span className="text-stone-500">
                {WRITING_CATEGORY_LABELS[e.category]} · {WRITING_QUALITY_LABELS[e.quality]} · {WRITING_SOURCE_TYPE_LABELS[e.source.type]}
              </span>
              <span className="font-mono text-stone-400">
                {e.id}@{e.version}
              </span>
            </div>
            <p className="mt-1 text-stone-900">{e.text}</p>
            {e.rewrite && (
              <p className="mt-1 text-emerald-900">
                <span className="text-xs font-semibold uppercase text-emerald-700">House version </span>
                {e.rewrite}
              </p>
            )}
            {e.whyItWorks && <p className="mt-1 text-xs text-stone-600">Works: {e.whyItWorks}</p>}
            {e.whyItFails && <p className="mt-1 text-xs text-red-800">Fails: {e.whyItFails}</p>}
            {e.traits.length > 0 && <p className="mt-1 text-xs text-stone-400">{e.traits.join(' · ')}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function HouseCard({ x }: { x: WritingExampleView }) {
  const queryClient = useQueryClient();
  const [why, setWhy] = useState(x.whyItWorks ?? '');
  const [category, setCategory] = useState<WritingCategory>(x.category);
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT' | 'RETIRE') => api.decideWritingExample(x.id, { decision, category, ...(why.trim() ? { whyItWorks: why.trim() } : {}) }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['writing-corpus'] }),
  });
  return (
    <li className="rounded-md border border-stone-200 bg-white p-3 text-sm" data-testid="house-example">
      <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
        <span className={`${pill} ${x.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-800' : x.status === 'CANDIDATE' ? 'bg-amber-100 text-amber-900' : 'bg-stone-100 text-stone-600'}`}>{WRITING_EXAMPLE_STATUS_LABELS[x.status]}</span>
        <span>{x.sourceReference}</span>
        <span>{x.narrativeFunction}</span>
      </div>
      <p className="mt-1">{x.text}</p>
      {x.status === 'CANDIDATE' ? (
        <div className="mt-2 space-y-1">
          <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as WritingCategory)} className="rounded-md border border-stone-300 px-2 py-1 text-xs">
            {WRITING_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {WRITING_CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
          <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} placeholder="Why it works — this is what teaches the writer (needed to approve)" className="w-full rounded-md border border-stone-300 px-2 py-1 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button disabled={decide.isPending || !why.trim()} onClick={() => decide.mutate('APPROVE')} className={`${button} bg-emerald-700 text-white`}>
              Add to the house corpus
            </button>
            <button disabled={decide.isPending} onClick={() => decide.mutate('REJECT')} className={`${button} bg-white text-red-700 ring-1 ring-red-300`}>
              Reject
            </button>
          </div>
        </div>
      ) : (
        <>
          {x.whyItWorks && <p className="mt-1 text-xs text-stone-600">Works: {x.whyItWorks}</p>}
          {x.reviewedBy && (
            <p className="text-xs text-stone-400">
              {x.status.toLowerCase()} by {x.reviewedBy}
            </p>
          )}
          {x.status === 'APPROVED' && (
            <button disabled={decide.isPending} onClick={() => decide.mutate('RETIRE')} className={`${button} mt-1 bg-white text-stone-700 ring-1 ring-stone-300`}>
              Retire
            </button>
          )}
        </>
      )}
      {decide.error && <p className="text-xs text-red-700">{decide.error.message}</p>}
    </li>
  );
}

function HouseTab({ corpus: c }: { corpus: WritingCorpusView }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-600">
        Our own approved work becomes the most important part of the corpus — but never automatically: an approved script proposes candidates (on its Versions tab), and each one enters retrieval only when a person approves it and says why it works.
      </p>
      <ul className="space-y-2">
        {c.house.map((x) => (
          <HouseCard key={x.id} x={x} />
        ))}
        {!c.house.length && <li className="text-sm text-stone-500">No candidates yet. Approve a script, then propose candidates from it.</li>}
      </ul>
    </div>
  );
}

function BibleTab({ corpus: c }: { corpus: WritingCorpusView }) {
  return (
    <Section title={`Style bible — ${c.styleBible.version}`}>
      <div className="space-y-4 text-sm">
        {c.styleBible.sections.map((s) => (
          <div key={s.title}>
            <h3 className="font-semibold">{s.title}</h3>
            {s.lead && <p className="font-medium text-stone-700">{s.lead}</p>}
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-stone-700">
              {s.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function RubricTab({ corpus: c }: { corpus: WritingCorpusView }) {
  return (
    <div className="space-y-4">
      <Section title={`Read-aloud rubric — ${c.rubric.version} (telemetry; never a gate)`}>
        <p className="mb-2 text-sm text-stone-700">Above every dimension: if you heard this as narration in a high-quality historical documentary, would you naturally assume a competent human documentary writer wrote it?</p>
        <ul className="space-y-1 text-sm">
          {c.rubric.dimensions.map((d) => (
            <li key={d.dimension}>
              <span className="font-medium">{RUBRIC_DIMENSION_LABELS[d.dimension]}</span> — {d.question}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="AI-pattern glossary — warnings, not failures">
        <ul className="space-y-1 text-sm">
          {c.patterns.map((p) => (
            <li key={p.pattern}>
              <span className="font-medium">{AI_PATTERN_LABELS[p.pattern]}</span> <span className="text-xs text-stone-500">({p.kind.toLowerCase()}; warns {p.warns})</span> — {p.looksLike}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
