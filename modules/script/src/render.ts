import { CAST_KIND_LABELS, NARRATIVE_MODE_LABELS, POV_STRATEGY_LABELS, fmtClock } from '@docengine/core';
import { sectionDurationSec, type ScriptDraft } from './draft.ts';
import type { ScriptScope } from './scope.ts';

/**
 * Plain-text renderings for the prompts: the approved architecture, the
 * evidence it cites, and a script version with block references. The beat
 * and block lines have a fixed shape (the test fakes read them).
 */

const list = (xs: readonly string[]) => (xs.length ? xs.join(', ') : 'none');

export function renderArchitecture(scope: ScriptScope): string {
  const a = scope.architecture;
  const lines = [
    `# The approved story architecture (v${scope.architectureVersion})`,
    `Logline: ${a.logline}`,
    `Central question (Q0): ${a.centralQuestion}`,
    `Human stakes: ${a.centralHumanStakes}`,
    `Told as: ${NARRATIVE_MODE_LABELS[a.narrativeMode]}${a.secondaryModes.length ? ` with ${a.secondaryModes.map((m) => NARRATIVE_MODE_LABELS[m].toLowerCase()).join(', ')}` : ''}`,
    `Point of view: ${POV_STRATEGY_LABELS[a.povStrategy.type]}${a.povStrategy.description ? ` — ${a.povStrategy.description}` : ''}`,
    `Thesis: ${a.thesis}`,
    `Spine: ${a.narrativeSpine}`,
    `Resolution (how the film answers Q0): ${a.resolution}`,
    '',
    '## Cast (fictional devices are labelled; they are never historical people)',
    ...a.cast.map((m) => `- ${m.id} · ${m.name} · ${CAST_KIND_LABELS[m.kind]}${scope.cast.get(m.id)?.fictional ? ' · FICTIONAL DEVICE' : ''} — ${m.description}${m.claimKeys.length ? ` (claims ${m.claimKeys.join(', ')})` : ''}`),
  ];
  for (const s of a.sequences) {
    lines.push(
      '',
      `## Sequence ${s.number} — ${s.title} (about ${fmtClock(s.estimatedDurationSec)})`,
      `purpose: ${s.purpose}`,
      `mode: ${NARRATIVE_MODE_LABELS[s.mode]} | question: ${s.question}`,
      `opening hook: ${s.openingHook}`,
      `conflict: ${s.conflict} | escalation: ${s.escalation}`,
      `reveal: ${s.reveal} | consequence: ${s.consequence}`,
      `ending beat: ${s.endingBeat} | transition: ${s.transition}`,
      `setting: ${s.setting.location.value} [${s.setting.location.basis}] · ${s.setting.date.value} [${s.setting.date.basis}] · ${s.setting.timeOfDay.value} [${s.setting.timeOfDay.basis}]`,
      `continuity: opens ${list(s.continuity.opens.map((o) => `${o.id} "${o.question}"`))}; resolves ${list(s.continuity.resolves)}; time jump ${s.continuity.timeJump}`,
      'beats:',
    );
    for (const b of s.beats) {
      lines.push(`- beat ${b.id} [${b.basis}/${b.function}] claims: ${list(b.claimKeys)} | cast: ${list(b.castIds)} | ${b.description}`);
      for (const x of b.speech) lines.push(`  speech ${x.speakerId} ${x.kind} claim ${x.claimKey ?? 'none'}: "${x.text}"`);
    }
    if (s.presentation.length) {
      lines.push('presentation (how claims that are not ESTABLISHED must be worded):');
      for (const p of s.presentation) lines.push(`- ${p.claimKey} ${p.presentation}: ${p.instruction}`);
    }
    if (s.contextClaims.length) lines.push(`background only (never a new story): ${s.contextClaims.map((c) => `${c.claimKey} (${c.purpose})`).join('; ')}`);
    if (s.visual.mustShow.length || s.visual.mustAvoid.length) {
      lines.push(`visual: must show ${list(s.visual.mustShow.map((m) => `${m.detail} [${m.claimKeys.join(', ')}]`))}; must avoid ${list(s.visual.mustAvoid)}`);
    }
  }
  return lines.join('\n');
}

/** The claims the architecture cites, with their verdicts and verified quotations: the only evidence. */
export function renderEvidence(scope: ScriptScope): string {
  return [`# Evidence: the ${scope.claims.length} claims the architecture cites (verdicts are final)`, scope.evidence.renderClaims(scope.claims, { quotes: 2, quoteChars: 320 })].join('\n');
}

/**
 * A script version as reviewers see it: sections with their blocks, each
 * with its reference ("3.4"), class, beats, claims and speaker. `only`
 * limits the rendering to some sections (the rest are summarised).
 */
export function renderScript(draft: ScriptDraft, opts: { only?: ReadonlySet<number>; delivery?: boolean } = {}): string {
  const lines: string[] = [];
  for (const s of draft.sections) {
    const shown = !opts.only || opts.only.has(s.sequence);
    lines.push(`## Section ${s.sequence} — ${s.title} (${fmtClock(sectionDurationSec(s))}${s.plan ? `, planned ${fmtClock(s.plan.targetSec)}` : ''})${shown ? '' : ' — not to be changed'}`);
    if (!shown) {
      const first = s.blocks[0]?.text ?? '';
      const last = s.blocks.at(-1)?.text ?? '';
      lines.push(`(${s.blocks.length} blocks) begins: "${first}"${s.blocks.length > 1 ? ` … ends: "${last}"` : ''}`);
      continue;
    }
    for (const b of s.blocks) {
      const meta = [
        b.infoClass,
        `beats ${list(b.beatIds)}`,
        `claims ${list(b.claimKeys)}`,
        b.speakerId ? `speaker ${b.speakerId} ${b.speechKind ?? ''}`.trim() : null,
        b.centralQuestion ? `${b.centralQuestion} Q0` : null,
        opts.delivery ? `${b.delivery.pace}/${b.delivery.energy}/${b.delivery.emotion}` : null,
      ].filter(Boolean);
      lines.push(`[${b.key}] ${meta.join(' · ')}`, b.text);
    }
    if (s.editorNotes) lines.push(`(editor's note on this section: ${s.editorNotes})`);
  }
  return lines.join('\n');
}
