/**
 * @docengine/writing — Documentary Writing Engine 2. The house-style corpus,
 * targeted retrieval, the diagnostics (AI-pattern fingerprint, spoken rhythm,
 * read-aloud rubric), historical money context from the evidence, name
 * layers, semantic layers and the change report between script versions.
 * A library for the script stage and the API; it never calls a model.
 */
export { STYLE_BIBLE, STYLE_BIBLE_VERSION, styleBibleMarkdown, styleBibleText } from './bible.ts';
export { corpusStats, filterCorpus, loadCorpus, withHouseExamples, type Corpus, type CorpusEntry, type CorpusFilter, type CorpusPolarity } from './corpus.ts';
export { DEFAULT_LIMITS, asRecord, renderExamples, retrieve, type RetrievalLimits, type RetrievalNeed, type Retrieved } from './retrieval.ts';
export { STOCK_PHRASES, actionable, aiSignals, blockPatterns, describesPicture, overThreshold, summarise } from './fingerprints.ts';
export { rhythmProfile, tongueTwister } from './rhythm.ts';
export { RUBRIC_QUESTIONS, RUBRIC_VERSION, rubric, type RubricInput } from './rubric.ts';
export { blockNeeds, diagnose, retrievalNeeds, type BlockNeed, type DiagnoseInput, type Diagnosis } from './diagnostics.ts';
export { NO_EQUIVALENT, currenciesOf, moneyContexts, moneyFacts, moneyGaps, moneyInNarration, moneyMentions, parseAmount, renderMoneyContexts, spokenRatio, unitFor, type MoneyMention, type MoneyUse } from './money.ts';
export { nameLayer, namesAltered, pronunciationRisk, type KnownName } from './names.ts';
export { deliveryMark, directionLeaks, type LayeredBlock } from './layers.ts';
export { changeReport, type ReportArgs, type ReportVersion } from './report.ts';
export { ExampleDecisionError, approvedHouseExamples, candidateLines, decideExample, saveCandidates, textHash, toCorpusExample, type CandidateProposal } from './house.ts';
export { PATTERN_NOTES, patternsMarkdown, rubricMarkdown } from './docs.ts';
export { countWords, maskQuotes, narratorSentences, quantities, quantitiesAdded, quantitiesLost, sentencesOf, type NarrationBlock, type Sentence } from './text.ts';
