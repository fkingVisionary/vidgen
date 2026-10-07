import { JOB_TYPES } from '@docengine/core';
import { describe, expect, it } from 'vitest';
import type { StageContext } from '../context.ts';
import { createMockStageHandlers } from './mock-stages.ts';

/** A context any use of which fails the test: a handler that reads it would call a provider or the database. */
const untouchable = new Proxy({} as StageContext, {
  get(_target, key) {
    throw new Error(`the handler used ctx.${String(key)}`);
  },
});

describe('mock stage handlers', () => {
  it('has a MOCK handler for every job type', () => {
    const handlers = createMockStageHandlers();
    expect(Object.keys(handlers).sort()).toEqual([...JOB_TYPES].sort());
    for (const type of JOB_TYPES) expect(handlers[type], type).toMatchObject({ type, mock: true });
  });

  it('plans no storyboard preview and calls nothing (it can run while the narration is reviewed, with a real model configured)', async () => {
    const result = await createMockStageHandlers().STORYBOARD_PREVIEW.run(untouchable);
    expect(result).toMatchObject({ mock: true, note: 'No storyboard preview was created.' });
  });
});
