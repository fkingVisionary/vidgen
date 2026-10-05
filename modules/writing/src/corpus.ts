import { createHash } from 'node:crypto';
import { CorpusManifest, WritingCorpusExample, type WritingCategory, type WritingQuality } from '@docengine/core';
import { CORPUS_FILES, MANIFEST } from '../corpus/index.ts';

/**
 * The Documentary Writing Corpus: the house's editorial memory. Examples live
 * as JSON files in `corpus/examples/{positive,negative,borderline,house_style}`
 * (reviewed like code, bundled into the build), validated here; house-style
 * examples a person approved from the team's own scripts join them from the
 * database. Its version is the manifest's, plus a hash of the exact wording,
 * so a prompt records precisely which examples it was given.
 */

export type CorpusPolarity = 'positive' | 'negative' | 'borderline' | 'house_style';

export interface CorpusEntry extends WritingCorpusExample {
  polarity: CorpusPolarity;
  /** Where it comes from: a corpus file, or the database (approved from an approved script). */
  origin: 'FILE' | 'HOUSE';
  file: string | null;
}

export interface Corpus {
  /** "1.0.0+3f2a9c1d" (manifest version + content hash; "+h…" when house examples joined). */
  version: string;
  manifest: CorpusManifest;
  examples: CorpusEntry[];
  /** Examples that failed validation (a test keeps this empty). */
  errors: string[];
}

const polarityOf = (quality: WritingQuality, dir: string): CorpusPolarity => (dir === 'house_style' ? 'house_style' : quality === 'bad' ? 'negative' : quality === 'borderline' ? 'borderline' : 'positive');

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 8);

let cached: Corpus | null = null;

/** The corpus files, validated (cached: the files are part of the build). */
export function loadCorpus(): Corpus {
  if (cached) return cached;
  const errors: string[] = [];
  const examples: CorpusEntry[] = [];
  const seen = new Set<string>();
  for (const f of CORPUS_FILES) {
    const dir = f.path.split('/')[0] ?? '';
    const list = Array.isArray(f.examples) ? f.examples : [];
    if (!Array.isArray(f.examples)) errors.push(`${f.path}: not a list of examples`);
    list.forEach((raw, i) => {
      const r = WritingCorpusExample.safeParse(raw);
      if (!r.success) {
        errors.push(`${f.path}[${i}]: ${r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
        return;
      }
      if (seen.has(r.data.id)) {
        errors.push(`${f.path}[${i}]: duplicate id ${r.data.id}`);
        return;
      }
      seen.add(r.data.id);
      examples.push({ ...r.data, polarity: polarityOf(r.data.quality, dir), origin: 'FILE', file: f.path });
    });
  }
  const manifest = CorpusManifest.parse(MANIFEST);
  cached = { version: `${manifest.version}+${hash(examples.map(({ file: _f, origin: _o, ...x }) => x))}`, manifest, examples, errors };
  return cached;
}

/** The corpus with the house examples a person approved (from the database) joined in. */
export function withHouseExamples(corpus: Corpus, house: readonly WritingCorpusExample[]): Corpus {
  if (!house.length) return corpus;
  const ids = new Set(corpus.examples.map((e) => e.id));
  const extra = house.filter((h) => !ids.has(h.id)).map((h): CorpusEntry => ({ ...h, polarity: polarityOf(h.quality, h.quality === 'bad' || h.quality === 'borderline' ? '' : 'house_style'), origin: 'HOUSE', file: null }));
  return { ...corpus, version: `${corpus.version}+h${hash(extra.map((e) => [e.id, e.version]))}`, examples: [...corpus.examples, ...extra] };
}

export interface CorpusFilter {
  category?: WritingCategory;
  quality?: WritingQuality;
  polarity?: CorpusPolarity;
  trait?: string;
  /** Only examples approved for retrieval and copyright-safe (the default for prompts). */
  retrievable?: boolean;
}

export function filterCorpus(examples: readonly CorpusEntry[], f: CorpusFilter = {}): CorpusEntry[] {
  return examples.filter(
    (e) =>
      (!f.category || e.category === f.category) &&
      (!f.quality || e.quality === f.quality) &&
      (!f.polarity || e.polarity === f.polarity) &&
      (!f.trait || e.traits.includes(f.trait)) &&
      (!f.retrievable || (e.approvedForRetrieval && e.copyrightSafe)),
  );
}

/** Counts by polarity and category (for the dashboard and the docs). */
export function corpusStats(examples: readonly CorpusEntry[]): { polarity: Record<CorpusPolarity, number>; category: Partial<Record<WritingCategory, number>> } {
  const polarity: Record<CorpusPolarity, number> = { positive: 0, negative: 0, borderline: 0, house_style: 0 };
  const category: Partial<Record<WritingCategory, number>> = {};
  for (const e of examples) {
    polarity[e.polarity]++;
    category[e.category] = (category[e.category] ?? 0) + 1;
  }
  return { polarity, category };
}
