import type { RuntimeTarget } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import { claimLinksLost, evidenceInvariants } from './evidence.ts';
import { checkScript, SCRIPT_BLOCKING, type ScriptFinding } from './rules.ts';
import { syntheticDraft, syntheticScope } from './testing.ts';

/**
 * The evidence invariants on synthetic films — history, science, business,
 * biography: a truth status never upgraded, every assertion about a person
 * resting on a claim the block cites, and claim links kept when a sentence
 * is kept or moved.
 */

const TARGET: RuntimeTarget = { minSec: 10, maxSec: 400, targetSec: 200 };
const kinds = (fs: readonly ScriptFinding[], kind: ScriptFinding['kind']) => fs.filter((f) => f.kind === kind);

// ── History: a historical figure and an uncertain event ──────────────────────

const history = syntheticScope({
  question: 'Did the general really burn the bridge?',
  claims: [
    { key: 'H1', statement: 'General Aldo Ferrant commanded the northern army in 1809.', importance: 'KEY' },
    { key: 'H2', statement: 'A popular story says Ferrant burned the bridge to stop his own men retreating.', verdict: 'MYTH', importance: 'KEY' },
    { key: 'H3', statement: 'The bridge was probably destroyed by the spring flood.', verdict: 'PROBABLE', importance: 'KEY' },
    { key: 'H4', statement: 'Ferrant resigned his command after the campaign.', importance: 'SUPPORTING' },
    { key: 'H5', statement: 'Ferrant went to the capital after the war.', importance: 'SUPPORTING' },
  ],
  cast: [{ id: 'R1', name: 'Aldo Ferrant', kind: 'REAL_PERSON', description: 'General commanding the northern army.', claimKeys: ['H1', 'H4'] }],
  sequences: [
    { title: 'The general', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'ORIENTATION', claimKeys: ['H1'], castIds: ['R1'] }] },
    { title: 'The legend', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'CONFLICT', claimKeys: ['H2'] }, { id: '2.2', basis: 'RECONSTRUCTION', function: 'ESCALATION', claimKeys: ['H1'] }] },
    { title: 'The flood', beats: [{ id: '3.1', basis: 'UNCERTAIN', function: 'REVEAL', claimKeys: ['H3'] }, { id: '3.2', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['H4', 'H5'], castIds: ['R1'] }] },
  ],
});

describe('truth status never upgraded (history)', () => {
  const film = (legend: string, scene: string, framing = 'So what really happened at the bridge?') =>
    syntheticDraft(history, [
      [
        { text: framing, infoClass: 'FRAMING', extra: { centralQuestion: 'POSED' } },
        { text: 'In 1809 General Aldo Ferrant commanded the northern army.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['H1'] },
      ],
      [
        { text: legend, infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['H2'] },
        { text: scene, infoClass: 'RECONSTRUCTION', beatIds: ['2.2'], claimKeys: ['H1'] },
      ],
      [
        { text: 'The bridge was probably destroyed by the spring flood.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['H3'], extra: { centralQuestion: 'ANSWERED' } },
        { text: 'After the campaign Ferrant resigned his command.', infoClass: 'DOCUMENTED', beatIds: ['3.2'], claimKeys: ['H4'] },
      ],
    ]);

  it('flags a legend told as "what probably happened", a reconstruction presented as probable history, and lets a PROBABLE claim say "probably"', () => {
    const drifted = film('The story goes that Ferrant probably burned the bridge himself.', 'What probably happened that night is simple: the men panicked at the river.');
    const fs = evidenceInvariants(drifted, history, null);
    expect(kinds(fs, 'UNCERTAINTY_UPGRADED').map((f) => f.detail)).toEqual([
      'Block 2.1: "probably" upgrades H2 (MYTH) to probable — word it as its verdict requires',
      'Block 2.2: "What probably happened" presents a reconstruction as probable history, and no PROBABLE claim stands behind it — tell it as the scene or question it is, or cite the claim that makes it probable',
    ]);
    // Blocking: no change may introduce it.
    expect(SCRIPT_BLOCKING).toContain('UNCERTAINTY_UPGRADED');
    // The legend framed as a legend, the scene as a scene, the question as a question: nothing to flag.
    const honest = film('The story goes that Ferrant burned the bridge to stop his own men retreating.', 'The river is loud. The men wait for an order.', 'So what probably happened at the bridge?');
    expect(kinds(evidenceInvariants(honest, history, null), 'UNCERTAINTY_UPGRADED')).toEqual([]);
  });

  it('blocks a sentence about the general that says what an uncited claim says', () => {
    const draft = film('The story goes that Ferrant burned the bridge to stop his own men retreating.', 'The river is loud. The men wait for an order.');
    draft.sections[0]!.blocks[1]!.text = 'In 1809 General Aldo Ferrant commanded the northern army, and he resigned his command soon after.';
    const fs = checkScript(draft, history, { target: TARGET });
    expect(kinds(fs, 'ASSERTION_UNCITED').map((f) => f.detail)).toEqual([
      'Block 1.2: "In 1809 General Aldo Ferrant commanded the northern army, and he…" says of Aldo Ferrant what H4 (ESTABLISHED) carries (resign), but the block does not cite H4 — cite it, worded as its verdict requires, or cut it',
    ]);
    // Cited, it rests on its claim.
    draft.sections[0]!.blocks[1]!.claimKeys = ['H1', 'H4'];
    expect(kinds(checkScript(draft, history, { target: TARGET }), 'ASSERTION_UNCITED')).toEqual([]);
    // A light verb another claim happens to use ("went") ties nothing: only what the sentence asserts does.
    draft.sections[0]!.blocks[1]!.claimKeys = ['H1'];
    draft.sections[0]!.blocks[1]!.text = 'In 1809 General Aldo Ferrant commanded the northern army, and he went to the river every morning.';
    expect(kinds(checkScript(draft, history, { target: TARGET }), 'ASSERTION_UNCITED')).toEqual([]);
  });
});

// ── Science: a discovery and competing explanations ──────────────────────────

const science = syntheticScope({
  question: 'Why did the lake turn red?',
  claims: [
    { key: 'S1', statement: 'The lake turned red in the summer of 1962.', importance: 'KEY' },
    { key: 'S2', statement: 'Scientists disagree whether algae or iron caused the colour.', verdict: 'DISPUTED', importance: 'KEY' },
  ],
  sequences: [
    { title: 'The colour', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'COLD_OPEN', claimKeys: ['S1'] }] },
    { title: 'The explanations', beats: [{ id: '2.1', basis: 'UNCERTAIN', function: 'INVESTIGATION', claimKeys: ['S2'] }] },
  ],
});

describe('competing explanations stay competing (science)', () => {
  it('flags "most likely" for a disputed explanation, and accepts saying it is disputed', () => {
    const draft = (text: string) =>
      syntheticDraft(science, [
        [{ text: 'In the summer of 1962 the lake turned red.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['S1'], extra: { centralQuestion: 'POSED' } }],
        [{ text, infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['S2'], extra: { centralQuestion: 'ANSWERED' } }],
      ]);
    expect(kinds(evidenceInvariants(draft('It was most likely the algae, though some scientists disagree.'), science, null), 'UNCERTAINTY_UPGRADED').map((f) => f.ref)).toEqual(['2.1']);
    expect(kinds(evidenceInvariants(draft('Scientists still disagree: algae, or iron.'), science, null), 'UNCERTAINTY_UPGRADED')).toEqual([]);
  });
});

// ── Business and biography: claim links kept when a sentence moves ──────────

const business = syntheticScope({
  question: 'How did the bakery chain grow so fast?',
  claims: [
    { key: 'B1', statement: 'Corra Bakeries opened forty shops between 1998 and 2003.', importance: 'KEY' },
    { key: 'B2', statement: 'Founder Ida Corra borrowed against her house to open the first shop.', importance: 'KEY' },
    { key: 'B3', statement: 'The chain closed most shops in 2009.', importance: 'KEY' },
  ],
  cast: [{ id: 'R1', name: 'Ida Corra', kind: 'REAL_PERSON', description: 'Founder of the bakery chain.', claimKeys: ['B2'] }],
  sequences: [
    { title: 'The start', beats: [{ id: '1.1', basis: 'DOCUMENTED', function: 'STAKES', claimKeys: ['B2'], castIds: ['R1'] }] },
    { title: 'The rise', beats: [{ id: '2.1', basis: 'DOCUMENTED', function: 'ESCALATION', claimKeys: ['B1'] }] },
    { title: 'The fall', beats: [{ id: '3.1', basis: 'DOCUMENTED', function: 'CONSEQUENCE', claimKeys: ['B3'] }] },
  ],
});

describe('claim links kept (business)', () => {
  const before = () =>
    syntheticDraft(business, [
      [{ text: 'To open her first shop, the founder Ida Corra borrowed against her house.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['B2'], extra: { centralQuestion: 'POSED' } }],
      [{ text: 'Between 1998 and 2003 Corra Bakeries opened forty shops.', infoClass: 'DOCUMENTED', beatIds: ['2.1'], claimKeys: ['B1'] }],
      [{ text: 'In 2009 the chain closed most of its shops.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['B3'], extra: { centralQuestion: 'ANSWERED' } }],
    ]);

  it('flags a sentence a refinement moved into a block that no longer cites the claim behind it', () => {
    const after = before();
    // The founder's loan moved into the rise, without its claim.
    after.sections[0]!.blocks[0]!.text = 'It started with one shop.';
    after.sections[1]!.blocks[0]!.text = 'To open her first shop, the founder Ida Corra borrowed against her house. Between 1998 and 2003 Corra Bakeries opened forty shops.';
    const lost = claimLinksLost(after, before(), business);
    expect(lost.map((f) => f.detail)).toEqual([
      'Block 2.1 keeps "To open her first shop, the founder Ida Corra borrowed against her…" from the version before, but no longer cites B2 (ESTABLISHED), the claim behind it — cite it, worded as its verdict requires, or cut the sentence',
    ]);
    // Through the rules: only when checked against the version before, and blocking.
    expect(kinds(checkScript(after, business, { target: TARGET }), 'CLAIM_LINK_LOST')).toEqual([]);
    expect(kinds(checkScript(after, business, { target: TARGET, previous: before() }), 'CLAIM_LINK_LOST').map((f) => f.ref)).toEqual(['2.1']);
    expect(SCRIPT_BLOCKING).toEqual(expect.arrayContaining(['CLAIM_LINK_LOST', 'ASSERTION_UNCITED']));
    // Moved with its claim, the link is kept.
    after.sections[1]!.blocks[0]!.claimKeys = ['B1', 'B2'];
    expect(claimLinksLost(after, before(), business)).toEqual([]);
  });

  it('leaves a reworded sentence alone when no claim was dropped', () => {
    const after = before();
    after.sections[1]!.blocks[0]!.text = 'In five years, from 1998 to 2003, Corra Bakeries opened forty shops.';
    expect(claimLinksLost(after, before(), business)).toEqual([]);
  });
});
