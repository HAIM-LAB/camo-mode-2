# Camo Mode 2

A presentation-ready Three.js playroom prototype with the approved Camo, cast, prop, and living-room GLBs, smooth keyboard movement, an elevated follow camera, proximity guidance, and carryable props. Every asset retains a procedural fallback for missing or failed files.

## Start locally

From the repository root, the authoritative one-command start is:

```sh
npm install && npm run dev
```

Open [http://localhost:4173](http://localhost:4173). Vite also prints a network URL for testing on another device.

## Controls

- **Arrow keys** or **WASD** — move around the room
- **E** — pick up the nearest ball or building block; press again to drop it

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

The production preview is also served at `http://localhost:4173`. `window.__CAMO_DEMO__.getState()` provides a read-only smoke-test snapshot of readiness, player and entity positions, carried item, active prompt, and asset modes.

For the five-minute team walkthrough, interactive/narrated boundaries, and review capture, see [`docs/presenter-notes.md`](docs/presenter-notes.md) and [`docs/review/integrated-scene.png`](docs/review/integrated-scene.png).
