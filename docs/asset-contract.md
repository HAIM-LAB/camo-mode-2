# Asset integration contract

This is the shared handoff contract for application, world, cast, and guide lanes. Optional files may land independently; the browser app must remain functional without them.

Shared integration contract:
- Three.js/Vite, glTF binary (`.glb`), meters, Y-up, ground at y=0, forward +Z, asset origin centered at floor contact.
- Indoor footprint: x=-6..6, z=-4.5..4.5. Player spawn `(-0.95,0,2.90)`.
- Integrated anchors: Camo `(-1.52,0,1.72)`, Friend A `(3.42,0,1.42)`, Friend B `(2.62,0,-5.35)`, ball `(-0.15,0,0.78)`, block `(1.20,0,1.32)`.
- Optional asset URLs: the room and the toys are `/assets/world/living-room.glb`, `/assets/cast/ball.glb`, and `/assets/cast/block.glb`. Every character has one model per style, `cartoon` and `realistic`: `/assets/cast/player-<style>.glb`, `/assets/cast/friend-a-<style>.glb`, `/assets/cast/friend-b-<style>.glb`, and `/assets/camo/camo-<style>.glb`. Only the chosen style's four are requested.
- Character and prop loaders normalize scene placement but must not silently rescale contract-compliant files. The room preserves its authored world origin.

## Loader behavior

The app renders procedural stand-ins immediately, then attempts each URL independently. A missing, empty, or malformed GLB leaves its stand-in in place and does not block the rest of the scene.

Character and prop bounds are centered in X/Z and moved to floor contact before the anchor transform is applied. The loader never changes model scale. For a contract-compliant model (centered at the origin with its lowest point at y=0), placement normalization is a no-op.

The living-room asset is anchored at world origin without bounds centering. Its shallow patio/backyard intentionally makes the full asset asymmetric in Z; centering aggregate bounds would incorrectly move the indoor floor and furniture. Friend B remains on that patio while player movement remains indoors. The nearest indoor doorway position is within the proximity radius, so it is the presentation/approach point for Friend B.

The player and Camo start together on the rug, left of the coffee table; Friend A stands inside by the couch. Cast and props are parented to the exact integrated anchors above. Keep model-authored units in meters; make any artistic scale correction in the source lane rather than relying on application scaling.

## The cast in each style

The style the child picks draws the whole cast, not only the player: `CAST_ASSET_URLS` in `src/config.ts` maps each style to its player, Camo, Friend A, and Friend B, and the playroom requests that one set. The room and the toys are the same in both.

Each character is built the way the matching player is:

| Character | Cartoon | Realistic |
| --- | --- | --- |
| Player | `build_player()` in `blender/cast/generate_cast.py` | `blender/cast/generate_realistic_player.py` |
| Friend A, Friend B | `build_friend_a()` and `build_friend_b()` in `generate_cast.py`, from the same kit and at the player's proportions | `blender/cast/generate_realistic_friends.py`, from the same CC0 sources as the player ([`third-party-assets.md`](third-party-assets.md)) |
| Camo | `build_cartoon()` in `blender/camo/generate_camo.py`, from the same kit | `build_realistic()` in `generate_camo.py`: an original sculpted and painted chameleon |

A character is the same individual in both styles. Keep these when regenerating one:

- Friend A: twin puffs tied in yellow, a mint dress with short lavender sleeves, a yellow sash and a plum panel on it, lavender leggings, plum shoes.
- Friend B: swept blue-black hair held by a lime clip, a rust jacket open over a sky shirt, a lime collar, navy trousers and shoes, one foot a little forward.
- Camo: a plump green chameleon with a cream belly and muzzle, teal bars on its flanks and tail, a sunny crest, amber turret eyes, a curled tail, and the coral kerchief that marks it as the guide.

What the application relies on:

- Names: every node of a friend's model starts with `friend_a_` or `friend_b_`, and of Camo's with `camo_`. None starts with `player_`, which character customization repaints and hides by name.
- Clips: each model carries one clip, `idle`, looping in place. `src/cast-motion.ts` plays it, each character starting at a different point of the loop. These characters stay where they stand, so there is no walk. A model without the clip still works: it stands still, and Camo's procedural stand-in bobs instead.
- Poses: the friends stand as the matching player does, arms relaxed and clear of the body. The generators measure that gap through the idle and fail under 20 mm, and the realistic generators also fail if a planted foot moves.
- Sizes: the cartoon friends stand 1.26 m and 1.15 m with their hair; the realistic ones 1.36 m and 1.38 m to the crown, beside the realistic player's 1.37 m. Camo is about 1.3 m long and 0.65 m tall in both. A friend's name label floats 0.22 m above the loaded model.

`tests/cast-motion.test.ts` loads every one of these files and checks its clip, joints, height, and names; `tests/assets.test.ts` checks that every file a style asks for is shipped.

## Player models

The child picks a style before customizing, and the style picks the model: `player-cartoon.glb` (`build_player()` in `blender/cast/generate_cast.py`) or `player-realistic.glb` (`blender/cast/generate_realistic_player.py`, built from the CC0 assets recorded in [`third-party-assets.md`](third-party-assets.md)). The cartoon player took over from the earlier chunky player, so a look saved before styles existed loads as the cartoon player with every choice kept.

The character menu customizes whichever model is loaded at runtime by name, so these names are API on both models. Keep them on the parts they cover today when regenerating a player; `tests/player-look.test.ts` loads the real files and fails if one disappears.

Materials, repainted by name:
- `Player Skin` carries the skin tone on both models. On the cartoon model `Player Skin Light` (nose) and `Player Blush` (cheeks) follow it, and `Ink` (eyes) and `Smile` (mouth) deepen on the darker tones so the painted face stays readable.
- `Player Teal` (top), `Player Coral` (trousers), `Player Gold` and `Player Gold Dark` (beanie; also the cartoon backpack) carry the outfit. `Player Teal Dark` is the cartoon tunic's trim.
- Five more follow the outfit: `Player Shoes` and `Player Scarf` take the beanie's color, `Player Scarf Dark` its darker shade, `Player Skirt` the top's trim, and `Player Leggings` the trousers' color.
- On the realistic model the skin, top, and trousers are textured. Their textures are neutral detail maps, and the material color multiplies them, so repainting works the same way as on flat colors.

Part sets, shown or hidden by node-name prefix (one shared body per model):
- `player_hair_boy_*` and `player_hair_girl_*`: Boy and Girl differ only in hair. These parts are the hair that shows below a hat.
- `player_trousers*` and `player_skirt*`: bottoms. The skirt set includes the leggings worn under it, so the legs are covered either way.
- `player_beanie_*`, `player_scarf_*`, and `player_bare_*`: headwear, or none. The head scarf also hides every `player_hair_*` part and the realistic model's `player_ear_*`. `player_bare_*` is the hair a hat covers, so it shows only on a bare head. The cartoon model has one such part for both hairstyles. The realistic model has one for each, `player_bare_hair_boy_*` and `player_bare_hair_girl_*`, and Boy or Girl picks between them.

All parts export together, so each model's bounds include its tallest part: the beanie's bobble on the cartoon model, and on the realistic one the hair of a bare head, which stands about a centimeter above the beanie. The default look is Boy, trousers, and beanie in the authored colors.

Clips: each model carries `idle` and `walk`, looping in place. `src/player-avatar.ts` finds them by those names, cross-fades between them, and plays the walk faster or slower with the player's speed. A model without both clips still works: it hops like the procedural stand-in.

Each style has its own movement speed, also in `src/player-avatar.ts`. The cartoon player toddles across the room at 2.75 m/s. The realistic player moves at 1.81 m/s, an easy walk at its playroom size: its walk clip plants each foot for exactly that speed, so the feet do not slide. The model records the speed as its rig's `walk_speed`, and `tests/player-avatar.test.ts` fails if the game's speed for this player differs from it.

Both players stand about as tall as the friends: the cartoon player 1.30 m and the realistic player 1.38 m, each in its beanie. The realistic child is modeled at a real child's height and enlarged as a whole in its generator, so no scaling happens in the application.
