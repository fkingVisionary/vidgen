# modules/

Home of the **real** pipeline stages. Empty in milestone 1 on purpose: every
stage currently runs a MOCK placeholder from
[`packages/pipeline/src/stages/mock-stages.ts`](../packages/pipeline/src/stages/mock-stages.ts).

Planned modules: `research`, `story`, `script`, `voice`, `visual-director`,
`infographics`, `editor`, `qa` (plus `localization` and `publishing` later).

## Convention

Each module is a workspace package (`modules/<stage>/package.json`, name
`@docengine/<stage>`) that exports a `StageHandler`:

```ts
import type { StageHandler } from '@docengine/pipeline';

export const researchStage: StageHandler = {
  type: 'RESEARCH',
  mock: false,
  async run(ctx) {
    const hits = await ctx.callProvider('research', 'search', () =>
      ctx.providers.research.search({ query: ctx.project.topic }),
    );
    // …write sources / claims / dossier rows via ctx.db…
    return { dossierId: '…', claims: 42 };
  },
};
```

and is registered in `apps/api/src/container.ts`:

```ts
handlers: { ...createMockStageHandlers(), RESEARCH: researchStage },
```

Rules:

- Use only what `StageContext` provides (db, providers, logger, signal,
  `callProvider`). Never construct vendor clients or read env vars here.
- Route every billable call through `ctx.callProvider` so it is costed and
  logged.
- Throw `NonRetryableError` for failures retrying cannot fix.
- Validate LLM output with the zod contracts in `@docengine/core`.
- Keep prompts next to the stage that uses them, versioned with the code.
