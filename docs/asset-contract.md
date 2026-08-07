# Asset integration contract

This is the shared handoff contract for application, world, cast, and guide lanes. Optional files may land independently; the browser app must remain functional without them.

Shared integration contract:
- Three.js/Vite, glTF binary (`.glb`), meters, Y-up, ground at y=0, forward +Z, asset origin centered at floor contact.
- Indoor footprint: x=-6..6, z=-4.5..4.5. Player spawn `(-0.95,0,2.90)`.
- Integrated anchors: Camo `(-1.52,0,1.72)`, Friend A `(3.42,0,1.42)`, Friend B `(2.62,0,-5.35)`, ball `(-0.15,0,0.78)`, block `(1.20,0,1.32)`.
- Optional asset URLs: `/assets/camo/camo.glb`, `/assets/world/living-room.glb`, `/assets/cast/player.glb`, `/assets/cast/friend-a.glb`, `/assets/cast/friend-b.glb`, `/assets/cast/ball.glb`, `/assets/cast/block.glb`.
- Character and prop loaders normalize scene placement but must not silently rescale contract-compliant files. The room preserves its authored world origin.

## Loader behavior

The app renders procedural stand-ins immediately, then attempts each URL independently. A missing, empty, or malformed GLB leaves its stand-in in place and does not block the rest of the scene.

Character and prop bounds are centered in X/Z and moved to floor contact before the anchor transform is applied. The loader never changes model scale. For a contract-compliant model (centered at the origin with its lowest point at y=0), placement normalization is a no-op.

The living-room asset is anchored at world origin without bounds centering. Its shallow patio/backyard intentionally makes the full asset asymmetric in Z; centering aggregate bounds would incorrectly move the indoor floor and furniture. Friend B remains on that patio while player movement remains indoors. The nearest indoor doorway position is within the proximity radius, so it is the presentation/approach point for Friend B.

The player and Camo start together on the rug, left of the coffee table; Friend A stands inside by the couch. Cast and props are parented to the exact integrated anchors above. Keep model-authored units in meters; make any artistic scale correction in the source lane rather than relying on application scaling.
