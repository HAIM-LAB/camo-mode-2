# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Asset coordinates and integration rules: `docs/asset-contract.md`.
- Conversational-agent layer - provider interfaces, persona/storylet schemas, authoring templates, key/proxy model, safety seam: `docs/dialogue-architecture.md`.
- Authoritative local start: `npm install && npm run dev`. It must keep working with **no API keys present**; the keyless mock brain is the default path, not a fallback to fix later.
- API keys are read server-side only, in `server/`. Never name a secret `VITE_*` and never read one from `src/`. After touching `server/` or `src/dialogue/providers/`, re-run the leak check in `docs/dialogue-architecture.md`.
- Authored content (personas, storylets, age bands) lives in `data/*.jsonc`, never in TypeScript. `data/templates/` is blank by design and is deliberately outside every loader glob.
- Never store a bare `fetch` on an object; wrap it in `resolveFetch()` from `src/dialogue/providers/types.ts`. `this.fetchImpl(...)` on an unbound native `fetch` throws `Illegal invocation` in browsers only - node, vitest, and `curl` all pass, so this class of bug reaches a live demo undetected. Tests in `tests/dialogue-providers.test.ts` pin it.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
