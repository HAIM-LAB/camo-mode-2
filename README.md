# Camo Mode 2

A presentation-ready Three.js playroom prototype with the approved Camo, cast, prop, and living-room GLBs, smooth keyboard movement, an elevated follow camera, proximity guidance, carryable props, and a modular LLM-driven conversational-agent layer. Every asset retains a procedural fallback for missing or failed files, and the dialogue layer runs with no API keys at all.

## Start locally

From the repository root, the authoritative one-command start is:

```sh
npm install && npm run dev
```

Open [http://localhost:4173](http://localhost:4173). Vite also prints a network URL for testing on another device.

**No API keys are required.** With no `.env` present the keyless mock brain drives the conversation from authored offline lines, so the full path — approach a character, open the panel, exchange turns, watch the story move — works out of the box.

## Controls

- **Arrow keys** or **WASD** — move around the room
- **E** — pick up the nearest ball or building block; press again to drop it
- **T**, or the **Talk** button — start a conversation with whoever is nearest
- **Esc**, the **Leave** button, or simply walking away — end a conversation, always without penalty

## Talking to the characters

Camo, Friend A, and Friend B each have an authored persona (identity, speech texture, OCEAN traits, and a mutable emotion state) and follow an authored storylet graph. Replies stream in as they arrive and are spoken through ElevenLabs when a voice key is configured. A microphone button appears when speech-to-text is available; typing always works.

What is true in the room changes how you are received — walk up to the friend on the patio while carrying the ball they fell out over and he will tell you not now.

See [`docs/dialogue-architecture.md`](docs/dialogue-architecture.md) for the interfaces, the provider swap procedure, the persona and graph schemas, the authoring templates, the key/proxy model, and the safety seam.

## Configuration

Copy [`.env.example`](.env.example) to `.env` and fill in what you have; `.env` is gitignored.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Hosted chat providers |
| `GROQ_API_KEY` / `CEREBRAS_API_KEY` | LPU inference against an open model |
| `CAMO_BRAIN` | Pin a provider: `mock`, `anthropic`, `openai`, `groq`, `cerebras` |
| `CAMO_MODEL` | Override the model id for the active provider |
| `ELEVENLABS_API_KEY` | Voice out, and speech-to-text via Scribe |
| `CAMO_MODERATION` / `MODERATION_ENDPOINT` | Safety gate: `permissive` (default), `shield`, `none` |

Every one of these is read **server-side only**, by the Vite middleware plugin in `server/dialogue-proxy.ts`. None is prefixed `VITE_`, and no key is reachable from browser-delivered code.

The player remains inside the 12m × 9m room. Camo starts beside the player on the carpet, Friend A is inside by the couch, and Friend B is visible outside on the patio. Approach Friend B from the patio doorway; the exterior is intentionally a presentation stop rather than navigable space. Move close to either toy to see its pickup prompt.

## Approved GLB art

The bundled approved GLBs load by default. The app starts with procedural backups and replaces each one independently; a missing or malformed file stays on its fallback and is reported in the status pill rather than failing startup.

See [`docs/asset-contract.md`](docs/asset-contract.md) for the authoritative coordinates, asset URLs, units, orientation, and loader behavior.

## Validation

```sh
npm test
npm run build
npm run preview
```

The production preview is also served at `http://localhost:4173`; the dialogue proxy is installed on it as well as on the dev server. `window.__CAMO_DEMO__.getState()` provides a read-only smoke-test snapshot of readiness, player and entity positions, carried item, active prompt, asset modes, and dialogue state.

A research inspector — current beat, live emotion vector, which edge fired last turn and why, and the last assembled prompt — is available with the backtick key or `?debug=1`. It is off by default and never appears in a demo run.

For the five-minute team walkthrough, interactive/narrated boundaries, and review capture, see [`docs/presenter-notes.md`](docs/presenter-notes.md) and [`docs/review/integrated-scene.png`](docs/review/integrated-scene.png).
