import { describe, expect, it } from 'vitest';
import { type DraftBlock, type ScriptDraft } from './draft.ts';
import { computeScriptReport } from './quality.ts';
import { DISPUTED_PATTERN, MYTH_PATTERN, SCRIPT_BLOCKING, UNVERIFIED_PATTERN, checkScript, type ScriptFindingKind } from './rules.ts';
import { fixtureBlock, fixtureDraft, fixtureScope } from './testing.ts';
import { allBlocks } from './draft.ts';
import { scriptTiming } from '@docengine/core';

const scope = fixtureScope();
/** A one-minute film (the fixture is about 50 seconds of narration). */
const target = { minSec: 40, maxSec: 80, targetSec: 60 };
const blocking = (d: ScriptDraft) => checkScript(d, scope, { target }).filter((f) => SCRIPT_BLOCKING.includes(f.kind));
const kinds = (d: ScriptDraft) => checkScript(d, scope, { target }).map((f) => f.kind);

/** The fixture draft with one block replaced (section `seq`, index `i`). */
function withBlock(seq: number, i: number, raw: Parameters<typeof fixtureBlock>[1], extra: Partial<DraftBlock> = {}): ScriptDraft {
  const d = fixtureDraft(scope);
  const s = d.sections.find((x) => x.sequence === seq)!;
  const key = s.blocks[i]!.key;
  s.blocks[i] = { ...fixtureBlock(scope, raw, extra), key };
  return d;
}

describe('the script rules', () => {
  it('pass a script that tells every beat as its class and verdicts require', () => {
    const d = fixtureDraft();
    expect(blocking(d)).toEqual([]);
    const report = computeScriptReport({ findings: checkScript(d, scope, { target }), timing: scriptTiming(allBlocks(d), target), content: { editor: null, factCheck: null }, notes: [] });
    expect(report.passed).toBe(true);
    expect(report.checks.find((c) => c.id === 'runtime')?.detail).toMatch(/^Target 1:00 \(0:40–1:20\) · script 0:\d\d · variance /);
  });

  describe('safety', () => {
    it('allows a fictional companion to do fictional things', () => {
      const d = withBlock(1, 3, { text: 'Pieter counts the coins in his purse and wonders whether to bid.', infoClass: 'FICTION', beatIds: ['1.3'] });
      expect(blocking(d)).toEqual([]);
      expect(allBlocks(d).find((b) => b.text.startsWith('Pieter'))).toMatchObject({ fictionalDevice: true, visual: { fictional: true } });
    });

    it('fails a fictional companion performing a documented or dated historical act', () => {
      const dated = withBlock(1, 3, { text: 'Pieter signs the contract on 3 February 1637.', infoClass: 'RECONSTRUCTION', beatIds: ['1.1'], claimKeys: ['C002'] });
      expect(kinds(dated)).toContain('FICTION_DOCUMENTED_ACT');
      const documented = withBlock(1, 2, { text: 'Pieter signs a contract for bulbs still in the ground.', infoClass: 'RECONSTRUCTION', beatIds: ['1.2'], claimKeys: ['C001'] });
      expect(kinds(documented)).toContain('FICTION_DOCUMENTED_ACT');
      const asFact = withBlock(1, 2, { text: 'Pieter and the buyers sign contracts for bulbs still in the ground.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['C001'] });
      // Told as documented fact, the fictional companion is caught whatever the sentence shape.
      expect(kinds(asFact)).toContain('FICTION_IN_DOCUMENTED');
      const withFigures = withBlock(1, 3, { text: 'Pieter has saved 300 guilders.', infoClass: 'FICTION', beatIds: ['1.3'] });
      expect(kinds(withFigures)).toContain('FICTION_WITH_FACTS');
    });

    it('fails invented words given to a real person', () => {
      const spoken = withBlock(2, 0, { text: '"I will not pay for flowers I never saw."', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'], speakerId: 'R1', speechKind: 'INVENTED' });
      expect(kinds(spoken)).toEqual(expect.arrayContaining(['REAL_PERSON_INVENTED_SPEECH']));
      const quoted = withBlock(2, 0, { text: 'Records suggest Cornelis Proefman told the grower: "I will not pay for flowers I never saw."', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'] });
      expect(kinds(quoted)).toContain('FABRICATED_QUOTE');
      const recorded = withBlock(2, 0, { text: '"Cornelis Proefman refused to accept the bulbs he had bought for 1,200 guilders."', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'], speakerId: 'R1', speechKind: 'RECORDED_QUOTE' });
      expect(kinds(recorded)).not.toContain('UNVERIFIED_RECORDED_QUOTE');
      const fictionalQuote = withBlock(1, 4, { text: '"Everyone here is buying paper, not flowers."', infoClass: 'FICTION', beatIds: ['1.3'], speakerId: 'F1', speechKind: 'RECORDED_QUOTE' });
      expect(kinds(fictionalQuote)).toContain('FICTIONAL_RECORDED_QUOTE');
    });

    it('fails a number the evidence does not contain', () => {
      const d = withBlock(2, 1, { text: 'In April 1637 the courts sent 4,000 unsettled contracts back to the towns.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['C007'] });
      expect(blocking(d).map((f) => `${f.kind} ${f.detail}`)).toEqual(['UNSUPPORTED_FIGURE Block 2.2: 4000 is in no claim of the approved architecture']);
    });

    it('fails a myth stated as established fact', () => {
      const asFact = withBlock(3, 0, { text: 'The trade ruined a nation.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['C010'] });
      expect(kinds(asFact)).toContain('MYTH_AS_FACT');
      const documented = withBlock(3, 0, { text: 'The legend says the trade ruined a nation.', infoClass: 'DOCUMENTED', beatIds: ['3.1'], claimKeys: ['C010'] });
      expect(kinds(documented)).toEqual(expect.arrayContaining(['MYTH_AS_FACT', 'DOCUMENTED_NOT_ESTABLISHED', 'CLASS_MISMATCH']));
    });

    it('passes a disputed claim told with its uncertainty, and fails it told as fact', () => {
      const told = withBlock(3, 1, { text: 'Historians disagree about the famous price: a single bulb, offered for 5,500 guilders.', infoClass: 'UNCERTAIN', beatIds: ['3.2'], claimKeys: ['C009'] });
      expect(blocking(told)).toEqual([]);
      const asFact = withBlock(3, 1, { text: 'A single bulb sold for 5,500 guilders.', infoClass: 'UNCERTAIN', beatIds: ['3.2'], claimKeys: ['C009'] });
      expect(kinds(asFact)).toContain('DISPUTED_AS_FACT');
    });
  });

  it('accepts the natural ways a narrator says a claim is probable, contested, unconfirmed or legend — and nothing less', () => {
    const disputed = withBlock(3, 1, { text: "The accounts don't agree on the famous price: a single bulb, offered for 5,500 guilders.", infoClass: 'UNCERTAIN', beatIds: ['3.2'], claimKeys: ['C009'] });
    expect(blocking(disputed)).toEqual([]);
    const legend = withBlock(3, 0, { text: "As it's usually told, the trade ruined a nation.", infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['C010'] });
    expect(blocking(legend)).toEqual([]);
    const probable = withBlock(2, 0, { text: 'Cornelis Proefman, it seems, refused the bulbs he had bought.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'] });
    expect(blocking(probable)).toEqual([]);
    for (const ok of ['The sources differ.', "It's not clear who paid.", 'No two accounts agree.', 'It depends on whom you believe.']) expect(DISPUTED_PATTERN.test(ok)).toBe(true);
    for (const ok of ["There's no way to check it.", 'It comes from a single source.', 'So we need to be careful here.', 'Nothing else backs it up.', "We can't be sure."]) expect(UNVERIFIED_PATTERN.test(ok)).toBe(true);
    for (const ok of ['You may have heard this one.', 'The famous version is simpler.', 'People still say the town was ruined.', "You've probably heard that men drowned."]) expect(MYTH_PATTERN.test(ok)).toBe(true);
    // Near misses stay misses: agreeing, being careful with money, a famous painter, people buying.
    for (const no of ['The buyers agreed to pay.', 'The price was clear.']) expect(DISPUTED_PATTERN.test(no)).toBe(false);
    for (const no of ['He was careful with money.', 'The only buyer left.', 'A single bulb sold.']) expect(UNVERIFIED_PATTERN.test(no)).toBe(false);
    for (const no of ['The famous painter arrived.', 'People bought bulbs.', 'The version printed that spring.']) expect(MYTH_PATTERN.test(no)).toBe(false);
    // The legend told plainly still fails, however conversational.
    expect(kinds(withBlock(3, 0, { text: 'And so the trade ruined a nation.', infoClass: 'UNCERTAIN', beatIds: ['3.1'], claimKeys: ['C010'] }))).toContain('MYTH_AS_FACT');
  });

  it('keeps every block inside the architecture and its evidence', () => {
    const outside = withBlock(2, 1, { text: 'In April 1637 the courts sent the contracts back to the towns.', infoClass: 'DOCUMENTED', beatIds: ['2.2'], claimKeys: ['C007', 'C020'] });
    expect(kinds(outside)).toContain('CLAIM_OUTSIDE_ARCHITECTURE');
    const unanchored = withBlock(2, 1, { text: 'The courts were slow.', infoClass: 'DOCUMENTED', claimKeys: ['C007'] });
    expect(kinds(unanchored)).toContain('NOT_IN_ARCHITECTURE');
    const bare = withBlock(2, 1, { text: 'The courts sent the contracts back.', infoClass: 'DOCUMENTED', beatIds: ['2.2'] });
    expect(kinds(bare)).toContain('BLOCK_WITHOUT_EVIDENCE');
    const stranger = withBlock(3, 2, { text: 'A book by Willem Fakerson spread the story.', infoClass: 'DOCUMENTED', beatIds: ['3.3'], claimKeys: ['C012'] });
    expect(kinds(stranger)).toContain('UNKNOWN_NAME');
  });

  it('keeps the information class of the beats, and keeps framing free of facts', () => {
    const promoted = withBlock(1, 1, { text: 'Florists trade around the tables of a crowded room.', infoClass: 'DOCUMENTED', beatIds: ['1.1'], claimKeys: ['C002'] });
    expect(kinds(promoted)).toContain('CLASS_MISMATCH');
    const fiction = withBlock(2, 1, { text: 'The courts dream of quiet streets.', infoClass: 'FICTION', beatIds: ['2.2'] });
    expect(kinds(fiction)).toContain('FICTION_NOT_ALLOWED');
    const framing = withBlock(1, 0, { text: 'Why did 90,000 guilders vanish?', infoClass: 'FRAMING' }, { centralQuestion: 'POSED' });
    expect(kinds(framing)).toContain('FRAMING_WITH_FACTS');
    const probable = withBlock(2, 0, { text: 'Cornelis Proefman refused the bulbs he had bought.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'] });
    expect(kinds(probable)).toContain('PROBABLE_UNHEDGED');
  });

  it('links a figure to the architecture claim it comes from (traceability)', () => {
    const b = fixtureBlock(scope, { text: 'Records suggest he refused bulbs worth 1,200 guilders.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: [] });
    expect(b.claimKeys).toEqual(['C008']);
    expect(b.presentation).toEqual([{ claimKey: 'C008', verdict: 'PROBABLE', presentation: 'HEDGE', instruction: 'Records suggest it (test).' }]);
  });

  it('requires every sequence told and the central question posed and answered', () => {
    const d = fixtureDraft();
    d.sections[1]!.blocks = [];
    expect(kinds(d)).toContain('SEQUENCE_MISSING');
    const noQuestion = fixtureDraft();
    for (const b of allBlocks(noQuestion)) b.centralQuestion = null;
    expect(kinds(noQuestion)).toEqual(expect.arrayContaining(['CENTRAL_QUESTION_NOT_POSED', 'CENTRAL_QUESTION_ABANDONED']));
  });

  it('measures runtime against the target: near is a warning, far is a failure', () => {
    const d = fixtureDraft();
    const total = scriptTiming(allBlocks(d), target).totalSec;
    expect(kinds(d)).not.toContain('RUNTIME_OFF');
    expect(checkScript(d, scope, { target: { minSec: total * 1.1, maxSec: total * 1.5, targetSec: total * 1.3 } }).map((f) => f.kind)).toContain('RUNTIME_NEAR');
    expect(checkScript(d, scope, { target: { minSec: total * 2, maxSec: total * 3, targetSec: total * 2.5 } }).map((f) => f.kind)).toContain('RUNTIME_OFF');
  });

  it('warns about pauses and emphasis used everywhere, and drops emphasis on words the block does not have', () => {
    const d = fixtureDraft();
    for (const b of allBlocks(d)) b.delivery = { ...b.delivery, pauseAfter: { length: 'LONG', reason: 'RHYTHM' }, emphasis: [{ text: b.text.split(' ')[0]!, level: 'STRONG' }] };
    expect(kinds(d)).toEqual(expect.arrayContaining(['PAUSE_OVERUSE', 'EMPHASIS_OVERUSE']));
    const b = fixtureBlock(scope, { text: 'The buyers sign contracts.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['C001'] }, { delivery: { pace: 'SLOW', energy: 'LOW', emotion: 'SOMBER', emphasis: [{ text: 'contracts', level: 'STRONG' }, { text: 'tulips', level: 'LIGHT' }], pauseBefore: { length: 'NONE', reason: null }, pauseAfter: { length: 'MEDIUM', reason: 'REVEAL' } } });
    expect(b.delivery.emphasis).toEqual([{ text: 'contracts', level: 'STRONG' }]);
    // 4 spoken words at 150 a minute, slowed (×0.88), plus a medium pause (1.2 s).
    expect(b.estimatedDurationSec).toBe(Math.round(((4 / (150 * 0.88)) * 60 + 1.2) * 10) / 10);
  });

  it('flags spoken-language problems as warnings, never as failures', () => {
    const d = withBlock(1, 1, { text: "But here's where things get interesting. You push into a crowded tavern room, 1636/37, where florists trade & bargain?", infoClass: 'RECONSTRUCTION', beatIds: ['1.1'], claimKeys: ['C002'] });
    const found = checkScript(d, scope, { target });
    expect(found.map((f) => f.kind)).toEqual(expect.arrayContaining(['AI_PHRASES', 'UNSPOKEN_SYMBOLS']));
    const warnings: ScriptFindingKind[] = ['AI_PHRASES', 'UNSPOKEN_SYMBOLS', 'RHETORICAL_QUESTIONS', 'LONG_SENTENCES', 'REPEATED_PHRASES', 'PAUSE_OVERUSE', 'PRONUNCIATION_REVIEW', 'REAL_INTERIORITY'];
    expect(warnings.filter((k) => SCRIPT_BLOCKING.includes(k))).toEqual([]);
  });

  it('flags pronunciations to confirm and names without one', () => {
    const d = fixtureDraft();
    expect(kinds(d)).toContain('NAME_WITHOUT_PRONUNCIATION');
    d.pronunciations = [
      { term: 'Cornelis Proefman', respelling: 'kor-NAY-lis PROOF-mahn', ipa: null, language: 'Dutch', confidence: 'MEDIUM', note: '', needsReview: true, source: 'MODEL' },
      { term: 'Pieter Graanhout', respelling: 'PEE-ter GRAHN-howt', ipa: null, language: 'Dutch', confidence: 'HIGH', note: '', needsReview: false, source: 'MODEL' },
    ];
    const found = checkScript(d, scope, { target });
    expect(found.map((f) => f.kind)).not.toContain('NAME_WITHOUT_PRONUNCIATION');
    expect(found.find((f) => f.kind === 'PRONUNCIATION_REVIEW')?.detail).toBe('1 pronunciation note(s) to confirm: Cornelis Proefman');
  });

  it('warns when a real person seems to be given thoughts, unless the narration admits not knowing', () => {
    const d = withBlock(2, 0, { text: 'Records suggest Proefman refused the bulbs. Proefman fears ruin.', infoClass: 'UNCERTAIN', beatIds: ['2.1'], claimKeys: ['C008'] });
    // The hedge in the block covers it ("records suggest"); without one it warns.
    expect(kinds(d)).not.toContain('REAL_INTERIORITY');
    const plain = withBlock(1, 2, { text: 'The buyers sign contracts while Testbroek fears the worst.', infoClass: 'DOCUMENTED', beatIds: ['1.2'], claimKeys: ['C001'] });
    expect(kinds(plain)).toContain('REAL_INTERIORITY');
  });

  it('blocks approval on an open critical fact issue until the block is edited', () => {
    const d = fixtureDraft();
    const issue = { ref: '2.2', severity: 'CRITICAL' as const, kind: 'WRONG_DATE', note: 'The month is wrong (test).', resolution: 'open: left for the editor' };
    expect(checkScript(d, scope, { target, factIssues: [issue] }).map((f) => f.kind)).toContain('OPEN_CRITICAL_FACT_ISSUE');
    d.sections[1]!.blocks[1]!.editedAt = new Date().toISOString();
    expect(checkScript(d, scope, { target, factIssues: [issue] }).map((f) => f.kind)).not.toContain('OPEN_CRITICAL_FACT_ISSUE');
  });
});
