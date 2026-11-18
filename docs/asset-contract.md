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

## Player customization

The character menu customizes `player.glb` at runtime by name, so these names are API. Keep them on the parts they cover today when regenerating the player; `tests/player-look.test.ts` loads the real file and fails if one disappears.

Materials, repainted by name:
- `Player Skin` and `Player Skin Light` carry the skin tone. `Ink` (eyes) and `Smile` (mouth) deepen on the darker tones so the face stays readable.
- `Player Teal`, `Player Teal Dark`, `Player Coral`, `Player Gold`, and `Player Gold Dark` carry the outfit. `Player Scarf`, `Player Scarf Dark`, and `Player Skirt` follow it: the head scarf takes the beanie's colors and the skirt the hood's.

Part sets, shown or hidden by node-name prefix (one shared body; see `add_player_variants()` in `blender/cast/generate_cast.py`):
- `player_hair_boy_*` and `player_hair_girl_*`: Boy and Girl differ only in hair. `player_hair_back` is shared.
- `player_skirt*`: a knee-length skirt over the trouser legs.
- `player_beanie_*` and `player_scarf_*`: headwear. The head scarf also hides every `player_hair_*`, the `player_ear_*` parts, and `player_hoodie_hood`.

All parts export together, so the player's bounds include the head scarf (1.44 m tall). The default look is Boy, trousers, and beanie in the authored colors: the approved art plus the boy's fringe.
