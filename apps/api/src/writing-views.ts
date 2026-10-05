import { AI_PATTERNS, RUBRIC_DIMENSIONS, type WritingCategory, type WritingCorpusView, type WritingExampleStatus, type WritingExampleView, type WritingQuality } from '@docengine/core';
import type { Database, WritingExample } from '@docengine/database';
import { PATTERN_NOTES, RUBRIC_QUESTIONS, RUBRIC_VERSION, STYLE_BIBLE, STYLE_BIBLE_VERSION, approvedHouseExamples, loadCorpus, withHouseExamples } from '@docengine/writing';

/** Read models for the house-style corpus page. */

export function toWritingExampleView(r: WritingExample): WritingExampleView {
  return {
    id: r.id,
    exampleId: r.exampleId,
    version: r.version,
    status: r.status as WritingExampleStatus,
    text: r.text,
    category: r.category as WritingCategory,
    quality: r.quality as WritingQuality,
    traits: r.traits,
    narrativeFunction: r.narrativeFunction,
    spokenRhythm: r.spokenRhythm,
    whyItWorks: r.whyItWorks,
    whyItFails: r.whyItFails,
    projectId: r.projectId,
    scriptVersion: r.scriptVersion,
    blockKey: r.blockKey,
    sourceReference: r.sourceReference,
    createdBy: r.createdBy,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt.toISOString(),
  };
}

export async function loadWritingCorpus(db: Database): Promise<WritingCorpusView> {
  const corpus = withHouseExamples(loadCorpus(), await approvedHouseExamples(db));
  const house = await db.writingExample.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 500 });
  return {
    version: corpus.version,
    manifest: corpus.manifest,
    styleBible: { version: STYLE_BIBLE_VERSION, sections: STYLE_BIBLE.map((x) => ({ ...x, rules: [...x.rules] })) },
    rubric: { version: RUBRIC_VERSION, dimensions: RUBRIC_DIMENSIONS.map((d) => ({ dimension: d, question: RUBRIC_QUESTIONS[d] })) },
    patterns: AI_PATTERNS.map((p) => ({ pattern: p, ...PATTERN_NOTES[p] })),
    examples: corpus.examples,
    errors: corpus.errors,
    house: house.map(toWritingExampleView),
  };
}
