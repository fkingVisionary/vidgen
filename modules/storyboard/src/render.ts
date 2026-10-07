import { VISUAL_APPROACH_LABELS, type StoryboardInputs, type StoryboardQaFinding, type StorySequenceV2, type VisualApproach } from '@docengine/core';
import type { DraftBlock } from '@docengine/script';
import type { DraftBeat, DraftShot, DraftSubject, StoryboardFacts } from './draft.ts';
import { blockFacts } from './inherit.ts';
import type { CutPoint, SpineBlock } from './spine.ts';

/**
 * The briefs a planning call reads (§2.11 S1), as text: per block its
 * class, beats, claims with their verdicts and presentation, the script's
 * visual hints, delivery, times, the treatments the class matrix allows and
 * any label obligation, and its words with the cut points between them; per
 * section its setting with each field's basis, the architecture's visual
 * thinking, continuity and plan; the cast, the data the evidence gives, the
 * period and place of the story candidates behind the sections, and the
 * continuity candidates. Only the claims the narration cites are
 * included — never a raw dossier. Deterministic: the same facts, the same
 * brief.
 */

/** "1:04.2" on the narration clock. */
export function clock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const list = (xs: readonly string[]) => xs.filter((x) => x.trim()).join('; ');

/** A cut point as the brief marks it between words: its id, kind and silence. */
function marker(p: CutPoint): string {
  const pause = p.silence.endMs - p.silence.startMs;
  return `⟦${p.id} ${p.kind.toLowerCase()}${pause >= 100 ? ` · ${seconds(pause)} silence` : ''}${p.clipEdge ? ' · clip edge' : ''}⟧`;
}

/** A block's words with every cut point inside or around it marked. */
export function markedText(facts: StoryboardFacts, b: SpineBlock): string {
  const spine = facts.spine;
  const parts: string[] = [];
  for (let i = b.first; i <= b.last; i++) {
    const p = spine.at(i);
    if (p) parts.push(marker(p));
    const w = spine.words[i]!;
    parts.push(w.timed ? w.text : `${w.text}°`);
  }
  const end = spine.at(b.last + 1);
  if (end) parts.push(marker(end));
  return parts.join(' ');
}

const sequenceOf = (facts: StoryboardFacts, b: SpineBlock): StorySequenceV2 | null => facts.scope.sequences.get(b.sequence) ?? null;

function claimLine(facts: StoryboardFacts, key: string): string | null {
  const c = facts.scope.evidence.claim(key);
  if (!c || !facts.scope.claimSet.has(key)) return null;
  const p = facts.scope.presentation.get(key);
  const sources = facts.scope.evidence.traceableSources(key).length;
  return `${key} (${c.verdict}, ${c.confidence} confidence${p ? `; present as ${p.presentation}: ${p.instruction}` : ''}; ${sources ? `${sources} traceable source${sources === 1 ? '' : 's'}` : 'no traceable source'}): ${c.statement}`;
}

/** One block's brief: its class and words, what it rests on, and what it allows. */
export function blockBrief(facts: StoryboardFacts, b: SpineBlock): string {
  const block: DraftBlock = b.block;
  const scope = facts.scope;
  const f = blockFacts(scope, block, sequenceOf(facts, b));
  const beats = block.beatIds.flatMap((id) => {
    const x = scope.beats.get(id);
    return x ? [`${id} ${x.beat.function} (${x.beat.basis}${x.beat.castIds.length ? `; cast ${x.beat.castIds.join(', ')}` : ''}): ${x.beat.description}`] : [];
  });
  const claimKeys = [...new Set([...block.claimKeys, ...block.beatIds.flatMap((id) => scope.beats.get(id)?.beat.claimKeys ?? [])])];
  const claims = claimKeys.flatMap((k) => (claimLine(facts, k) ? [claimLine(facts, k)!] : []));
  const v = block.visual;
  const d = block.delivery;
  const pauses = [d.pauseBefore.length !== 'NONE' ? `${d.pauseBefore.length.toLowerCase()} pause before${d.pauseBefore.reason ? ` (${d.pauseBefore.reason.toLowerCase()})` : ''}` : '', d.pauseAfter.length !== 'NONE' ? `${d.pauseAfter.length.toLowerCase()} pause after${d.pauseAfter.reason ? ` (${d.pauseAfter.reason.toLowerCase()})` : ''}` : ''];
  const lines = [
    `### Block ${b.key} · ${block.infoClass}${block.fictionalDevice ? ' · fictional device' : ''}${block.speakerId ? ` · spoken by ${block.speakerId} (${block.speechKind ?? 'narration'})` : ''}${block.centralQuestion ? ` · central question ${block.centralQuestion.toLowerCase()}` : ''} · ${clock(b.startMs)}–${clock(b.endMs)} (${seconds(b.endMs - b.startMs)})`,
    beats.length ? `Architecture beats: ${beats.join(' | ')}` : 'Architecture beats: none',
    claims.length ? `Claims:\n${claims.map((c) => `- ${c}`).join('\n')}` : 'Claims: none (nothing here may be depicted as fact)',
    `Script's visual hint (a hint, not a decision): intent ${v.intent}, priority ${v.priority}${v.note ? `; note: ${v.note}` : ''}`,
    ...(f.mustShow.length ? [`Must show: ${f.mustShow.map((m) => `"${m.detail}"${m.claimKeys.length ? ` [${m.claimKeys.join(', ')}]` : ''}${m.caution ? ` — ${m.caution}` : ''} (${m.origin.toLowerCase()})`).join('; ')}`] : []),
    ...(f.mustAvoid.length ? [`Must avoid: ${f.mustAvoid.map((m) => m.text).join('; ')}`] : []),
    `Delivery: ${d.emotion.toLowerCase()}, ${d.pace.toLowerCase()} pace${list(pauses) ? `; ${list(pauses)}` : ''}`,
    `Treatments allowed over ${block.infoClass} words: ${f.treatments.join(', ')}${f.seed ? `; the script's intent suggests ${f.seed}` : ''}`,
    ...(f.labelObligation ? ['Label obligation: the script promised an on-screen label for the fictional device here (code adds it to the first shot over the block).'] : []),
    `Words (° = not timed, never a cut):\n${markedText(facts, b)}`,
  ];
  return lines.join('\n');
}

const basis = (f: { value: string; basis: string }) => (f.value ? `${f.value} (${f.basis})` : 'not given');

/** A section's brief: the architecture sequence it tells and the script's plan for it. */
export function sectionBrief(facts: StoryboardFacts, sectionKey: string): string {
  const section = facts.script.sections.find((s) => s.key === sectionKey)!;
  const seq = facts.scope.sequences.get(section.sequence) ?? null;
  const lines = [`## Section ${section.sequence} (${section.key}): ${section.title}`];
  if (seq) {
    lines.push(`Setting: location ${basis(seq.setting.location)}; date ${basis(seq.setting.date)}; time of day ${basis(seq.setting.timeOfDay)}. A date or place stamp needs a DOCUMENTED field or a claim.`);
    const v = seq.visual;
    lines.push(
      `Architecture's visual thinking: ${list([
        v.environment ? `environment ${v.environment}` : '',
        v.keyObjects.length ? `key objects ${v.keyObjects.join(', ')}` : '',
        v.physicalActions.length ? `actions ${v.physicalActions.join(', ')}` : '',
        v.emotionalState ? `emotional state ${v.emotionalState}` : '',
        v.visualMetaphor ? `metaphor ${v.visualMetaphor}` : '',
        v.mustShow.length ? `must show ${v.mustShow.map((m) => `"${m.detail}"${m.claimKeys.length ? ` [${m.claimKeys.join(', ')}]` : ''}`).join(', ')}` : '',
        v.mustAvoid.length ? `must avoid ${v.mustAvoid.join(', ')}` : '',
        v.shotIdeas.length ? `ideas ${v.shotIdeas.join(', ')}` : '',
      ]) || 'none'}`,
    );
    lines.push(`Continuity: ${list([seq.continuity.carriesIn.length ? `carries in ${seq.continuity.carriesIn.join(', ')}` : '', seq.continuity.carriesOut.length ? `carries out ${seq.continuity.carriesOut.join(', ')}` : '', `time jump ${seq.continuity.timeJump}`])}`);
    if (seq.contextClaims.length) lines.push(`Background claims (CONTEXT or PERIOD_BASIS only): ${seq.contextClaims.map((c) => `${c.claimKey} (${c.purpose})`).join('; ')}`);
  }
  const plan = section.plan;
  if (plan) lines.push(`Script plan: ${list([plan.purpose, plan.showNotSay.length ? `show, don't say: ${plan.showNotSay.join(', ')}` : '', plan.tension ? `tension: ${plan.tension}` : '', plan.reveal ? `reveal: ${plan.reveal}` : '', plan.sparse ? 'sparse narration: let pictures carry it' : ''])}`);
  return lines.join('\n');
}

/** The cast, by id: who may appear, and how. */
export function castBrief(facts: StoryboardFacts): string {
  const cast = [...facts.scope.cast.values()];
  if (!cast.length) return '## Cast\nNone: any figure on screen is anonymous.';
  return `## Cast (characters are these, by id, or anonymous figures)\n${cast.map((c) => `- ${c.member.id} ${c.member.name} (${c.member.kind}${c.fictional ? ', a fictional device' : ', real'})${c.member.claimKeys.length ? ` [${c.member.claimKeys.join(', ')}]` : ''}: ${c.member.description}`).join('\n')}`;
}

/** What the evidence gives for charts, timelines and maps: items tied to the claims the architecture cites. */
export function dataBrief(facts: StoryboardFacts): string {
  const content = facts.scope.evidence.content;
  const cited = (keys: readonly string[]) => keys.filter((k) => facts.scope.claimSet.has(k));
  const lines = [
    ...content.priceEvidence.flatMap((p) => (cited(p.claimKeys).length ? [`- price: ${p.item}, ${p.price}${p.currency ? ` ${p.currency}` : ''}${p.date ? `, ${p.date}` : ''} [${cited(p.claimKeys).join(', ')}]`] : [])),
    ...content.timeline.flatMap((t) => (cited(t.claimKeys).length ? [`- dated: ${t.date}${t.approximate ? ' (approximate)' : ''} — ${t.event} [${cited(t.claimKeys).join(', ')}]`] : [])),
    ...content.keyFigures.flatMap((k) => (cited(k.claimKeys).length ? [`- person: ${k.name}, ${k.role} [${cited(k.claimKeys).join(', ')}]`] : [])),
  ];
  return `## Data the evidence gives (a chart, timeline or map draws only on these, each figure as written in its claim)\n${lines.length ? lines.join('\n') : 'None.'}`;
}

/** Who and what could recur: the cast in these beats, the settings, and the story candidates' places and periods. */
export function continuityBrief(facts: StoryboardFacts, sequences: readonly number[]): string {
  const scope = facts.scope;
  const seqs = sequences.flatMap((n) => (scope.sequences.get(n) ? [scope.sequences.get(n)!] : []));
  const castIds = [...new Set(seqs.flatMap((s) => s.beats.flatMap((b) => b.castIds)))];
  const lines = [
    castIds.length ? `- cast in these beats: ${castIds.map((id) => `${id} ${scope.cast.get(id)?.member.name ?? '(not in the cast)'}`).join(', ')}` : '',
    ...seqs.map((s) => `- section ${s.number}: ${list([s.setting.location.value ? `place ${basis(s.setting.location)}` : '', s.visual.environment ? `environment ${s.visual.environment}` : '', s.visual.keyObjects.length ? `objects ${s.visual.keyObjects.join(', ')}` : ''])}`),
  ].filter(Boolean);
  return `## Continuity candidates\n${lines.length ? lines.join('\n') : 'None.'}`;
}

/** The story candidates behind these sections, by section: their period, setting and what was on screen (era context, never a claim). */
export function eraBrief(facts: StoryboardFacts, candidates: StoryboardInputs['candidates'], sequences: readonly number[]): string | null {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const lines = sequences.flatMap((n) => {
    const own = (facts.scope.sequences.get(n)?.candidateIds ?? []).flatMap((id) => (byId.get(id) ? [byId.get(id)!] : []));
    return own.length ? [`- section ${n}: ${own.map((c) => `${c.key} — ${list([c.timePeriod, c.setting, c.visualEnvironment ? `on screen: ${c.visualEnvironment}` : ''])}`).join(' | ')}`] : [];
  });
  return lines.length ? `## Period and place (the story candidates these sections tell: era context for the look, never a claim to depict)\n${lines.join('\n')}` : null;
}

/** The continuity subjects of the version, by key. */
export function subjectsBrief(subjects: readonly DraftSubject[]): string {
  if (!subjects.length) return '## Continuity subjects\nNone yet.';
  return `## Continuity subjects (use these keys)\n${subjects
    .map((s) => {
      const x = s.spec;
      return `- ${s.key} ${x.name} (${x.kind}${x.castId ? `, cast ${x.castId}` : x.anonymous ? ', anonymous' : ''}; ${x.basis}): ${x.description}${x.rules.length ? ` Rules: ${x.rules.join('; ')}.` : ''}${x.designDetails.length ? ` Details: ${x.designDetails.map((d) => `${d.detail} (${d.basis})`).join('; ')}.` : ''}`;
    })
    .join('\n')}`;
}

function header(facts: StoryboardFacts, title: string): string {
  const n = facts.spine.narration;
  const approved = n.takes.filter((t) => t.status === 'APPROVED').length;
  return [
    `# ${title}`,
    `Narration: voice run ${n.run.number} (${n.run.kind.toLowerCase()}), assembly v${n.assembly.version}, ${seconds(facts.spine.totalDurationMs)}; ${facts.spine.blocks.length} block(s) narrated${facts.spine.outOfScope.length ? `, ${facts.spine.outOfScope.length} of the script not narrated (out of scope)` : ''}; takes ${approved}/${n.takes.length} approved.`,
  ].join('\n');
}

/** The blocks of the scope in these sections, each with its section brief once. */
function narrationBriefs(facts: StoryboardFacts, blocks: readonly SpineBlock[]): string {
  const out: string[] = [];
  let section: string | null = null;
  for (const b of blocks) {
    if (b.sectionKey !== section) {
      section = b.sectionKey;
      out.push(sectionBrief(facts, b.sectionKey));
    }
    out.push(blockBrief(facts, b));
  }
  return out.join('\n\n');
}

/** The beats call's brief: the whole scope, or one section of a long one (with the subjects proposed so far). */
export function beatsPrompt(facts: StoryboardFacts, o: { title: string; sequence?: number; subjects?: readonly DraftSubject[]; candidates?: StoryboardInputs['candidates'] }): string {
  const blocks = facts.spine.blocks.filter((b) => o.sequence === undefined || b.sequence === o.sequence);
  // A section's edge beside an untimed word is no cut point: the nearest ones outside it are.
  const points = facts.spine.points;
  const first = points.filter((p) => p.position <= blocks[0]!.first).at(-1)!;
  const last = points.find((p) => p.position >= blocks.at(-1)!.last + 1)!;
  const sequences = [...new Set(blocks.map((b) => b.sequence))];
  const era = o.candidates ? eraBrief(facts, o.candidates, sequences) : null;
  return [
    header(facts, o.title),
    castBrief(facts),
    narrationBriefs(facts, blocks),
    dataBrief(facts),
    ...(era ? [era] : []),
    continuityBrief(facts, sequences),
    ...(o.subjects?.length ? [`${subjectsBrief(o.subjects)}\nKeep these keys for the same subjects; number new ones after them.`] : []),
    `# Task\nPlan the visual beats from ${first.id} to ${last.id}${o.sequence !== undefined ? ` (section ${o.sequence} only)` : ''}: every word in exactly one beat, beats in order, each from and to a cut point above. Give each beat its three approach options, and propose the continuity subjects.`,
  ].join('\n\n');
}

function beatLine(facts: StoryboardFacts, b: DraftBeat, approach: VisualApproach): string {
  const option = b.content.options[approach];
  return `- ${b.key} "${b.content.title}" ${b.narration.from} → ${b.narration.to}: plan as ${option.treatment} (${option.concept || b.content.concept}). Purpose: ${b.content.purpose}. Importance ${b.content.importance}.${b.claimKeys.length ? ` Claims ${b.claimKeys.join(', ')}.` : ''}${b.content.continuity.subjectKeys.length ? ` Subjects ${b.content.continuity.subjectKeys.join(', ')}.` : ''}`;
}

/** The blocks a set of beats covers, in clock order. */
function blocksOfBeats(facts: StoryboardFacts, beats: readonly DraftBeat[]): SpineBlock[] {
  const keys = new Set<string>();
  for (const b of beats) {
    const from = facts.spine.point(b.narration.from);
    const to = facts.spine.point(b.narration.to);
    if (!from || !to) continue;
    for (let i = from.position; i < to.position; i++) keys.add(facts.spine.words[i]!.blockKey);
  }
  return facts.spine.blocks.filter((b) => keys.has(b.key));
}

/** A shots call's brief: one section's beats, the approach's treatment for each, their narration, the subjects and the cast. */
export function shotsPrompt(facts: StoryboardFacts, o: { title: string; beats: readonly DraftBeat[]; subjects: readonly DraftSubject[]; approach: VisualApproach; instructions?: string; current?: readonly DraftShot[]; candidates?: StoryboardInputs['candidates'] }): string {
  const blocks = blocksOfBeats(facts, o.beats);
  const era = o.candidates ? eraBrief(facts, o.candidates, [...new Set(blocks.map((b) => b.sequence))]) : null;
  const parts = [
    header(facts, o.title),
    castBrief(facts),
    subjectsBrief(o.subjects),
    `## The beats to plan (approach ${o.approach}: ${VISUAL_APPROACH_LABELS[o.approach]})\n${o.beats.map((b) => beatLine(facts, b, o.approach)).join('\n')}`,
    narrationBriefs(facts, blocks),
    dataBrief(facts),
    ...(era ? [era] : []),
  ];
  if (o.current?.length) parts.push(`## Their shots now (to be replaced)\n${o.current.map((s) => `- ${s.key} of ${s.beatKey}: ${s.narration ? `${s.narration.from} → ${s.narration.to}` : `silence at ${s.silenceAt}`}, ${s.treatment ?? 'no plan'} — ${s.spec.description || '(no description)'}`).join('\n')}`);
  if (o.instructions) parts.push(`## The editor's instructions\n${o.instructions}`);
  parts.push(
    `# Task\nPlan the shots of ${o.beats.map((b) => b.key).join(', ')}: each beat tiled by its shots from its first cut point to its last.${o.instructions ? ' Follow the editor\'s instructions; you may revise a beat\'s concept or treatment (beats), within the class matrix.' : ' Leave beats empty unless a beat\'s concept must change.'}`,
  );
  return parts.join('\n\n');
}

/** The repair call's brief: each beat with its shots as they are and what the checks found. */
export function repairPrompt(facts: StoryboardFacts, o: { title: string; beats: readonly DraftBeat[]; shots: readonly DraftShot[]; subjects: readonly DraftSubject[]; approach: VisualApproach; findings: readonly StoryboardQaFinding[]; partition: readonly string[] }): string {
  const parts = [header(facts, o.title), castBrief(facts), subjectsBrief(o.subjects)];
  for (const b of o.beats) {
    const own = o.shots.filter((s) => s.beatKey === b.key);
    const keys = new Set([b.key, ...own.map((s) => s.key)]);
    const found = o.findings.filter((f) => f.severity === 'BLOCKING' && f.ref && keys.has(f.ref));
    parts.push(
      [
        `## ${b.key} "${b.content.title}" ${b.narration.from} → ${b.narration.to} (${b.content.options[o.approach].treatment})`,
        o.partition.includes(b.key) ? 'Its shots did not tile it: they were repaired by code beyond the limit.' : '',
        `Findings:\n${found.length ? found.map((f) => `- ${f.kind}${f.ref ? ` (${f.ref})` : ''}: ${f.detail}`).join('\n') : '- none that name it (see above)'}`,
        `Shots now:\n${own.length ? own.map((s) => `- ${JSON.stringify({ key: s.key, narration: s.narration, silenceAt: s.silenceAt, treatment: s.treatment, method: s.method, claims: s.claims, subjects: s.subjects.map((x) => ({ subjectKey: x.subjectKey, ...x.detail })), description: s.spec.description, specifics: s.spec.specifics, overlays: s.spec.overlays, uncertaintyDevice: s.spec.uncertaintyDevice })}`).join('\n') : '- none'}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  parts.push(narrationBriefs(facts, blocksOfBeats(facts, o.beats)));
  parts.push(`# Task\nReturn replacement shots for ${o.beats.map((b) => b.key).join(', ')}: each beat whole, tiled from its first cut point to its last, its findings fixed and nothing made worse.`);
  return parts.join('\n\n');
}
