import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VISUAL_PROFILE_PRESETS } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { PLANNED_PROVIDERS } from '../registry.ts';
import { createVisualCatalog } from './catalog.ts';

/**
 * Treatment before provider: the visual vendors live only in
 * packages/providers. A static guard over core (contracts, enums, presets),
 * the Prisma schema and the storyboard engine, tests included (their
 * fixtures use acme-* names): none names a visual vendor or a model maker.
 * The names come from the catalog's own vendor cards, plus the makers the
 * brief and its decisions mention that are not catalogued.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');

/** Cards that are not vendors: their ids are generic words. */
const GENERIC = new Set(['in-house', 'archival', 'stock', 'mock']);
const UNCATALOGUED = ['veo', 'seedance', 'hailuo', 'midjourney'];

function vendorNames(): string[] {
  const names = new Set(UNCATALOGUED);
  for (const card of createVisualCatalog().cards) {
    if (GENERIC.has(card.provider)) continue;
    names.add(card.provider);
    // Model ids name their maker first: "kling-video/v3.0/…", "higgsfield-ai/soul/…".
    for (const m of card.models) names.add(m.model.split('/')[0]!.replace(/-(video|ai)$/, ''));
  }
  return [...names].sort();
}

const NAMES = vendorNames();
const pattern = (names: readonly string[]) => new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const VENDOR = pattern(NAMES);

/**
 * The storyboard engine and the seeded presets are new and name no vendor at
 * all: no AI, research or voice vendor the registry configures, no AI model
 * family, no vendor it plans. Core predates this rule and still names a voice
 * and a research vendor, so core is held to the visual names only.
 */
const ANY_VENDOR = pattern([...NAMES, 'anthropic', 'claude', 'elevenlabs', 'tavily', ...Object.values(PLANNED_PROVIDERS).flat()]);

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

function hits(paths: string[], names = VENDOR): string[] {
  return paths.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, i) => (names.test(line) ? [`${relative(root, path)}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe('visual vendor names', () => {
  it('are taken from the catalog, so a new vendor card is guarded at once', () => {
    expect(NAMES).toEqual(expect.arrayContaining(['higgsfield', 'kling', 'veo']));
    expect(NAMES).not.toContain('mock');
  });

  it('appear nowhere in core: contracts, enums, labels, views or presets', () => {
    const files = sources(join(root, 'packages/core/src'));
    expect(files.map((f) => relative(root, f))).toEqual(expect.arrayContaining(['packages/core/src/enums.ts', 'packages/core/src/contracts/storyboard.ts', 'packages/core/src/contracts/visual-profile.ts']));
    expect(hits(files)).toEqual([]);
  });

  it('appear nowhere in the Prisma schema (no vendor enum value or column)', () => {
    expect(hits([join(root, 'packages/database/prisma/schema.prisma')])).toEqual([]);
  });

  it('appear nowhere in the storyboard engine, its tests and fixtures included, nor does any other vendor or model family', () => {
    expect(hits(sources(join(root, 'modules/storyboard/src')), ANY_VENDOR)).toEqual([]);
  });

  it('appear in no seeded visual preset', () => {
    expect(VISUAL_PROFILE_PRESETS.filter((p) => ANY_VENDOR.test(JSON.stringify(p))).map((p) => p.key)).toEqual([]);
  });

  it('the guard itself catches a vendor and passes a synthetic fixture', () => {
    expect(VENDOR.test("providerPreferences: { GENERATIVE_VIDEO: [{ provider: 'higgsfield' }] }")).toBe(true);
    expect(VENDOR.test('model: "Kling 3.0 Pro"')).toBe(true);
    expect(VENDOR.test("{ provider: 'acme-video', model: 'acme-v1' }")).toBe(false);
    expect(ANY_VENDOR.test("const voice = { provider: 'elevenlabs' };")).toBe(true);
    expect(ANY_VENDOR.test('// planned with the Claude model')).toBe(true);
    expect(ANY_VENDOR.test("ctx.callProvider('ai', 'generateObject', input)")).toBe(false);
  });
});
