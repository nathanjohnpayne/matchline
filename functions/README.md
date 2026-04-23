# Matchline Functions

Backend for Matchline's AI pipeline, deployed as Firebase Cloud
Functions v2 on Node 20.

## Layout

```
functions/
  src/
    index.ts         entrypoint — exports every deployed function
    llm/             LLM + embedding client wrappers
      anthropic.ts   lazy Anthropic client bound to ANTHROPIC_API_KEY secret
      openai.ts      lazy OpenAI client bound to OPENAI_API_KEY secret
      embeddings.ts  embed / embedMany, OpenAI text-embedding-3-small
      config.ts      per-stage model selection (see specs/matchline.md)
      index.ts       barrel export
  package.json
  tsconfig.json
```

## Conventions

- **No hardcoded model IDs in call sites.** Every stage goes through
  `modelFor(stage)` in `llm/config.ts` so models can be retuned without
  touching business logic.
- **Lazy clients.** The SDK wrappers build their client on first use so
  the module can be imported without materializing secrets.
- **Explicit secrets on each function.** When a function needs an LLM
  key, list the `anthropicKey` / `openaiKey` params in its `secrets:`
  config. Functions without a declared secret cannot read it.

## Build and deploy

Build output lands in `lib/`. Firebase's `predeploy` hook runs
`npm run build` automatically.

```bash
# Local typecheck
npm --prefix functions run typecheck

# Local emulator (requires firebase-tools)
npm --prefix functions run serve

# Deploy (see DEPLOYMENT.md for the 1Password-backed auth flow)
op-firebase-deploy --only functions
```

## Sprint 0 surface

Only `health` is exported in Sprint 0. The extraction, matching,
generation, and validation endpoints defined in `specs/matchline.md`
§ AI pipeline land in Sprint 1.
