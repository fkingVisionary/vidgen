import { HEDGE_PATTERN } from '@docengine/core';
import { wordTokens } from '@docengine/story/shared';

/**
 * How narration words the status of what it says: the uncertainty patterns
 * the rules require for PROBABLE, DISPUTED, UNVERIFIED and MYTH claims;
 * probability wording, which belongs to PROBABLE claims only; hedge phrases,
 * which are never a callback; and a light stemmer, so "bought" matches "buy".
 * Generic English, no subject.
 */

/** Words that say a claim is disputed (including the natural ways a narrator says so: "the accounts don't agree"). */
export const DISPUTED_PATTERN =
  /\b(disput\w*|debat\w*|contest\w*|disagree\w*|controvers\w*|not everyone agrees|(?:nobody|no one|no two \w+) agrees?|unclear|uncertain|some (?:historians|scholars|accounts|sources|writers) (?:say|argue|claim|believe|think|doubt|suggest)|others? (?:argue|say|claim|doubt|suggest)|historians (?:argue|differ|debate|question|doubt|disagree)|(?:accounts|sources|versions|records|witnesses|details|numbers|stories|historians) (?:differ|conflict|clash|contradict each other)|(?:don't|do not|doesn't|does not|didn't|did not|never) (?:quite )?agree|(?:it's|it is|that's|that is) not clear|hard to say|depends on (?:who|whom) you (?:ask|believe|read)|still argued over|we (?:can't|cannot|don't|do not) know|no one (?:knows|can say))\b/i;
/** Words that say a claim cannot be confirmed (including "there's no way to check", "a single source", "we need to be careful"). */
export const UNVERIFIED_PATTERN =
  /\b(unconfirmed|unverified|unproven|cannot be (?:confirmed|verified|checked)|can't be (?:confirmed|verified|checked)|could not be (?:confirmed|verified|checked)|no (?:surviving )?(?:record|source|document|witness) (?:confirms|proves|shows|backs)|nothing (?:else )?(?:confirms|proves|backs (?:it|this|that) up)|(?:there's|there is|we have) no way (?:to (?:check|confirm|know|verify)|of (?:knowing|checking))|(?:we|no one|nobody) (?:can't|cannot|could not|couldn't|can) (?:confirm|check|verify) (?:it|this|that)|(?:can't|cannot) be sure|(?:a|one|the) (?:single|only|lone) (?:source|account|record|witness)|(?:we|you) (?:should|need to|have to) be careful|reportedly|allegedly|(?:is|was|are|were) said to|supposedly|if (?:the|this|that) (?:story|account|report) is true|we (?:can't|cannot|don't|do not) know|we have no way of knowing)\b/i;
/** Words that frame a claim as the popular story or legend (including "the famous version", "you may have heard", "as it's usually told"). */
export const MYTH_PATTERN =
  /\b(myths?|legends?|legendary|the story goes|(?:so|as) the story goes|it is (?:often|commonly|widely|still|usually) (?:said|claimed|told|repeated|believed)|(?:often|commonly|widely|endlessly|usually|always|generally) (?:told|repeated|claimed|said)|(?:popular|famous|familiar|usual|classic|standard|traditional|well-known) (?:account|story|version|telling|memory|belief|image|picture|tale)|the version (?:everyone|most people|people|you) (?:knows?|remembers?|tells?|heard)|you (?:may|might) (?:have heard|know|remember)|you've (?:probably )?heard|people (?:still )?(?:say|tell|repeat|believe)|folklore|tall tales?|supposedly|according to (?:the )?(?:legend|popular|story)|the tale|retold|the familiar story)\b/i;

/**
 * Words that present something as probably true. They belong to PROBABLE
 * claims: used for a myth, an unverified or disputed claim, a reconstruction
 * or a framing line, they upgrade its truth status.
 */
export const PROBABILITY_PATTERN = /\b(probably|most likely|more likely than not|in all likelihood|(?:is|was|are|were|seems?|it's) likely|presumably|what (?:probably|likely|really|actually) happened|the likely (?:truth|answer|story|explanation))\b/i;

/** Tokens of uncertainty, disagreement and legend: a phrase containing one is a hedge, never a callback. */
const HEDGE_TOKENS = new Set(
  'probably likely perhaps possibly maybe apparently reportedly allegedly supposedly presumably seems seem seemed appears appear appeared suggest suggests suggested disagree disagrees disagreed dispute disputed disputes unclear uncertain unconfirmed unverified unproven legend legends legendary myth myths folklore differ differs differed contested contradict contradicts'.split(' '),
);

/** Is this phrase (words, lower case) uncertainty language — a hedge, a disagreement, a legend frame? */
export function isHedgePhrase(phrase: string): boolean {
  const t = wordTokens(phrase);
  if (t.some((w) => HEDGE_TOKENS.has(w))) return true;
  const s = ` ${t.join(' ')} `;
  // "don't agree", "do not agree", "never agree", "not clear", "the story goes", "no way to know".
  if (/ (?:don t|do not|doesn t|does not|didn t|did not|never|no two \w+) (?:quite )?agree /.test(s)) return true;
  if (/ (?:not|isn t|wasn t) (?:quite )?(?:clear|certain|known) | the story goes | no way (?:to|of) /.test(s)) return true;
  return HEDGE_PATTERN.test(phrase) || DISPUTED_PATTERN.test(phrase) || UNVERIFIED_PATTERN.test(phrase) || MYTH_PATTERN.test(phrase);
}

/** Common irregular past forms, so a sentence and a claim that use different forms of one verb still match. */
const IRREGULAR: Record<string, string> = Object.fromEntries(
  'bought:buy sold:sell paid:pay went:go gone:go took:take taken:take gave:give given:give made:make said:say told:tell wrote:write written:write met:meet saw:see seen:see knew:know known:know thought:think brought:bring caught:catch fought:fight sought:seek built:build sent:send spent:spend lent:lend held:hold kept:keep left:leave lost:lose won:win ran:run began:begin begun:begin became:become broke:break broken:break chose:choose chosen:choose drew:draw drawn:draw drove:drive fell:fall fallen:fall flew:fly grew:grow grown:grow hid:hide hung:hang laid:lay led:lead rode:ride rose:rise sat:sit shook:shake spoke:speak spoken:speak stood:stand stole:steal struck:strike swore:swear threw:throw thrown:throw understood:understand wore:wear woke:wake owed:owe fled:flee found:find got:get felt:feel heard:hear meant:mean struck:strike forgave:forgive forgot:forget'
    .split(' ')
    .map((x) => x.split(':') as [string, string]),
);

/** A word's stem: its irregular base, or the word with a common ending (-ing, -ed, -es, -s) removed. */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (IRREGULAR[w]) return IRREGULAR[w]!;
  for (const end of ['ings', 'ing', 'ied', 'ies', 'ed', 'es', 's']) {
    if (w.length - end.length >= 4 && w.endsWith(end)) return end === 'ied' || end === 'ies' ? `${w.slice(0, -end.length)}y` : w.slice(0, -end.length);
  }
  return w;
}
