# Runtime Architecture

OWEN now runs through an explicit runtime shell instead of routing everything through `src/index.ts`.

## Entry Point

- `src/index.ts` is the Worker shell.
- It validates env bindings, handles global `OPTIONS`, delegates to `src/router.ts`, then applies security headers.

## Request Context

- `src/runtime/context.ts` builds a `RuntimeContext` per request.
- The context bundles env, app config, request id, request URL, observability hooks, capability flags, and storage bindings.
- `src/runtime/session-store.ts` wraps auth/browser session persistence and conversation scoping.
- `src/runtime/transcript-store.ts` isolates transcript replay/compaction helpers.

## Route Dispatch

- `src/routes/api.ts` is the canonical API dispatcher for `/api/*`.
- `src/routes/assets.ts` owns asset rewrites, compatibility paths, and `/index.html` fallback behavior.
- `src/router.ts` now dispatches directly to those two route owners.

## Service Domains

- `src/services/*` expose domain entrypoints for chat, library, quiz, study-guide, Anki, analytics, pdf, upload, auth, conversations, and presence compatibility.
- Shared runtime utilities now live under `src/services/runtime/*` with dedicated env, HTTP, OpenAI, storage, and vector-store owners.
- The former runtime compatibility shim has been removed.

## Registries

- `src/registry/prompts.ts` reads `src/generated/prompt-registry.ts`.
- `src/generated/prompt-registry.ts` is built from canonical prompt assets under `prompts/`.
- `src/registry/agents.ts`, `src/registry/models.ts`, and `src/registry/pipelines.ts` expose live runtime metadata.
- `src/runtime/execution-registry.ts` assembles route, prompt, pipeline, agent, and model registries into one runtime inventory.
- `src/runtime/system-init.ts` exposes the self-observation summary used by architecture tooling.

## Pipelines

- Study-guide, quiz, and Anki flows are described in `src/registry/pipelines.ts`.
- The registry records stage ids, contracts, and validators so runtime metadata and tooling stay aligned with live features.

## Prompts

- Canonical prompt sources live in `prompts/`.
- `scripts/build-prompt-registry.mjs` compiles them into `src/generated/prompt-registry.ts`.
- Runtime code imports prompts through `src/registry/prompts.ts`; there are no filesystem reads at Worker runtime.

## Test Boundaries

- `src/index.ts` is reserved for Worker/integration tests.
- Unit tests now import helper modules directly from `src/services/*`, `src/registry/prompts.ts`, or `src/anki_house_style.ts`.
- Architecture scripts use the registries directly instead of scraping `src/index.ts`.
