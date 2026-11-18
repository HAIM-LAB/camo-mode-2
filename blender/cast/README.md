# Camo Mode 2 cast assets

Two generators live here. `generate_cast.py` builds the cartoon player, both friends, and the props from Blender primitives and procedural materials, with no outside assets. `generate_realistic_player.py` builds the realistic player from CC0 MakeHuman assets; [`docs/third-party-assets.md`](../../docs/third-party-assets.md) records each one.

## Rebuild the cartoon player, friends, and props

From the repository root:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python blender/cast/generate_cast.py
```

The generator overwrites `camo-cast.blend`, `cast-lineup.png`, and these runtime exports:

- `/assets/cast/player-cartoon.glb`
- `/assets/cast/friend-a.glb`
- `/assets/cast/friend-b.glb`
- `/assets/cast/ball.glb`
- `/assets/cast/block.glb`

Before exporting, the generator measures the gap between the cartoon player's arms and its body while it stands and through every frame of both clips, in trousers and in the skirt, and fails if a mitt or lower sleeve comes within 20 mm. At the end of generation, each GLB is cleared into a fresh Blender scene, imported independently, and checked for geometry, file size, scale, ground contact, and expected prop centering.

Blender does not write byte-identical GLBs from run to run. After changing only the player, restore the files you did not mean to touch (`git checkout -- public/assets/cast/friend-a.glb` and so on) rather than committing the churn.

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

It overwrites `/assets/cast/player-realistic.glb` and `realistic-player-preview.png`. Before exporting it plays the walk and fails if a planted foot slides more than 6 mm, and it measures the gap between the hands and forearms and the body while standing and through both clips, in trousers and in the skirt, failing under 20 mm. After exporting it re-imports the GLB and checks its parts, clips, height, ground contact, triangle count (28,000 at most), and size (2.5 MB at most). It stops with a pointer back to this file if MPFB or the pack is missing. Add `-- --views <directory>` to also save close-up renders of every look.

No `.blend` is kept for this model: the script and the CC0 sources are the source, and the processed textures exist only inside the GLB.

What the script does with the MakeHuman sources:

- Body: a young child of six or seven, just under six heads tall, with a round face, a slight smile, and relaxed eyes. It is built, dressed, animated, and checked at a real child's 1.1 m, then enlarged as a whole to 1.38 m so that it stands as tall in the playroom as the rest of the cast; enlarging keeps its proportions. MakeHuman's age control alone gives an older child's build, so head, leg, and shoulder morphs bring it to a young child's proportions. Boy and Girl share it; only the hair differs.
- Skin under the clothes is removed from the mesh and blanked in the texture, so no unclothed body ships.
- Textures become neutral detail maps that the outfit and skin colors multiply. The shirt's print is dropped and the shoes are untextured, so no logo or brand mark survives.
- The skirt and its leggings are cut from the base mesh's own garment helpers. The beanie and the head scarf's wrap are layers fitted over the head, the scarf's drape is laid from the neck onto the collarbones, and the hair is trimmed to what shows below the beanie. All of them are placed from measurements of the built head, so they follow any change to the body's proportions.
- The walk is built from where the feet are on the ground and solved back to leg angles, so each planted foot stays put at the speed the game moves this player. The exported file records that speed as the rig's `walk_speed`: `WALK_SPEED` times the enlargement, 1.81 m/s. `moveSpeed` in `src/player-avatar.ts` must equal it, and `tests/player-avatar.test.ts` fails if it does not.
- MakeHuman's A-pose is turned into a relaxed stand and made the rest pose, so the model stands naturally even where no clip plays. The arms are held a little out, so the hands and forearms hang clear of the top, the hips, and the skirt.

## Runtime contract

- Binary glTF (`.glb`), meters, Y-up, forward +Z.
- Character origins are centered between the feet at floor contact; floor is y=0.
- Prop origins are centered horizontally at ground contact; floor is y=0.
- The friends are approximately 1.4 m tall, the cartoon player 1.30 m, and the realistic player 1.38 m.
- Ball diameter is 0.34 m. Block dimensions are approximately 0.30 × 0.24 × 0.295 m including studs.
- Everything from `generate_cast.py` uses vertex geometry and embedded glTF material values only. The realistic player also embeds its textures.
- Both players carry `idle` and `walk` clips that loop in place. The cartoon player's clips move pivot nodes; the realistic player's move a skeleton.
- The players' material and part names are runtime API: character customization repaints materials and shows part sets (hair, bottoms, headwear) by name, the same way on both models. See [`docs/asset-contract.md`](../../docs/asset-contract.md#player-models).
- Each player GLB carries every alternative part set; `cast-lineup.png` and `realistic-player-preview.png` show chosen looks rather than every set at once.

The `.blend` keeps the five primitive assets in named collections and places them in a studio lineup; the cartoon player is deliberately turned around there to preview its third-person rear read while both friends face forward. Exported files are generated before those preview transforms and remain at their own local origins. The player's gold backpack and beanie provide its deliberate rear-view identity.

Integrated runtime anchors are placement data rather than baked transforms: player `(-0.95,0,2.90)`, Friend A `(3.42,0,1.42)`, Friend B `(2.62,0,-5.35)`, ball `(-0.15,0,0.78)`, and block `(1.20,0,1.32)`. See [`docs/asset-contract.md`](../../docs/asset-contract.md) for the full room-aware composition, including Camo.
