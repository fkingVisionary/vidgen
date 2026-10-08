import type { ClaimView, QualityReport, SourceType } from '@docengine/core';
import type { ReactNode } from 'react';
import { formatDate } from '../format.ts';
import { SourceTypeBadge, VERDICT_STYLE, VerdictBadge } from './badges.tsx';

/** Evidence display shared by the research dossier and the story pages. */

export interface SourceLike {
  id: string;
  title: string;
  url: string | null;
  sourceType: SourceType;
}

export function Section({ title, children, className = '', id }: { title: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`scroll-mt-4 rounded-lg border border-stone-200 bg-white p-4 ${className}`}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h2>
      {children}
    </section>
  );
}

export function ClaimCard({ claim: c, sources, question, anchor = true }: { claim: ClaimView; sources: Map<string, SourceLike>; question?: string; anchor?: boolean }) {
  const style = VERDICT_STYLE[c.verdict];
  const group = (stance: string) => c.citations.filter((x) => x.stance === stance);
  return (
    <article id={anchor ? `claim-${c.key}` : undefined} className={`rounded-md border border-l-4 border-stone-200 p-3 ${style.card}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-stone-500">{c.key}</span>
        <VerdictBadge verdict={c.verdict} />
        {c.importance === 'KEY' && <span className="rounded-full bg-stone-900 px-2 py-0.5 font-semibold text-white">KEY</span>}
        <span className="text-stone-500">
          confidence {c.confidence.toLowerCase()} · {c.claimType.toLowerCase().replace('_', ' ')}
        </span>
        {c.needsVerification && <span className="rounded-full bg-yellow-200 px-2 py-0.5 font-medium text-yellow-950">needs verification</span>}
        {c.category && (
          <span className="text-stone-400" title={question}>
            {c.category}
          </span>
        )}
      </div>
      <p className="mt-1.5 font-medium">{c.statement}</p>
      {c.popularVersion && (
        <p className="mt-1.5 rounded bg-white/70 px-2 py-1 text-sm ring-1 ring-stone-200">
          <span className="font-semibold text-rose-700">Commonly claimed: </span>
          {c.popularVersion}
        </p>
      )}
      {c.notes && <p className="mt-1.5 text-sm text-stone-700">{c.notes}</p>}
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <Citations title="Supporting" tone="text-emerald-800" citations={group('SUPPORTS')} sources={sources} />
        <Citations title="Contradicting" tone="text-red-700" citations={group('CONTRADICTS')} sources={sources} />
      </div>
      {group('CONTEXT').length > 0 && <Citations title="Context" tone="text-stone-600" citations={group('CONTEXT')} sources={sources} />}
      {c.citations.length === 0 && <p className="mt-2 text-xs italic text-yellow-900">No citation: no retrieved source establishes this claim.</p>}
    </article>
  );
}

function Citations({ title, tone, citations, sources }: { title: string; tone: string; citations: ClaimView['citations']; sources: Map<string, SourceLike> }) {
  if (citations.length === 0) return null;
  return (
    <div>
      <h4 className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>
        {title} ({citations.length})
      </h4>
      <ul className="mt-1 space-y-1.5">
        {citations.map((x) => {
          const s = sources.get(x.sourceId);
          return (
            <li key={x.id} className="text-xs">
              <div className="flex flex-wrap items-center gap-1">
                {s && <SourceTypeBadge type={s.sourceType} />}
                {s?.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {s.title}
                  </a>
                ) : (
                  <span className="font-medium">{s?.title ?? 'Unknown source'}</span>
                )}
                {x.locator && <span className="text-stone-500">· {x.locator}</span>}
                {x.quoteVerified && (
                  <span className="text-emerald-700" title="Quote found verbatim in the retrieved full text">
                    ✓ verified
                  </span>
                )}
              </div>
              {x.quote && <blockquote className="mt-0.5 border-l-2 border-stone-300 pl-2 text-stone-700 italic">“{x.quote}”</blockquote>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Claim keys as verdict-coloured chips; the statement shows on hover. Links to `#claim-KEY` when `link` is set. */
export function ClaimRefs({ keys, claims, link = true }: { keys: string[]; claims: ClaimView[]; link?: boolean }) {
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {keys.map((k) => {
        const c = claims.find((x) => x.key === k);
        const cls = `rounded px-1 font-mono text-[10px] ${c ? VERDICT_STYLE[c.verdict].badge : 'bg-stone-100'}`;
        const title = c ? `${c.verdict}: ${c.statement}` : undefined;
        return link ? (
          <a key={k} href={`#claim-${k}`} className={cls} title={title}>
            {k}
          </a>
        ) : (
          <span key={k} className={cls} title={title}>
            {k}
          </span>
        );
      })}
    </span>
  );
}

const CHECK_TONE = { PASS: 'text-emerald-700', WARN: 'text-amber-700', FAIL: 'text-red-700 font-semibold' } as const;

/** An automated quality report: checks, review issues and automatic adjustments. */
export function QualityReportView({ report: r, claims, reviewTitle = 'Coherence review' }: { report: QualityReport; claims: ClaimView[]; reviewTitle?: string }) {
  return (
    <div className="space-y-4">
      <Section title={`Automated checks — ${r.passed ? 'passed' : 'FAILED'} (${formatDate(r.generatedAt)})`}>
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-stone-100 align-top">
            {r.checks.map((c) => (
              <tr key={c.id}>
                <td className={`w-16 py-1.5 ${CHECK_TONE[c.status]}`}>{c.status}</td>
                <td className="py-1.5 pr-3 font-medium">{c.label}</td>
                <td className="py-1.5 text-stone-600">{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-stone-500">Passing the gate only allows human review. It is not an approval.</p>
      </Section>
      {r.coherenceIssues.length > 0 && (
        <Section title={`${reviewTitle} (${r.coherenceIssues.length} issue(s))`}>
          <ul className="space-y-1.5 text-sm">
            {r.coherenceIssues.map((i, n) => (
              <li key={n}>
                <span className={i.severity === 'MINOR' ? 'text-stone-500' : 'font-semibold text-orange-700'}>{i.severity}</span> {i.description}
                {i.claimKeys.length > 0 && <ClaimRefs keys={i.claimKeys} claims={claims} link={false} />}
                <div className="text-xs text-stone-500">{i.resolution}</div>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Automatic adjustments (${r.normalizations.length})`}>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-stone-600">
          {r.normalizations.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
