import { blockDurationSec, type Pronunciation, type ScriptBlockClass, type ScriptDelivery, type ScriptVisual, type VoiceScope } from '@docengine/core';
import type { Database, Tx } from '@docengine/database';
import { loadById } from '@docengine/script';
import type { ChunkSection } from './chunking.ts';

/**
 * The script as the voice engine reads it: an approved version's sections
 * and blocks (text, delivery, visual intent), in order. Read only — the
 * voice engine never writes to a script.
 */

export interface VoiceScriptBlock {
  id: string;
  key: string;
  text: string;
  delivery: ScriptDelivery;
  visual: ScriptVisual;
  infoClass: ScriptBlockClass;
  speakerId: string | null;
  /** Position in the whole script. */
  order: number;
  sectionKey: string;
  estimatedDurationSec: number;
}

export interface VoiceScriptSection {
  id: string;
  key: string;
  sequence: number;
  title: string;
  blocks: VoiceScriptBlock[];
}

export interface VoiceScript {
  id: string;
  version: number;
  status: string;
  sections: VoiceScriptSection[];
  pronunciations: Pronunciation[];
  blocks: Map<string, VoiceScriptBlock>;
}

export async function loadScriptForVoice(db: Database | Tx, scriptId: string): Promise<VoiceScript | null> {
  const loaded = await loadById(db, scriptId);
  if (!loaded) return null;
  let order = 0;
  const sections: VoiceScriptSection[] = loaded.draft.sections.map((s) => ({
    id: s.rowId!,
    key: s.key,
    sequence: s.sequence,
    title: s.title,
    blocks: s.blocks.map((b) => ({
      id: b.rowId!,
      key: b.key,
      text: b.text,
      delivery: b.delivery,
      visual: b.visual,
      infoClass: b.infoClass,
      speakerId: b.speakerId,
      order: order++,
      sectionKey: s.key,
      estimatedDurationSec: b.estimatedDurationSec || blockDurationSec(b.text, b.delivery),
    })),
  }));
  return {
    id: loaded.row.id,
    version: loaded.row.version,
    status: loaded.row.status,
    sections,
    pronunciations: loaded.draft.pronunciations,
    blocks: new Map(sections.flatMap((s) => s.blocks.map((b) => [b.key, b] as const))),
  };
}

/** The approved script narration is made from: the newest APPROVED version. */
export async function approvedScript(db: Database | Tx, projectId: string): Promise<{ id: string; version: number } | null> {
  return db.script.findFirst({ where: { projectId, status: 'APPROVED' }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** The blocks a scope covers, in script order, and a description of it. */
export function resolveScope(script: VoiceScript, scope: VoiceScope): { blocks: VoiceScriptBlock[]; description: string } {
  const all = script.sections.flatMap((s) => s.blocks);
  if (!all.length) throw new ScopeError(`Script v${script.version} has no narration blocks`);
  switch (scope.kind) {
    case 'AUDITION': {
      // The opening: whole blocks from the start until about `seconds` of planned narration.
      const out: VoiceScriptBlock[] = [];
      let sec = 0;
      for (const b of all) {
        if (sec >= scope.seconds) break;
        out.push(b);
        sec += b.estimatedDurationSec;
      }
      return { blocks: out, description: `Opening audition: blocks ${out[0]!.key}–${out.at(-1)!.key} (about ${Math.round(sec)} s planned)` };
    }
    case 'SECTION': {
      const section = script.sections.find((s) => s.sequence === scope.section);
      if (!section || !section.blocks.length) throw new ScopeError(`Script v${script.version} has no section ${scope.section}`);
      return { blocks: section.blocks, description: `Section ${section.sequence}: ${section.title}` };
    }
    case 'BLOCKS': {
      const missing = scope.blockKeys.filter((k) => !script.blocks.has(k));
      if (missing.length) throw new ScopeError(`No block ${missing.join(', ')} in script v${script.version}`);
      const wanted = new Set(scope.blockKeys);
      const blocks = all.filter((b) => wanted.has(b.key));
      return { blocks, description: `Blocks ${blocks.map((b) => b.key).join(', ')}` };
    }
    case 'RANGE': {
      const from = all.findIndex((b) => b.key === scope.from);
      const to = all.findIndex((b) => b.key === scope.to);
      if (from === -1 || to === -1) throw new ScopeError(`No block ${from === -1 ? scope.from : scope.to} in script v${script.version}`);
      if (to < from) throw new ScopeError(`Block ${scope.to} comes before ${scope.from}`);
      return { blocks: all.slice(from, to + 1), description: `Blocks ${scope.from} to ${scope.to}` };
    }
    case 'FULL':
      return { blocks: all, description: `The whole script (v${script.version})` };
  }
}

/** The scope's blocks grouped back into their sections, for chunking. */
export function chunkSections(script: VoiceScript, blocks: readonly VoiceScriptBlock[]): ChunkSection[] {
  const wanted = new Set(blocks.map((b) => b.key));
  return script.sections
    .map((s) => ({ id: s.id, key: s.key, blocks: s.blocks.filter((b) => wanted.has(b.key)) }))
    .filter((s) => s.blocks.length > 0);
}
