"""Generate the realistic Friend A and Friend B for Camo Mode 2 with MPFB (MakeHuman for Blender).

Run from the repository root (see blender/cast/README.md for the one-time MPFB setup):
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/cast/generate_realistic_friends.py

The friends are built the way the realistic player is and from the same CC0
MakeHuman sources, so this script reuses generate_realistic_player.py's building
blocks: the child body, the texture and material handling, the fitted cloth
layers, the pose helpers, and the arm clearance measurement. What is here is
what makes each friend themselves: the face, hair, clothes, stance, and idle.
docs/third-party-assets.md records every outside asset.

Add `-- --views <directory>` to also save close-up renders of each friend,
`-- --emotions <directory>` to save every emotion of each (its face alone, and
its face and body), and `-- --only friend-a` (or friend-b) to build just one.
"""

from __future__ import annotations

import math
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

SCRIPT_PATH = Path(__file__).resolve()
# The player's script is imported as a module; no bytecode cache is left beside it.
sys.dont_write_bytecode = True
sys.path.insert(0, str(SCRIPT_PATH.parent))
import generate_realistic_player as rp  # noqa: E402

REPO_ROOT = SCRIPT_PATH.parents[2]
OUTPUT_DIR = REPO_ROOT / "public" / "assets" / "cast"
PREVIEW_PATH = SCRIPT_PATH.parent / "realistic-friends-preview.png"


# -----------------------------------------------------------------------------
# Outside assets (all CC0; keep docs/third-party-assets.md in step with this list).
# The eyes, eyebrows, eyelashes, and shoes are the realistic player's.

SKIN_A = ("skins", "young_african_female/young_african_female.mhmat", "young_darkskinned_female_diffuse.png")
SKIN_B = ("skins", "young_caucasian_male/young_caucasian_male.mhmat", "young_lightskinned_male_diffuse.png")
HAIR_A = ("hair", "afro01/afro01.mhclo", "Hair")
HAIR_A_TEXTURE = "afro_diffuse.png"
HAIR_B = ("hair", "short03/short03.mhclo", "Hair")
SUIT_A = ("clothes", "male_casualsuit04/male_casualsuit04.mhclo", "Clothes")
SUIT_B = ("clothes", "male_casualsuit05/male_casualsuit05.mhclo", "Clothes")


# -----------------------------------------------------------------------------
# Colors: each friend's own. They are the hues the cartoon friends wear
# (generate_cast.py), so a friend is the same child in either style, at the
# depth of the realistic player's outfits, so the realistic cast is one set.

A_SKIN_HEX = "#7c4c34"
A_HAIR_HEX = "#1f181b"
A_MINT_HEX = "#55b79f"
A_MINT_DARK_HEX = "#449d88"
A_LAVENDER_HEX = "#b294d4"
A_PLUM_HEX = "#8c4c9f"
A_SUN_HEX = "#f0bf48"

B_SKIN_HEX = "#e0b592"
B_HAIR_HEX = "#1c2536"
B_RUST_HEX = "#c96a3e"
B_SKY_HEX = "#6cadd6"
B_NAVY_HEX = "#324e78"
B_LIME_HEX = "#b5c955"


# -----------------------------------------------------------------------------
# Bodies: the realistic player's young child, with each friend's own build and face.

# Both friends are the player's age, six or seven, and have its build and its
# friendly, relaxed expression. Friend A has a slightly softer smile.
A_MACROS = {
    **rp.CHILD_MACROS,
    "gender": 0.3,
    "race": {"asian": 0.05, "caucasian": 0.1, "african": 0.85},
}
A_MORPHS = {
    **rp.CHILD_TARGETS,
    "mouth-corner-puller": 0.4,
    "eye-left-closure": 0.08,
    "eye-right-closure": 0.08,
}

# Friend B is the older of the two by a year: a touch taller, with a squarer
# face and a wider grin.
B_MACROS = {
    **rp.CHILD_MACROS,
    "gender": 0.75,
    "age": 0.115,
    "height": 0.64,
    "race": {"asian": 0.2, "caucasian": 0.75, "african": 0.05},
}
B_MORPHS = {
    **rp.CHILD_TARGETS,
    "head-round": 0.25,
    "head-square": 0.2,
    "mouth-corner-puller": 0.5,
}


# -----------------------------------------------------------------------------
# Scene and mesh helpers


def reset_scene() -> None:
    """Empties the scene between friends, clips and preview stage included."""
    rp.reset_scene()
    for collection in (bpy.data.actions, bpy.data.cameras, bpy.data.lights, bpy.data.worlds):
        for block in list(collection):
            collection.remove(block)


def attach(obj: bpy.types.Object, rig: bpy.types.Object, name: str, bone: str = "head") -> bpy.types.Object:
    """Names a mesh, hangs it on the rig, and skins all of it to one bone."""
    obj.name = obj.data.name = name
    obj.parent = rig
    obj.vertex_groups.clear()
    obj.vertex_groups.new(name=bone).add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    rp.strip_modifiers(obj, keep=())
    obj.modifiers.new("Armature", "ARMATURE").object = rig
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def primitive(add: Callable[..., object], **settings) -> bpy.types.Object:
    """A new primitive mesh at the origin, in the scene's collection."""
    add(location=(0.0, 0.0, 0.0), **settings)
    return bpy.context.object


def uv_islands(mesh: bpy.types.Mesh) -> list[list[int]]:
    """The mesh's faces, grouped by the patch of texture each group is cut from."""
    source = bmesh.new()
    source.from_mesh(mesh)
    uv = source.loops.layers.uv.active
    seen: set[int] = set()
    islands: list[list[int]] = []
    for face in source.faces:
        if face.index in seen:
            continue
        seen.add(face.index)
        island, waiting = [], [face]
        while waiting:
            current = waiting.pop()
            island.append(current.index)
            for loop in current.loops:
                # The neighbor across this edge is in the same patch when both
                # faces place the edge at the same spot in the texture.
                for other in loop.link_loops:
                    if other.face.index in seen:
                        continue
                    if (other[uv].uv - loop.link_loop_next[uv].uv).length < 1e-5 and (other.link_loop_next[uv].uv - loop[uv].uv).length < 1e-5:
                        seen.add(other.face.index)
                        waiting.append(other.face)
        islands.append(island)
    source.free()
    return islands


def paint_islands(obj: bpy.types.Object, second: bpy.types.Material, chosen: Callable[[Vector], bool]) -> None:
    """Gives a second material to every texture patch whose middle satisfies chosen().

    A garment's pattern pieces are its texture patches, so the color changes along a seam.
    """
    obj.data.materials.append(second)
    polygons = obj.data.polygons
    for island in uv_islands(obj.data):
        middle = sum((polygons[index].center for index in island), Vector()) / len(island)
        if chosen(middle):
            for index in island:
                polygons[index].material_index = 1


def cut_between(source: bpy.types.Object, name: str, low: Vector, high: Vector) -> bpy.types.Object:
    """A copy of a mesh, cut cleanly to the box between two corners."""
    piece = rp.duplicate(source, name)
    rp.strip_modifiers(piece)
    for axis in range(3):
        point, normal = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
        point[axis], normal[axis] = low[axis], 1.0
        rp.bisect(piece, tuple(point), tuple(normal))
        point[axis], normal[axis] = high[axis], -1.0
        rp.bisect(piece, tuple(point), tuple(normal))
    return piece


def sewn_on(source: bpy.types.Object, name: str, low: Vector, high: Vector, thickness: float) -> bpy.types.Object:
    """Cloth lying over the part of a garment between two corners: a sash or a panel."""
    piece = cut_between(source, f"{name}_cut", low, high)
    layer = rp.fitted_layer(piece, name, lambda vertex, deform: True, thickness=lambda vertex: thickness, smoothing=2)
    bpy.data.objects.remove(piece)
    return layer


def clothes_texture(mpfb: dict, suit: tuple[str, str, str], name: str, woven: list[bpy.types.Object], size: int = 512) -> Path:
    """One grayscale detail map for a suit's garments, multiplied by each garment's color.

    Every garment takes the pack's ambient occlusion (its folds and seams),
    which leaves prints and patterns behind. The woven ones, trousers, also keep
    their denim weave.
    """
    subdir, fragment, _ = suit
    folder = rp.asset_path(mpfb, subdir, fragment).parent
    stem = Path(fragment).stem
    detail = 0.35 + 0.65 * rp.load_pixels(folder / f"{stem}_ao.png", size)[..., 0]
    if woven:
        weave = rp.luminance(rp.srgb_to_linear(rp.load_pixels(folder / f"{stem}_diffuse.png", size)[..., :3]))
        denim = np.zeros((size, size), dtype=bool)
        for garment in woven:
            for x0, y0, x1, y1 in rp.uv_pixel_boxes(garment.data, size):
                denim[y0:y1, x0:x1] = True
        detail[denim] *= np.clip(0.45 + 0.55 * weave[denim] / np.percentile(weave[denim], 80), 0.0, 1.0)
    pixels = np.ones((size, size, 4), dtype=np.float32)
    pixels[..., :3] = rp.linear_to_srgb(detail)[..., None]
    return rp.save_pixels(name, pixels, alpha=False)


def split_footwear(shoes: bpy.types.Object, prefix: str) -> tuple[bpy.types.Object, bpy.types.Object]:
    """The pack's sneakers as a pair of shoes and the pair of socks they come with."""
    footwear = sorted(rp.separate_loose(shoes), key=lambda obj: len(obj.data.vertices))
    if len(footwear) != 4:
        raise SystemExit(f"Expected two shoes and two socks, got {len(footwear)} parts")
    return rp.join(footwear[2:], f"{prefix}_shoes"), rp.join(footwear[:2], f"{prefix}_socks")


def add_face(mpfb: dict, body: bpy.types.Object, expressions: rp.Expressions) -> dict[str, bpy.types.Object]:
    """The realistic player's eyes, eyebrows, and eyelashes, fitted to this body; the last two follow its expressions."""
    face = {name: rp.add_part(mpfb, body, part) for name, part in (("eyes", rp.EYES), ("brows", rp.BROWS), ("lashes", rp.LASHES))}
    rp.follow_base_mesh(mpfb, expressions, face["brows"], rp.BROWS)
    rp.follow_base_mesh(mpfb, expressions, face["lashes"], rp.LASHES)
    return face


def eye_texture(mpfb: dict, source: tuple[str, str, str], name: str, iris: tuple[float, float, float], size: int = 256) -> Path:
    """The pack's eye with its iris shaded: each channel of the colored part is scaled, the white is not."""
    subdir, fragment, filename = source
    pixels = rp.load_pixels(rp.asset_path(mpfb, subdir, fragment).parent / filename, size)
    color = pixels[..., :3]
    colored = np.clip((color.max(axis=2) - color.min(axis=2)) * 5.0, 0.0, 1.0)[..., None]
    # The pack's eye whites are grey; lifted a little so the eyes read from the game camera.
    pixels[..., :3] = np.clip(color * 1.15 * (1.0 - colored + colored * np.array(iris, dtype=np.float32)), 0.0, 1.0)
    pixels[..., 3] = 1.0
    return rp.save_pixels(name, pixels, alpha=False)


def paint_face(mpfb: dict, face: dict[str, bpy.types.Object], prefix: str, *, iris: tuple[float, float, float], brow_hex: str) -> None:
    """Paints the face parts. iris shades the pack's brown iris, a red-brown, toward the friend's own."""
    rp.assign(face["eyes"], rp.make_material(f"{prefix} eyes", "#ffffff", texture=eye_texture(mpfb, rp.EYE_TEXTURE, f"{prefix}-eyes", iris), roughness=0.3))
    rp.assign(face["brows"], rp.make_material(f"{prefix} brows", "#ffffff", texture=rp.tinted_alpha_texture(mpfb, rp.BROWS, f"{prefix}-brows", brow_hex), roughness=0.9, alpha="BLEND"))
    rp.assign(face["lashes"], rp.make_material(f"{prefix} lashes", "#ffffff", texture=rp.tinted_alpha_texture(mpfb, rp.LASHES, f"{prefix}-lashes", "#1b1412"), roughness=0.9, alpha="BLEND"))


# -----------------------------------------------------------------------------
# Friend A: twin puffs tied in yellow, a mint dress with lavender sleeves, plum shoes


def hairline(head: rp.Head, body: bpy.types.Object, rise: float, nape: float) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    """The plane hair grows above: from a hairline up the forehead straight back down to the nape.

    rise is how far up from the brows to the crown the hairline sits; nape is
    how far below the middle of the ears the hair ends at the back, in meters.
    """
    height = head.brow + rise * (head.crown - head.brow)
    front = min(vertex.co.y for vertex in body.data.vertices if abs(vertex.co.x) < 0.012 and abs(vertex.co.z - height) < 0.006)
    slope = (head.ear.z - nape - height) / (head.back - front)
    return (0.0, front, height), (0.0, -slope, 1.0)


# How far above the hairline plane the combed texture's rows run, in meters.
COMB_REACH = 0.08


def scalp_hair(body: bpy.types.Object, head: rp.Head, name: str, plane, thickness: float) -> bpy.types.Object:
    """Hair drawn tight over the scalp: a thin layer above the hairline, clear of the ears.

    Its texture coordinates run around the head and up from the hairline, for
    combed_texture() to draw the strands and the hairline along.
    """
    point, normal = Vector(plane[0]), Vector(plane[1]).normalized()
    ears = body.vertex_groups["ears"].index

    def on_scalp(vertex, deform) -> bool:
        return (
            vertex.co.z > head.shoulders
            and (vertex.co - point).dot(normal) > -0.02
            and rp.group_weight(vertex, deform, ears) == 0
        )

    scalp = rp.fitted_layer(body, name, on_scalp, cut=plane, thickness=lambda vertex: thickness, smoothing=3)
    middle = (head.forehead + head.back) / 2.0
    mesh = scalp.data
    coordinates = mesh.uv_layers.active.data
    for polygon in mesh.polygons:
        around = []
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            around.append(math.atan2(co.x, middle - co.y) / (2.0 * math.pi) + 0.5)
            coordinates[loop].uv.y = min(max((co - point).dot(normal) / COMB_REACH, 0.0), 1.0)
        # A face across the seam at the back of the head runs on past 1 rather than back through the texture.
        seam = max(around) - min(around) > 0.5
        for loop, turn in zip(polygon.loop_indices, around):
            coordinates[loop].uv.x = turn + 1.0 if seam and turn < 0.5 else turn
    return scalp


def combed_texture(name: str, tint_hex: str, size: int = 512) -> Path:
    """Hair combed back from the hairline: fine strands that each begin at their own height.

    Columns run around the head and rows up from the hairline, as scalp_hair()
    lays them out. The strands' uneven starts make a soft hairline instead of
    a cap's edge. Drawn here; no outside asset is used.
    """
    random = np.random.default_rng(11)
    strands = random.random(size).astype(np.float32)
    strands = (np.roll(strands, 1) + strands + np.roll(strands, -1)) / 3.0
    starts = 0.03 + 0.12 * random.random(size).astype(np.float32)
    starts = (np.roll(starts, 1) + starts) / 2.0
    rows = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]
    tint = np.array(rp.hex_rgba(tint_hex)[:3], dtype=np.float32)
    pixels = np.empty((size, size, 4), dtype=np.float32)
    pixels[..., :3] = rp.linear_to_srgb(np.clip((0.7 + 0.6 * strands)[None, :, None] * tint, 0.0, 1.0))
    pixels[..., 3] = np.clip((rows - starts[None, :]) / 0.04, 0.0, 1.0)
    return rp.save_pixels(name, pixels, alpha=True)


def hair_puffs(afro: bpy.types.Object, scalp: bpy.types.Object, head: rp.Head, rig: bpy.types.Object, prefix: str) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Two round puffs high on the sides of the head, and the ties that hold them.

    Each puff is the pack's afro, made small and turned so that its open
    underside sits against the scalp.
    """
    size = 0.42
    corners = [Vector(corner) for corner in afro.bound_box]
    middle = sum(corners, Vector()) / 8.0
    radius = size * (max(corner.x for corner in corners) - min(corner.x for corner in corners)) / 2.0
    # The afro is open where the neck and face go: below and in front.
    opening = Vector((0.0, -0.45, -0.89)).normalized()
    skull = Vector((0.0, (head.forehead + head.back) / 2.0, head.eye + 0.02))
    surface = BVHTree.FromObject(scalp, bpy.context.evaluated_depsgraph_get())

    puffs, ties = [], []
    for side, sign in (("l", 1.0), ("r", -1.0)):
        outward = Vector((sign * 0.6, 0.14, 0.79)).normalized()
        root, _, _, _ = surface.ray_cast(skull + outward * 0.4, -outward)
        if root is None:
            raise SystemExit("A hair puff has no scalp to sit on")
        turned = opening.rotation_difference(-outward).to_matrix()
        puff = rp.duplicate(afro, f"{prefix}_puff_{side}")
        for vertex in puff.data.vertices:
            vertex.co = root + outward * radius * 0.72 + turned @ ((vertex.co - middle) * size)
        puffs.append(puff)

        ring = primitive(bpy.ops.mesh.primitive_torus_add, major_radius=radius * 0.66, minor_radius=0.0048, major_segments=20, minor_segments=6)
        ring.data.transform(Matrix.Translation(root + outward * 0.005) @ outward.to_track_quat("Z", "Y").to_matrix().to_4x4())
        ties.append(ring)

    return (
        attach(rp.join(puffs, f"{prefix}_hair_puffs"), rig, f"{prefix}_hair_puffs"),
        attach(rp.join(ties, f"{prefix}_hair_ties"), rig, f"{prefix}_hair_ties"),
    )


def build_friend_a(mpfb: dict) -> dict[str, bpy.types.Object]:
    prefix = "friend_a"
    body = rp.build_body(mpfb, A_MACROS, A_MORPHS)
    rig = mpfb["HumanService"].add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = rig.data.name = f"{prefix}_rig"
    expressions = rp.capture_expressions(mpfb, body, rig, A_MORPHS, rp.FACE_UNITS)
    face = add_face(mpfb, body, expressions)
    afro = rp.add_part(mpfb, body, HAIR_A)
    suit = rp.add_part(mpfb, body, SUIT_A)
    footwear = rp.add_part(mpfb, body, rp.SHOES)

    # The dress is the suit's T-shirt down to a sash at the waist and, from
    # there, a skirt cut from the base mesh's own helper, over its tights.
    bones = rig.data.bones
    hip, knee = bones["thigh_l"].head_local.z, bones["calf_l"].head_local.z
    waist = (bones["spine_01"].head_local.z + bones["spine_02"].head_local.z) / 2.0
    hem = knee - 0.012
    skirt = rp.helper_garment(body, f"{prefix}_skirt", "helper-skirt", hem, waist + 0.004)
    rp.flare(skirt, waist, hem, 0.22)
    leggings = rp.helper_garment(body, f"{prefix}_leggings", "helper-tights", 0.0, hip + 0.05)
    rp.visible_skin(body)

    trousers, tee = sorted(rp.separate_loose(suit), key=lambda obj: rp.world_z_range(obj)[1])
    bpy.data.objects.remove(trousers)  # She wears the skirt instead.
    wide = Vector((1.0, 1.0, 0.0))
    sash = sewn_on(tee, f"{prefix}_sash", -wide + Vector((0.0, 0.0, waist - 0.02)), wide + Vector((0.0, 0.0, waist + 0.014)), 0.006)
    rp.bisect(tee, (0.0, 0.0, waist - 0.018), (0.0, 0.0, 1.0))
    front = min(vertex.co.y for vertex in skirt.data.vertices)
    panel = sewn_on(
        skirt, f"{prefix}_panel",
        Vector((-0.043, front - 0.01, waist - 0.165)), Vector((0.043, front + 0.05, waist - 0.07)), 0.004,
    )

    shoes, socks = split_footwear(footwear, prefix)
    rp.bisect(leggings, (0.0, 0.0, rp.world_z_range(socks)[1] - 0.008), (0.0, 0.0, 1.0))
    head = rp.measure_head(rig, body, face["eyes"], face["brows"], tee)
    print(f"Friend A: {(rp.world_z_range(body)[1] - rp.world_z_range(shoes)[0]) / (head.crown - head.chin):.2f} heads tall")

    scalp = scalp_hair(body, head, f"{prefix}_hair_scalp", hairline(head, body, 0.5, 0.03), 0.003)
    puffs, ties = hair_puffs(afro, scalp, head, rig, prefix)
    bpy.data.objects.remove(afro)

    body = rp.lighten_body(body, head, knee)
    rp.tuck_mouth_lining(body)
    for obj in (shoes, leggings):
        rp.simplify(obj, 0.5)
    rp.simplify(puffs, 0.45)

    parts = {
        f"{prefix}_body": body,
        **{f"{prefix}_{name}": obj for name, obj in face.items()},
        f"{prefix}_hair_scalp": scalp,
        f"{prefix}_hair_puffs": puffs,
        f"{prefix}_hair_ties": ties,
        f"{prefix}_dress": tee,
        f"{prefix}_skirt": skirt,
        f"{prefix}_sash": sash,
        f"{prefix}_panel": panel,
        f"{prefix}_leggings": leggings,
        f"{prefix}_socks": socks,
        f"{prefix}_shoes": shoes,
    }
    for name, obj in parts.items():
        obj.name = obj.data.name = name
        rp.strip_modifiers(obj)

    rp.assign(body, rp.make_material(f"{prefix} skin", A_SKIN_HEX, texture=rp.skin_texture(mpfb, body, None, source=SKIN_A, name=f"{prefix}-skin"), roughness=0.62))
    paint_face(mpfb, face, prefix, iris=(0.42, 0.4, 0.38), brow_hex="#1d1513")  # A deep brown.
    rp.assign(scalp, rp.make_material(f"{prefix} hair scalp", "#ffffff", texture=combed_texture(f"{prefix}-hair-scalp", A_HAIR_HEX), roughness=0.85, alpha="CLIP"))
    rp.assign(puffs, rp.make_material(
        f"{prefix} hair", "#ffffff", roughness=0.9, alpha="CLIP", double_sided=True,
        texture=rp.hair_texture(mpfb, HAIR_A, f"{prefix}-hair", 256, tint_hex=A_HAIR_HEX, filename=HAIR_A_TEXTURE),
    ))
    detail = clothes_texture(mpfb, SUIT_A, f"{prefix}-clothes", [])
    rp.assign(tee, rp.make_material(f"{prefix} mint", A_MINT_HEX, texture=detail, roughness=0.85))
    # The sleeves are their own pattern pieces, out past the shoulders.
    paint_islands(tee, rp.make_material(f"{prefix} lavender", A_LAVENDER_HEX, texture=detail, roughness=0.85), lambda middle: abs(middle.x) > head.shoulder_reach)
    rp.assign(skirt, rp.make_material(f"{prefix} mint dark", A_MINT_DARK_HEX, roughness=0.85, double_sided=True))
    sun, plum = rp.make_material(f"{prefix} sun", A_SUN_HEX, roughness=0.8), rp.make_material(f"{prefix} plum", A_PLUM_HEX, roughness=0.8)
    rp.assign(ties, sun)
    rp.assign(sash, sun)
    rp.assign(panel, plum)
    rp.assign(leggings, rp.make_material(f"{prefix} leggings", A_LAVENDER_HEX, roughness=0.8))
    rp.assign(socks, rp.make_material(f"{prefix} socks", rp.SOCK_HEX, roughness=0.9))
    rp.assign(shoes, plum)
    sole_top = rp.world_z_range(shoes)[0] + 0.02
    rp.split_material(shoes, sun, lambda center: center.z < sole_top)
    return {"rig": rig, "expressions": expressions, **parts}


# -----------------------------------------------------------------------------
# Friend B: swept blue-black hair under a lime clip, a rust jacket open over a sky shirt, navy trousers


def sweep_fringe(hair: bpy.types.Object, head: rp.Head) -> None:
    """Turns the pack's side-swept cut to sweep toward +X and lifts its fringe clear of the eye."""
    for vertex in hair.data.vertices:
        vertex.co.x = -vertex.co.x
    hair.data.flip_normals()
    # The fringe hangs over one eye; what falls below the brows is drawn up to end just above them.
    fringe = [vertex for vertex in hair.data.vertices if vertex.co.y < head.ear_front - 0.02]
    ceiling, floor = head.brow + 0.04, head.brow + 0.008
    lowest = min(vertex.co.z for vertex in fringe)
    if lowest < floor:
        squeeze = (ceiling - floor) / (ceiling - lowest)
        for vertex in fringe:
            if vertex.co.z < ceiling:
                vertex.co.z = ceiling - (ceiling - vertex.co.z) * squeeze


def hair_clip(hair: bpy.types.Object, head: rp.Head, rig: bpy.types.Object, name: str) -> bpy.types.Object:
    """A small flat clip on the hair above the temple the fringe is swept away from."""
    skull = Vector((0.0, (head.forehead + head.back) / 2.0, head.eye + 0.02))
    surface = BVHTree.FromPolygons([vertex.co.copy() for vertex in hair.data.vertices], [tuple(polygon.vertices) for polygon in hair.data.polygons])
    # Looking in at the head from its front on the -X side, rising from the
    # brow: the clip sits a little above the first hair found. (Where the hair
    # is parted a ray finds none and carries on to the far side of the head.)
    seat = None
    for step in range(40):
        toward = Vector((-0.4, -0.8, 0.2 + 0.02 * step)).normalized()
        spot, normal, _, _ = surface.ray_cast(skull + toward * 0.4, -toward)
        if spot is not None and (spot - skull).dot(toward) > 0.0:
            seat = step if seat is None else seat
            if step >= seat + 3:
                break
    else:
        raise SystemExit("The hair clip has no hair to sit on")
    if normal.dot(toward) < 0.0:
        normal = -normal
    along = normal.cross(Vector((0.0, 0.0, 1.0))).normalized()
    across = along.cross(normal)
    clip = primitive(bpy.ops.mesh.primitive_cube_add, size=1.0)
    clip.data.transform(Matrix.Diagonal((0.03, 0.005, 0.009, 1.0)))
    bevel = clip.modifiers.new("Rounded", "BEVEL")
    bevel.width, bevel.segments = 0.0018, 2
    rp.select_only(clip)
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    # Tilted a little, the way a clip pushed into hair sits.
    placed = Matrix((along, normal, across)).transposed().to_4x4() @ Matrix.Rotation(math.radians(-18.0), 4, "Y")
    clip.data.transform(Matrix.Translation(spot + normal * 0.006) @ placed)
    return attach(clip, rig, name)


def take_in(jacket: bpy.types.Object, rig: bpy.types.Object, amount: float) -> None:
    """Narrows a jacket's body around the waist by amount of its width.

    The pack's jacket is cut for an adult: on a child it stands as wide as the
    elbows, where the arms hang. It eases in from the armpits to the waist,
    and most of the way out again by the hips, where it has to stay wide of the
    trousers under it. The sleeves keep their shape.
    """
    bones = rig.data.bones
    armpit, waist = bones["spine_03"].tail_local.z, bones["spine_02"].tail_local.z
    belly, hips = bones["spine_02"].head_local.z, bones["spine_01"].head_local.z
    sleeve = rp.weight_share(jacket, rig, rp.ARM_GROUPS)
    for vertex, share in zip(jacket.data.vertices, sleeve):
        height = vertex.co.z
        if height > waist:
            fitted = min(max((armpit - height) / (armpit - waist), 0.0), 1.0)
        else:
            fitted = 1.0 - 0.65 * min(max((belly - height) / (belly - hips), 0.0), 1.0)
        vertex.co.x *= 1.0 - amount * fitted * (1.0 - share)


def crop(jacket: bpy.types.Object, rig: bpy.types.Object, hem: float) -> None:
    """Shortens a jacket's body to a hem at a height, leaving its sleeves whole.

    The pack's jacket reaches an adult's hips, which on a child is where the
    hands hang.
    """
    arms = {group.index for group in jacket.vertex_groups if group.name in rig.data.bones and group.name.startswith(rp.ARM_GROUPS)}
    mesh = bmesh.new()
    mesh.from_mesh(jacket.data)
    deform = mesh.verts.layers.deform.verify()

    def on_body(face) -> bool:
        return all(sum(weight for group, weight in vertex[deform].items() if group in arms) < 0.5 for vertex in face.verts)

    body = [face for face in mesh.faces if on_body(face)]
    geometry = set(body)
    for face in body:
        geometry.update(face.edges)
        geometry.update(face.verts)
    bmesh.ops.bisect_plane(mesh, geom=list(geometry), plane_co=Vector((0.0, 0.0, hem)), plane_no=Vector((0.0, 0.0, 1.0)))
    below = [face for face in mesh.faces if face.calc_center_median().z < hem and on_body(face)]
    bmesh.ops.delete(mesh, geom=below, context="FACES")
    mesh.to_mesh(jacket.data)
    mesh.free()
    jacket.data.update()


def fit_sleeves(jacket: bpy.types.Object, body: bpy.types.Object, rig: bpy.types.Object, slim: float) -> None:
    """Fits a jacket's sleeves to a child's arms: slimmer by slim of their width, and ending at the wrists.

    The pack's sleeves are an adult's, wide and long enough to swallow a
    child's hands. Each is drawn in toward the arm it covers and cut off just
    past where the hand's skin begins, so the whole hand shows.
    """
    bones = rig.data.bones
    hands = rp.weight_share(body, rig, ("hand", "index", "middle", "ring", "pinky", "thumb"))
    for side, sign in (("l", 1.0), ("r", -1.0)):
        # Measured for each sleeve in turn: cutting the first renumbers the jacket's vertices.
        sleeve = rp.weight_share(jacket, rig, rp.ARM_GROUPS)
        joints = [bones[f"upperarm_{side}"].head_local, bones[f"lowerarm_{side}"].head_local, bones[f"hand_{side}"].head_local]
        for vertex, share in zip(jacket.data.vertices, sleeve):
            if share <= 0.0 or vertex.co.x * sign <= 0.0:
                continue
            # The nearest point of the arm's axis, from the shoulder to the wrist.
            nearest = None
            for start, end in zip(joints, joints[1:]):
                along = (end - start).normalized()
                reach = min(max((vertex.co - start).dot(along), 0.0), (end - start).length)
                point = start + along * reach
                if nearest is None or (vertex.co - point).length < (vertex.co - nearest).length:
                    nearest = point
            vertex.co = nearest + (vertex.co - nearest) * (1.0 - slim * share)

        elbow, wrist = joints[1], joints[2]
        forearm = (wrist - elbow).normalized()
        skin = min(
            (vertex.co - elbow).dot(forearm)
            for vertex, share in zip(body.data.vertices, hands) if share > 0.5 and vertex.co.x * sign > 0.0
        )
        cuff = elbow + forearm * (skin + 0.008)
        if any((vertex.co - cuff).dot(forearm) > 0.0 for vertex, share in zip(jacket.data.vertices, sleeve) if share < 0.2):
            raise SystemExit("Cutting the jacket's sleeve at the wrist would cut into its body")
        rp.bisect(jacket, tuple(cuff), tuple(-forearm))


def build_friend_b(mpfb: dict) -> dict[str, bpy.types.Object]:
    prefix = "friend_b"
    body = rp.build_body(mpfb, B_MACROS, B_MORPHS)
    rig = mpfb["HumanService"].add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = rig.data.name = f"{prefix}_rig"
    expressions = rp.capture_expressions(mpfb, body, rig, B_MORPHS, rp.FACE_UNITS)
    face = add_face(mpfb, body, expressions)
    hair = rp.add_part(mpfb, body, HAIR_B)
    suit = rp.add_part(mpfb, body, SUIT_B)
    footwear = rp.add_part(mpfb, body, rp.SHOES)
    knee = rig.data.bones["calf_l"].head_local.z
    rp.visible_skin(body)

    # The suit is four pieces: trousers, a jacket, the shirt that shows inside it, and the shirt's collar.
    pieces = rp.separate_loose(suit)
    if len(pieces) != 4:
        raise SystemExit(f"Expected the suit to split into trousers, jacket, shirt, and collar, got {len(pieces)} parts")
    trousers = min(pieces, key=lambda obj: rp.world_z_range(obj)[0])
    jacket = max(pieces, key=lambda obj: max(vertex.co.x for vertex in obj.data.vertices))
    shirt, collar = sorted((obj for obj in pieces if obj not in (trousers, jacket)), key=lambda obj: rp.world_z_range(obj)[0])
    # Cut for a child: hip length, so the hem is above the hands and still over
    # the top of the trousers; closer at the waist; sleeves that end at the wrists.
    hem = rp.world_z_range(trousers)[1] - 0.035
    crop(jacket, rig, hem)
    rp.bisect(shirt, (0.0, 0.0, hem + 0.004), (0.0, 0.0, 1.0))
    take_in(jacket, rig, 0.22)
    fit_sleeves(jacket, body, rig, 0.3)

    shoes, socks = split_footwear(footwear, prefix)
    head = rp.measure_head(rig, body, face["eyes"], face["brows"], jacket)
    print(f"Friend B: {(rp.world_z_range(body)[1] - rp.world_z_range(shoes)[0]) / (head.crown - head.chin):.2f} heads tall")
    sweep_fringe(hair, head)
    attach(hair, rig, f"{prefix}_hair")
    clip = hair_clip(hair, head, rig, f"{prefix}_hair_clip")

    body = rp.lighten_body(body, head, knee)
    rp.tuck_mouth_lining(body)
    rp.simplify(shoes, 0.5)

    parts = {
        f"{prefix}_body": body,
        **{f"{prefix}_{name}": obj for name, obj in face.items()},
        f"{prefix}_hair": hair,
        f"{prefix}_hair_clip": clip,
        f"{prefix}_jacket": jacket,
        f"{prefix}_shirt": shirt,
        f"{prefix}_collar": collar,
        f"{prefix}_trousers": trousers,
        f"{prefix}_socks": socks,
        f"{prefix}_shoes": shoes,
    }
    for name, obj in parts.items():
        obj.name = obj.data.name = name
        rp.strip_modifiers(obj)

    rp.assign(body, rp.make_material(f"{prefix} skin", B_SKIN_HEX, texture=rp.skin_texture(mpfb, body, None, source=SKIN_B, name=f"{prefix}-skin"), roughness=0.62))
    paint_face(mpfb, face, prefix, iris=(0.62, 0.66, 0.62), brow_hex="#1b2130")  # A soft hazel brown.
    rp.assign(hair, rp.make_material(
        f"{prefix} hair", "#ffffff", roughness=0.8, alpha="CLIP", double_sided=True,
        texture=rp.hair_texture(mpfb, HAIR_B, f"{prefix}-hair", tint_hex=B_HAIR_HEX),
    ))
    lime = rp.make_material(f"{prefix} lime", B_LIME_HEX, roughness=0.6)
    rp.assign(clip, lime)
    detail = clothes_texture(mpfb, SUIT_B, f"{prefix}-clothes", [trousers])
    rp.assign(jacket, rp.make_material(f"{prefix} rust", B_RUST_HEX, texture=detail, roughness=0.85, double_sided=True))
    rp.assign(shirt, rp.make_material(f"{prefix} sky", B_SKY_HEX, texture=detail, roughness=0.85))
    rp.assign(collar, rp.make_material(f"{prefix} lime collar", B_LIME_HEX, texture=detail, roughness=0.85, double_sided=True))
    rp.assign(trousers, rp.make_material(f"{prefix} navy", B_NAVY_HEX, texture=detail, roughness=0.85))
    rp.assign(socks, rp.make_material(f"{prefix} socks", rp.SOCK_HEX, roughness=0.9))
    rp.assign(shoes, rp.make_material(f"{prefix} navy shoes", B_NAVY_HEX, roughness=0.7))
    sole_top = rp.world_z_range(shoes)[0] + 0.02
    rp.split_material(shoes, lime, lambda center: center.z < sole_top)
    return {"rig": rig, "expressions": expressions, **parts}


# -----------------------------------------------------------------------------
# Stance and idle
#
# Sides are the rig's own: _l is the child's left, at +X, since the child faces
# -Y. Angles and directions follow generate_realistic_player.py's conventions.


@dataclass(frozen=True)
class Stance:
    """What is a friend's own about how they stand. The arms hang as the realistic player's do."""

    # How far forward of its rest each ankle stands, per side, in meters.
    step: dict[str, float]
    # Degrees the head is held tilted toward the left shoulder.
    tilt: float


def plant_legs(rig: bpy.types.Object, legs: dict[str, rp.Leg], *, sway: float, drop: float, step: dict[str, float] | None = None) -> None:
    """Poses the pelvis and legs so the body moves over feet that stay where they are.

    The pelvis shifts sway meters toward +X and sinks drop meters; each leg is
    solved from its planted ankle, as the walk's are. step moves an ankle
    forward of its rest, in meters.
    """
    rp.stand_over_feet(
        rig, legs, hips=(sway, 0.0, -drop),
        feet={side: rp.Foot(ahead=ahead) for side, ahead in (step or {}).items()},
    )


def stand(rig: bpy.types.Object, meshes: list[bpy.types.Object], stance: Stance) -> None:
    """Gives the friend the realistic player's relaxed stand, then their own feet and tilt of the head."""
    rp.relax_rest_pose(rig, meshes)
    plant_legs(rig, {side: rp.measure_leg(rig, side) for side in ("l", "r")}, sway=0.0, drop=0.0, step=stance.step)
    rp.turn(rig.pose.bones["head"], ("Y", stance.tilt))
    rp.apply_pose_as_rest(rig, meshes)


@dataclass(frozen=True)
class Idle:
    """A friend's idle: breathing and a slow weight shift over planted feet, scaled to their energy."""

    frames: int  # Length of the loop at 30 fps.
    breaths: int  # Breaths per loop.
    sway: float  # Meters the hips drift to each side.
    dip: float  # Meters the hips sink with each breath out.
    chest: float  # Degrees the chest lifts with each breath.
    look: float  # Degrees the head turns to each side.
    arms: float  # Degrees the arms swing.


def animate_idle(rig: bpy.types.Object, idle: Idle) -> None:
    action = rp.new_clip(rig, "idle")
    bones = rig.pose.bones
    legs = {side: rp.measure_leg(rig, side) for side in ("l", "r")}
    for frame in range(0, idle.frames + 1, 3):
        cycle = 2.0 * math.pi * frame / idle.frames
        breath = math.sin(idle.breaths * cycle)
        drift = math.sin(cycle)
        glance = math.sin(cycle + 0.6)
        plant_legs(rig, legs, sway=idle.sway * drift, drop=idle.dip * (1.0 - math.cos(idle.breaths * cycle)) / 2.0)
        for side in ("l", "r"):
            rp.turn(bones[f"upperarm_{side}"], ("X", idle.arms * (0.6 * breath + 0.4 * drift)))
            rp.turn(bones[f"lowerarm_{side}"], ("X", -idle.arms * (0.8 + 0.6 * breath)))
        rp.turn(bones["spine_01"], ("X", -0.5 * idle.chest * breath))
        rp.turn(bones["spine_02"], ("X", -idle.chest * breath), ("Z", -0.6 * drift))
        rp.turn(bones["spine_03"], ("X", -idle.chest * breath), ("Z", -0.6 * drift))
        rp.turn(bones["neck_01"], ("X", 0.6 * breath), ("Z", 0.4 * idle.look * glance))
        rp.turn(bones["head"], ("X", 0.8 * breath), ("Z", 0.6 * idle.look * glance), ("Y", 1.2 * drift))
        rp.key(rig, frame + 1, rp.limb_names(rp.LEG_BONES) + rp.limb_names(rp.ARM_BONES) + rp.TRUNK_BONES, location=("pelvis",))
    rp.finish_clip(rig, action)


# The furthest, in meters, a planted foot may move during the idle.
MAX_FOOT_DRIFT = 0.003


def check_feet(rig: bpy.types.Object, idle: Idle) -> float:
    """Plays the idle and returns how far the ankle or the ball of a foot strays, in meters."""
    scene = bpy.context.scene
    rig.animation_data.action = bpy.data.actions["idle"]
    spots: dict[str, list[Vector]] = {}
    for frame in range(0, idle.frames + 1, 3):
        scene.frame_set(frame + 1)
        for side in ("l", "r"):
            foot = rig.pose.bones[f"foot_{side}"]
            spots.setdefault(f"ankle_{side}", []).append(foot.head.copy())
            spots.setdefault(f"ball_{side}", []).append(foot.tail.copy())
    rig.animation_data.action = None
    rp.reset_pose(rig)
    scene.frame_set(1)
    return max((spot - places[0]).length for places in spots.values() for spot in places)


def check_clearance(rig: bpy.types.Object, parts: dict[str, bpy.types.Object], friend: "Friend") -> dict[str, tuple[float, str]]:
    """The smallest arm-to-body gap, and where it is, while standing and through the idle."""
    scene = bpy.context.scene
    clearance = rp.Clearance(rig, parts, body=f"{friend.prefix}_body", top=f"{friend.prefix}_{friend.top}")
    below = tuple(f"{friend.prefix}_{name}" for name in friend.below)
    bpy.context.view_layer.update()
    gaps = {"standing": clearance.measure(below)}
    rig.animation_data.action = bpy.data.actions["idle"]
    for frame in range(1, friend.idle.frames + 2, 6):
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        gaps["idle"] = min(gaps.get("idle", (math.inf, "")), clearance.measure(below))
    rig.animation_data.action = None
    rp.reset_pose(rig)
    scene.frame_set(1)
    return gaps


# -----------------------------------------------------------------------------
# The cast


@dataclass(frozen=True)
class Friend:
    key: str  # The exported file's name.
    prefix: str  # What every node in the file is named after.
    label: str
    build: Callable[[dict], dict[str, bpy.types.Object]]
    # How tall the friend stands in the playroom, in meters, to the crown of the
    # head; hair adds to it. Like the player, each is built at a real child's
    # height and enlarged as a whole.
    height: float
    stance: Stance
    idle: Idle
    # The part that carries the sleeves, and the parts below it the arms could touch.
    top: str
    below: tuple[str, ...]
    # The parts lying on the face, which move with the skin under them when it changes expression.
    draped: tuple[str, ...]
    # The exported file must stay a sensible download for a browser game.
    max_triangles: int
    max_bytes: int


FRIEND_A = Friend(
    key="friend-a-realistic",
    prefix="friend_a",
    label="Friend A",
    build=build_friend_a,
    height=1.36,
    # She stands square, her head a little to one side.
    stance=Stance(step={}, tilt=2.5),
    # Quiet: slow breaths and barely a glance around.
    idle=Idle(frames=120, breaths=2, sway=0.004, dip=0.002, chest=0.8, look=2.5, arms=1.2),
    top="dress",
    below=("skirt", "sash", "panel", "leggings"),
    # Her hair is drawn tight over the forehead her eyebrows lift.
    draped=("hair_scalp",),
    max_triangles=26_000,
    max_bytes=1_500_000,
)

FRIEND_B = Friend(
    key="friend-b-realistic",
    prefix="friend_b",
    label="Friend B",
    build=build_friend_b,
    height=1.38,
    # His right foot is ahead of the left, as on the cartoon Friend B.
    stance=Stance(step={"r": 0.03, "l": -0.008}, tilt=-2.0),
    # He cannot keep still: quicker, deeper breaths, shifting his weight, looking about.
    idle=Idle(frames=90, breaths=2, sway=0.008, dip=0.004, chest=1.1, look=7.0, arms=2.2),
    top="jacket",
    below=("trousers", "shirt", "collar"),
    draped=(),
    max_triangles=24_000,
    max_bytes=1_500_000,
)

FRIENDS = (FRIEND_A, FRIEND_B)


# -----------------------------------------------------------------------------
# Preview and validation


def render_frames(friend: Friend, height: float, directory: Path | None) -> list[Path]:
    """Renders the friend's rest pose from the front and from behind, for the preview strip."""
    rp.setup_preview_scene(height)
    render = bpy.context.scene.render
    render.resolution_percentage = 70  # Four frames side by side make the strip.
    frames = []
    for name, angle in (("front", 14.0), ("back", 166.0)):
        frames.append(rp.TEXTURE_DIR / f"preview-{friend.key}-{name}.png")
        rp.shot(frames[-1], angle, height * 0.5, height * 2.6, 60.0)
    render.resolution_percentage = 100
    if directory:
        for name, angle, target, distance, lens, rise in rp.VIEWS:
            rp.shot(directory / f"{friend.key}-{name}.png", angle, height * target, height * distance, lens, rise)
    return frames


def save_preview(frames: list[Path]) -> None:
    strips = []
    for frame in frames:
        image = bpy.data.images.load(str(frame))
        width, tall = image.size
        strips.append(np.array(image.pixels[:], dtype=np.float32).reshape(tall, width, 4))
        bpy.data.images.remove(image)
    sheet = np.concatenate(strips, axis=1)
    preview = bpy.data.images.new("Realistic Friends Preview", sheet.shape[1], sheet.shape[0])
    preview.pixels = sheet.ravel()
    preview.filepath_raw = str(PREVIEW_PATH)
    preview.file_format = "PNG"
    preview.save()
    bpy.data.images.remove(preview)


def validate_export(friend: Friend, nodes: list[str]) -> None:
    """Re-imports the GLB into an empty scene and checks it against the asset contract."""
    path = OUTPUT_DIR / f"{friend.key}.glb"
    size = path.stat().st_size
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    # The importer adds a stand-in mesh for bone shapes; only the model's own parts count.
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith(friend.prefix)]
    missing = sorted(set(nodes) - {obj.name for obj in meshes})
    if missing:
        raise RuntimeError(f"{path.name}: missing parts {missing}")
    clips = {action.name.split("_")[0] for action in bpy.data.actions}
    if clips != {"idle", *rp.EMOTIONS}:
        raise RuntimeError(f"{path.name}: expected an idle clip and one per emotion, found {sorted(clips)}")
    for part in ("body", "brows", "lashes"):
        keys = next(obj for obj in meshes if obj.name == f"{friend.prefix}_{part}").data.shape_keys
        faces = [key.name for key in keys.key_blocks[1:]] if keys else []
        if faces != list(rp.EMOTIONS):
            raise RuntimeError(f"{path.name}: {part} should carry one face per emotion, found {faces}")

    bpy.context.view_layer.update()
    # Vertices rather than bounding boxes: a skinned mesh's box is not filled in on import.
    points = [obj.matrix_world @ vertex.co for obj in meshes for vertex in obj.data.vertices]
    low = min(point.z for point in points)  # glTF Y-up returns to Blender Z-up on import.
    tall = max(point.z for point in points) - low
    body = next(obj for obj in meshes if obj.name == f"{friend.prefix}_body")
    crown = max((body.matrix_world @ vertex.co).z for vertex in body.data.vertices) - low
    center_x = (min(point.x for point in points) + max(point.x for point in points)) / 2
    triangles = sum(len(polygon.vertices) - 2 for obj in meshes for polygon in obj.data.polygons)
    if abs(low) > 0.006:
        raise RuntimeError(f"{path.name}: ground is z={low:.5f} m after import, expected 0")
    # Hair may stand a little above the crown.
    if abs(crown - friend.height) > 0.01 or tall > friend.height + 0.08:
        raise RuntimeError(f"{path.name}: unexpected height {crown:.4f} m to the crown, {tall:.4f} m in all")
    if abs(center_x) > 0.03:
        raise RuntimeError(f"{path.name}: not centered between the feet (x={center_x:.4f})")
    if triangles > friend.max_triangles or size > friend.max_bytes:
        raise RuntimeError(f"{path.name}: {triangles} triangles and {size} bytes exceed the budget")
    print(f"PASS {path.name} {size} bytes | crown={crown:.3f} m, {tall:.3f} m with hair | triangles={triangles} | meshes={len(meshes)} | clips={sorted(clips)}")


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    views = Path(arguments[arguments.index("--views") + 1]).resolve() if "--views" in arguments else None
    if views:
        views.mkdir(parents=True, exist_ok=True)
    only = arguments[arguments.index("--only") + 1] if "--only" in arguments else None
    emotions = Path(arguments[arguments.index("--emotions") + 1]).resolve() if "--emotions" in arguments else None
    if emotions:
        emotions.mkdir(parents=True, exist_ok=True)
    friends = [friend for friend in FRIENDS if only is None or friend.key.startswith(only)]
    if not friends:
        raise SystemExit(f"No friend is called {only}")

    mpfb = rp.require_mpfb()
    frames: list[Path] = []
    nodes: dict[str, list[str]] = {}
    for friend in friends:
        reset_scene()
        parts = friend.build(mpfb)
        rig = parts.pop("rig")
        expressions = parts.pop("expressions")
        meshes = list(parts.values())
        nodes[friend.key] = list(parts)

        def part(name: str) -> bpy.types.Object:
            return parts[f"{friend.prefix}_{name}"]

        stand(rig, meshes, friend.stance)
        rp.ground(rig, meshes)
        # Rendered before the clips exist, so the preview shows the rest pose.
        frames += render_frames(friend, max(rp.world_z_range(obj)[1] for obj in meshes), views)
        rp.add_expressions(expressions, rig, part("body"), rp.FACES, draped=tuple(part(name) for name in friend.draped))
        animate_idle(rig, friend.idle)
        rp.animate_emotions(rig)
        drift = check_feet(rig, friend.idle)
        print(f"{'PASS' if drift <= MAX_FOOT_DRIFT else 'FAIL'} {friend.label} idle: the planted feet stay within {drift * 1000:.1f} mm")
        if drift > MAX_FOOT_DRIFT:
            raise RuntimeError(f"{friend.label}'s feet slide {drift * 1000:.1f} mm during the idle")
        gaps = check_clearance(rig, parts, friend)
        for label, (gap, where) in gaps.items():
            print(f"{'PASS' if gap >= rp.MIN_CLEARANCE else 'FAIL'} {friend.label} arms {label}: {gap * 1000:.0f} mm at the closest, between {where}")
        if min(gap for gap, _ in gaps.values()) < rp.MIN_CLEARANCE:
            raise RuntimeError(f"One of {friend.label}'s arms comes within {rp.MIN_CLEARANCE * 1000:.0f} mm of the body")
        # Rendered before the clips are checked, so a clip that fails can be looked at.
        if emotions:
            rp.render_emotions(rig, meshes, friend.key, emotions)
        rp.report_faces(friend.label, meshes)
        clearance = rp.Clearance(rig, parts, body=f"{friend.prefix}_body", top=f"{friend.prefix}_{friend.top}")
        rp.report_emotions(friend.label, rig, clearance, {"": tuple(f"{friend.prefix}_{name}" for name in friend.below)})
        # Everything above is measured at the child's natural height. Only now
        # is the friend enlarged to stand with the rest of the cast.
        factor = friend.height / rp.world_z_range(parts[f"{friend.prefix}_body"])[1]
        rp.enlarge(rig, meshes, factor)
        print(f"{friend.label}: enlarged {factor:.3f} times to stand {friend.height} m to the crown")
        rp.export_model(rig, meshes, OUTPUT_DIR / f"{friend.key}.glb")

    if len(friends) == len(FRIENDS):
        save_preview(frames)
        print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")
    for friend in friends:
        validate_export(friend, nodes[friend.key])
        print(f"Model:   {(OUTPUT_DIR / f'{friend.key}.glb').relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
