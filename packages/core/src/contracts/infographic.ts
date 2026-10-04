import { z } from 'zod';

/**
 * Infographic specification.
 *
 * The AI *proposes* a spec; the application *renders* it deterministically.
 * Factual charts are never generated as AI images. This schema is the
 * boundary that keeps numbers exact and sources attached:
 *   - every numeric value is a finite number (zod rejects NaN/Infinity),
 *   - a source citation is mandatory,
 *   - approximate values must be flagged as such,
 *   - cross-references (routes → locations, edges → nodes) must resolve.
 */

const DataPoint = z.object({
  label: z.string().min(1),
  value: z.number(),
  /** True when the historical figure is an estimate/reconstruction — rendered with a "≈"/note. */
  approximate: z.boolean().default(false),
  note: z.string().optional(),
});

const Series = z.object({
  name: z.string().min(1),
  unit: z.string().optional(),
  points: z.array(DataPoint).min(1),
});

const Annotation = z.object({
  text: z.string().min(1).max(200),
  /** Label of the point/event/node the annotation attaches to, if any. */
  target: z.string().optional(),
});

const SourceRef = z.object({
  /** Human-readable citation shown on screen / in the description. Required. */
  citation: z.string().trim().min(3),
  /** Research Source ids backing the data. */
  sourceIds: z.array(z.uuid()).default([]),
  notes: z.string().optional(),
});

const Base = z.object({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  annotations: z.array(Annotation).default([]),
  source: SourceRef,
  animation: z.enum(['NONE', 'DRAW', 'GROW', 'COUNT_UP', 'REVEAL']).default('REVEAL'),
  durationSec: z.number().min(1).max(60),
});

const SeriesChart = { series: z.array(Series).min(1) };

export const InfographicSpec = z
  .discriminatedUnion('chartType', [
    Base.extend({ chartType: z.literal('LINE_CHART'), ...SeriesChart }),
    Base.extend({ chartType: z.literal('BAR_CHART'), ...SeriesChart }),
    Base.extend({ chartType: z.literal('PRICE_CHANGE'), ...SeriesChart, currency: z.string().min(1) }),
    Base.extend({
      chartType: z.literal('COMPARISON'),
      items: z.array(DataPoint.extend({ unit: z.string().optional() })).min(2),
    }),
    Base.extend({
      chartType: z.literal('NUMBER_COUNTER'),
      value: z.number(),
      from: z.number().default(0),
      unit: z.string().optional(),
      decimals: z.number().int().min(0).max(6).default(0),
      approximate: z.boolean().default(false),
    }),
    Base.extend({
      chartType: z.literal('TIMELINE'),
      events: z
        .array(
          z.object({
            /** Free-form historical date ("1636-11", "February 1637", "c. 1593"). */
            date: z.string().min(1),
            label: z.string().min(1),
            approximate: z.boolean().default(false),
          }),
        )
        .min(2),
    }),
    Base.extend({
      chartType: z.literal('MAP'),
      region: z.string().min(1),
      locations: z
        .array(z.object({ name: z.string().min(1), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }))
        .min(1),
      routes: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).default([]),
    }),
    Base.extend({
      chartType: z.literal('FLOW_DIAGRAM'),
      nodes: z.array(z.object({ id: z.string().min(1), label: z.string().min(1) })).min(2),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).min(1),
    }),
    Base.extend({
      chartType: z.literal('ECONOMIC_CYCLE'),
      phases: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(3),
    }),
  ])
  .superRefine((spec, ctx) => {
    switch (spec.chartType) {
      case 'MAP': {
        const names = new Set(spec.locations.map((l) => l.name));
        spec.routes.forEach((r, i) => {
          for (const end of ['from', 'to'] as const) {
            if (!names.has(r[end])) {
              ctx.addIssue({ code: 'custom', path: ['routes', i, end], message: `Unknown location "${r[end]}"` });
            }
          }
        });
        break;
      }
      case 'FLOW_DIAGRAM': {
        const ids = new Set(spec.nodes.map((n) => n.id));
        if (ids.size !== spec.nodes.length) {
          ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'Node ids must be unique' });
        }
        spec.edges.forEach((e, i) => {
          for (const end of ['from', 'to'] as const) {
            if (!ids.has(e[end])) {
              ctx.addIssue({ code: 'custom', path: ['edges', i, end], message: `Unknown node "${e[end]}"` });
            }
          }
        });
        break;
      }
      default:
        break;
    }
  });
export type InfographicSpec = z.infer<typeof InfographicSpec>;
