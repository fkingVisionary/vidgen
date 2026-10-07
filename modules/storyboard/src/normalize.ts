import {
  SubjectKey,
  TREATMENT_METHODS,
  beatKey as makeBeatKey,
  shotKey as makeShotKey,
  type ShotSubjectDetail,
  type StoryboardQaFinding,
  type StorySequenceV2,
  type VisualApproach,
} from '@docengine/core';
import type { DraftBlock } from '@docengine/script';
import { normalize as flatten } from '@docengine/story/shared';
import { checkOptions, optionAllowed } from './approaches.ts';
import { isFictional, resolveDetail, resolveSubject } from './continuity.ts';
import { droppedNote, emptyContent, nextKey, type DraftBeat, type DraftShot, type DraftSubject, type ShotContent, type StoryboardDraft, type StoryboardFacts } from './draft.ts';
import { beatBases, blockFacts, claimAllowed, inheritedMustShow, narrativeClass } from './inherit.ts';
import { planStoryboard } from './plan.ts';
import type { BeatsOutput, RepairOutput, ShotOutput, ShotsOutput } from './schemas.ts';
import type { CutPoint, Spine } from './spine.ts';
import { minDurationMs } from './timing.ts';

/**
 * What code does with a model's output before anything is judged (§2.11
 * S3, S5 and S6): every reference resolved — cut points, beats, blocks,
 * architecture beats, claims, cast and subject keys — and anything that
 * does not resolve dropped and noted; beats and shots repaired until the
 * narration is partitioned; a beat that cannot be made valid covered by one
 * placeholder shot with no content (SHOT_UNPLANNED). A model mistake can
 * produce a blocking finding, never a silently wrong timeline.
 */

/** A beat that needed more partition fixes than this goes to the repair call. */
export const REPAIR_FIX_LIMIT = 2;

const flat = (s: string) => flatten(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The script blocks of a narration range (or a silence's neighbours). */
function blocksOf(spine: Spine, from: number, to: number): DraftBlock[] {
  return [...new Set(spine.words.slice(from, to).map((w) => w.blockKey))].map((k) => spine.block(k)!.block);
}
const sequenceOf = (facts: StoryboardFacts, b: DraftBlock): StorySequenceV2 | null => facts.scope.sequences.get(facts.spine.block(b.key)!.sequence) ?? null;

// ── S3: beats ────────────────────────────────────────────────────────────────

/**
 * The beats call resolved: subjects checked against the cast; beats on
 * known cut points, sorted and repaired to partition the narration (a gap
 * goes to the beat before it, an overlap is trimmed), keyed VB01… in clock
 * order; their architecture beats, claims and subjects resolved, a
 * fictional subject taken out of a beat over documented narration, and
 * options outside the class matrix replaced by the seed treatment.
 */
export function resolveBeats(out: BeatsOutput, facts: StoryboardFacts, notes: string[]): { beats: DraftBeat[]; subjects: DraftSubject[] } {
  const spine = facts.spine;
  const scope = facts.scope;
  const subjects: DraftSubject[] = [];
  for (const s of out.subjects) {
    if (!SubjectKey.safeParse(s.key).success) {
      notes.push(droppedNote(s.key, `the subject "${s.name}"`, 'its key is not a subject key such as "CS01"'));
      continue;
    }
    if (subjects.some((x) => x.key === s.key)) {
      notes.push(droppedNote(s.key, `the second subject "${s.name}"`, 'the key is used twice'));
      continue;
    }
    const resolved = resolveSubject({ ...s, castId: s.castId }, scope, notes);
    if (resolved) subjects.push(resolved);
  }
  const known = new Map(subjects.map((s) => [s.key, s]));

  const ranged: { from: CutPoint; to: CutPoint; out: BeatsOutput['beats'][number] }[] = [];
  out.beats.forEach((b, i) => {
    const from = spine.point(b.from);
    const to = spine.point(b.to);
    const ref = `beat ${i + 1}`;
    if (!from || !to) notes.push(droppedNote(ref, `the beat "${b.title}"`, `the cut point ${!from ? b.from : b.to} is not in the narration`));
    else if (from.position >= to.position) notes.push(droppedNote(ref, `the beat "${b.title}"`, `it ends (${b.to}) before it starts (${b.from})`));
    else ranged.push({ from, to, out: b });
  });
  ranged.sort((a, b) => a.from.position - b.from.position);

  // Partition: from the start of the scope to its end, each beat starting where the one before ends.
  const points = spine.points;
  const first = points[0]!;
  const last = points.at(-1)!;
  const kept: typeof ranged = [];
  for (const r of ranged) {
    const prev = kept.at(-1);
    if (!prev) {
      if (r.from.position !== first.position) notes.push(`${r.out.title}: starts at the beginning of the narration (was ${r.from.id})`);
      kept.push({ ...r, from: first });
      continue;
    }
    if (r.from.position > prev.to.position) {
      notes.push(`${prev.out.title}: extended to ${r.from.id} over words no beat covered`);
      prev.to = r.from;
    } else if (r.from.position < prev.to.position) {
      if (r.to.position <= prev.to.position) {
        notes.push(`${r.out.title}: removed — it lies inside the beat before it`);
        continue;
      }
      notes.push(`${r.out.title}: trimmed to start at ${prev.to.id} where the beat before it ends`);
      r.from = prev.to;
    }
    kept.push(r);
  }
  const end = kept.at(-1);
  if (end && end.to.position !== last.position) {
    notes.push(`${end.out.title}: extended to the end of the narration`);
    end.to = last;
  }

  const beats = kept.map((r, i): DraftBeat => {
    const key = makeBeatKey(i + 1);
    const blocks = blocksOf(spine, r.from.position, r.to.position);
    const sequences = [...new Set(blocks.map((b) => sequenceOf(facts, b)))];
    const archBeatIds = r.out.archBeatIds.filter((id) => {
      if (scope.beats.has(id)) return true;
      notes.push(droppedNote(key, `the architecture beat ${id}`, 'it is not in the architecture'));
      return false;
    });
    const claimKeys = [...new Set(r.out.claimKeys)].filter((k) => {
      if (claimAllowed(scope, 'DEPICTS', k, blocks, sequences)) return true;
      notes.push(droppedNote(key, `claim ${k}`, scope.claimSet.has(k) ? 'it is not a claim of the narration the beat covers' : 'it is not in the approved evidence'));
      return false;
    });
    const documented = beatBases(scope, blocks).includes('DOCUMENTED');
    const subjectKeys = [...new Set(r.out.subjectKeys)].filter((k) => {
      const s = known.get(k);
      if (!s) notes.push(droppedNote(key, `the subject ${k}`, 'no such continuity subject'));
      else if (documented && isFictional(s.spec)) notes.push(droppedNote(key, `the subject ${k} (${s.spec.name})`, 'a fictional character is never in a documented scene'));
      else return true;
      return false;
    });
    const cls = narrativeClass(blocks.map((b) => b.infoClass));
    const seed = blocks.map((b) => blockFacts(scope, b, sequenceOf(facts, b)).seed).find((t) => t !== null) ?? null;
    return {
      key,
      narration: { from: r.from.id, to: r.to.id },
      archBeatIds,
      claimKeys,
      content: {
        title: r.out.title,
        purpose: r.out.purpose,
        concept: r.out.concept,
        informationCommunicated: r.out.informationCommunicated,
        narrativePurpose: r.out.narrativePurpose,
        evidenceRelationship: r.out.evidenceRelationship,
        importance: r.out.importance,
        complexity: r.out.complexity,
        continuity: { subjectKeys, notes: r.out.continuityNotes },
        options: checkOptions(key, r.out.options, cls, seed, notes),
      },
    };
  });
  return { beats, subjects };
}

// ── S4: shots ────────────────────────────────────────────────────────────────

interface Built {
  shot: Omit<DraftShot, 'key'>;
  from: number;
  to: number;
  silence: CutPoint | null;
}

/** One shot of the model resolved against the narration, the beat, the subjects and the evidence; null when it cannot be placed. */
function fromOutput(o: ShotOutput, ref: string, beat: DraftBeat, beatRange: { from: CutPoint; to: CutPoint }, facts: StoryboardFacts, subjects: ReadonlyMap<string, DraftSubject>, notes: string[]): Built | null {
  const spine = facts.spine;
  const scope = facts.scope;
  let from: CutPoint | undefined;
  let to: CutPoint | undefined;
  let silence: CutPoint | null = null;
  if (o.narration) {
    from = spine.point(o.narration.from);
    to = spine.point(o.narration.to);
    if (!from || !to) {
      notes.push(droppedNote(ref, 'the shot', `the cut point ${!from ? o.narration.from : o.narration.to} is not in the narration`));
      return null;
    }
    if (from.position >= to.position) {
      notes.push(droppedNote(ref, 'the shot', `its narration ends (${o.narration.to}) before it starts (${o.narration.from})`));
      return null;
    }
    if (o.silenceAt) notes.push(droppedNote(ref, `the silence ${o.silenceAt}`, 'a shot with narration is not silence-only'));
  } else if (o.silenceAt) {
    const p = spine.point(o.silenceAt);
    if (!p) {
      notes.push(droppedNote(ref, 'the silence-only shot', `the cut point ${o.silenceAt} is not in the narration`));
      return null;
    }
    if (p.position < beatRange.from.position || p.position > beatRange.to.position) {
      notes.push(droppedNote(ref, 'the silence-only shot', `${p.id} is outside beat ${beat.key}`));
      return null;
    }
    const length = p.silence.endMs - p.silence.startMs;
    if (length < minDurationMs(o.treatment)) {
      notes.push(droppedNote(ref, 'the silence-only shot', `the silence at ${p.id} lasts ${length} ms, under the ${minDurationMs(o.treatment)} ms minimum`));
      return null;
    }
    silence = p;
  } else {
    notes.push(droppedNote(ref, 'the shot', 'it has neither narration nor a silence'));
    return null;
  }
  const lo = silence ? silence.position : from!.position;
  const hi = silence ? silence.position : to!.position;
  const blocks = silence ? [spine.words[lo - 1]?.blockKey, spine.words[lo]?.blockKey].filter((k): k is string => !!k).map((k) => spine.block(k)!.block) : blocksOf(spine, lo, hi);
  const sequences = [...new Set(blocks.map((b) => sequenceOf(facts, b)))];

  const point = (id: string | null, what: string) => {
    if (!id) return null;
    if (silence) {
      notes.push(droppedNote(ref, `the ${what} ${id}`, 'a silence-only shot has none'));
      return null;
    }
    const p = spine.point(id);
    if (!p) notes.push(droppedNote(ref, `the ${what} ${id}`, 'the cut point is not in the narration'));
    return p?.id ?? null;
  };
  const visualFrom = point(o.visualFrom, 'lead-in from');
  const visualTo = point(o.visualTo, 'tail-out to');

  let method = o.method;
  if (method && !TREATMENT_METHODS[o.treatment].includes(method)) {
    notes.push(`${ref}: ${method} cannot make ${o.treatment}; the router chooses`);
    method = null;
  }
  const knownClaim = (k: string, what: string) => {
    if (scope.claimSet.has(k)) return true;
    notes.push(droppedNote(ref, `claim ${k} of ${what}`, 'it is not in the approved evidence'));
    return false;
  };
  const grounded = <T extends { basis: 'CLAIM' | 'PERIOD_GENERIC' | 'INVENTED'; claimKeys: string[] }>(d: T, what: string): T => {
    const claimKeys = d.claimKeys.filter((k) => knownClaim(k, `"${what}"`));
    if (d.basis === 'CLAIM' && claimKeys.length === 0) {
      notes.push(`${ref}: "${what}" rests on no known claim; marked invented`);
      return { ...d, claimKeys, basis: 'INVENTED' };
    }
    return { ...d, claimKeys };
  };
  const environmentKey = o.environment.subjectKey && subjects.has(o.environment.subjectKey) ? o.environment.subjectKey : null;
  if (o.environment.subjectKey && !environmentKey) notes.push(droppedNote(ref, `the environment ${o.environment.subjectKey}`, 'no such continuity subject'));

  // Claims: known, and allowed for their role over these words.
  const claims: DraftShot['claims'] = [];
  for (const c of o.claims) {
    if (claims.some((x) => x.claimKey === c.claimKey && x.role === c.role)) continue;
    if (!scope.claimSet.has(c.claimKey)) notes.push(droppedNote(ref, `claim ${c.claimKey}`, 'it is not in the approved evidence'));
    else if (!claimAllowed(scope, c.role, c.claimKey, blocks, sequences)) notes.push(droppedNote(ref, `claim ${c.claimKey} (${c.role})`, 'it is not a claim of the narration the shot covers'));
    else claims.push({ claimKey: c.claimKey, role: c.role });
  }
  // The data requirement draws only on claims the shot rests on (a claim of the narration is linked as DATA).
  let dataSpec = o.dataSpec;
  if (dataSpec) {
    const items = dataSpec.items.filter((item) => {
      if (claims.some((c) => c.claimKey === item.claimKey)) return true;
      if (scope.claimSet.has(item.claimKey) && claimAllowed(scope, 'DATA', item.claimKey, blocks, sequences)) {
        claims.push({ claimKey: item.claimKey, role: 'DATA' });
        notes.push(`${ref}: the data cites ${item.claimKey}; linked as data`);
        return true;
      }
      notes.push(droppedNote(ref, `the data item "${item.label}"`, `${item.claimKey} is not a claim of the narration the shot covers`));
      return false;
    });
    dataSpec = items.length ? { ...dataSpec, items } : null;
    if (!items.length) notes.push(droppedNote(ref, 'the data requirement', 'none of its items rests on a claim of the narration'));
  }
  const subjectList: DraftShot['subjects'] = [];
  const keys = new Set(subjects.keys());
  for (const s of o.subjects) {
    if (!subjects.has(s.subjectKey)) {
      notes.push(droppedNote(ref, `the subject ${s.subjectKey}`, 'no such continuity subject'));
      continue;
    }
    if (subjectList.some((x) => x.subjectKey === s.subjectKey)) continue;
    let speaks = s.speaks;
    if (speaks?.claimKey && !scope.claimSet.has(speaks.claimKey)) {
      notes.push(droppedNote(ref, `claim ${speaks.claimKey} of ${s.subjectKey}'s line`, 'it is not in the approved evidence'));
      speaks = { ...speaks, claimKey: null };
    }
    const detail: ShotSubjectDetail = { role: s.role, action: s.action, interactions: s.interactions, likeness: s.likeness, speaks };
    subjectList.push({ subjectKey: s.subjectKey, detail: resolveDetail(ref, detail, keys, notes) });
  }
  const inherited = blocks.flatMap((b) => inheritedMustShow(scope, b, sequenceOf(facts, b)));
  const spec: ShotContent = {
    purpose: o.purpose,
    description: o.description,
    composition: o.composition,
    shotType: o.shotType,
    camera: o.camera,
    movement: o.movement,
    environment: { subjectKey: environmentKey, description: o.environment.description },
    objects: o.objects.map((x) => grounded(x, x.name)),
    lighting: o.lighting,
    mood: o.mood,
    transitionIn: o.transitionIn,
    transitionOut: o.transitionOut,
    continuity: { subjectKeys: [], notes: o.continuityNotes },
    // An inherited must-show keeps the claims the script or the sequence gave it (its caution follows them).
    mustShow: o.mustShow.map((m) => {
      const match = inherited.find((x) => flat(x.detail) === flat(m.detail));
      const own = m.claimKeys.filter((k) => knownClaim(k, `"${m.detail}"`));
      const added = (match?.claimKeys ?? []).filter((k) => !own.includes(k));
      if (added.length) notes.push(`${ref}: the must-show "${m.detail}" rests on ${added.join(', ')}, as the ${match!.origin === 'SCRIPT' ? 'script' : 'sequence'} says`);
      return { detail: m.detail, claimKeys: [...own, ...added], origin: match?.origin ?? ('STORYBOARD' as const) };
    }),
    mustAvoid: o.mustAvoid.map((text) => ({ text, origin: 'STORYBOARD' as const })),
    specifics: o.specifics.map((x) => grounded(x, x.detail)),
    overlays: o.overlays.map((x) => ({ ...x, claimKeys: x.claimKeys.filter((k) => knownClaim(k, `the ${x.kind.toLowerCase()} overlay`)), auto: false })),
    uncertaintyDevice: o.uncertaintyDevice,
    dataSpec,
    styleOverrides: {
      ...(o.style.realism ? { realism: o.style.realism } : {}),
      ...(o.style.filmGrain ? { filmGrain: o.style.filmGrain } : {}),
      ...(o.style.motionIntensity ? { motionIntensity: o.style.motionIntensity } : {}),
      ...(o.style.lighting ? { lighting: o.style.lighting } : {}),
    },
    notes: o.notes,
  };
  return {
    shot: {
      beatKey: beat.key,
      narration: silence ? null : { from: from!.id, to: to!.id },
      silenceAt: silence?.id ?? null,
      visualFrom,
      visualTo,
      cutIn: o.cutIn,
      cutOut: o.cutOut,
      cutOffsetMs: 0,
      treatment: o.treatment,
      method,
      proposedClass: o.infoClass,
      spec,
      subjects: subjectList,
      claims,
      recommendation: null,
      unplanned: false,
    },
    from: lo,
    to: hi,
    silence,
  };
}

/**
 * A beat's shots repaired to partition its words (§2.11 S5): sorted, a gap
 * extends the shot before it, an overlap trims the later shot, a shot left
 * empty is removed, and the first and last meet the beat's edges. A
 * silence-only shot stays only between two of its shots or at an edge.
 * Each fix is one note.
 */
export function repairPartition(beat: DraftBeat, built: Built[], spine: Spine, notes: string[]): { kept: Built[]; fixes: number } {
  const from = spine.point(beat.narration.from)!;
  const to = spine.point(beat.narration.to)!;
  let fixes = 0;
  const fix = (n: string) => {
    fixes++;
    notes.push(n);
  };
  const narrated = built.filter((b) => !b.silence).sort((a, b) => a.from - b.from);
  const kept: Built[] = [];
  for (const b of narrated) {
    const lo = Math.max(b.from, from.position);
    const hi = Math.min(b.to, to.position);
    if (lo !== b.from || hi !== b.to) {
      if (hi <= lo) {
        fix(`${beat.key}: a shot over ${b.shot.narration!.from}–${b.shot.narration!.to} lies outside the beat; removed`);
        continue;
      }
      fix(`${beat.key}: a shot over ${b.shot.narration!.from}–${b.shot.narration!.to} was trimmed to the beat`);
      b.from = lo;
      b.to = hi;
    }
    const prev = kept.at(-1);
    if (prev && b.from > prev.to) {
      fix(`${beat.key}: a shot extended over words no shot covered (${spine.at(prev.to)?.id ?? prev.to}–${spine.at(b.from)?.id ?? b.from})`);
      prev.to = b.from;
    } else if (prev && b.from < prev.to) {
      if (b.to <= prev.to) {
        fix(`${beat.key}: a shot inside the shot before it was removed`);
        continue;
      }
      fix(`${beat.key}: a shot trimmed to start where the shot before it ends`);
      b.from = prev.to;
    }
    kept.push(b);
  }
  if (kept.length) {
    if (kept[0]!.from !== from.position) {
      fix(`${beat.key}: its first shot extended back to the start of the beat`);
      kept[0]!.from = from.position;
    }
    if (kept.at(-1)!.to !== to.position) {
      fix(`${beat.key}: its last shot extended to the end of the beat`);
      kept.at(-1)!.to = to.position;
    }
  }
  // Positions back to cut point ids (every repaired edge is a point another shot or the beat already used).
  for (const b of kept) b.shot.narration = { from: spine.at(b.from)!.id, to: spine.at(b.to)!.id };
  const edges = new Set([from.position, to.position, ...kept.flatMap((b) => [b.from, b.to])]);
  const silences = built
    .filter((b) => b.silence)
    .filter((b, i, all) => {
      const p = b.silence!.position;
      const between = edges.has(p) && (p === from.position || p === to.position || kept.some((k) => k.to === p));
      const once = all.findIndex((x) => x.silence!.position === p) === i;
      if (!between || !once) fix(`${beat.key}: the silence-only shot at ${b.silence!.id} was removed (${!once ? 'another is there' : 'it is not between two of the beat\'s shots'})`);
      return between && once;
    });
  return { kept: [...kept, ...silences].sort((a, b) => a.from - b.from || (a.silence ? 0 : 1) - (b.silence ? 0 : 1)), fixes };
}

export interface ResolvedShots {
  /** The shots, keyed in clock order after every key the draft already uses. */
  shots: DraftShot[];
  /** Beats whose plan could not be made valid (more than REPAIR_FIX_LIMIT fixes, or no shot left): for the repair call. */
  needRepair: string[];
}

/**
 * A shots call resolved for some beats: each shot placed and checked, each
 * beat's shots repaired to partition it; a beat named in no shot, or beyond
 * the repair limit, is listed for the repair call.
 */
export function resolveShots(shots: readonly ShotOutput[], beats: readonly DraftBeat[], draft: Pick<StoryboardDraft, 'shots' | 'subjects'>, facts: StoryboardFacts, notes: string[], usedKeys: Iterable<string> = []): ResolvedShots {
  const spine = facts.spine;
  const subjects = new Map(draft.subjects.map((s) => [s.key, s]));
  const byBeat = new Map<string, Built[]>(beats.map((b) => [b.key, []]));
  shots.forEach((o, i) => {
    const ref = `shot ${i + 1} (${o.beatKey})`;
    const beat = beats.find((b) => b.key === o.beatKey);
    if (!beat) {
      notes.push(droppedNote(ref, 'the shot', `${o.beatKey} is not a beat of this request`));
      return;
    }
    const range = { from: spine.point(beat.narration.from)!, to: spine.point(beat.narration.to)! };
    const built = fromOutput(o, ref, beat, range, facts, subjects, notes);
    if (built) byBeat.get(beat.key)!.push(built);
  });
  const keys = new Set([...draft.shots.map((s) => s.key), ...usedKeys]);
  const out: DraftShot[] = [];
  const needRepair: string[] = [];
  // A silence holds one shot: two beats meeting at a pause cannot both put one there.
  const silences = new Set(draft.shots.flatMap((s) => (s.silenceAt && spine.point(s.silenceAt) ? [spine.point(s.silenceAt)!.position] : [])));
  for (const beat of beats) {
    const { kept, fixes } = repairPartition(beat, byBeat.get(beat.key)!, spine, notes);
    if (fixes > REPAIR_FIX_LIMIT || !kept.some((b) => !b.silence)) {
      needRepair.push(beat.key);
      if (!kept.some((b) => !b.silence)) notes.push(`${beat.key}: no shot could be placed over its words`);
    }
    for (const b of kept) {
      if (b.silence) {
        if (silences.has(b.silence.position)) {
          notes.push(`${beat.key}: the silence-only shot at ${b.silence.id} was removed (another shot already holds that silence)`);
          continue;
        }
        silences.add(b.silence.position);
      }
      const key = nextKey(keys, makeShotKey);
      keys.add(key);
      out.push({ ...b.shot, key });
    }
  }
  return { shots: out, needRepair };
}

/** A beat's concept or treatment revised by a beat re-plan (a treatment outside the class matrix is refused, and noted). */
export function applyBeatRevisions(beats: DraftBeat[], revisions: ShotsOutput['beats'], approach: VisualApproach, facts: StoryboardFacts, notes: string[]): DraftBeat[] {
  return beats.map((b) => {
    const r = revisions.find((x) => x.beatKey === b.key);
    if (!r) return b;
    let content = b.content;
    if (r.concept) content = { ...content, concept: r.concept };
    if (r.treatment) {
      const range = { from: facts.spine.point(b.narration.from)!, to: facts.spine.point(b.narration.to)! };
      const cls = narrativeClass(blocksOf(facts.spine, range.from.position, range.to.position).map((x) => x.infoClass));
      if (optionAllowed(r.treatment, cls)) content = { ...content, options: { ...content.options, [approach]: { ...content.options[approach], treatment: r.treatment } } };
      else notes.push(droppedNote(b.key, `the treatment ${r.treatment}`, `it is not allowed over ${cls} narration`));
    }
    return { ...b, content };
  });
}

// ── S6: repair, and the placeholder ──────────────────────────────────────────

/** The blocking kinds a repair call may fix. */
export const REPAIRABLE: readonly StoryboardQaFinding['kind'][] = [
  'CLAIM_INVALID',
  'UNCERTAIN_AS_FACT',
  'GENERATED_RECORD',
  'FICTION_IN_DOCUMENTED',
  'FICTION_REAL_INTERACTION',
  'FICTION_WITH_FACTS',
  'INVENTED_CHARACTER',
  'INVENTED_DETAIL_DOCUMENTED',
  'REAL_LIKENESS',
  'OVERLAY_UNSUPPORTED',
  'EVIDENCE_MISSING',
];

/** The beats with repairable blocking findings (a finding on a shot counts for its beat). */
export function beatsToRepair(draft: Pick<StoryboardDraft, 'shots'>, qa: readonly StoryboardQaFinding[]): string[] {
  const beatOf = new Map(draft.shots.map((s) => [s.key, s.beatKey]));
  return [...new Set(qa.filter((f) => f.severity === 'BLOCKING' && REPAIRABLE.includes(f.kind) && f.ref).flatMap((f) => (beatOf.get(f.ref!) ? [beatOf.get(f.ref!)!] : /^VB\d+$/.test(f.ref!) ? [f.ref!] : [])))];
}

/** Blocking findings as counts by what they say, shot keys masked (a replacement shot has a new key but may say the same). */
function blockingOf(qa: readonly StoryboardQaFinding[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of qa) {
    if (f.severity !== 'BLOCKING') continue;
    const k = `${f.kind}\u0000${f.detail.replace(/\bSH\d{3,5}\b/g, 'SH')}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Findings in `b` beyond those in `a`. */
const beyond = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) => [...b].reduce((n, [k, c]) => n + Math.max(0, c - (a.get(k) ?? 0)), 0);

/**
 * The repair call's replacements, judged beat by beat as reviewPatch judges a
 * change: a beat's new shots are kept only when they remove blocking
 * findings and add none — or, for a beat sent by the partition limit
 * (`partition`, resolveShots' needRepair), when they cover it within the
 * limit and add none, since code's own fixes left it without a finding to
 * remove. Then the whole set is checked once more, and if together they add
 * any blocking finding none is kept. Every decision is noted.
 */
export function applyRepair(draft: StoryboardDraft, out: RepairOutput, facts: StoryboardFacts, notes: string[], o: { partition?: readonly string[]; usedKeys?: readonly string[] } = {}): { draft: StoryboardDraft; kept: string[] } {
  const baseline = blockingOf(planStoryboard(draft, facts).qa);
  let current = draft;
  const kept: string[] = [];
  for (const r of out.beats) {
    const beat = draft.beats.find((b) => b.key === r.beatKey);
    if (!beat) {
      notes.push(droppedNote(`repair of ${r.beatKey}`, 'the replacement', 'no such beat'));
      continue;
    }
    const local: string[] = [];
    const others = current.shots.filter((s) => s.beatKey !== beat.key);
    const resolved = resolveShots(r.shots, [beat], { shots: others, subjects: current.subjects }, facts, local, [...current.shots.map((s) => s.key), ...(o.usedKeys ?? [])]);
    if (resolved.needRepair.length) {
      notes.push(`${beat.key}: the repair was not kept — its shots still do not cover the beat (${local.length} fixes needed)`);
      continue;
    }
    const candidate: StoryboardDraft = { ...current, shots: sortShots([...others, ...resolved.shots], facts.spine) };
    const now = blockingOf(planStoryboard(candidate, facts).qa);
    const before = blockingOf(planStoryboard(current, facts).qa);
    const added = beyond(before, now);
    const removed = beyond(now, before);
    const partition = o.partition?.includes(beat.key) ?? false;
    if (added || (removed === 0 && !partition)) {
      notes.push(`${beat.key}: the repair was not kept — ${added ? `it adds ${added} blocking finding(s)` : 'it removes no blocking finding'}`);
      continue;
    }
    notes.push(...local);
    notes.push(`${beat.key}: re-planned by the repair (${removed ? `${removed} blocking finding(s) removed` : 'its shots now cover it within the repair limit'})`);
    current = candidate;
    kept.push(beat.key);
  }
  if (kept.length) {
    if (beyond(baseline, blockingOf(planStoryboard(current, facts).qa)) > 0) {
      notes.push(`The repairs of ${kept.join(', ')} were not kept: together they add blocking findings`);
      return { draft, kept: [] };
    }
  }
  return { draft: current, kept };
}

/** One placeholder shot covering a beat whose plan could not be made valid: no content, so it blocks (SHOT_UNPLANNED). */
export function unplannedShot(beat: DraftBeat, key: string): DraftShot {
  return {
    key,
    beatKey: beat.key,
    narration: { ...beat.narration },
    silenceAt: null,
    visualFrom: null,
    visualTo: null,
    cutIn: 'BEAT_CHANGE',
    cutOut: 'BEAT_CHANGE',
    cutOffsetMs: 0,
    treatment: null,
    method: null,
    proposedClass: null,
    spec: emptyContent(),
    subjects: [],
    claims: [],
    recommendation: null,
    unplanned: true,
  };
}

/** The draft with these beats covered by placeholders instead of their shots (keyed after every key in the draft and `usedKeys`). */
export function markUnplanned(draft: StoryboardDraft, beatKeys: readonly string[], facts: StoryboardFacts, notes: string[], usedKeys: readonly string[] = []): StoryboardDraft {
  if (!beatKeys.length) return draft;
  const set = new Set(beatKeys);
  const keys = new Set([...draft.shots.map((s) => s.key), ...usedKeys]);
  const placeholders = draft.beats.filter((b) => set.has(b.key)).map((b) => {
    const key = nextKey(keys, makeShotKey);
    keys.add(key);
    notes.push(`${b.key}: no valid plan; one placeholder shot (${key}) covers it until it is edited or re-planned`);
    return unplannedShot(b, key);
  });
  return { ...draft, shots: sortShots([...draft.shots.filter((s) => !set.has(s.beatKey)), ...placeholders], facts.spine) };
}

/** Shots in clock order (a silence-only shot before the narrated shot starting at its point). */
export function sortShots(shots: readonly DraftShot[], spine: Spine): DraftShot[] {
  const at = (s: DraftShot) => {
    const p = spine.point(s.narration?.from ?? s.silenceAt ?? '');
    return p ? p.position * 2 + (s.narration ? 1 : 0) : Number.MAX_SAFE_INTEGER;
  };
  return shots.map((s, i) => ({ s, i })).sort((a, b) => at(a.s) - at(b.s) || a.i - b.i).map((x) => x.s);
}
