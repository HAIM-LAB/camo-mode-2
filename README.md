# Camo Mode 2

A presentation-ready Three.js playroom prototype with smooth keyboard movement, a fixed elevated follow camera, proximity guidance, and carryable props. Every character, prop, and room element has a procedural fallback, so no external art is required to run the demo.

## Start locally

From the repository root, the authoritative one-command start is:

```sh
npm install && npm run dev
```

Open [http://localhost:4173](http://localhost:4173). Vite also prints a network URL for testing on another device.

## Controls

- **Arrow keys** or **WASD** — move around the room
- **E** — pick up the nearest ball or building block; press again to drop it

The player is constrained to the 12m × 9m room. Move close to Camo, Friend A, Friend B, the ball, or the building block to see a contextual prompt.

## Optional GLB art

The app starts with procedural geometry and attempts optional GLB files in the background. Missing or malformed files remain on their fallbacks and are reported in the small status pill rather than failing startup.

See [`docs/asset-contract.md`](docs/asset-contract.md) for the authoritative coordinates, asset URLs, units, orientation, and loader behavior.

## Validation

```sh
npm test
npm run build
npm run preview
```

The production preview is also served at `http://localhost:4173`. `window.__CAMO_DEMO__.getState()` provides a read-only smoke-test snapshot of readiness, player position, carried item, active prompt, and asset modes.
