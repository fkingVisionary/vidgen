# modules/

Home of the **real** pipeline stages. A stage without a module here runs a
MOCK placeholder from
[`packages/pipeline/src/stages/mock-stages.ts`](../packages/pipeline/src/stages/mock-stages.ts).

| Module | Package | What it is (docs/ARCHITECTURE.md) |
|---|---|---|
| `research` | `@docengine/research` | RESEARCH: the evidence dossier (§11) |
| `story` | `@docengine/story` | STORY_MINING, STORY_ARCHITECTURE, revisions and STORY_ANGLES (§12–§14) |
| `script` | `@docengine/script` | SCRIPT: the spoken script, its rules and versions (§15) |
| `voice` | `@docengine/voice` | VOICE: narration in chunks, takes, assemblies, the VOICE gate, saved voice profiles; the narration spine read (§16) |
| `writing` | `@docengine/writing` | A library for the script stage: the house-style corpus, diagnostics, the narration pass (§17) |
| `storyboard` | `@docengine/storyboard` | VISUAL_PLAN and STORYBOARD_PREVIEW: the storyboard (beats and shots on the narration's clock, treatments, evidence, continuity, forecasts), its versions, decisions and STORYBOARD gate, and the visual profile library (§18). It generates no media |

Planned: visual generation, `infographics`, `editor`, `qa` (plus
`localization` and `publishing` later).

A module may export a `./testing` entry (scripted fakes and synthetic
fixtures, never used in production code): `@docengine/research/testing`, `@docengine/story/testing`,
`@docengine/script/testing`, `@docengine/voice/testing`,
`@docengine/storyboard/testing`.

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
