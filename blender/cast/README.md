# Camo Mode 2 cast assets

Original low-poly character and prop assets generated entirely with Blender primitives and procedural materials. No external textures, fonts, or licensed assets are used.

## Rebuild

From the repository root:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python blender/cast/generate_cast.py
```

The generator overwrites `camo-cast.blend`, `cast-lineup.png`, and these runtime exports:

- `/assets/cast/player.glb`
- `/assets/cast/friend-a.glb`
- `/assets/cast/friend-b.glb`
- `/assets/cast/ball.glb`
- `/assets/cast/block.glb`

At the end of generation, each GLB is cleared into a fresh Blender scene, imported independently, and checked for geometry, file size, scale, ground contact, and expected prop centering.

## Runtime contract

- Binary glTF (`.glb`), meters, Y-up, forward +Z.
- Character origins are centered between the feet at floor contact; floor is y=0.
- Prop origins are centered horizontally at ground contact; floor is y=0.
- Characters are approximately 1.4 m tall.
- Ball diameter is 0.34 m. Block dimensions are approximately 0.30 × 0.24 × 0.295 m including studs.
- Materials use vertex geometry and embedded glTF material values only.

The `.blend` keeps the five assets in named collections and places them in a studio lineup; the player is deliberately turned around there to preview its third-person rear read while both friends face forward. Exported files are generated before those preview transforms and remain at their own local origins. The player's gold backpack, hood, and coral trousers provide its deliberate rear-view identity.

Suggested runtime anchors are integration data rather than baked transforms: player `(-4,0,3)`, Friend A `(2,0,-1)`, Friend B `(3.5,0,-1)`, ball `(-1,0,1)`, and block `(0.5,0,1)`.
