import { PRODUCTION_METHOD_LABELS, VISUAL_TREATMENT_LABELS, type CostAlternativeView, type CostBucket, type StoryboardVersionView } from '@docengine/core';
import { useState, type ReactNode } from 'react';
import { bucketLabel, bucketRows, estimateUsd, perMinuteText, pricingRows, rollupText, shotCostRows } from '../storyboard-plan.ts';
import { RaceNotice, useEdits, type EditContext } from './storyboard.tsx';
import { primary } from './ui.ts';

/**
 * The Costs tab: the version's forecast by treatment, method, provider,
 * model, section and shot — every figure an estimate made before anything
 * exists, an unpriced shot never counted as $0 — the cheaper alternatives
 * (applied only by a person, as a new version), and the prices it was
 * costed with, each with its source, check date and confidence.
 */
export function CostsTab({ version: v, ctx }: { version: StoryboardVersionView; ctx: EditContext }) {
  const c = v.costs;
  const groups: [string, readonly CostBucket[], (k: string) => string][] = [
    ['By treatment', c.byTreatment, bucketLabel],
    ['By method', c.byMethod, bucketLabel],
    ['By provider', c.byProvider, (k) => (k === 'none' ? 'None needed' : k)],
    ['By model', c.byModel, (k) => (k === 'none' ? 'None needed' : k)],
    ['By section', c.bySection, (k) => k],
  ];
  return (
    <div className="space-y-6">
      <div className="rounded-md bg-stone-100 p-3 text-sm text-stone-800" data-cost-total>
        <p className="font-medium">{rollupText(c)}</p>
        <p className="mt-1 text-xs text-stone-600">
          A forecast of what producing these shots would cost, made before anything exists: never spend, never in the cost ledger. Actual cost: none yet (no asset).
          {perMinuteText(c) ? ` ${perMinuteText(c)}` : ''} Priced with catalog {c.catalogVersion}.
        </p>
        {c.pricingChanged && <p className="mt-1 text-xs text-amber-900">The catalog has changed since this version was saved: the figures here are as they were frozen. A new version (an edit) is costed at today's prices.</p>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map(([title, buckets, label]) => (
          <BucketTable key={title} title={title} buckets={buckets} label={label} />
        ))}
      </div>
      <ShotCosts version={v} />
      <Alternatives version={v} ctx={ctx} />
      <PricingSnapshot version={v} />
    </div>
  );
}

function Table({ head, children, data }: { head: string[]; children: ReactNode; data?: string }) {
  return (
    <div className="overflow-x-auto" data-table={data}>
      <table className="w-full text-left text-xs">
        <thead className="text-stone-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-1 pr-3 font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 align-top">{children}</tbody>
      </table>
    </div>
  );
}

function BucketTable({ title, buckets, label }: { title: string; buckets: readonly CostBucket[]; label: (k: string) => string }) {
  return (
    <section className="min-w-0">
      <h3 className="text-sm font-medium text-stone-800">{title}</h3>
      <Table head={['', 'Shots', 'Estimate', 'Unpriced shots']} data={title}>
        {bucketRows(buckets, label).map((r) => (
          <tr key={r.key}>
            <td className="py-1 pr-3 break-words text-stone-800">{r.label}</td>
            <td className="py-1 pr-3 tabular-nums">{r.shots}</td>
            <td className="py-1 pr-3 tabular-nums">{r.total}</td>
            <td className="py-1 pr-3 tabular-nums">{r.unpriced || ''}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

function ShotCosts({ version: v }: { version: StoryboardVersionView }) {
  return (
    <section className="min-w-0">
      <h3 className="text-sm font-medium text-stone-800">By shot</h3>
      <Table head={['Shot', 'Treatment', 'Method', 'Recommended', 'Generations', 'Estimate']} data="By shot">
        {shotCostRows(v.shots).map((r) => (
          <tr key={r.key}>
            <td className="py-1 pr-3 font-medium">{r.key}</td>
            <td className="py-1 pr-3">{r.treatment}</td>
            <td className="py-1 pr-3">{r.method}</td>
            <td className="py-1 pr-3 break-words">{r.recommendation}</td>
            <td className="py-1 pr-3 tabular-nums">{r.generations}</td>
            <td className="py-1 pr-3 tabular-nums">{r.estimate}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

/** Cheaper ways to show some shots: a person applies one, as a new version; nothing is downgraded by itself. */
function Alternatives({ version: v, ctx }: { version: StoryboardVersionView; ctx: EditContext }) {
  return (
    <section className="space-y-2" data-alternatives>
      <h3 className="text-sm font-medium text-stone-800">Cheaper alternatives</h3>
      {v.alternatives.length ? (
        <ul className="space-y-2">
          {v.alternatives.map((a) => (
            <Alternative key={a.id} alternative={a} ctx={ctx} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-stone-500">None: no cheaper treatment the evidence allows would save anything here.</p>
      )}
    </section>
  );
}

function Alternative({ alternative: a, ctx }: { alternative: CostAlternativeView; ctx: EditContext }) {
  const [confirmed, setConfirmed] = useState(false);
  const edits = useEdits(ctx, () => setConfirmed(false));
  return (
    <li className="min-w-0 rounded-md border border-stone-200 p-2 text-xs" data-alternative={a.id}>
      <p className="font-medium break-words text-stone-900">{a.title}</p>
      <p className="mt-0.5 break-words text-stone-700">
        {a.shotKeys.join(', ')}: {VISUAL_TREATMENT_LABELS[a.from.treatment]} ({PRODUCTION_METHOD_LABELS[a.from.method].toLowerCase()}) → {VISUAL_TREATMENT_LABELS[a.to.treatment]} ({PRODUCTION_METHOD_LABELS[a.to.method].toLowerCase()})
      </p>
      <p className="mt-0.5 text-stone-700">
        {estimateUsd(a.beforeUsd)} → {estimateUsd(a.afterUsd)} · {a.savingUsd !== null ? `saves ${estimateUsd(a.savingUsd)}` : 'the saving is unknown (a side is unpriced)'} · estimates
      </p>
      <p className="mt-0.5 break-words text-stone-500">Trade-off: {a.tradeoff}</p>
      {a.apply.allowed ? (
        <div className="mt-1 space-y-1">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>Apply it to {a.shotKeys.join(', ')} as a new version (no model call; v{ctx.version} is kept).</span>
          </label>
          <button type="button" disabled={!confirmed || edits.pending || edits.race !== null} onClick={() => edits.submit([{ op: 'applyAlternative', alternativeId: a.id }], a.title)} className={primary}>
            Apply → new version
          </button>
        </div>
      ) : (
        a.apply.reason && <p className="mt-1 text-stone-500">{a.apply.reason}</p>
      )}
      {edits.race !== null && (
        <div className="mt-1">
          <RaceNotice race={edits.race} pending={edits.pending} onSaveAnyway={edits.saveAnyway} onReload={ctx.onReload} what="this alternative" />
        </div>
      )}
      {edits.error && <p className="mt-1 break-words text-red-700">{edits.error.message}</p>}
    </li>
  );
}

/** The prices this version was costed with, as frozen when it was saved. */
function PricingSnapshot({ version: v }: { version: StoryboardVersionView }) {
  const rows = pricingRows(v.inputs.pricing);
  return (
    <section className="min-w-0 space-y-1" data-pricing>
      <h3 className="text-sm font-medium text-stone-800">Prices used (catalog {v.inputs.pricing.catalogVersion})</h3>
      <p className="text-xs text-stone-500">As frozen into this version. A card with no price is unpriced: its shots are left out of the totals, never counted as $0.</p>
      <Table head={['Provider', 'Model', 'Methods', 'Rates', 'Checked', 'Confidence', 'Source']} data="Prices used">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="py-1 pr-3 break-words">{r.provider}</td>
            <td className="py-1 pr-3 break-words">{r.label}</td>
            <td className="py-1 pr-3 break-words">{r.methods}</td>
            <td className="py-1 pr-3 break-words">{r.rates}</td>
            <td className="py-1 pr-3 whitespace-nowrap">{r.checkedAt}</td>
            <td className="py-1 pr-3">{r.sure}</td>
            <td className="max-w-xs py-1 pr-3 break-words text-stone-500">
              {r.source}
              {r.rateSources.map((x) => (
                <span key={x} className="mt-0.5 block">
                  {x}
                </span>
              ))}
            </td>
          </tr>
        ))}
      </Table>
    </section>
  );
}

