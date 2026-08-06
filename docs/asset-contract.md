# Asset integration contract

This is the shared handoff contract for application, world, cast, and guide lanes. Optional files may land independently; the browser app must remain functional without them.

Shared integration contract (repeat this verbatim in project docs):
- Three.js/Vite, glTF binary (`.glb`), meters, Y-up, ground at y=0, forward +Z, asset origin centered at floor contact.
- Room footprint: x=-6..6, z=-4.5..4.5. Player spawn (-4,0,3).
- Scene anchors: Camo (-3,0,-2), Friend A (2,0,-1), Friend B (3.5,0,-1), ball (-1,0,1), block (0.5,0,1).
- Optional asset URLs: `/assets/camo/camo.glb`, `/assets/world/living-room.glb`, `/assets/cast/player.glb`, `/assets/cast/friend-a.glb`, `/assets/cast/friend-b.glb`, `/assets/cast/ball.glb`, `/assets/cast/block.glb`.
- Asset loaders normalize scene placement but must not silently rescale contract-compliant files.

## Loader behavior

The app renders procedural stand-ins immediately, then attempts each URL independently. A missing, empty, or malformed GLB leaves its stand-in in place and does not block the rest of the scene.

Loaded scene bounds are centered in X/Z and moved to floor contact before the anchor transform is applied. The loader never changes model scale. For a contract-compliant model (centered at the origin with its lowest point at y=0), placement normalization is a no-op.

The living-room asset is anchored at world origin. Cast and prop assets are parented to the exact scene anchors above. Keep model-authored units in meters; make any artistic scale correction in the source lane rather than relying on application scaling.
