# Camo Mode 2 cast assets

Three generators live here. `generate_cast.py` builds the cartoon cast (the player and both friends) and the props from Blender primitives and procedural materials, with no outside assets. `generate_realistic_player.py` and `generate_realistic_friends.py` build the realistic player and the realistic friends from CC0 MakeHuman assets; [`docs/third-party-assets.md`](../../docs/third-party-assets.md) records each one. Camo has its own generator for both styles, [`blender/camo/generate_camo.py`](../camo/generate_camo.py), which draws the cartoon Camo with this folder's kit.

## Rebuild the cartoon cast and the props

From the repository root:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python blender/cast/generate_cast.py
```

The generator overwrites `camo-cast.blend`, `cast-lineup.png`, and these runtime exports:

- `/assets/cast/player-cartoon.glb`
- `/assets/cast/friend-a-cartoon.glb`
- `/assets/cast/friend-b-cartoon.glb`
- `/assets/cast/ball.glb`
- `/assets/cast/block.glb`

The friends are drawn with the player's kit and at its proportions: the same round head and painted-on face, their own hair and clothes, and the player's relaxed arms. Before exporting, the generator measures the gap between each character's arms and its body while it stands and through every frame of its clips (the player in trousers and in the skirt), and fails if a mitt or the free part of an arm comes within 20 mm. At the end of generation, each GLB is cleared into a fresh Blender scene, imported independently, and checked for geometry, clips, file size, scale, ground contact, and expected prop centering. Add `-- --views <directory>` to also save close-up renders of each character.

Blender does not write byte-identical GLBs from run to run. After changing only one character, restore the files you did not mean to touch (`git checkout -- public/assets/cast/ball.glb` and so on) rather than committing the churn.

## Rebuild the realistic player

One-time setup: install [MPFB](https://static.makehumancommunity.org/mpfb.html) (MakeHuman for Blender, 2.0.18 or later) and the CC0 "MakeHuman system assets" pack into the Blender you generate with.

```bash
BLENDER=/Applications/Blender.app/Contents/MacOS/Blender
$BLENDER --online-mode --command extension sync
$BLENDER --online-mode --command extension install -e mpfb

# 281 MB; https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html
curl -LO https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
unzip makehuman_system_assets_cc0.zip \
  -d "$HOME/Library/Application Support/Blender/4.5/extensions/.user/blender_org/mpfb/data"
```

To keep MPFB out of your everyday Blender profile, set `BLENDER_USER_RESOURCES` to a scratch directory for the commands above and for the generator, and unzip the pack into `$BLENDER_USER_RESOURCES/extensions/.user/blender_org/mpfb/data` instead.

Then, from the repository root:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python blender/cast/generate_realistic_player.py
```

It overwrites `/assets/cast/player-realistic.glb` and `realistic-player-preview.png`. Before exporting it plays the walk and fails if a planted foot slides more than 6 mm, and it measures the gap between the hands and forearms and the body while standing and through both clips, in trousers and in the skirt, failing under 20 mm. After exporting it re-imports the GLB and checks its parts, clips, height, ground contact, triangle count (31,000 at most), and size (2.5 MB at most). It stops with a pointer back to this file if MPFB or the pack is missing. Add `-- --views <directory>` to also save renders of every look from all around, close-ups of the head included.

No `.blend` is kept for this model: the script and the CC0 sources are the source, and the processed textures exist only inside the GLB.

What the script does with the MakeHuman sources:

- Body: a young child of six or seven, just under six heads tall, with a round face, a slight smile, and relaxed eyes. It is built, dressed, animated, and checked at a real child's 1.1 m, then enlarged as a whole to 1.38 m so that it stands as tall in the playroom as the rest of the cast; enlarging keeps its proportions. MakeHuman's age control alone gives an older child's build, so head, leg, and shoulder morphs bring it to a young child's proportions. Boy and Girl share it; only the hair differs.
- Skin under the clothes is removed from the mesh and blanked in the texture, so no unclothed body ships.
- Textures become neutral detail maps that the outfit and skin colors multiply. The shirt's print is dropped and the shoes are untextured, so no logo or brand mark survives.
- The skirt and its leggings are cut from the base mesh's own garment helpers. The beanie and the head scarf's wrap are layers fitted over the head, and the scarf's drape is laid from the neck onto the collarbones. All of them are placed from measurements of the built head, so they follow any change to the body's proportions.
- Each hairstyle is cut in two along the beanie's brim. The part below it shows under a hat; the part above it shows only on a bare head, so the beanie hides it rather than having it poke through the knit. The long hair lies flat against the upper skull as it comes from MakeHuman, which would give a bare head a pointed top, so above the brim it is lifted to an even depth. The hair a hat shows is not changed.
- The walk is built from where the feet are on the ground and solved back to leg angles, so each planted foot stays put at the speed the game moves this player. The exported file records that speed as the rig's `walk_speed`: `WALK_SPEED` times the enlargement, 1.81 m/s. `moveSpeed` in `src/player-avatar.ts` must equal it, and `tests/player-avatar.test.ts` fails if it does not.
- MakeHuman's A-pose is turned into a relaxed stand and made the rest pose, so the model stands naturally even where no clip plays. The arms are held a little out, so the hands and forearms hang clear of the top, the hips, and the skirt.

## Rebuild the realistic friends

With the same one-time setup as the realistic player:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python blender/cast/generate_realistic_friends.py
```

It overwrites `/assets/cast/friend-a-realistic.glb`, `/assets/cast/friend-b-realistic.glb`, and `realistic-friends-preview.png`. Add `-- --views <directory>` for close-up renders and `-- --only friend-a` (or `friend-b`) to build one.

The script imports `generate_realistic_player.py` and reuses its building blocks, so the friends are the player's kind of child: the same body, age, and build, the same texture and material treatment, the same relaxed stand, and the same arm-to-body measurement, failing under 20 mm. Each friend carries one clip, `idle`; the script solves the legs from the planted ankles and fails if a foot moves more than 3 mm while the body shifts over it. After exporting it re-imports each GLB and checks its parts, clip, height, ground contact, triangle count, and size.

What makes each friend themselves:

- Friend A: the dress is the pack's T-shirt down to a sash at the waist and, from there, a skirt cut from the base mesh's own helper over its tights. The sleeves are the T-shirt's own pattern pieces, in their own color. Her hair is drawn tight over the scalp, a thin layer with a soft, uneven hairline painted in the script, into two puffs made from the pack's afro.
- Friend B: the pack's jacket is recut for a child: hip length, taken in at the waist, and its sleeves slimmed and ended at the wrists so the hands show. The pack's side-swept hair is mirrored to sweep the way the cartoon Friend B's does, and its fringe is lifted clear of the eye.
- Colors are the cartoon friends' hues at the depth of the realistic player's outfits. Prints and patterns in the pack's textures are dropped, as on the player; only folds and the denim weave are kept.

## Runtime contract

- Binary glTF (`.glb`), meters, Y-up, forward +Z.
- Character origins are centered between the feet at floor contact; floor is y=0.
- Prop origins are centered horizontally at ground contact; floor is y=0.
- The cartoon player is 1.30 m tall in its beanie and the cartoon friends 1.26 m and 1.15 m with their hair. The realistic player is 1.38 m in its beanie, 1.37 m to the crown, and its hair stands about a centimeter taller than the beanie on a bare head; the realistic friends stand 1.36 m and 1.38 m to the crown.
- Ball diameter is 0.34 m. Block dimensions are approximately 0.30 × 0.24 × 0.295 m including studs.
- Everything from `generate_cast.py` uses vertex geometry and embedded glTF material values only. The realistic models also embed their textures.
- Both players carry `idle` and `walk` clips that loop in place; the friends carry `idle` only, since they stay where they stand. The cartoon models' clips move pivot nodes; the realistic models' move a skeleton.
- A friend's nodes are named `friend_a_*` or `friend_b_*`, never `player_*`.
- The players' material and part names are runtime API: character customization repaints materials and shows part sets (hair, bottoms, headwear or the bare head's hair) by name, the same way on both models. See [`docs/asset-contract.md`](../../docs/asset-contract.md#player-models).
- Each player GLB carries every alternative part set; `cast-lineup.png` and `realistic-player-preview.png` show chosen looks rather than every set at once.

The `.blend` keeps the five assets of `generate_cast.py` in named collections and places them in a studio lineup; the cartoon player is deliberately turned around there to preview its third-person rear read while both friends face forward. Exported files are generated before those preview transforms and remain at their own local origins. The player's gold backpack and beanie provide its deliberate rear-view identity.

Integrated runtime anchors are placement data rather than baked transforms: player `(-0.95,0,2.90)`, Friend A `(3.42,0,1.42)`, Friend B `(2.62,0,-5.35)`, ball `(-0.15,0,0.78)`, and block `(1.20,0,1.32)`. See [`docs/asset-contract.md`](../../docs/asset-contract.md) for the full room-aware composition, including Camo.
