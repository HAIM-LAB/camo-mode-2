"""Generate the realistic player for Camo Mode 2 with MPFB (MakeHuman for Blender).

Run from the repository root (see blender/cast/README.md for the one-time MPFB setup):
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/cast/generate_realistic_player.py

Add `-- --views <directory>` to also save renders of every look, and
`-- --emotions <directory>` to save every emotion: its face alone, and its
face and body.

Unlike generate_cast.py this uses outside assets: the MakeHuman base mesh, rig,
and morph targets that ship with MPFB, and hair, clothes, shoes, skin, eyes,
eyebrows, and eyelashes from the "MakeHuman system assets" pack. All of them are
CC0; docs/third-party-assets.md records each one.

The modeling space is Blender's Z-up space. Blender's glTF exporter converts it to
Y-up; the child faces Blender -Y so that the exported forward direction is glTF +Z.
"""

from __future__ import annotations

import importlib
import math
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
SOURCE_DIR = REPO_ROOT / "blender" / "cast"
OUTPUT_PATH = REPO_ROOT / "public" / "assets" / "cast" / "player-realistic.glb"
PREVIEW_PATH = SOURCE_DIR / "realistic-player-preview.png"
MPFB_MODULE = "bl_ext.blender_org.mpfb"
# Processed textures are embedded in the GLB; the files themselves are scratch.
TEXTURE_DIR = Path(tempfile.mkdtemp(prefix="camo-realistic-player-"))


# -----------------------------------------------------------------------------
# MPFB


def require_mpfb() -> dict:
    """Returns MPFB's services, enabling the extension for this session if needed."""
    # --factory-startup ignores the saved preferences, so the extension is
    # enabled here rather than relying on how this Blender was last left.
    if MPFB_MODULE not in bpy.context.preferences.addons:
        bpy.ops.preferences.addon_enable(module=MPFB_MODULE)
    if MPFB_MODULE not in bpy.context.preferences.addons:
        raise SystemExit(
            "MPFB is not installed in this Blender. See blender/cast/README.md for the one-time setup."
        )
    return {
        name: getattr(importlib.import_module(f"{MPFB_MODULE}.services.{name.lower()}"), name)
        for name in ("HumanService", "AssetService", "TargetService")
    }


def asset_path(mpfb: dict, subdir: str, fragment: str) -> Path:
    path = mpfb["AssetService"].find_asset_absolute_path(fragment, subdir)
    if not path:
        raise SystemExit(
            f"MakeHuman asset {subdir}/{fragment} is missing. Install the CC0 "
            "'MakeHuman system assets' pack; see blender/cast/README.md."
        )
    return Path(path)


# -----------------------------------------------------------------------------
# Outside assets (all CC0; keep docs/third-party-assets.md in step with this list)

SKIN = ("skins", "young_caucasian_female/young_caucasian_female.mhmat", "young_lightskinned_female_diffuse.png")
EYE_TEXTURE = ("eyes", "materials/brown.mhmat", "brown_eye.png")
EYES = ("eyes", "low-poly/low-poly.mhclo", "Eyes")
BROWS = ("eyebrows", "eyebrow001/eyebrow001.mhclo", "Eyebrows")
LASHES = ("eyelashes", "eyelashes01/eyelashes01.mhclo", "Eyelashes")
HAIR_BOY = ("hair", "short02/short02.mhclo", "Hair")
HAIR_GIRL = ("hair", "long01/long01.mhclo", "Hair")
SUIT = ("clothes", "male_casualsuit02/male_casualsuit02.mhclo", "Clothes")
SHOES = ("clothes", "shoes06/shoes06.mhclo", "Clothes")


# -----------------------------------------------------------------------------
# Colors. The runtime repaints these materials by name (src/player-look.ts), so
# each is authored in the default look's color.

def hex_rgba(value: str) -> tuple[float, float, float, float]:
    """An sRGB hex color as the linear RGBA Blender materials expect."""
    channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
    return (*[srgb_to_linear(np.float32(channel)).item() for channel in channels], 1.0)


def srgb_to_linear(value: np.ndarray) -> np.ndarray:
    return np.where(value <= 0.04045, value / 12.92, ((value + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(value: np.ndarray) -> np.ndarray:
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * np.maximum(value, 0.0) ** (1 / 2.4) - 0.055)


SKIN_HEX = "#b88561"  # Medium, the default tone.
TOP_HEX = "#2ca8af"  # Ocean, the default outfit.
TOP_DARK_HEX = "#248590"
TROUSERS_HEX = "#ea7373"
ACCENT_HEX = "#ffc73c"
ACCENT_DARK_HEX = "#dd9521"
HAIR_HEX = "#4d352c"
SOCK_HEX = "#eef0ee"
SOLE_HEX = "#f4f1ea"


# -----------------------------------------------------------------------------
# Scene helpers


def select_only(obj: bpy.types.Object) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures):
        for block in list(collection):
            collection.remove(block)
    bpy.context.preferences.filepaths.save_version = 0


def group_weight(vertex: bmesh.types.BMVert, layer, index: int | None) -> float:
    if index is None:
        return 0.0
    return vertex[layer].get(index, 0.0)


def keep_vertices(obj: bpy.types.Object, keep) -> None:
    """Deletes every vertex for which keep(vertex, deform_layer) is false."""
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    layer = mesh.verts.layers.deform.verify()
    doomed = [vertex for vertex in mesh.verts if not keep(vertex, layer)]
    bmesh.ops.delete(mesh, geom=doomed, context="VERTS")
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()


def keep_faces(obj: bpy.types.Object, keep) -> None:
    """Deletes every face for which keep(face) is false, without changing how the rest is shaded.

    The vertices that stay keep the normals they had among all their old
    neighbors, so no crease appears where the mesh now ends.
    """
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    mesh.normal_update()
    normals = {vertex: vertex.normal.copy() for vertex in mesh.verts}
    bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if not keep(face)], context="FACES")
    kept = [normals[vertex] for vertex in mesh.verts]
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()
    obj.data.normals_split_custom_set_from_vertices(kept)


def duplicate(obj: bpy.types.Object, name: str) -> bpy.types.Object:
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    copy.data.name = name
    for collection in obj.users_collection:
        collection.objects.link(copy)
    return copy


def separate_loose(obj: bpy.types.Object) -> list[bpy.types.Object]:
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    return list(bpy.context.selected_objects)


def join(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    joined.data.name = name
    return joined


def world_z_range(obj: bpy.types.Object) -> tuple[float, float]:
    heights = [(obj.matrix_world @ vertex.co).z for vertex in obj.data.vertices]
    return min(heights), max(heights)


def strip_modifiers(obj: bpy.types.Object, *, keep: tuple[str, ...] = ("ARMATURE",)) -> None:
    for modifier in list(obj.modifiers):
        if modifier.type not in keep:
            obj.modifiers.remove(modifier)


# -----------------------------------------------------------------------------
# Body


# A young child, about six or seven: MakeHuman's age scale runs from a
# one-year-old at 0 to a ten-year-old at 0.1875. Boy and Girl share this one
# body, as on the cartoon player; only the hair differs.
CHILD_MACROS = {
    "gender": 0.5,
    "age": 0.11,
    # A little softer than average, as young children are.
    "muscle": 0.45,
    "weight": 0.47,
    "proportions": 0.3,
    # Taller than MakeHuman's own child of this age, which comes out toddler-sized.
    "height": 0.62,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race": {"asian": 0.33, "caucasian": 0.34, "african": 0.33},
}

# Morphs on top of the macros. Without them the age scale alone gives an older
# child's build: these bring the figure to just under six heads tall.
CHILD_TARGETS = {
    # A young child's proportions: a larger head on a short-legged body with
    # narrow, sloping shoulders and no taper from chest to waist.
    "head-scale-vert-incr": 0.4,
    "head-scale-horiz-incr": 0.4,
    "head-scale-depth-incr": 0.4,
    "upperlegs-height-decr": 0.3,
    "lowerlegs-height-decr": 0.3,
    "measure-shoulder-dist-decr": 0.5,
    "torso-vshape-decr": 0.35,
    # A round, soft face rather than a small adult's.
    "head-age-decr": 0.5,
    "head-round": 0.4,
    "l-cheek-volume-incr": 0.5,
    "r-cheek-volume-incr": 0.5,
    # A relaxed, friendly expression: a slight closed-mouth smile and eyes at
    # rest, a touch larger than life but not held wide.
    "mouth-corner-puller": 0.45,
    "l-eye-scale-incr": 0.2,
    "r-eye-scale-incr": 0.2,
    "eye-left-closure": 0.12,
    "eye-right-closure": 0.12,
}


def build_body(mpfb: dict, macros: dict = CHILD_MACROS, morphs: dict = CHILD_TARGETS) -> bpy.types.Object:
    human, targets = mpfb["HumanService"], mpfb["TargetService"]
    body = human.create_human(scale=0.1, macro_detail_dict=macros)
    for name, weight in morphs.items():
        path = targets.target_full_path(name)
        if not path:
            raise SystemExit(f"MPFB morph target {name} is missing")
        targets.load_target(body, path, weight=weight)
    targets.bake_targets(body)
    return body


def add_part(mpfb: dict, body: bpy.types.Object, part: tuple[str, str, str]) -> bpy.types.Object:
    subdir, fragment, kind = part
    # Materials are rebuilt below, so MPFB is asked for none.
    return mpfb["HumanService"].add_mhclo_asset(
        str(asset_path(mpfb, subdir, fragment)), body, asset_type=kind, subdiv_levels=0, material_type="NONE",
    )


def visible_skin(body: bpy.types.Object) -> None:
    """Keeps the skin no garment covers, as MPFB's mask modifiers would show it.

    Doing it in the mesh rather than with modifiers also drops the base mesh's
    helper geometry and everything under the clothes from the exported file.
    """
    names = {group.index: group.name for group in body.vertex_groups}
    body_group = body.vertex_groups["body"].index
    hidden = [index for index, name in names.items() if name.startswith("Delete.")]

    def keep(vertex, layer) -> bool:
        if group_weight(vertex, layer, body_group) <= 0:
            return False
        return not any(group_weight(vertex, layer, index) > 0 for index in hidden)

    keep_vertices(body, keep)
    strip_modifiers(body)


# -----------------------------------------------------------------------------
# Expressions
#
# A face shows an emotion through morph targets (Blender shape keys): one per
# emotion, named for it, on every mesh the face moves. Each is a blend of
# MakeHuman's expression units, the small movements of a face (a brow raised, a
# lip corner pulled) that ship with MPFB as CC0 morphs of the whole base mesh.
#
# The units are read off the base mesh as soon as the body is built, because
# everything after that cuts the mesh up. Its vertices are numbered first, so
# whatever skin is left at the end can still find its share of each unit.

EMOTIONS = ("anger", "disgust", "fear", "happiness", "sadness", "surprise")
# The vertex attribute that numbers the base mesh's vertices; -1 marks a vertex made later.
BASE_VERTEX = "base_vertex"
# A vertex an expression moves less than this, in meters, is left where it is,
# so the exported targets list only the vertices of the face that really move.
# A tenth of a millimeter is a quarter of a pixel in a close-up of the head.
STILL = 0.0001
# A child's face stays smooth and round where an adult's creases. MakeHuman's
# units are an adult's: they furrow the brow, fold the skin from the nose to the
# corners of the mouth, and crease the cheeks. So a face's movement is spread
# over the skin around it: every vertex takes half of its neighbors' average
# movement, this many times over. The lift of a cheek and the dip of a brow
# survive that; a fold one edge wide does not.
SOFTENING_PASSES = 10
# The edges of the eyelids keep their own movement, so that they stay on the
# eyeball: everything within the first of these distances from an eye's middle,
# in eyeball radii, and less and less out to the second.
EYELID_REACH = (1.15, 1.6)
# The lips keep this share of theirs, because their shape is the expression.
LIP_HOLD = 0.7


def both(unit: str, weight: float) -> dict[str, float]:
    """A morph MakeHuman keeps one of for each side of the face, at the same weight on both.

    {side} in its name stands for left and right, and {s} for l and r.
    """
    return {unit.format(side=side, s=side[0]): weight for side in ("left", "right")}


# Each emotion's face, as the weight of every morph it sets: MakeHuman's
# expression units, and some of its modeling morphs where a unit alone is too
# faint to read or creases an adult's way (the angle of the brows, the lift and
# roundness of the cheeks, the length of the nose). A morph a face does not name
# stays as the resting face has it. Weights above 1 push a morph past its own
# extreme, which a child's round face needs before it shows.
#
# Each face has to be named from a close-up of the head alone, without a
# label, and never be frightening: they are drawn for clarity, not intensity.
FACES: dict[str, dict[str, float]] = {
    # Brows drawn down and together over narrowed eyes, the lips pressed and turned down.
    "anger": {
        **both("eyebrows-{side}-down", 1.2), "eyebrows-angle-down": 0.5, **both("eye-{side}-slit", 0.4),
        **both("nose-{side}-dilatation", 0.6),
        "mouth-corner-puller": 0.0, "mouth-compression": 0.8, "mouth-depression": 0.7,
    },
    # A nose scrunched short, the eyes screwed up, and the top lip lifting away from the lower.
    "disgust": {
        **both("nose-{side}-elevation", 0.2), "nose-scale-vert-decr": 0.8, "nose-nostrils-angle-up": 0.6,
        "nose-flaring-incr": 0.3, **both("eyebrows-{side}-down", 0.55),
        **both("eye-{side}-slit", 0.6), **both("eye-{side}-closure", 0.25),
        "mouth-corner-puller": 0.0, "mouth-elevation": 0.6, "mouth-upperlip-middle-up": 0.6, "mouth-depression": 0.6,
        "mouth-upward-retraction": 0.2,
    },
    # Brows raised and pinched up in the middle, eyes wide enough to show white above, the mouth open and stretched sideways.
    "fear": {
        **both("eyebrows-{side}-up", 0.6), **both("eyebrows-{side}-inner-up", 1.3), "eyebrows-angle-up": 0.7,
        **both("eye-{side}-opened-up", 1.2),
        "mouth-corner-puller": 0.0, "mouth-open": 0.45, "mouth-retraction": 0.6, "mouth-depression": 0.2,
    },
    # A warm smile: round cheeks lifting under eyes that narrow a little, the mouth curving up and just open.
    "happiness": {
        "mouth-corner-puller": 0.95, "mouth-angles-up": 0.35, "mouth-open": 0.15,
        **both("{s}-cheek-trans-up", 1.0), **both("{s}-cheek-volume-incr", 1.2),
        **both("eye-{side}-slit", 0.45), **both("eyebrows-{side}-up", 0.2),
    },
    # Brows lifting in the middle over heavy lids, and a mouth turned down into a pout.
    "sadness": {
        **both("eyebrows-{side}-inner-up", 1.2), "eyebrows-angle-up": 0.4, **both("eye-{side}-closure", 0.35),
        "mouth-corner-puller": 0.0, "mouth-depression": 0.45, "mouth-eversion": 0.5, "mouth-angles-down": 0.9,
    },
    # Brows high and arched, eyes wide, and the jaw dropped into a round, dark mouth.
    "surprise": {
        **both("eyebrows-{side}-up", 1.3), **both("eyebrows-{side}-inner-up", 0.7), **both("eye-{side}-opened-up", 1.0),
        "mouth-corner-puller": 0.0, "mouth-open": 0.68, "mouth-protusion": 0.35,
    },
}
FACE_UNITS = tuple(sorted({unit for face in FACES.values() for unit in face}))


def positions(mesh: bpy.types.Mesh) -> np.ndarray:
    """A mesh's vertex positions as (vertices, 3) meters."""
    flat = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", flat)
    return flat.reshape(-1, 3)


@dataclass
class Expressions:
    """What a child's expression units do to the base mesh, captured before that mesh is cut up."""

    # How far each unit, at full weight, moves each vertex of the base mesh: (vertices, 3) meters.
    units: dict[str, np.ndarray]
    # The weight of each unit in the face the body is built with.
    resting: dict[str, float]
    # How the head bone lay when the units were read. A later rest pose may turn the head, and the units with it.
    head: Matrix
    # The parts fitted to the base mesh, each with the three base vertices every one of its vertices follows and their weights.
    fitted: list[tuple[bpy.types.Object, np.ndarray, np.ndarray]]
    # The base mesh's edges, as pairs of its vertices.
    edges: np.ndarray
    # How much of its own movement each base vertex keeps when a face is softened, 0 to 1.
    keep: np.ndarray

    def blend(self, weights: dict[str, float]) -> np.ndarray:
        """How far a face with these unit weights is from the resting face, per base vertex.

        A unit the weights do not name stays as the resting face has it. The
        movement is softened, so the skin swells and dips without creasing.
        """
        return self.soften(sum(
            ((weight - self.resting.get(unit, 0.0)) * self.units[unit] for unit, weight in weights.items()),
            np.zeros_like(next(iter(self.units.values()))),
        ))

    def soften(self, moved: np.ndarray) -> np.ndarray:
        """Spreads a face's movement over the skin around it; see SOFTENING_PASSES."""
        start, end = self.edges[:, 0], self.edges[:, 1]
        joined = np.maximum(np.bincount(self.edges.ravel(), minlength=len(moved)), 1)[:, None]
        keep = self.keep[:, None]
        own = moved
        for _ in range(SOFTENING_PASSES):
            around = np.zeros_like(moved)
            np.add.at(around, start, moved[end])
            np.add.at(around, end, moved[start])
            moved = keep * own + (1.0 - keep) * 0.5 * (moved + around / joined)
        return moved.astype(np.float32)


def capture_expressions(
    mpfb: dict,
    body: bpy.types.Object,
    rig: bpy.types.Object,
    morphs: dict,
    units: tuple[str, ...],
) -> Expressions:
    """Reads the expression units off the freshly built base mesh and numbers its vertices."""
    targets = mpfb["TargetService"]
    rest = positions(body.data)
    moves: dict[str, np.ndarray] = {}
    for unit in units:
        # Found the way build_body() finds the resting face's own units, so a blend can take those away exactly.
        path = targets.target_full_path(unit)
        if not path:
            raise SystemExit(f"MPFB expression unit {unit} is missing")
        key = targets.load_target(body, path, weight=0.0, name=unit)
        moved = np.empty(rest.size, dtype=np.float32)
        key.data.foreach_get("co", moved)
        moves[unit] = moved.reshape(-1, 3) - rest
    body.shape_key_clear()
    numbers = body.data.attributes.new(BASE_VERTEX, "INT", "POINT")
    numbers.data.foreach_set("value", np.arange(len(rest), dtype=np.int32))
    edges = np.empty(len(body.data.edges) * 2, dtype=np.int32)
    body.data.edges.foreach_get("vertices", edges)
    return Expressions(
        units=moves,
        resting={unit: float(morphs.get(unit, 0.0)) for unit in units},
        head=rig.data.bones["head"].matrix_local.to_3x3(),
        fitted=[],
        edges=edges.reshape(-1, 2),
        keep=own_movement(body, rest),
    )


def own_movement(body: bpy.types.Object, rest: np.ndarray) -> np.ndarray:
    """How much of its own movement each vertex of the base mesh keeps when a face is softened, 0 to 1.

    The edges of the eyelids keep all of theirs and the lips most of it. So
    does everything that is not skin: the helpers the eyelashes and the
    clothes hang on.
    """
    names = {group.index: group.name for group in body.vertex_groups}
    members: dict[str, list[int]] = {}
    for vertex in body.data.vertices:
        for item in vertex.groups:
            members.setdefault(names[item.group], []).append(vertex.index)
    keep = np.ones(len(rest), dtype=np.float32)
    keep[members["body"]] = 0.0
    keep[members["lips"]] = LIP_HOLD
    near, far = EYELID_REACH
    for side in "lr":
        eyeball = rest[members[f"helper-{side}-eye"]]
        middle = eyeball.mean(axis=0)
        radius = np.linalg.norm(eyeball - middle, axis=1).max()
        beyond = np.clip((np.linalg.norm(rest - middle, axis=1) / radius - near) / (far - near), 0.0, 1.0)
        keep = np.maximum(keep, 1.0 - beyond * beyond * (3.0 - 2.0 * beyond))
    return keep


def follow_base_mesh(mpfb: dict, expressions: Expressions, obj: bpy.types.Object, part: tuple[str, str, str]) -> None:
    """Notes how a part fitted to the base mesh, such as the eyebrows, follows it.

    MakeHuman hangs each vertex of such a part on three vertices of the base
    mesh; the part takes its share of an expression from the same three.
    """
    subdir, fragment, _ = part
    fit = importlib.import_module(f"{MPFB_MODULE}.entities.clothes.mhclo").Mhclo()
    fit.load(str(asset_path(mpfb, subdir, fragment)))
    if len(fit.verts) != len(obj.data.vertices):
        raise SystemExit(f"{fragment} fits {len(fit.verts)} vertices, but its mesh has {len(obj.data.vertices)}")
    order = sorted(fit.verts)
    expressions.fitted.append((
        obj,
        np.array([fit.verts[index]["verts"] for index in order], dtype=np.int32),
        np.array([fit.verts[index]["weights"] for index in order], dtype=np.float32),
    ))


def forget_base_vertices(obj: bpy.types.Object) -> None:
    """Marks every vertex of a mesh as no longer one of the base mesh's, after an edit that moved or merged them."""
    numbers = obj.data.attributes.get(BASE_VERTEX)
    if numbers:
        numbers.data.foreach_set("value", np.full(len(obj.data.vertices), -1, dtype=np.int32))


def add_shape_key(obj: bpy.types.Object, name: str, offsets: np.ndarray) -> None:
    """A shape key that moves each vertex by its offset, left at rest."""
    if not obj.data.shape_keys:
        obj.shape_key_add(name="Basis", from_mix=False)
    key = obj.shape_key_add(name=name, from_mix=False)
    offsets = np.where(np.linalg.norm(offsets, axis=1, keepdims=True) < STILL, 0.0, offsets)
    key.data.foreach_set("co", (positions(obj.data) + offsets).astype(np.float32).ravel())
    key.value = 0.0


# Cloth lying on the face moves with the skin under it while it is this close, in
# meters, and less and less out to twice as far.
DRAPE_REACH = 0.03


def skin_offsets(obj: bpy.types.Object, blends: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """The skin's share of each blend: what is left of the base mesh, by the numbers its vertices still carry."""
    mesh = obj.data
    numbers = np.empty(len(mesh.vertices), dtype=np.int32)
    mesh.attributes[BASE_VERTEX].data.foreach_get("value", numbers)
    kept = numbers >= 0
    offsets: dict[str, np.ndarray] = {}
    for name, blend in blends.items():
        offsets[name] = np.zeros((len(numbers), 3), dtype=np.float32)
        offsets[name][kept] = blend[numbers[kept]]
    return offsets


def add_expressions(
    expressions: Expressions,
    rig: bpy.types.Object,
    body: bpy.types.Object,
    faces: dict[str, dict[str, float]],
    *,
    draped: tuple[bpy.types.Object, ...] = (),
) -> None:
    """Gives the finished model its faces: one shape key per entry of faces on every mesh a face moves.

    faces maps a name to the unit weights of that face. The skin takes each
    blend by its base vertex numbers. The parts fitted to the base mesh take
    it from the vertices they follow, and draped names the cloth lying on the
    face (a hat's cuff, a scarf), which takes it from the skin beneath.
    """
    # The head may have been turned into a new rest pose since the units were read.
    turned = np.array(rig.data.bones["head"].matrix_local.to_3x3() @ expressions.head.inverted(), dtype=np.float32)
    blends = {name: expressions.blend(weights) @ turned.T for name, weights in faces.items()}
    skin = skin_offsets(body, blends)
    # Deep in the mouth nothing can be seen to move: the lining follows the lips
    # only where it hangs from them, and the rest of it is not in any face.
    deep = [index for index, step in lining_depth(body).items() if step >= 2]
    for offsets in skin.values():
        offsets[deep] = 0.0

    # What the cloth lies on: the skin as it rests, in triangles.
    mesh = body.data
    mesh.calc_loop_triangles()
    triangles = np.array([triangle.vertices[:] for triangle in mesh.loop_triangles], dtype=np.int32)
    corners = positions(mesh)
    surface = BVHTree.FromPolygons([Vector(co) for co in corners], [tuple(triangle) for triangle in triangles])
    lying: list[tuple[bpy.types.Object, np.ndarray, np.ndarray]] = []
    for cloth in draped:
        follows = np.zeros((len(cloth.data.vertices), 3), dtype=np.int32)
        shares = np.zeros((len(cloth.data.vertices), 3), dtype=np.float32)
        for vertex in cloth.data.vertices:
            location, _, index, distance = surface.find_nearest(vertex.co)
            if location is None or distance >= 2.0 * DRAPE_REACH:
                continue
            a, b, c = (Vector(corners[corner]) for corner in triangles[index])
            # The nearest point's barycentric coordinates in its triangle.
            across, along, to = b - a, c - a, location - a
            d00, d01, d11 = across.dot(across), across.dot(along), along.dot(along)
            d20, d21 = to.dot(across), to.dot(along)
            area = d00 * d11 - d01 * d01
            if area < 1e-14:
                continue
            v, w = (d11 * d20 - d01 * d21) / area, (d00 * d21 - d01 * d20) / area
            near = min(max(2.0 - distance / DRAPE_REACH, 0.0), 1.0)
            follows[vertex.index] = triangles[index]
            shares[vertex.index] = np.array((1.0 - v - w, v, w)) * near
        lying.append((cloth, follows, shares))

    for name in faces:
        add_shape_key(body, name, skin[name])
        for obj, follows, shares in expressions.fitted:
            add_shape_key(obj, name, np.einsum("vk,vkc->vc", shares, blends[name][follows]))
        for obj, follows, shares in lying:
            add_shape_key(obj, name, np.einsum("vk,vkc->vc", shares, skin[name][follows]))


def show_face(meshes: list[bpy.types.Object], name: str | None) -> None:
    """Sets one face on every mesh that carries it, and clears every other face; None is the resting face."""
    for obj in meshes:
        if obj.data.shape_keys:
            for key in obj.data.shape_keys.key_blocks[1:]:
                key.value = 1.0 if key.name == name else 0.0


# -----------------------------------------------------------------------------
# Textures


def load_pixels(path: Path, size: int) -> np.ndarray:
    """An image as (size, size, 4) floats in its stored (sRGB) encoding, row 0 at v=0."""
    image = bpy.data.images.load(str(path))
    image.scale(size, size)
    pixels = np.array(image.pixels[:], dtype=np.float32).reshape(size, size, 4)
    bpy.data.images.remove(image)
    return pixels


def save_pixels(name: str, pixels: np.ndarray, *, alpha: bool) -> Path:
    """Writes pixels as PNG (with alpha) or JPEG and returns the file."""
    size = pixels.shape[0]
    image = bpy.data.images.new(name, size, size, alpha=alpha)
    image.pixels = np.clip(pixels, 0.0, 1.0).astype(np.float32).ravel()
    path = TEXTURE_DIR / f"{name}.{'png' if alpha else 'jpg'}"
    image.filepath_raw = str(path)
    image.file_format = "PNG" if alpha else "JPEG"
    image.save(quality=88)
    bpy.data.images.remove(image)
    return path


def luminance(linear_rgb: np.ndarray) -> np.ndarray:
    return linear_rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def uv_pixel_boxes(mesh: bpy.types.Mesh, size: int) -> list[tuple[int, int, int, int]]:
    """The pixel bounding box (x0, y0, x1, y1) of every face in UV space."""
    uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
    mesh.uv_layers.active.data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2) * size
    boxes = []
    for polygon in mesh.polygons:
        corners = uvs[polygon.loop_start:polygon.loop_start + polygon.loop_total]
        low = np.floor(corners.min(axis=0)).astype(int)
        high = np.ceil(corners.max(axis=0)).astype(int)
        boxes.append((max(low[0], 0), max(low[1], 0), min(high[0], size), min(high[1], size)))
    return boxes


def uv_coverage(mesh: bpy.types.Mesh, size: int, margin: int) -> np.ndarray:
    """Texels the mesh's faces use, grown by a margin so filtering never bleeds."""
    covered = np.zeros((size, size), dtype=bool)
    for x0, y0, x1, y1 in uv_pixel_boxes(mesh, size):
        covered[max(y0 - margin, 0):y1 + margin, max(x0 - margin, 0):x1 + margin] = True
    return covered


# The inside of the mouth is so dark that an open mouth is a plain dark shape
# on every skin, with nothing in it to take for a tongue or for teeth:
# everything the closed lips hide is one flat color that no light changes.
MOUTH_HEX = "#2a1210"
# Where the lips meet it they are painted dark too, as a share of the skin
# tone: fully for a couple of texels, then fading out over a few more, as a
# shadow would. The edge of what the lips hide follows the mesh, a staircase,
# and this keeps it out of sight.
MOUTH_SHADE = (0.035, 0.012, 0.011)
MOUTH_SHADE_REACH = 2
MOUTH_SHADE_FEATHER = 3


def inside_mouth(body: bpy.types.Object) -> list[int]:
    """The faces of the skin behind the closed lips: the backs of the lips and the whole lining they hide.

    A face is hidden when it cannot be seen from in front while the face
    rests, because something is in the way. The hidden faces just behind the
    lips are the mouth's, and so is every hidden face that joins them: the
    lining runs on from there, up to the palate and down under the tongue,
    and stops at the lips, which can be seen.
    """
    mesh = body.data
    lips = body.vertex_groups["lips"].index
    on_lips = [vertex.co for vertex in mesh.vertices if any(item.group == lips for item in vertex.groups)]
    low = Vector(min(co[axis] for co in on_lips) for axis in range(3))
    high = Vector(max(co[axis] for co in on_lips) for axis in range(3))
    surface = BVHTree.FromPolygons(
        [vertex.co.copy() for vertex in mesh.vertices], [tuple(polygon.vertices) for polygon in mesh.polygons],
    )
    forward = Vector((0.0, -1.0, 0.0))

    def hidden(polygon: bpy.types.MeshPolygon) -> bool:
        # Only the head around the mouth is asked: the back of the head is hidden from the front too.
        center = polygon.center
        if not (abs(center.x) < high.x + 0.03 and low.z - 0.05 < center.z < high.z + 0.04 and low.y < center.y < high.y + 0.09):
            return False
        return surface.ray_cast(center + forward * 0.0006, forward, 0.12)[0] is not None

    def behind_lips(polygon: bpy.types.MeshPolygon) -> bool:
        center = polygon.center
        return low.x < center.x < high.x and low.z < center.z < high.z and center.y < high.y + 0.01

    out_of_sight = {polygon.index for polygon in mesh.polygons if hidden(polygon)}
    neighbors: dict[tuple[int, int], list[int]] = {}
    for index in out_of_sight:
        for edge in mesh.polygons[index].edge_keys:
            neighbors.setdefault(edge, []).append(index)
    inside = {index for index in out_of_sight if behind_lips(mesh.polygons[index])}
    if not inside:
        raise SystemExit("Found nothing behind the lips; the mouth's lining cannot be painted")
    reached = list(inside)
    while reached:
        for edge in mesh.polygons[reached.pop()].edge_keys:
            for index in neighbors[edge]:
                if index not in inside:
                    inside.add(index)
                    reached.append(index)
    return sorted(inside)


# How far the mouth's lining is drawn back from the skin in front of it, in
# meters, and how much narrower and lower it is made deep in the head.
LINING_TUCK = 0.009
LINING_NARROWING = 0.4


def lining_depth(body: bpy.types.Object) -> dict[int, int]:
    """For each vertex of what the closed lips hide, how many edges of lining lie between it and the lips it hangs from.

    None on the lips themselves, where the lining joins the skin that can be seen.
    """
    mesh = body.data
    hidden = set(inside_mouth(body))
    inside: set[int] = set()
    outside: set[int] = set()
    edges: dict[int, set[int]] = {}
    for polygon in mesh.polygons:
        (inside if polygon.index in hidden else outside).update(polygon.vertices)
        if polygon.index in hidden:
            for start, end in polygon.edge_keys:
                edges.setdefault(start, set()).add(end)
                edges.setdefault(end, set()).add(start)
    steps = {index: 0 for index in inside & outside}
    front = list(steps)
    while front:
        following = []
        for index in front:
            for neighbor in edges[index]:
                if neighbor not in steps:
                    steps[neighbor] = steps[index] + 1
                    following.append(neighbor)
        front = following
    return steps


def tuck_mouth_lining(body: bpy.types.Object) -> None:
    """Draws the lining of the mouth back from the skin of the face.

    In the base mesh the backs of the lips and the cheeks' lining lie a few
    millimeters under the skin. An expression that presses the lips together
    moves the skin through them, and the lining, which is dark, would show on
    the face. Everything the lips hide is moved back and drawn in toward the
    middle of the mouth, except where it joins the lips, so the skin has room
    to move. report_faces() checks that it has enough.
    """
    mesh = body.data
    steps = lining_depth(body)
    lips = [mesh.vertices[index].co for index, step in steps.items() if step == 0]
    if not lips:
        raise SystemExit("The mouth's lining does not join the lips; it cannot be drawn back from them")
    middle = sum(lips, Vector()) / len(lips)
    back = max(co.y for co in lips)
    for index, step in steps.items():
        co = mesh.vertices[index].co
        share = min(step / 2.0, 1.0)
        deep = ease(min(max((co.y - back) / 0.015, 0.0), 1.0))
        co.y += LINING_TUCK * share
        co.x = middle.x + (co.x - middle.x) * (1.0 - LINING_NARROWING * share * deep)
        co.z = middle.z + (co.z - middle.z) * (1.0 - LINING_NARROWING * share * deep)
    mesh.update()


def lining_showing(body: bpy.types.Object, hidden: set[int]) -> int:
    """Counts the lines of sight to the lower face that meet the mouth's lining where skin should be.

    Looked at from the front, from above, and from either side, the lining
    may be seen through parted lips, with nothing behind it but the back of
    the head. Where it shows with the skin of the face just behind it, it has
    come through the face. Measured in the pose and face the body is in.
    """
    mesh = body.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
    lips = body.vertex_groups["lips"].index
    on_lips = [vertex.co for vertex in mesh.vertices if any(item.group == lips for item in vertex.groups)]
    low = Vector(min(co[axis] for co in on_lips) for axis in range(3))
    high = Vector(max(co[axis] for co in on_lips) for axis in range(3))
    surface = BVHTree.FromPolygons(
        [vertex.co.copy() for vertex in mesh.vertices], [tuple(polygon.vertices) for polygon in mesh.polygons],
    )
    showing = 0
    for toward in ((0.0, 1.0, 0.0), (0.0, 1.0, -0.45), (0.5, 1.0, 0.0), (-0.5, 1.0, 0.0)):
        direction = Vector(toward).normalized()
        x = low.x - 0.03
        while x <= high.x + 0.03:
            z = low.z - 0.035
            while z <= high.z + 0.03:
                aim_at = Vector((x, (low.y + high.y) / 2.0, z))
                place, _, index, _ = surface.ray_cast(aim_at - direction * 0.3, direction)
                if place is not None and index in hidden:
                    # Whatever the sight line meets next, within the thickness of a cheek.
                    behind, normal, following, _ = surface.ray_cast(place + direction * 0.0002, direction, 0.02)
                    if behind is not None and following not in hidden and normal.dot(direction) < 0.0:
                        showing += 1
                z += 0.0025
            x += 0.0025
    return showing


def paint_faces(mask: np.ndarray, mesh: bpy.types.Mesh, faces: list[int]) -> None:
    """Marks the texels inside the given faces of a mesh, exactly: no texel of a neighboring face."""
    size = mask.shape[0]
    uvs = np.empty(len(mesh.loops) * 2, dtype=np.float32)
    mesh.uv_layers.active.data.foreach_get("uv", uvs)
    uvs = uvs.reshape(-1, 2) * size
    for index in faces:
        polygon = mesh.polygons[index]
        corners = uvs[polygon.loop_start:polygon.loop_start + polygon.loop_total]
        x0, y0 = np.floor(corners.min(axis=0)).astype(int)
        x1, y1 = np.ceil(corners.max(axis=0)).astype(int) + 1
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, size), min(y1, size)
        if x1 <= x0 or y1 <= y0:
            continue
        # A texel is inside a convex face when its middle is on one side of every edge.
        xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5, np.arange(y0, y1) + 0.5)
        sides = [
            (end[0] - start[0]) * (ys - start[1]) - (end[1] - start[1]) * (xs - start[0])
            for start, end in zip(corners, np.roll(corners, -1, axis=0))
        ]
        inside = np.all([side >= 0 for side in sides], axis=0) | np.all([side <= 0 for side in sides], axis=0)
        mask[y0:y1, x0:x1] |= inside


# How much of the color a skin pack paints around the eyes is taken out, and how
# far from an eye's middle that reaches, in eyeball radii.
EYELID_PLAINNESS = 0.85
EYELID_PAINT_REACH = 1.8


def around_eyes(body: bpy.types.Object, eyes: bpy.types.Object) -> list[int]:
    """The faces of the skin around the eyes: the eyelids and their rims."""
    eyeballs = positions(eyes.data)
    centers = np.array([polygon.center[:] for polygon in body.data.polygons], dtype=np.float32)
    near = np.zeros(len(centers), dtype=bool)
    for side in (eyeballs[:, 0] < 0.0, eyeballs[:, 0] > 0.0):
        middle = eyeballs[side].mean(axis=0)
        radius = np.linalg.norm(eyeballs[side] - middle, axis=1).max()
        near |= np.linalg.norm(centers - middle, axis=1) < EYELID_PAINT_REACH * radius
    return np.flatnonzero(near).tolist()


def skin_texture(
    mpfb: dict,
    body: bpy.types.Object,
    ears: bpy.types.Object | None,
    size: int = 1024,
    *,
    source: tuple[str, str, str] = SKIN,
    name: str = "player-skin",
    plain_eyelids: bpy.types.Object | None = None,
) -> Path:
    """The skin as a neutral detail map: multiplied by a tone it gives that tone.

    Only the texels the visible skin uses are kept. Everything the clothes cover
    is flattened, so no unclothed body texture ships in the file. ears is the
    ears' own mesh, on a model that keeps them apart from the body.

    The inside of the mouth has its own material, from line_mouth(); here
    the lips are shaded where they meet it.

    plain_eyelids is the eyes' mesh, for a pack that paints the rims of the
    eyelids red-brown, as the player's does. On a young child that reads as
    sore eyes, so the skin around the eyes keeps its light and shade and
    loses that color.
    """
    subdir, fragment, filename = source
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / filename, size)
    linear = srgb_to_linear(pixels[..., :3])
    used = uv_coverage(body.data, size, margin=4)
    if ears is not None:
        used |= uv_coverage(ears.data, size, margin=4)
    # The typical skin value becomes white, so the tone the runtime multiplies
    # in is the tone the child sees; lips, creases, and brows stay relative to it.
    reference = np.percentile(linear[used], 75, axis=0)
    neutral = np.clip(linear / reference, 0.0, 1.0)
    neutral[~used] = 1.0
    if plain_eyelids is not None:
        rims = np.zeros((size, size), dtype=bool)
        paint_faces(rims, body.data, around_eyes(body, plain_eyelids))
        # Feathered over a few texels, so the change has no edge.
        share = rims.astype(np.float32)
        for _ in range(6):
            share = (share + sum(np.roll(share, step, axis) for step in (-1, 1) for axis in (0, 1))) / 5.0
        grey = luminance(neutral)[..., None]
        neutral = neutral + (grey - neutral) * (EYELID_PLAINNESS * share)[..., None]
    lining = np.zeros((size, size), dtype=bool)
    paint_faces(lining, body.data, inside_mouth(body))
    for _ in range(MOUTH_SHADE_REACH):
        lining = lining | np.roll(lining, 1, 0) | np.roll(lining, -1, 0) | np.roll(lining, 1, 1) | np.roll(lining, -1, 1)
    share = lining.astype(np.float32)
    for _ in range(MOUTH_SHADE_FEATHER):
        share = np.maximum(share, (share + sum(np.roll(share, step, axis) for step in (-1, 1) for axis in (0, 1))) / 5.0)
    neutral = neutral + (np.array(MOUTH_SHADE, dtype=np.float32) - neutral) * share[..., None]
    pixels[..., :3] = linear_to_srgb(neutral)
    pixels[..., 3] = 1.0
    return save_pixels(name, pixels, alpha=False)


def clothes_texture(mpfb: dict, top: bpy.types.Object, trousers: bpy.types.Object, size: int = 512) -> Path:
    """One grayscale detail map for the top and trousers, multiplied by the outfit colors.

    The top takes only the pack's ambient occlusion (its folds), which leaves the
    original print behind. The trousers also keep their denim weave and seams.
    """
    subdir, fragment, _ = SUIT
    folder = asset_path(mpfb, subdir, fragment).parent
    stem = Path(fragment).stem
    occlusion = load_pixels(folder / f"{stem}_ao.png", size)[..., 0]
    weave = luminance(srgb_to_linear(load_pixels(folder / f"{stem}_diffuse.png", size)[..., :3]))

    denim = np.zeros((size, size), dtype=bool)
    for x0, y0, x1, y1 in uv_pixel_boxes(trousers.data, size):
        denim[y0:y1, x0:x1] = True
    for x0, y0, x1, y1 in uv_pixel_boxes(top.data, size):
        if denim[y0:y1, x0:x1].any():
            raise SystemExit("The top and trousers share texture space; the denim mask would bleed onto the top")

    detail = 0.35 + 0.65 * occlusion
    weave_level = np.percentile(weave[denim], 80)
    detail[denim] *= np.clip(0.45 + 0.55 * weave[denim] / weave_level, 0.0, 1.0)
    pixels = np.ones((size, size, 4), dtype=np.float32)
    pixels[..., :3] = linear_to_srgb(detail)[..., None]
    return save_pixels("player-clothes", pixels, alpha=False)


def hair_texture(
    mpfb: dict,
    part: tuple[str, str, str],
    name: str,
    size: int = 512,
    *,
    tint_hex: str = HAIR_HEX,
    filename: str | None = None,
) -> Path:
    """Strand detail in one hair color, keeping the pack's alpha.

    filename is the hair's texture, for the one the pack does not name after the hair.
    """
    subdir, fragment, _ = part
    filename = filename or f"{Path(fragment).stem}_diffuse.png"
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / filename, size)
    strands = luminance(srgb_to_linear(pixels[..., :3]))
    opaque = pixels[..., 3] > 0.5
    level = np.median(strands[opaque])
    shade = np.clip(0.3 + 0.7 * strands / level, 0.0, 1.9)
    tint = np.array(hex_rgba(tint_hex)[:3], dtype=np.float32)
    pixels[..., :3] = linear_to_srgb(np.clip(shade[..., None] * tint, 0.0, 1.0))
    return save_pixels(name, pixels, alpha=True)


def tinted_alpha_texture(mpfb: dict, part: tuple[str, str, str], name: str, tint_hex: str, size: int = 256) -> Path:
    """An eyebrow or eyelash card: the pack's alpha in one flat color."""
    subdir, fragment, _ = part
    stem = Path(fragment).stem
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / f"{stem}.png", size)
    pixels[..., :3] = linear_to_srgb(np.array(hex_rgba(tint_hex)[:3], dtype=np.float32))
    return save_pixels(name, pixels, alpha=True)


# The pack's brown iris is a red-brown, and bright: at the game's size it reads
# as red eyes. Each channel of it is scaled by these, toward a plain warm brown.
IRIS = (0.58, 0.68, 0.6)


def eye_texture(
    mpfb: dict,
    size: int = 256,
    *,
    source: tuple[str, str, str] = EYE_TEXTURE,
    name: str = "player-eyes",
    iris: tuple[float, float, float] = IRIS,
) -> Path:
    """The pack's eye with everything colored in it scaled by iris, channel by channel.

    That is the iris and the pink in the corners of the eye. The white is left as it is.
    """
    subdir, fragment, filename = source
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / filename, size)
    color = pixels[..., :3]
    colored = np.clip((color.max(axis=2) - color.min(axis=2)) * 5.0, 0.0, 1.0)[..., None]
    # The pack's eye whites are grey; lifted a little so the eyes read from the game camera.
    pixels[..., :3] = np.clip(color * 1.15 * (1.0 - colored + colored * np.array(iris, dtype=np.float32)), 0.0, 1.0)
    pixels[..., 3] = 1.0
    return save_pixels(name, pixels, alpha=False)


# -----------------------------------------------------------------------------
# Materials


def make_material(
    name: str,
    color_hex: str,
    *,
    texture: Path | None = None,
    roughness: float = 0.75,
    alpha: str | None = None,
    double_sided: bool = False,
) -> bpy.types.Material:
    """A glTF-exportable material: base color = color x texture.

    The multiply node exports as baseColorFactor next to baseColorTexture, which
    is what lets the runtime recolor a textured part by setting material.color.
    """
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = not double_sided
    tree = material.node_tree
    shader = tree.nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    color = hex_rgba(color_hex)
    material.diffuse_color = color
    if texture is None:
        shader.inputs["Base Color"].default_value = color
        return material

    image = tree.nodes.new("ShaderNodeTexImage")
    image.image = bpy.data.images.load(str(texture))
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    tree.links.new(image.outputs["Color"], mix.inputs["A"])
    mix.inputs["B"].default_value = color
    tree.links.new(mix.outputs["Result"], shader.inputs["Base Color"])

    if alpha == "CLIP":
        # A Round node is how the exporter recognises alpha clip (glTF MASK, cutoff 0.5).
        clip = tree.nodes.new("ShaderNodeMath")
        clip.operation = "ROUND"
        tree.links.new(image.outputs["Alpha"], clip.inputs[0])
        tree.links.new(clip.outputs[0], shader.inputs["Alpha"])
    elif alpha == "BLEND":
        tree.links.new(image.outputs["Alpha"], shader.inputs["Alpha"])
    return material


def mouth_material(name: str) -> bpy.types.Material:
    """The inside of a mouth: one flat dark color that no light changes.

    Lit as skin is, even painted dark, the lining catches a light shone at
    the face and shows a pale band behind the lips, like teeth. A color wired
    straight to the output is how the exporter recognises an unlit material
    (glTF KHR_materials_unlit).
    """
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = hex_rgba(MOUTH_HEX)
    tree = material.node_tree
    tree.nodes.remove(tree.nodes["Principled BSDF"])
    color = tree.nodes.new("ShaderNodeRGB")
    color.outputs["Color"].default_value = hex_rgba(MOUTH_HEX)
    tree.links.new(color.outputs["Color"], tree.nodes["Material Output"].inputs["Surface"])
    return material


def line_mouth(body: bpy.types.Object, material: bpy.types.Material) -> None:
    """Gives everything the closed lips hide the mouth's material.

    The packs do not paint the inside of the mouth for looking into: it is
    pale on one skin and bright red on another, and the backs of the lips are
    lip-red, which shows as a tongue in an open mouth.
    """
    body.data.materials.append(material)
    slot = len(body.data.materials) - 1
    for index in inside_mouth(body):
        body.data.polygons[index].material_index = slot


def assign(obj: bpy.types.Object, material: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True


# -----------------------------------------------------------------------------
# Variant parts
#
# The skirt, leggings, beanie, and head scarf are all cut from meshes the child
# already has, so they fit this body and carry its skin weights.


def bisect(
    obj: bpy.types.Object,
    point: tuple[float, float, float],
    normal: tuple[float, float, float],
    *,
    keep_both: bool = False,
) -> None:
    """Cuts a mesh along a plane and keeps the normal's side, with a clean cut edge.

    keep_both only scores the mesh along the plane, for a clean line between two materials.
    """
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    bmesh.ops.bisect_plane(
        mesh,
        geom=mesh.verts[:] + mesh.edges[:] + mesh.faces[:],
        plane_co=Vector(point),
        plane_no=Vector(normal),
        clear_inner=not keep_both,
    )
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()


def helper_garment(body: bpy.types.Object, name: str, group: str, low: float, high: float) -> bpy.types.Object:
    """One of the base mesh's garment helpers (a skirt or tights), cut to a height range."""
    garment = duplicate(body, name)
    index = garment.vertex_groups[group].index
    keep_vertices(garment, lambda vertex, layer: group_weight(vertex, layer, index) > 0)
    strip_modifiers(garment)
    bisect(garment, (0.0, 0.0, low), (0.0, 0.0, 1.0))
    bisect(garment, (0.0, 0.0, high), (0.0, 0.0, -1.0))
    return garment


def flare(obj: bpy.types.Object, top: float, hem: float, amount: float) -> None:
    """Widens a garment toward its hem, giving a straight helper skirt an A-line."""
    center = sum((vertex.co.y for vertex in obj.data.vertices), 0.0) / len(obj.data.vertices)
    for vertex in obj.data.vertices:
        reach = min(max((top - vertex.co.z) / (top - hem), 0.0), 1.0)
        vertex.co.x *= 1.0 + amount * reach
        vertex.co.y = center + (vertex.co.y - center) * (1.0 + amount * reach)


# How far a fitted layer's edge stands off the surface: enough not to flicker, too little to see under.
EDGE_STAND_OFF = 0.0025


def fitted_layer(
    source: bpy.types.Object,
    name: str,
    keep,
    *,
    thickness,
    smoothing: int,
    cut: tuple[tuple[float, float, float], tuple[float, float, float]] | None = None,
    shape=None,
    detail: float = 1.0,
) -> bpy.types.Object:
    """Cloth lying over part of a mesh: the kept faces, pushed outward and smoothed.

    keep(vertex, deform_layer) picks the faces; cut is an optional (point,
    normal) plane for a clean edge. thickness(vertex) is how far the cloth
    stands off, in meters. The cloth's edge is held against the surface so
    nothing shows under it. shape(mesh) may reshape the kept faces before they
    are pushed out, and detail below 1 thins the result to that share of its
    faces.
    """
    layer = duplicate(source, name)
    keep_vertices(layer, keep)
    strip_modifiers(layer)
    if cut:
        bisect(layer, *cut)

    mesh = bmesh.new()
    mesh.from_mesh(layer.data)
    if shape:
        shape(mesh)
    mesh.normal_update()
    surface = BVHTree.FromBMesh(mesh)  # What the cloth lies on, before it is lifted off.
    edge = {vertex for vertex in mesh.verts if vertex.is_boundary}
    stand_off = {vertex: (EDGE_STAND_OFF if vertex in edge else thickness(vertex)) for vertex in mesh.verts}
    for vertex, distance in stand_off.items():
        vertex.co += vertex.normal * distance
    inner = [vertex for vertex in mesh.verts if vertex not in edge]
    for _ in range(smoothing):
        bmesh.ops.smooth_vert(mesh, verts=inner, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    # Smoothing pulls the cloth in on tight curves; nothing may sink into the surface.
    for vertex in mesh.verts:
        location, normal, _, distance = surface.find_nearest(vertex.co)
        least = 0.6 * stand_off[vertex]
        if (vertex.co - location).dot(normal) < 0.0 or distance < least:
            vertex.co = location + normal * least
    mesh.to_mesh(layer.data)
    mesh.free()
    layer.data.update()

    if detail < 1.0:
        simplify(layer, detail)
    return layer


def simplify(obj: bpy.types.Object, detail: float, group: str = "") -> None:
    """Thins a mesh to a share of its faces, only among a vertex group's vertices if one is named."""
    select_only(obj)
    modifier = obj.modifiers.new("Simplify", "DECIMATE")
    modifier.ratio = detail
    modifier.vertex_group = group
    bpy.ops.object.modifier_move_to_index(modifier=modifier.name, index=0)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def split_material(obj: bpy.types.Object, second: bpy.types.Material, chosen) -> None:
    """Gives the faces for which chosen(center) is true a second material."""
    obj.data.materials.append(second)
    for polygon in obj.data.polygons:
        if chosen(polygon.center):
            polygon.material_index = 1


@dataclass(frozen=True)
class Head:
    """Where things sit on this child's head and neck, in meters before the model is grounded.

    Measured from the built meshes rather than written down, so the headwear
    still fits whenever the body's proportions change.
    """

    shoulders: float  # Height that separates the head and neck from the raised hands.
    crown: float  # Top of the skull.
    brow: float  # Top of the eyebrows.
    eye: float  # Middle of the eyes.
    chin: float  # Just under the chin, where the jaw has turned back toward the neck.
    forehead: float  # y of the forehead where a hat's cuff sits.
    back: float  # y of the back of the skull.
    half_width: float  # Half the skull's width above the ears.
    ear: Vector  # Middle of the ear on the +x side.
    ear_front: float  # y of the front edge of the ears.
    collar: float  # Top edge of the top's collar.
    neck: Vector  # A point on the neck's axis at its base.
    shoulder_reach: float  # x of the shoulder joint.

    # The beanie's brim runs from above the brows down to the nape, clipping the tops of the ears.
    @property
    def brim_front(self) -> tuple[float, float]:
        return (self.forehead, self.brow + 0.026)

    @property
    def brim_slope(self) -> float:
        return (self.eye - 0.025 - self.brim_front[1]) / (self.back - 0.002 - self.forehead)

    @property
    def brim_plane(self) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
        return ((0.0, *self.brim_front), (0.0, -self.brim_slope, 1.0))

    @property
    def cuff_height(self) -> float:
        return 0.18 * (self.crown - self.chin)

    def above_brim(self, co: Vector) -> float:
        """Height of a point above the beanie's brim plane."""
        return co.z - (self.brim_front[1] + self.brim_slope * (co.y - self.forehead))

    # The scarf frames the face with an oval, seen from the front: above the brows to under the chin.
    @property
    def face_center(self) -> Vector:
        return Vector((0.0, 0.0, (self.brow + 0.042 + self.chin) / 2.0))

    @property
    def face_half_height(self) -> float:
        return (self.brow + 0.042 - self.chin) / 2.0

    @property
    def face_half_width(self) -> float:
        return 0.84 * self.half_width

    def in_front(self, co: Vector) -> bool:
        """Whether a point is on the face, in front of the ears."""
        return co.y < self.ear_front - 0.004

    def face_oval(self, co: Vector) -> float:
        """Below 1 inside the scarf's face opening, above 1 outside it."""
        if not self.in_front(co):
            return 2.0
        return math.hypot(co.x / self.face_half_width, (co.z - self.face_center.z) / self.face_half_height)


def measure_head(
    rig: bpy.types.Object,
    body: bpy.types.Object,
    eyes: bpy.types.Object,
    brows: bpy.types.Object,
    top: bpy.types.Object,
) -> Head:
    shoulders = rig.data.bones["spine_03"].tail_local.z
    skin = [vertex.co for vertex in body.data.vertices if vertex.co.z > shoulders]
    middle = [co for co in skin if abs(co.x) < 0.012]
    eye = sum(vertex.co.z for vertex in eyes.data.vertices) / len(eyes.data.vertices)
    brow = max(vertex.co.z for vertex in brows.data.vertices)

    def group_bounds(name: str, keep=lambda co: True) -> tuple[Vector, Vector]:
        index = body.vertex_groups[name].index
        inside = [
            vertex.co for vertex in body.data.vertices
            if keep(vertex.co) and any(item.group == index and item.weight > 0 for item in vertex.groups)
        ]
        return (
            Vector(min(co[axis] for co in inside) for axis in range(3)),
            Vector(max(co[axis] for co in inside) for axis in range(3)),
        )

    ear_low, ear_high = group_bounds("ears", lambda co: co.x > 0)
    lips_low, lips_high = group_bounds("lips")

    # Walking down the profile from the mouth, the chin ends where the skin has
    # turned back 3 cm behind the most forward point passed so far.
    profile: dict[int, float] = {}
    for co in middle:
        if shoulders < co.z < lips_low.z and co.y < ear_low.y:
            step = int(co.z / 0.003)
            profile[step] = min(profile.get(step, co.y), co.y)
    forward = lips_low.y
    chin = shoulders
    for step in sorted(profile, reverse=True):
        forward = min(forward, profile[step])
        if profile[step] > forward + 0.03:
            chin = step * 0.003
            break

    return Head(
        shoulders=shoulders,
        crown=max(co.z for co in skin),
        brow=brow,
        eye=eye,
        chin=chin,
        forehead=min(co.y for co in middle if brow + 0.018 < co.z < brow + 0.04),
        back=max(co.y for co in skin if co.z > eye),
        half_width=max(abs(co.x) for co in skin if co.z > brow + 0.025),
        ear=(ear_low + ear_high) / 2.0,
        ear_front=ear_low.y,
        collar=world_z_range(top)[1],
        neck=rig.data.bones["neck_01"].head_local.copy(),
        shoulder_reach=abs(rig.data.bones["upperarm_l"].head_local.x),
    )


def cut_oval(mesh: bmesh.types.BMesh, center: Vector, across: Vector, up: Vector, half_across: float, half_up: float, *, keep: str, applies=lambda co: True) -> None:
    """Cuts a mesh along an oval cylinder, leaving a clean edge, and keeps what is inside or outside it.

    The oval lies in the plane of the unit vectors across and up, around
    center. It is cut as a many-sided polygon: each side scores the faces near
    the oval along one of its tangents, then one side of the polygon goes.
    Only faces whose middle satisfies applies() are touched.
    """
    def reach(co: Vector) -> float:
        offset = co - center
        return math.hypot(offset.dot(across) / half_across, offset.dot(up) / half_up)

    tangents = []
    for side in range(32):
        angle = 2.0 * math.pi * side / 32
        point = center + across * (half_across * math.cos(angle)) + up * (half_up * math.sin(angle))
        normal = (across * (math.cos(angle) / half_across) + up * (math.sin(angle) / half_up)).normalized()
        tangents.append((point, normal))
        around = [
            face for face in mesh.faces
            if applies(face.calc_center_median()) and 0.7 < reach(face.calc_center_median()) < 1.4
        ]
        geometry = set(around)
        for face in around:
            geometry.update(face.edges)
            geometry.update(face.verts)
        bmesh.ops.bisect_plane(mesh, geom=list(geometry), plane_co=point, plane_no=normal)

    def inside(co: Vector) -> bool:
        return applies(co) and all((co - point).dot(normal) < 0.0 for point, normal in tangents)

    doomed = [face for face in mesh.faces if inside(face.calc_center_median()) != (keep == "inside")]
    bmesh.ops.delete(mesh, geom=doomed, context="FACES")


X_AXIS, Y_AXIS, Z_AXIS = Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0))


def bridge_ears(mesh: bmesh.types.BMesh, ears: int) -> None:
    """Replaces each ear of a head mesh with a flat patch across its outline."""
    deform = mesh.verts.layers.deform.verify()

    def on_ear(element) -> bool:
        return all(group_weight(vertex, deform, ears) > 0 for vertex in element.verts)

    bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if on_ear(face)], context="FACES")
    outlines = [edge for edge in mesh.edges if edge.is_boundary and on_ear(edge)]
    patches = bmesh.ops.holes_fill(mesh, edges=outlines, sides=0)["faces"]
    bmesh.ops.triangulate(mesh, faces=patches)
    # The patches must face outward like the skin around them.
    bmesh.ops.recalc_face_normals(mesh, faces=mesh.faces[:])


# How deep the long hair lies on the head, in meters: over the parting, and
# at the sides, where it is on its way out to fall over the ears.
CROWN_DEPTH = 0.017
SIDE_DEPTH = 0.028


def fill_out_crown(head: Head, hair: bpy.types.Object, body: bpy.types.Object) -> None:
    """Lifts hair that lies flat on the upper head, so a bare head is round rather than pointed.

    The long hair rises at its parting and falls wide over the ears, but
    between them it lies close against the skull, which gives the head a
    gabled outline. Wherever the hair around a vertex is shallower than the
    depth wanted there, the vertex moves off the scalp by what is missing, so
    the layers keep their order and their spacing. Nothing moves at the
    beanie's brim or below it.
    """
    reach = 0.025  # Hair within this distance along the scalp counts as around a vertex.
    scalp = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
    vertices = [vertex for vertex in hair.data.vertices if head.above_brim(vertex.co) > 0.0]
    roots, outward, depths = [], [], []
    for vertex in vertices:
        location, normal, _, _ = scalp.find_nearest(vertex.co)
        roots.append(location)
        outward.append(normal)
        depths.append((vertex.co - location).dot(normal))
    around = KDTree(len(roots))
    for index, root in enumerate(roots):
        around.insert(root, index)
    around.balance()
    neighbors = [[index for _, index, _ in around.find_range(root, reach)] for root in roots]
    deepest = [max(depths[index] for index in near) for near in neighbors]
    for vertex, normal, near in zip(vertices, outward, neighbors):
        # Averaged over the neighborhood, so the lift changes smoothly along the hair.
        depth = sum(deepest[index] for index in near) / len(near)
        # The scalp faces sideways where the hair is heading for the ears.
        wanted = CROWN_DEPTH + (SIDE_DEPTH - CROWN_DEPTH) * ease(min(abs(normal.x) / 0.85, 1.0))
        # The lift fades out toward the brim, over the three centimeters above it.
        vertex.co += normal * max(wanted - depth, 0.0) * ease(min(head.above_brim(vertex.co) / 0.03, 1.0))
    hair.data.update()


def split_at_brim(head: Head, hair: bpy.types.Object, name: str, shape=None) -> bpy.types.Object:
    """Cuts a hairstyle in two along the beanie's brim and returns the part above it.

    The hair keeps what shows below a hat. The rest, which a hat covers and
    only a bare head shows, becomes a mesh of its own, so the beanie hides it
    rather than having it poke through the knit. The two still shade as one
    head of hair. shape(hair) may reshape what is above the brim once the cut
    is marked, which leaves the hair below it exactly as it was.
    """
    bisect(hair, *head.brim_plane, keep_both=True)
    if shape:
        shape(hair)
    crown = duplicate(hair, name)
    keep_faces(crown, lambda face: head.above_brim(face.calc_center_median()) > 0.0)
    keep_faces(hair, lambda face: head.above_brim(face.calc_center_median()) <= 0.0)
    return crown


def build_headwear(head: Head, body: bpy.types.Object, top: bpy.types.Object) -> dict[str, bpy.types.Object]:
    _, brim_normal = head.brim_plane
    beanie = fitted_layer(
        body,
        "player_beanie_knit",
        lambda vertex, layer: vertex.co.z > head.shoulders and head.above_brim(vertex.co) > -0.02,
        cut=head.brim_plane,
        # A rolled cuff: the lowest band of the hat stands further off the head.
        thickness=lambda vertex: 0.022 if head.above_brim(vertex.co) < head.cuff_height else 0.012,
        smoothing=6,
    )
    # Scored where the cuff ends, so its darker color stops on a clean line.
    bisect(beanie, (0.0, head.forehead, head.brim_front[1] + head.cuff_height), brim_normal, keep_both=True)

    ears = body.vertex_groups["ears"].index

    def shape_scarf(mesh: bmesh.types.BMesh) -> None:
        # Cloth bridges an ear rather than following its folds. (The look hides
        # the ears themselves under the scarf.)
        bridge_ears(mesh, ears)
        # The skin still dips toward the ear canal around each patch; ironed flat here.
        around = [
            vertex for vertex in mesh.verts
            if (vertex.co - Vector((math.copysign(head.ear.x - 0.004, vertex.co.x), head.ear.y, head.ear.z))).length < 0.04
        ]
        for _ in range(12):
            bmesh.ops.smooth_vert(mesh, verts=around, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        # The face opening: an oval seen from the front, cut through the front of the head only.
        cut_oval(
            mesh, head.face_center, X_AXIS, Z_AXIS, head.face_half_width, head.face_half_height,
            keep="outside", applies=head.in_front,
        )

    scarf = fitted_layer(
        body,
        "player_scarf_wrap",
        lambda vertex, layer: vertex.co.z > head.shoulders,
        shape=shape_scarf,
        thickness=lambda vertex: 0.014,
        smoothing=14,
        detail=0.45,
    )

    drape = build_cowl(head, body, top)
    return {"player_beanie_knit": beanie, "player_scarf_wrap": scarf, "player_scarf_drape": drape}


def landing(surface: BVHTree, start: Vector) -> float | None:
    """The height at which something dropped from start first lands on top of a surface.

    Undersides are passed through: a point that starts inside the jaw or the
    neck comes out of it and keeps falling.
    """
    point = start.copy()
    for _ in range(6):
        hit, normal, _, _ = surface.ray_cast(point, Vector((0.0, 0.0, -1.0)))
        if hit is None:
            return None
        if normal.z > 0.0:
            return hit.z
        point = hit - Vector((0.0, 0.0, 0.001))
    return None


def build_cowl(head: Head, body: bpy.types.Object, top: bpy.types.Object) -> bpy.types.Object:
    """The scarf's drape: cloth falling from under the jaw onto the collarbones.

    Rings of vertices spread from the neck, just under the chin, out to an oval
    edge that stays inside the shoulders and reaches lower on the chest than on
    the back. Each ring is dropped onto whatever it lies over, the neck or the
    top, and held a little off it: a soft fold near the neck thinning to an edge
    that rests on the cloth below.
    """
    segments = 32
    # How far each ring stands off what it lies on, from the neck outward.
    stand_off = (0.004, 0.02, 0.017, 0.011, EDGE_STAND_OFF)
    dependency = bpy.context.evaluated_depsgraph_get()
    surfaces = [BVHTree.FromObject(top, dependency), BVHTree.FromObject(body, dependency)]

    # The neck's outline just under the chin, where the head wrap ends.
    ring_height = head.chin - 0.002
    throat = [
        vertex.co for vertex in body.data.vertices
        if abs(vertex.co.z - ring_height) < 0.012 and vertex.co.y > head.forehead + 0.05
    ]
    neck_front, neck_back = min(co.y for co in throat), max(co.y for co in throat)
    neck_side = max(abs(co.x) for co in throat)
    neck_middle = (neck_front + neck_back) / 2.0

    # How far the drape reaches over each shoulder, the chest, and the back.
    side_reach = 0.95 * head.shoulder_reach
    chest = [vertex.co for vertex in top.data.vertices if abs(vertex.co.x) < 0.03]
    front_reach = min(co.y for co in chest if abs(co.z - (head.collar - 0.08)) < 0.02) + 0.01
    back_reach = max(co.y for co in chest if abs(co.z - (head.collar - 0.045)) < 0.02) - 0.01

    rings: list[list[Vector]] = [[] for _ in stand_off]
    for segment in range(segments):
        angle = 2.0 * math.pi * segment / segments
        across, along = math.cos(angle), math.sin(angle)
        inner = Vector((
            neck_side * across,
            neck_middle + (neck_back - neck_middle if along > 0 else neck_middle - neck_front) * along,
            ring_height,
        ))
        outer = Vector((
            side_reach * across,
            head.neck.y + (back_reach - head.neck.y if along > 0 else head.neck.y - front_reach) * along,
            ring_height,
        ))
        for level, clearance in enumerate(stand_off):
            point = inner.lerp(outer, level / (len(stand_off) - 1))
            if level == 0:
                rings[level].append(point + Vector((across, along, 0.0)).normalized() * clearance)
                continue
            # Dropped from chin height, so the head above never gets in the way.
            heights = [height for height in (landing(surface, point) for surface in surfaces) if height is not None]
            if not heights:
                raise SystemExit("The scarf's drape reaches past the body it should rest on")
            rings[level].append(Vector((point.x, point.y, min(max(heights), ring_height) + clearance)))

    vertices = [point for ring in rings for point in ring]
    faces = [
        (level * segments + segment, level * segments + (segment + 1) % segments,
         (level + 1) * segments + (segment + 1) % segments, (level + 1) * segments + segment)
        for level in range(len(rings) - 1) for segment in range(segments)
    ]
    mesh = bpy.data.meshes.new("player_scarf_drape")
    mesh.from_pydata([tuple(vertex) for vertex in vertices], [], faces)
    mesh.update()
    cowl = bpy.data.objects.new("player_scarf_drape", mesh)
    for collection in top.users_collection:
        collection.objects.link(cowl)
    cowl.parent = top.parent

    # The drape moves with the top it rests on: each vertex takes the skin
    # weights of the nearest point of that top.
    names = {group.index: group.name for group in top.vertex_groups}
    nearest = KDTree(len(top.data.vertices))
    for vertex in top.data.vertices:
        nearest.insert(vertex.co, vertex.index)
    nearest.balance()
    for vertex in cowl.data.vertices:
        _, index, _ = nearest.find(vertex.co)
        for item in top.data.vertices[index].groups:
            group = cowl.vertex_groups.get(names[item.group]) or cowl.vertex_groups.new(name=names[item.group])
            group.add([vertex.index], item.weight, "REPLACE")
    modifier = cowl.modifiers.new("Armature", "ARMATURE")
    modifier.object = top.parent
    return cowl


def split_ears(body: bpy.types.Object) -> bpy.types.Object:
    """Moves the ears into their own mesh, so the head scarf's look can hide them.

    The head keeps a patch of skin where each ear was, so there is no hole to
    see into when the ears are hidden.
    """
    index = body.vertex_groups["ears"].index
    ears = duplicate(body, "player_ear_pair")
    keep_vertices(ears, lambda vertex, layer: group_weight(vertex, layer, index) > 0)

    mesh = bmesh.new()
    mesh.from_mesh(body.data)
    bridge_ears(mesh, index)
    mesh.to_mesh(body.data)
    mesh.free()
    body.data.update()
    return ears


def lighten_body(body: bpy.types.Object, head: Head, knee: float, detail: float = 0.34) -> bpy.types.Object:
    """Drops skin no look ever shows and thins the hands, which the camera never studies, to detail of their faces."""
    # Rings of ankle skin are left between the shoes' and the trousers' masks,
    # under the socks. The hands are well above the knees while the arms are raised.
    keep_vertices(body, lambda vertex, layer: vertex.co.z > knee)
    # The hands are separate pieces of the mesh, so they can be thinned on
    # their own and the face and neck keep every vertex.
    hands = duplicate(body, "hands")
    keep_vertices(hands, lambda vertex, layer: vertex.co.z < head.shoulders)
    simplify(hands, detail)
    forget_base_vertices(hands)  # Thinning merges vertices, and no expression reaches the hands.
    keep_vertices(body, lambda vertex, layer: vertex.co.z >= head.shoulders)
    return join([body, hands], body.name)


# -----------------------------------------------------------------------------
# Build


def build_player(mpfb: dict) -> dict[str, bpy.types.Object]:
    body = build_body(mpfb)
    rig = mpfb["HumanService"].add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = rig.data.name = "player_rig"
    expressions = capture_expressions(mpfb, body, rig, CHILD_TARGETS, FACE_UNITS)

    eyes = add_part(mpfb, body, EYES)
    brows = add_part(mpfb, body, BROWS)
    lashes = add_part(mpfb, body, LASHES)
    follow_base_mesh(mpfb, expressions, brows, BROWS)
    follow_base_mesh(mpfb, expressions, lashes, LASHES)
    hair_boy = add_part(mpfb, body, HAIR_BOY)
    hair_girl = add_part(mpfb, body, HAIR_GIRL)
    suit = add_part(mpfb, body, SUIT)
    shoes = add_part(mpfb, body, SHOES)

    # The skirt and the leggings under it come from the base mesh's own garment
    # helpers, before those are dropped: knee length, tucked under the top's hem.
    hip = rig.data.bones["thigh_l"].head_local.z
    knee = rig.data.bones["calf_l"].head_local.z
    skirt = helper_garment(body, "player_skirt", "helper-skirt", knee - 0.01, hip + 0.03)
    flare(skirt, hip + 0.03, knee - 0.01, 0.2)
    tights = helper_garment(body, "player_skirt_leggings", "helper-tights", 0.0, hip + 0.05)

    visible_skin(body)

    # The suit is one mesh of two garments; the shoes come with their socks.
    garments = sorted(separate_loose(suit), key=lambda obj: world_z_range(obj)[1])
    if len(garments) != 2:
        raise SystemExit(f"Expected the suit to split into trousers and a top, got {len(garments)} parts")
    trousers, top = garments
    footwear = sorted(separate_loose(shoes), key=lambda obj: len(obj.data.vertices))
    if len(footwear) != 4:
        raise SystemExit(f"Expected two shoes and two socks, got {len(footwear)} parts")
    socks = join(footwear[:2], "player_socks")
    shoes = join(footwear[2:], "player_shoes")
    # The leggings stop just inside the socks' tops, so neither shows through the other.
    leggings = tights
    bisect(leggings, (0.0, 0.0, world_z_range(socks)[1] - 0.008), (0.0, 0.0, 1.0))
    head = measure_head(rig, body, eyes, brows, top)
    print(f"Child: {(world_z_range(body)[1] - world_z_range(shoes)[0]) / (head.crown - head.chin):.2f} heads tall")

    parts = {
        "player_body": body,
        "player_eyes": eyes,
        "player_brows": brows,
        "player_lashes": lashes,
        "player_hair_boy_short": hair_boy,
        "player_hair_girl_long": hair_girl,
        "player_bare_hair_boy_short": split_at_brim(head, hair_boy, "player_bare_hair_boy_short"),
        "player_bare_hair_girl_long": split_at_brim(
            head, hair_girl, "player_bare_hair_girl_long", shape=lambda hair: fill_out_crown(head, hair, body),
        ),
        "player_top": top,
        "player_trousers": trousers,
        "player_skirt": skirt,
        "player_skirt_leggings": leggings,
        "player_socks": socks,
        "player_shoes": shoes,
        **build_headwear(head, body, top),
    }
    parts["player_ear_pair"] = ears = split_ears(body)
    parts["player_body"] = body = lighten_body(body, head, knee)
    tuck_mouth_lining(body)
    # Small on screen and simple in shape: half the faces lose nothing visible.
    for obj in (ears, shoes, leggings):
        simplify(obj, 0.5)
    for name, obj in parts.items():
        obj.name = obj.data.name = name
        strip_modifiers(obj)

    clothes_map = clothes_texture(mpfb, top, trousers)
    skin = make_material("Player Skin", SKIN_HEX, texture=skin_texture(mpfb, body, ears, plain_eyelids=eyes), roughness=0.62)
    assign(body, skin)
    assign(ears, skin)
    line_mouth(body, mouth_material("Player Mouth"))
    assign(eyes, make_material("Player Eyes", "#ffffff", texture=eye_texture(mpfb), roughness=0.25))
    assign(brows, make_material("Player Brows", "#ffffff", texture=tinted_alpha_texture(mpfb, BROWS, "player-brows", "#3a2820"), roughness=0.9, alpha="BLEND"))
    assign(lashes, make_material("Player Lashes", "#ffffff", texture=tinted_alpha_texture(mpfb, LASHES, "player-lashes", "#241a16"), roughness=0.9, alpha="BLEND"))
    for gender, source, style in (("boy", HAIR_BOY, "short"), ("girl", HAIR_GIRL, "long")):
        strands = make_material(
            f"Player Hair {gender.title()}", "#ffffff", texture=hair_texture(mpfb, source, f"player-hair-{gender}"),
            roughness=0.8, alpha="CLIP", double_sided=True,
        )
        assign(parts[f"player_hair_{gender}_{style}"], strands)
        assign(parts[f"player_bare_hair_{gender}_{style}"], strands)
    assign(top, make_material("Player Teal", TOP_HEX, texture=clothes_map, roughness=0.85))
    assign(trousers, make_material("Player Coral", TROUSERS_HEX, texture=clothes_map, roughness=0.85))
    assign(skirt, make_material("Player Skirt", TOP_DARK_HEX, roughness=0.85, double_sided=True))
    assign(leggings, make_material("Player Leggings", TROUSERS_HEX, roughness=0.8))
    assign(socks, make_material("Player Sock", SOCK_HEX, roughness=0.9))
    # Plain sneakers in the outfit's accent with a pale sole: no texture, so no brand marks.
    assign(shoes, make_material("Player Shoes", ACCENT_HEX, roughness=0.7))
    sole_top = world_z_range(shoes)[0] + 0.02
    split_material(shoes, make_material("Player Sole", SOLE_HEX, roughness=0.8), lambda center: center.z < sole_top)

    accent, accent_dark = make_material("Player Gold", ACCENT_HEX, roughness=0.9), make_material("Player Gold Dark", ACCENT_DARK_HEX, roughness=0.9)
    assign(parts["player_beanie_knit"], accent)
    split_material(parts["player_beanie_knit"], accent_dark, lambda center: head.above_brim(center) < head.cuff_height)
    scarf = make_material("Player Scarf", ACCENT_HEX, roughness=0.9, double_sided=True)
    assign(parts["player_scarf_wrap"], scarf)
    assign(parts["player_scarf_drape"], scarf)

    return {"rig": rig, "expressions": expressions, **parts}


# -----------------------------------------------------------------------------
# Pose and animation
#
# Joint angles are written as rotations about the armature's axes (X: left,
# -Y: forward, Z: up), each applied in the frame its parent has already turned
# the joint into. With the limbs hanging down that makes X the flexion axis:
# a positive X angle carries a hanging limb backward or leans the trunk forward.

FPS = 30


def turn(bone: bpy.types.PoseBone, *rotations: tuple[str, float]) -> None:
    """Poses a bone by (axis, degrees) rotations about armature axes, applied in order."""
    world = Matrix.Identity(3)
    for axis, degrees in rotations:
        world = Matrix.Rotation(math.radians(degrees), 3, axis) @ world
    rest = bone.bone.matrix_local.to_3x3()
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = (rest.inverted() @ world @ rest).to_quaternion()


def aim(bone: bpy.types.PoseBone, direction: tuple[float, float, float], parent_turn: Matrix | None = None) -> Matrix:
    """Points a bone along an armature-space direction by the shortest turn.

    parent_turn is what aim() returned for the bone's parent, if that was aimed
    too. Returns this bone's own accumulated turn, for aiming its children.
    """
    parent_turn = parent_turn or Matrix.Identity(3)
    rest = bone.bone.matrix_local.to_3x3()
    rest_direction = (bone.bone.tail_local - bone.bone.head_local).normalized()
    target = parent_turn.inverted() @ Vector(direction).normalized()
    world = rest_direction.rotation_difference(target).to_matrix()
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = (rest.inverted() @ world @ rest).to_quaternion()
    return parent_turn @ world


def shift(bone: bpy.types.PoseBone, offset: tuple[float, float, float]) -> None:
    """Moves a bone by an armature-space offset in meters."""
    bone.location = bone.bone.matrix_local.to_3x3().inverted() @ Vector(offset)


def apply_pose_as_rest(rig: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    """Bakes the current pose into the meshes and makes it the skeleton's rest pose."""
    for obj in meshes:
        select_only(obj)
        for modifier in [item for item in obj.modifiers if item.type == "ARMATURE"]:
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    select_only(rig)
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in meshes:
        modifier = obj.modifiers.new("Armature", "ARMATURE")
        modifier.object = rig


FINGERS = ("index", "middle", "ring", "pinky")


def relax_rest_pose(rig: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    """Turns MakeHuman's A-pose into a relaxed stand and makes that the rest pose.

    The model then stands naturally wherever it is shown without an animation,
    and the clips below are small motions around a believable pose.
    """
    bones = rig.pose.bones
    # The arms hang with a soft bend at the elbow, held far enough out that the
    # forearms and hands clear the round of the top and the hips below it
    # (check_clearance() measures the gap). The feet come a little closer.
    for side, sign in (("l", 1.0), ("r", -1.0)):
        upper = aim(bones[f"upperarm_{side}"], (sign * 0.58, 0.03, -1.0))
        aim(bones[f"lowerarm_{side}"], (sign * 0.17, -0.2, -1.0), upper)
        turn(bones[f"thigh_{side}"], ("Y", sign * 3.0))
        turn(bones[f"foot_{side}"], ("Y", sign * -3.0))
    apply_pose_as_rest(rig, meshes)

    # With the arms down, armature Y is the axis the fingers curl around.
    for side, sign in (("l", 1.0), ("r", -1.0)):
        for finger in FINGERS:
            for joint, curl in (("01", 16.0), ("02", 20.0), ("03", 12.0)):
                turn(bones[f"{finger}_{joint}_{side}"], ("Y", sign * curl))
    apply_pose_as_rest(rig, meshes)


def reset_pose(rig: bpy.types.Object) -> None:
    for bone in rig.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        bone.location = (0.0, 0.0, 0.0)


def new_clip(rig: bpy.types.Object, name: str) -> bpy.types.Action:
    reset_pose(rig)
    rig.animation_data_create()
    action = bpy.data.actions.new(name)
    rig.animation_data.action = action
    return action


def key(rig: bpy.types.Object, frame: int, names: tuple[str, ...], *, location: tuple[str, ...] = ()) -> None:
    for name in names:
        rig.pose.bones[name].keyframe_insert("rotation_quaternion", frame=frame)
    for name in location:
        rig.pose.bones[name].keyframe_insert("location", frame=frame)


def finish_clip(rig: bpy.types.Object, action: bpy.types.Action) -> None:
    """Parks the clip on its own NLA track; the exporter writes one animation per track."""
    for curve in action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
    track = rig.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, 1, action)
    # Parked clips stay silent, so the rig rests, and plays one clip alone, while it is checked and rendered.
    track.mute = True
    rig.animation_data.action = None
    reset_pose(rig)


# The walk: an easy child's walk in place, built from where the feet are on the
# ground rather than from joint angles. While a foot is down it stays exactly
# where it landed as the body travels over it, so at WALK_SPEED nothing slides.
WALK_FRAMES = 16  # One stride (two steps) in 0.53 s at 30 fps: a small child's quick, short steps.
# Meters per second the walk covers at the child's natural height. The model is
# enlarged for the playroom after it is animated (see PLAYROOM_HEIGHT), and its
# walk speed grows with it; the exported file records the result as the rig's
# walk_speed, which the realistic player's moveSpeed in src/player-avatar.ts
# must equal (tests/player-avatar.test.ts checks that it does).
WALK_SPEED = 1.45
STANCE = 0.6  # Share of the stride each foot spends on the ground.
HEEL_ROCKER, TOE_ROCKER = 0.12, 0.55  # Stance shares where the foot lies flat between them.
HEEL_STRIKE_PITCH, TOE_OFF_PITCH = -14.0, 30.0  # Degrees; positive points the toes down.
STEP_CLEARANCE = 0.045  # How high the ankle lifts in mid swing, in meters.
PELVIS_BOB = 0.01
PELVIS_SWAY = 0.012

LEG_BONES = ("thigh", "calf", "foot")
ARM_BONES = ("upperarm", "lowerarm")
TRUNK_BONES = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head")


def limb_names(bones: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(f"{bone}_{side}" for bone in bones for side in ("l", "r"))


@dataclass(frozen=True)
class Leg:
    """A leg seen from the side, measured from the rest pose: meters, and radians of forward lean."""

    hip_height: float
    thigh: float
    shin: float
    thigh_lean: float
    shin_lean: float
    ankle_ahead: float  # How far in front of the hip the ankle rests.
    ankle_height: float
    toe_ahead: float  # From the ankle forward to the tip of the shoe.
    heel_behind: float  # From the ankle back to the heel.


def measure_leg(rig: bpy.types.Object, side: str = "l") -> Leg:
    bones = rig.data.bones
    hip, knee, ankle = (bones[f"{name}_{side}"].head_local for name in ("thigh", "calf", "foot"))
    ball = bones[f"foot_{side}"].tail_local

    def lean(upper: Vector, lower: Vector) -> float:
        return math.atan2(upper.y - lower.y, upper.z - lower.z)  # Forward is -y.

    ball_ahead = ankle.y - ball.y  # The foot bone runs from the ankle to the ball of the foot.
    return Leg(
        hip_height=hip.z,
        thigh=math.hypot(knee.y - hip.y, knee.z - hip.z),
        shin=math.hypot(ankle.y - knee.y, ankle.z - knee.z),
        thigh_lean=lean(hip, knee),
        shin_lean=lean(knee, ankle),
        ankle_ahead=hip.y - ankle.y,
        ankle_height=ankle.z,
        toe_ahead=1.45 * ball_ahead,
        heel_behind=0.4 * ball_ahead,
    )


def pitched(ahead: float, up: float, degrees: float) -> tuple[float, float]:
    """A point of the foot, given ahead of and above its pivot, after the foot pitches toes-down."""
    angle = math.radians(degrees)
    return (ahead * math.cos(angle) + up * math.sin(angle), -ahead * math.sin(angle) + up * math.cos(angle))


def ease(share: float) -> float:
    return share * share * (3.0 - 2.0 * share)


def foot_placement(leg: Leg, phase: float) -> tuple[float, float, float]:
    """Where one ankle is at a phase (0..1) of its stride: meters ahead of the hip, meters up, and pitch.

    The stride starts at this foot's heel strike. The body moves forward at
    WALK_SPEED, so a point resting on the ground drifts backward under it.
    """
    stride = WALK_SPEED * WALK_FRAMES / FPS
    travel = stride * STANCE  # How far the ground passes while the foot is down.
    # The heel lands far enough ahead that the ankle is under the hip mid stance.
    heel_landing = leg.ankle_ahead + 0.42 * travel - leg.heel_behind

    def stance(share: float) -> tuple[float, float, float]:
        ground = heel_landing - travel * share  # Where the heel's landing spot is now.
        if share < HEEL_ROCKER:
            # The foot lands on its heel and rolls flat around it.
            pitch = HEEL_STRIKE_PITCH * (1.0 - share / HEEL_ROCKER)
            ahead, up = pitched(leg.heel_behind, leg.ankle_height, pitch)
            return (ground + ahead, up, pitch)
        if share < TOE_ROCKER:
            return (ground + leg.heel_behind, leg.ankle_height, 0.0)
        # The heel lifts and the foot rolls over its toe, which stays where it is.
        pitch = TOE_OFF_PITCH * ease((share - TOE_ROCKER) / (1.0 - TOE_ROCKER))
        ahead, up = pitched(-leg.toe_ahead, leg.ankle_height, pitch)
        return (ground + leg.heel_behind + leg.toe_ahead + ahead, up, pitch)

    if phase < STANCE:
        return stance(phase / STANCE)
    # Swing: the foot lifts and travels from where it left the ground to its next landing.
    share = (phase - STANCE) / (1.0 - STANCE)
    left_ahead, left_up, left_pitch = stance(1.0)
    land_ahead, land_up, land_pitch = stance(0.0)
    glide = ease(share)
    return (
        left_ahead + (land_ahead - left_ahead) * glide,
        left_up + (land_up - left_up) * glide + STEP_CLEARANCE * math.sin(math.pi * share),
        left_pitch + (land_pitch - left_pitch) * ease(min(share / 0.7, 1.0)),
    )


def hip_height(leg: Leg, phase: float) -> float:
    """The hips ride lowest as a heel lands and highest as the body passes over the standing foot."""
    ahead, up, _ = foot_placement(leg, 0.0)
    reach = 0.992 * (leg.thigh + leg.shin)  # The leading leg lands almost straight.
    lowest = up + math.sqrt(reach * reach - ahead * ahead)
    return lowest + PELVIS_BOB * (1.0 - math.cos(4.0 * math.pi * phase))


def leg_angles(leg: Leg, hip: float, ahead: float, up: float) -> tuple[float, float]:
    """Two-bone IK in the side view: the thigh's and shin's forward lean (radians) that put the ankle there."""
    drop = hip - up
    distance = min(math.hypot(ahead, drop), 0.999 * (leg.thigh + leg.shin))
    line = math.atan2(ahead, drop)
    at_hip = math.acos((leg.thigh ** 2 + distance ** 2 - leg.shin ** 2) / (2.0 * leg.thigh * distance))
    at_knee = math.acos((leg.thigh ** 2 + leg.shin ** 2 - distance ** 2) / (2.0 * leg.thigh * leg.shin))
    thigh_lean = line + at_hip  # The knee bends forward of the hip-to-ankle line.
    return thigh_lean, thigh_lean - (math.pi - at_knee)


def animate_walk(rig: bpy.types.Object) -> None:
    action = new_clip(rig, "walk")
    bones = rig.pose.bones
    leg = measure_leg(rig)
    for frame in range(WALK_FRAMES + 1):
        phase = frame / WALK_FRAMES
        hip = hip_height(leg, phase)
        # The body leans over whichever foot is carrying it: the left at phase 0.3.
        sway = PELVIS_SWAY * math.cos(2.0 * math.pi * (phase - 0.3))
        shift(bones["pelvis"], (sway, 0.0, hip - leg.hip_height))

        for side, sign, offset in (("l", 1.0, 0.0), ("r", -1.0, 0.5)):
            ahead, up, pitch = foot_placement(leg, (phase + offset) % 1.0)
            thigh_lean, shin_lean = leg_angles(leg, hip, ahead, up)
            # A positive turn about X carries a hanging limb backward.
            thigh = -math.degrees(thigh_lean - leg.thigh_lean)
            shin = -math.degrees(shin_lean - leg.shin_lean)
            # The legs tilt against the sway, so the feet stay under their own tracks.
            tilt = math.degrees(math.atan2(sway, hip))
            turn(bones[f"thigh_{side}"], ("X", thigh), ("Y", tilt))
            turn(bones[f"calf_{side}"], ("X", shin - thigh))
            # The foot undoes the leg's turns in reverse, then takes its own pitch.
            turn(bones[f"foot_{side}"], ("X", pitch), ("Y", -tilt), ("X", -shin))

            # Arms swing gently against the legs, the elbow easing as the arm comes forward.
            reach = -math.cos(2.0 * math.pi * (phase + offset))  # +1: this arm is fully forward.
            turn(bones[f"upperarm_{side}"], ("X", -13.0 * reach + 2.0))
            turn(bones[f"lowerarm_{side}"], ("X", -(11.0 + 6.0 * reach)))

        twist = math.cos(2.0 * math.pi * phase)  # The shoulders turn a little against the hips.
        turn(bones["spine_01"], ("X", 1.5))
        turn(bones["spine_02"], ("Z", 1.6 * twist))
        turn(bones["spine_03"], ("Z", 1.6 * twist))
        turn(bones["neck_01"], ("X", -0.8), ("Z", -1.6 * twist))
        turn(bones["head"], ("X", -0.7), ("Z", -1.6 * twist))
        key(rig, frame + 1, limb_names(LEG_BONES) + limb_names(ARM_BONES) + TRUNK_BONES, location=("pelvis",))
    finish_clip(rig, action)


def check_walk(rig: bpy.types.Object) -> float:
    """Plays the walk and returns how far a planted foot slides, in meters.

    Measured on the posed skeleton: while the foot lies flat, the ankle should
    move backward under the body at exactly WALK_SPEED.
    """
    scene = bpy.context.scene
    rig.animation_data.action = bpy.data.actions["walk"]
    flat_start, flat_end = HEEL_ROCKER * STANCE, TOE_ROCKER * STANCE
    spots = []
    for frame in range(WALK_FRAMES + 1):
        phase = frame / WALK_FRAMES
        if not flat_start <= phase <= flat_end:
            continue
        scene.frame_set(frame + 1)
        ankle = rig.pose.bones["foot_l"].head
        # Where on the ground the ankle is, with the body's travel added back.
        spots.append((-ankle.y + WALK_SPEED * frame / FPS, ankle.x, ankle.z))
    rig.animation_data.action = None
    reset_pose(rig)
    scene.frame_set(1)
    return max(max(spot[axis] for spot in spots) - min(spot[axis] for spot in spots) for axis in range(3))


IDLE_FRAMES = 120  # a 4 s loop


def animate_idle(rig: bpy.types.Object) -> None:
    """Standing still: breathing, a slow weight shift, and a small head turn."""
    action = new_clip(rig, "idle")
    bones = rig.pose.bones
    for frame in range(0, IDLE_FRAMES + 1, 3):
        cycle = 2.0 * math.pi * frame / IDLE_FRAMES
        breath = math.sin(2.0 * cycle)  # two breaths per loop
        drift = math.sin(cycle)
        turn(bones["pelvis"], ("Z", 1.2 * drift), ("Y", 0.8 * drift))
        shift(bones["pelvis"], (0.006 * drift, 0.0, -0.002 * (1.0 - math.cos(2.0 * cycle))))
        # The legs counter the pelvis so the feet stay planted.
        for side in ("l", "r"):
            turn(bones[f"thigh_{side}"], ("Z", -1.2 * drift), ("Y", -0.8 * drift))
            turn(bones[f"upperarm_{side}"], ("X", 1.5 * breath + 1.0 * drift))
            turn(bones[f"lowerarm_{side}"], ("X", -2.0 - 1.5 * breath))
        turn(bones["spine_01"], ("X", -0.5 * breath))
        turn(bones["spine_02"], ("X", -0.9 * breath), ("Z", -0.6 * drift))
        turn(bones["spine_03"], ("X", -0.9 * breath), ("Z", -0.6 * drift))
        turn(bones["neck_01"], ("X", 0.6 * breath), ("Z", 2.0 * math.sin(cycle + 0.6)))
        turn(bones["head"], ("X", 0.8 * breath - 1.0), ("Z", 3.0 * math.sin(cycle + 0.6)), ("Y", 1.2 * drift))
        key(rig, frame + 1, limb_names(("thigh",)) + limb_names(ARM_BONES) + TRUNK_BONES, location=("pelvis",))
    finish_clip(rig, action)


# -----------------------------------------------------------------------------
# Emotions: the body
#
# Each emotion has one clip, named for it, that holds the emotion's posture and
# keeps it alive: a loop in place, like the idle. The game fades from the idle
# into it and back, so no clip has to begin or end in the relaxed stand. The
# face is not in the clip: it is the morph target of the same name (see
# Expressions), so the game can show a face alone or a face with its body.
#
# The tone is a young child's and stays gentle: anger is stiff arms and a small
# stamp, never a raised hand, and fear is shrinking back with the hands held
# close, never terror.


@dataclass(frozen=True)
class Foot:
    """Where a foot is, measured from where it rests: meters forward and up, and degrees its toes point down."""

    ahead: float = 0.0
    up: float = 0.0
    pitch: float = 0.0


def stand_over_feet(
    rig: bpy.types.Object,
    legs: dict[str, Leg],
    *,
    hips: tuple[float, float, float] = (0.0, 0.0, 0.0),
    feet: dict[str, Foot] | None = None,
) -> None:
    """Poses the pelvis and the legs so the body moves over feet that stay where they are.

    The pelvis moves by hips: meters toward +X, forward, and up. Each leg is
    solved from its ankle, as the walk's are, so a foot only moves if feet
    says so.
    """
    bones = rig.pose.bones
    across, forward, rise = hips
    shift(bones["pelvis"], (across, -forward, rise))
    for side, leg in legs.items():
        foot = (feet or {}).get(side, Foot())
        hip = leg.hip_height + rise
        thigh_lean, shin_lean = leg_angles(leg, hip, leg.ankle_ahead + foot.ahead - forward, leg.ankle_height + foot.up)
        thigh = -math.degrees(thigh_lean - leg.thigh_lean)
        shin = -math.degrees(shin_lean - leg.shin_lean)
        # The legs tilt against a shift to the side, so the feet stay under their own tracks.
        tilt = math.degrees(math.atan2(across, hip))
        turn(bones[f"thigh_{side}"], ("X", thigh), ("Y", tilt))
        turn(bones[f"calf_{side}"], ("X", shin - thigh))
        # The foot undoes the leg's turns in reverse, then takes its own pitch.
        turn(bones[f"foot_{side}"], ("X", foot.pitch), ("Y", -tilt), ("X", -shin))


Direction = tuple[float, float, float]


class Puppet:
    """A rig being posed for one frame of an emotion: the few moves the postures are made of.

    Directions and angles follow this section's conventions, and whatever is
    written for a side is written for the left one (+X): the right mirrors it.
    """

    def __init__(self, rig: bpy.types.Object) -> None:
        self.rig = rig
        self.bones = rig.pose.bones
        self.legs = {side: measure_leg(rig, side) for side in ("l", "r")}

    def stand(self, across: float = 0.0, forward: float = 0.0, rise: float = 0.0, **feet: Foot) -> None:
        """Moves the hips, in meters, over the feet; l= and r= move a foot."""
        stand_over_feet(self.rig, self.legs, hips=(across, forward, rise), feet=feet)

    def trunk(self, lean: float = 0.0, twist: float = 0.0, tilt: float = 0.0) -> None:
        """Bends the spine, in degrees over its whole length: forward, turned toward the left, and tipped toward the left."""
        for bone, share in (("spine_01", 0.25), ("spine_02", 0.35), ("spine_03", 0.4)):
            turn(self.bones[bone], ("X", lean * share), ("Y", tilt * share), ("Z", twist * share))

    def head(self, nod: float = 0.0, look: float = 0.0, tilt: float = 0.0) -> None:
        """Turns the head on the neck, in degrees: chin down, toward the left, and tipped toward the left shoulder."""
        for bone, share in (("neck_01", 0.4), ("head", 0.6)):
            turn(self.bones[bone], ("X", nod * share), ("Y", tilt * share), ("Z", look * share))

    def shoulders(self, lift: float, left: float | None = None) -> None:
        """Raises the shoulders by degrees; left raises that one by its own amount."""
        for side, sign, degrees in (("l", 1.0, lift if left is None else left), ("r", -1.0, lift)):
            turn(self.bones[f"clavicle_{side}"], ("Y", -sign * degrees))

    def arm(self, side: str, upper: Direction, lower: Direction) -> None:
        """Points one arm's upper arm and forearm along directions given relative to the chest."""
        sign = 1.0 if side == "l" else -1.0
        turned = aim(self.bones[f"upperarm_{side}"], (sign * upper[0], upper[1], upper[2]))
        aim(self.bones[f"lowerarm_{side}"], (sign * lower[0], lower[1], lower[2]), turned)

    def arms(self, upper: Direction, lower: Direction) -> None:
        for side in ("l", "r"):
            self.arm(side, upper, lower)


def wave(phase: float, cycles: float = 1.0, lead: float = 0.0) -> float:
    """A sine through cycles turns of the loop, so the clip closes on itself."""
    return math.sin(2.0 * math.pi * (cycles * phase + lead))


def pose_anger(puppet: Puppet, phase: float) -> None:
    """Stiff and squared up: straight arms pushed down and back, the chin lowered, and a small stamp of one foot."""
    huff = wave(phase, 2.0)
    # The right foot lifts a little and comes down once in the loop.
    stamp = math.sin(math.pi * min(max((phase - 0.55) / 0.25, 0.0), 1.0))
    puppet.stand(forward=0.012, rise=-0.006 - 0.004 * stamp, r=Foot(up=0.035 * stamp, pitch=6.0 * stamp))
    puppet.trunk(lean=7.0 + 1.2 * huff)
    puppet.head(nod=13.0 - 1.0 * huff)
    puppet.shoulders(9.0 + 2.0 * huff)
    # A tremor of held tension runs through the arms.
    shake = 0.012 * wave(phase, 8.0)
    puppet.arm("l", (0.38 + shake, 0.22, -1.0), (0.38 + shake, 0.08, -1.0))
    puppet.arm("r", (0.38 - shake, 0.22, -1.0), (0.38 - shake, 0.08, -1.0))


def pose_disgust(puppet: Puppet, phase: float) -> None:
    """Keeping something nasty away: both hands push it off to one side while the head and chest turn and lean the other way."""
    refuse = wave(phase, 2.0)
    puppet.stand(across=0.02, forward=-0.025, rise=-0.008)
    puppet.trunk(lean=-5.0, twist=16.0, tilt=8.0)
    puppet.head(nod=-2.0, look=28.0 + 4.0 * refuse, tilt=6.0)
    puppet.shoulders(5.0)
    # The thing is low on the child's right: the right arm reaches out at it, and the left crosses the chest to join it.
    push = 0.04 * refuse
    puppet.arm("r", (0.75, -0.5, -0.35), (0.8, -0.5 + push, -0.05))
    puppet.arm("l", (-0.15, -0.9, -0.42), (-0.7, -0.68 + push, 0.12))


def pose_fear(puppet: Puppet, phase: float) -> None:
    """Shrinking back: a step away, the knees bent, the shoulders up, and both hands held close under the chin, trembling."""
    tremble = wave(phase, 6.0)
    breath = wave(phase, 1.0)
    puppet.stand(forward=-0.045, rise=-0.028 + 0.002 * breath, l=Foot(ahead=-0.07))
    puppet.trunk(lean=6.0 + 0.6 * tremble, twist=-4.0)
    puppet.head(nod=-3.0 + 0.5 * tremble, look=-3.0, tilt=-3.0)
    puppet.shoulders(15.0 + 1.0 * breath)
    quiver = 0.02 * tremble
    # The hands come close under the chin without touching each other.
    puppet.arms((0.38, -0.5, -0.8), (-0.26 + quiver, -0.68, 0.6))


def pose_happiness(puppet: Puppet, phase: float) -> None:
    """A little jump for joy with both arms thrown up."""
    # Half the loop is the hop; before and after it the knees give.
    air = math.sin(math.pi * min(max((phase - 0.3) / 0.45, 0.0), 1.0))
    crouch = 0.5 * (1.0 - math.cos(2.0 * math.pi * min(max(phase / 0.3, 0.0), 1.0))) if phase < 0.3 else (
        0.5 * (1.0 - math.cos(2.0 * math.pi * min(max((phase - 0.75) / 0.25, 0.0), 1.0))) if phase > 0.75 else 0.0
    )
    lift = 0.05 * air
    feet = Foot(up=lift, pitch=24.0 * air)
    puppet.stand(rise=lift - 0.022 * crouch, l=feet, r=feet)
    puppet.trunk(lean=-5.0 + 3.0 * crouch)
    puppet.head(nod=-8.0 + 3.0 * crouch, tilt=3.0 * wave(phase))
    puppet.shoulders(10.0)
    pump = 0.1 * air
    puppet.arms((0.62, -0.1, 0.78 + pump), (0.28, -0.12, 1.0))


def pose_sadness(puppet: Puppet, phase: float) -> None:
    """Drooping: the head hangs, the shoulders round forward, and the arms fall limp."""
    sigh = wave(phase, 1.0)
    sway = wave(phase, 1.0, 0.25)
    puppet.stand(across=0.004 * sway, rise=-0.012 - 0.003 * sigh)
    puppet.trunk(lean=13.0 + 1.5 * sigh, tilt=1.0 * sway)
    # Bowed, but not so far that the face is lost from the playroom's camera above.
    puppet.head(nod=19.0 + 1.5 * sigh, look=3.0 * sway, tilt=4.0)
    puppet.shoulders(-5.0)
    # Limp arms hang straight down from the rounded shoulders, in front of the body.
    puppet.arms((0.68, -0.36, -1.0), (0.52, -0.5, -1.0))


def pose_surprise(puppet: Puppet, phase: float) -> None:
    """Caught off guard: rocked back on the heels with both hands flown up and out, held."""
    breath = wave(phase, 2.0)
    settle = wave(phase, 1.0)
    puppet.stand(forward=-0.022, rise=0.004 + 0.002 * breath)
    puppet.trunk(lean=-7.0 - 0.6 * breath)
    puppet.head(nod=-6.0, look=1.5 * settle)
    puppet.shoulders(12.0 + 1.0 * breath)
    puppet.arms((0.95, -0.2, -0.5), (0.6, -0.45, 0.62 + 0.03 * breath))


# Each emotion's clip: its length in frames and its pose at a phase (0..1) of the loop.
EMOTION_POSES = {
    "anger": (60, pose_anger),
    "disgust": (60, pose_disgust),
    "fear": (30, pose_fear),
    "happiness": (30, pose_happiness),
    "sadness": (90, pose_sadness),
    "surprise": (60, pose_surprise),
}
EMOTION_BONES = limb_names(LEG_BONES) + limb_names(("clavicle", *ARM_BONES)) + TRUNK_BONES


def animate_emotions(rig: bpy.types.Object) -> None:
    """Writes one clip per emotion, each a loop that holds the emotion's posture."""
    puppet = Puppet(rig)
    for name, (frames, pose) in EMOTION_POSES.items():
        action = new_clip(rig, name)
        for frame in range(frames + 1):
            reset_pose(rig)
            pose(puppet, frame / frames)
            key(rig, frame + 1, EMOTION_BONES, location=("pelvis",))
        finish_clip(rig, action)


def pose_at(rig: bpy.types.Object, clip: str | None, share: float = 0.0) -> None:
    """Holds the rig at a share (0..1) of a clip, or back at rest for None."""
    scene = bpy.context.scene
    if clip is None:
        rig.animation_data.action = None
        reset_pose(rig)
        scene.frame_set(1)
    else:
        action = bpy.data.actions[clip]
        rig.animation_data.action = action
        scene.frame_set(1 + round(share * (action.frame_range[1] - 1)))
    bpy.context.view_layer.update()


# -----------------------------------------------------------------------------
# Clearance: the hands and forearms must hang clear of the body

ARM_GROUPS = ("upperarm", "lowerarm", "hand", "index", "middle", "ring", "pinky", "thumb")
FOREARM_GROUPS = ARM_GROUPS[1:]
# What the hands could touch in each look.
BODY_PARTS = {
    "trousers": ("player_trousers",),
    "skirt": ("player_skirt", "player_skirt_leggings"),
}


def weight_share(obj: bpy.types.Object, rig: bpy.types.Object, prefixes: tuple[str, ...], side: str = "") -> list[float]:
    """For each vertex, the share of its skin weight that belongs to bones with these name prefixes.

    side narrows them to the bones of one side of the body, l or r.
    """
    # The meshes also carry vertex groups that are not bones; only bones move a vertex.
    bones = {group.index for group in obj.vertex_groups if group.name in rig.data.bones}
    chosen = {
        group.index for group in obj.vertex_groups
        if group.index in bones and group.name.startswith(prefixes) and group.name.endswith(f"_{side}" if side else "")
    }
    shares = []
    for vertex in obj.data.vertices:
        total = sum(item.weight for item in vertex.groups if item.group in bones)
        shares.append(sum(item.weight for item in vertex.groups if item.group in chosen) / total if total else 0.0)
    return shares


class Clearance:
    """Measures the gap between the child's hands and forearms and the rest of the body.

    The moving points are the skin of the hands and the cuffs and forearms of
    the sleeves. They are measured against the torso of the top and against
    whichever bottoms a look shows, on the posed, skinned meshes. body and top
    name the parts that carry the skin and the sleeves.
    """

    def __init__(self, rig: bpy.types.Object, player: dict[str, bpy.types.Object], *, body: str = "player_body", top: str = "player_top") -> None:
        self.player = player
        self.body, self.top = body, top
        body, top = player[body], player[top]
        self.hand_points = [index for index, share in enumerate(weight_share(body, rig, FOREARM_GROUPS)) if share > 0.5]
        # The head and neck, which a raised hand could reach.
        above = weight_share(body, rig, ("head", "neck"))
        self.head_faces = [
            polygon.index for polygon in body.data.polygons
            if all(above[index] > 0.5 for index in polygon.vertices)
        ]
        # Each arm by itself, skin and sleeve, for a pose that brings one near the other.
        self.arms: dict[str, dict[str, tuple[list[int], list[int]]]] = {}
        for side in ("l", "r"):
            self.arms[side] = {}
            for name, obj in ((self.body, body), (self.top, top)):
                share = weight_share(obj, rig, ARM_GROUPS, side)
                self.arms[side][name] = (
                    [index for index, part in enumerate(share) if part > 0.5],
                    [polygon.index for polygon in obj.data.polygons if all(share[index] > 0.5 for index in polygon.vertices)],
                )
        self.sleeve_points = [index for index, share in enumerate(weight_share(top, rig, FOREARM_GROUPS)) if share > 0.5]
        arm = weight_share(top, rig, ARM_GROUPS)
        self.torso_faces = [
            polygon.index for polygon in top.data.polygons
            if all(arm[index] < 0.2 for index in polygon.vertices)
        ]

    def measure(self, bottoms: tuple[str, ...], *, head: bool = False) -> tuple[float, str]:
        """The smallest gap in meters in the current pose, and what it is between.

        bottoms names the parts the look shows below the top; head also
        measures to the head and neck, for a pose that raises the hands. The
        gap is negative when something has sunk into the body.
        """
        dependency = bpy.context.evaluated_depsgraph_get()

        def posed(name: str) -> bpy.types.Mesh:
            return self.player[name].evaluated_get(dependency).data

        top = posed(self.top)
        surfaces = {"the top": BVHTree.FromPolygons(
            [vertex.co.copy() for vertex in top.vertices],
            [tuple(top.polygons[index].vertices) for index in self.torso_faces],
        )}
        prefix = self.body.rsplit("_", 1)[0] + "_"
        for name in bottoms:
            surfaces[name.replace(prefix, "the ").replace("_", " ")] = BVHTree.FromObject(self.player[name], dependency)
        body = posed(self.body)
        if head:
            surfaces["the head"] = BVHTree.FromPolygons(
                [vertex.co.copy() for vertex in body.vertices],
                [tuple(body.polygons[index].vertices) for index in self.head_faces],
            )
        movers = {
            "a hand": [body.vertices[index].co for index in self.hand_points],
            "a forearm": [top.vertices[index].co for index in self.sleeve_points],
        }

        smallest = (math.inf, "")
        for mover, points in movers.items():
            for part, surface in surfaces.items():
                for point in points:
                    location, normal, _, distance = surface.find_nearest(point)
                    inside = (point - location).dot(normal) < 0.0 and distance < 0.03
                    smallest = min(smallest, (-distance if inside else distance, f"{mover} and {part}"))
        return smallest


    def arms_apart(self) -> float:
        """The smallest gap in meters between one arm and the other in the current pose; negative when one has sunk into the other."""
        dependency = bpy.context.evaluated_depsgraph_get()
        posed = {name: self.player[name].evaluated_get(dependency).data for name in (self.body, self.top)}
        smallest = math.inf
        for mover, other in (("l", "r"), ("r", "l")):
            surfaces = [
                BVHTree.FromPolygons(
                    [vertex.co.copy() for vertex in posed[name].vertices],
                    [tuple(posed[name].polygons[index].vertices) for index in self.arms[other][name][1]],
                )
                for name in posed if self.arms[other][name][1]
            ]
            for name in posed:
                for index in self.arms[mover][name][0]:
                    point = posed[name].vertices[index].co
                    for surface in surfaces:
                        location, normal, _, distance = surface.find_nearest(point)
                        inside = (point - location).dot(normal) < 0.0 and distance < 0.03
                        smallest = min(smallest, -distance if inside else distance)
        return smallest


# The least gap, in meters, allowed between a hand or forearm and the body in any frame of any look.
MIN_CLEARANCE = 0.02
# An emotion may bring one arm near the other, but never into it: the least gap between them, in meters.
MIN_ARMS_APART = 0.003


def check_clearance(rig: bpy.types.Object, player: dict[str, bpy.types.Object]) -> dict[str, tuple[float, str]]:
    """The smallest arm-to-body gap, and where it is, while standing, through the idle, and through the walk."""
    scene = bpy.context.scene
    clearance = Clearance(rig, player)
    gaps: dict[str, tuple[float, str]] = {}

    def record(label: str) -> None:
        bpy.context.view_layer.update()
        for look, bottoms in BODY_PARTS.items():
            key = f"{label} in {look}"
            gaps[key] = min(gaps.get(key, (math.inf, "")), clearance.measure(bottoms))

    record("standing")
    for clip, frames in (("idle", range(1, IDLE_FRAMES + 2, 6)), ("walk", range(1, WALK_FRAMES + 2))):
        rig.animation_data.action = bpy.data.actions[clip]
        for frame in frames:
            scene.frame_set(frame)
            record(clip)
        rig.animation_data.action = None
        reset_pose(rig)
    scene.frame_set(1)
    return gaps


def emotion_gaps(rig: bpy.types.Object, clearance: Clearance, bottoms: tuple[str, ...]) -> dict[str, tuple[float, str]]:
    """The smallest gap between the arms and the body, head included, through each emotion's clip."""
    gaps: dict[str, tuple[float, str]] = {}
    for name, (frames, _) in EMOTION_POSES.items():
        for frame in range(0, frames, 3):
            pose_at(rig, name, frame / frames)
            gaps[name] = min(gaps.get(name, (math.inf, "")), clearance.measure(bottoms, head=True))
    pose_at(rig, None)
    return gaps


def emotion_arms_apart(rig: bpy.types.Object, clearance: Clearance) -> dict[str, float]:
    """The smallest gap between one arm and the other through each emotion's clip."""
    gaps: dict[str, float] = {}
    for name, (frames, _) in EMOTION_POSES.items():
        for frame in range(0, frames, 3):
            pose_at(rig, name, frame / frames)
            gaps[name] = min(gaps.get(name, math.inf), clearance.arms_apart())
    pose_at(rig, None)
    return gaps


# How far, in meters, a foot on the floor may slide during an emotion, and how far any foot may sink into the floor.
MAX_EMOTION_SLIDE = 0.003
MAX_FOOT_SINK = 0.002


def check_emotion_feet(rig: bpy.types.Object) -> dict[str, tuple[float, float]]:
    """Plays each emotion and returns how far a foot on the floor slides and how far a foot sinks, in meters.

    A clip may lift a foot (a stamp, a hop) or hold it somewhere else (a step
    back), but while a foot is down it must stay where it is, and it must
    never go through the floor.
    """
    floor = {side: (rig.data.bones[f"foot_{side}"].head_local.z, rig.data.bones[f"foot_{side}"].tail_local.z) for side in ("l", "r")}
    results: dict[str, tuple[float, float]] = {}
    for name, (frames, _) in EMOTION_POSES.items():
        slide = sink = 0.0
        down: dict[str, list[Vector]] = {"l": [], "r": []}
        for frame in range(frames + 1):
            pose_at(rig, name, frame / frames)
            for side in ("l", "r"):
                foot = rig.pose.bones[f"foot_{side}"]
                ankle, ball = floor[side]
                sink = max(sink, ankle - foot.head.z, ball - foot.tail.z)
                if abs(foot.head.z - ankle) < 0.002 and abs(foot.tail.z - ball) < 0.002:
                    down[side].append(foot.head.copy())
        for spots in down.values():
            slide = max([slide, *((spot - spots[0]).length for spot in spots)])
        results[name] = (slide, sink)
    pose_at(rig, None)
    return results


def report_faces(label: str, meshes: list[bpy.types.Object]) -> None:
    """Checks every emotion's face and fails if the mouth's dark lining shows through the skin around the mouth."""
    body = next(obj for obj in meshes if obj.name.endswith("_body"))
    hidden = set(inside_mouth(body))
    failed = []
    for name in FACES:
        show_face(meshes, name)
        bpy.context.view_layer.update()
        showing = lining_showing(body, hidden)
        print(f"{'PASS' if showing == 0 else 'FAIL'} {label} {name} face: the mouth's lining shows through the skin along {showing} sight lines")
        if showing:
            failed.append(name)
    show_face(meshes, None)
    bpy.context.view_layer.update()
    if failed:
        raise RuntimeError(f"{label}'s {' and '.join(failed)} face pushes the skin through the lining of the mouth")


def report_emotions(label: str, rig: bpy.types.Object, clearance: Clearance, looks: dict[str, tuple[str, ...]]) -> None:
    """Checks every emotion's clip and fails on a sliding or sinking foot, an arm too close to the body, or one arm in the other.

    looks maps a look's name to the parts it shows below the top.
    """
    failed = []
    for name, (slide, sink) in check_emotion_feet(rig).items():
        fine = slide <= MAX_EMOTION_SLIDE and sink <= MAX_FOOT_SINK
        print(f"{'PASS' if fine else 'FAIL'} {label} {name}: a foot on the floor slides {slide * 1000:.1f} mm and sinks {sink * 1000:.1f} mm at the most")
        if not fine:
            failed.append(f"a foot slides or sinks during {name}")
    for look, bottoms in looks.items():
        for name, (gap, where) in emotion_gaps(rig, clearance, bottoms).items():
            wears = f" in {look}" if look else ""
            print(f"{'PASS' if gap >= MIN_CLEARANCE else 'FAIL'} {label} arms {name}{wears}: {gap * 1000:.0f} mm at the closest, between {where}")
            if gap < MIN_CLEARANCE:
                failed.append(f"an arm comes within {MIN_CLEARANCE * 1000:.0f} mm of the body during {name}{wears}")
    for name, gap in emotion_arms_apart(rig, clearance).items():
        print(f"{'PASS' if gap >= MIN_ARMS_APART else 'FAIL'} {label} arms {name}: {gap * 1000:.0f} mm between one arm and the other at the closest")
        if gap < MIN_ARMS_APART:
            failed.append(f"one arm sinks into the other during {name}")
    if failed:
        raise RuntimeError(f"{label}: " + "; ".join(failed))


# Where in its loop each emotion is caught for a still picture.
EMOTION_STILLS = {"anger": 0.68, "disgust": 0.12, "fear": 0.25, "happiness": 0.52, "sadness": 0.25, "surprise": 0.12}


def render_emotions(rig: bpy.types.Object, meshes: list[bpy.types.Object], key: str, directory: Path) -> None:
    """Saves each emotion twice into directory: `<key>-<emotion>-face.png` and `<key>-<emotion>-body.png`.

    The face is the emotion's face alone, on the resting body, as the game
    shows it close up. The body is the face with the emotion's clip.
    `<key>-rest-*` is the resting child, for comparison. Call it after
    setup_preview_scene().
    """
    scene = bpy.context.scene
    render = scene.render
    size = (render.resolution_x, render.resolution_y)
    # Without it the preview's sky lights the inside of an open mouth.
    scene.eevee.use_raytracing = True
    skin = next(obj for obj in meshes if obj.name.endswith("_body"))
    height = world_z_range(skin)[1]
    face_height = height - 0.5 * (height - rig.data.bones["head"].head_local.z)
    for name in (None, *EMOTION_POSES):
        label = name or "rest"
        show_face(meshes, name)
        pose_at(rig, None)
        render.resolution_x, render.resolution_y = 480, 480
        shot(directory / f"{key}-{label}-face.png", 5.0, face_height, 0.62, 85.0, 0.02)
        pose_at(rig, name, EMOTION_STILLS[name] if name else 0.0)
        render.resolution_x, render.resolution_y = 480, 640
        shot(directory / f"{key}-{label}-body.png", 20.0, height * 0.58, height * 2.75, 60.0, 0.06)
    show_face(meshes, None)
    pose_at(rig, None)
    scene.eevee.use_raytracing = False
    render.resolution_x, render.resolution_y = size


# -----------------------------------------------------------------------------
# Export and validation


def ground(rig: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    """Rests the shoe soles on z=0, as the asset contract asks of every character."""
    lowest = min(world_z_range(obj)[0] for obj in meshes)
    rig.location.z -= lowest
    select_only(rig)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    for obj in meshes:
        select_only(obj)
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


# How tall the child stands in the playroom, in meters: the height of the rest
# of the cast. A real child of this build is shorter, so the finished model is
# enlarged as a whole, which keeps its young proportions.
PLAYROOM_HEIGHT = 1.38


def hatted_height(meshes: list[bpy.types.Object]) -> float:
    """The top of the child in the beanie, the look its height is defined in.

    The hair of a bare head stands a little taller than the knit that would
    press it down, and must not change how large the body is made.
    """
    return max(world_z_range(obj)[1] for obj in meshes if not obj.name.startswith("player_bare_"))


def enlarge(rig: bpy.types.Object, meshes: list[bpy.types.Object], factor: float) -> None:
    """Scales the finished, animated model about the floor under its feet."""
    scale = Matrix.Scale(factor, 4)
    for obj in meshes:
        obj.data.transform(scale, shape_keys=True)
        obj.data.update()
    rig.data.transform(scale)
    # A clip's turns hold at any size; the distances it moves the pelvis grow with the body.
    for action in bpy.data.actions:
        for curve in action.fcurves:
            if curve.data_path.endswith("location"):
                for point in curve.keyframe_points:
                    point.co.y *= factor
                    point.handle_left.y *= factor
                    point.handle_right.y *= factor


def export_model(rig: bpy.types.Object, meshes: list[bpy.types.Object], path: Path, *, walk_speed: float | None = None) -> None:
    """Writes a rigged model and its clips to a GLB.

    A model that walks carries one fact of its own: the ground speed its walk
    clip is built for, which the game must move it at. MPFB's own bookkeeping
    properties are dropped.
    """
    for obj in [rig, *meshes]:
        for name in list(obj.keys()):
            del obj[name]
    for obj in meshes:
        numbers = obj.data.attributes.get(BASE_VERTEX)
        if numbers:
            obj.data.attributes.remove(numbers)
    if walk_speed is not None:
        rig["walk_speed"] = round(walk_speed, 3)
    bpy.context.scene.render.fps = FPS
    for track in rig.animation_data.nla_tracks:
        track.mute = False
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for obj in meshes:
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        # Nothing but the skeleton deforms these meshes, and applying modifiers would drop the faces' shape keys.
        export_apply=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_skins=True,
        # The faces: one morph target per shape key, listing only the vertices
        # it moves. Their normals stay out of the file, where they would more
        # than double every face: the game works them out when it loads the
        # model (src/morph-normals.ts).
        export_morph=True,
        export_morph_normal=False,
        export_morph_tangent=False,
        export_try_sparse_sk=True,
        export_morph_animation=False,
        export_animations=True,
        # One animation per action. Exported this way, rather than by NLA track,
        # the exporter knows which joints a clip keys: it keeps those, a pose
        # held still included, and leaves out the joints the clip never touches.
        export_animation_mode="ACTIONS",
        export_optimize_animation_size=True,
        export_optimize_animation_keep_anim_armature=False,
        export_anim_single_armature=True,
        # Clips start at time zero, so a loop is exactly as long as its stride.
        export_anim_slide_to_zero=True,
    )


# -----------------------------------------------------------------------------
# Preview


VIEWS = (
    # name, camera angle around the child (0 = front), then the look-at height and
    # the camera's distance as multiples of the child's height, the lens, and how
    # far the camera rises above what it looks at, as a share of its distance
    ("front", 0.0, 0.5, 3.0, 60.0, 0.08),
    ("threeq", 35.0, 0.5, 3.0, 60.0, 0.08),
    ("side", 90.0, 0.5, 3.0, 60.0, 0.08),
    ("back", 180.0, 0.5, 3.0, 60.0, 0.08),
    ("face", 12.0, 0.87, 1.15, 70.0, 0.08),
    ("profile", 90.0, 0.87, 1.15, 70.0, 0.08),
    ("nape", 168.0, 0.87, 1.15, 70.0, 0.08),
    # From above and behind, as the playroom's camera sees the child.
    ("crown", 180.0, 0.87, 1.15, 70.0, 0.6),
    ("above", 25.0, 0.87, 1.15, 70.0, 0.6),
)


def setup_preview_scene(height: float) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 860
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("Preview World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.52, 0.56, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6

    def area_light(name: str, location: tuple[float, float, float], energy: float, size: float) -> None:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.size = size
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = location
        obj.rotation_euler = (Vector((0, 0, height * 0.6)) - obj.location).to_track_quat("-Z", "Y").to_euler()

    area_light("Key Light", (-2.0, -3.0, 3.0), 260.0, 3.0)
    area_light("Fill Light", (2.5, -2.0, 1.5), 120.0, 3.0)
    area_light("Rim Light", (0.5, 3.0, 2.5), 200.0, 2.0)

    camera_data = bpy.data.cameras.new("Preview Camera")
    camera = bpy.data.objects.new("Preview Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera


def shot(path: Path, angle: float, target_z: float, distance: float, lens: float, rise: float = 0.08) -> None:
    scene = bpy.context.scene
    camera = scene.camera
    camera.data.lens = lens
    radians = math.radians(angle)
    camera.location = (math.sin(radians) * distance, -math.cos(radians) * distance, target_z + distance * rise)
    camera.rotation_euler = (Vector((0, 0, target_z)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


LOOKS = (
    # label, gender, bottoms, headwear
    ("boy", "boy", "trousers", "beanie"),
    ("girl", "girl", "skirt", "beanie"),
    ("scarf", "girl", "skirt", "scarf"),
    ("boy-bare", "boy", "trousers", "bare"),
    ("girl-bare", "girl", "skirt", "bare"),
)
VARIANT_PREFIXES = ("player_hair_", "player_bare_", "player_trousers", "player_skirt", "player_beanie_", "player_scarf_", "player_ear_")


def show_look(player: dict[str, bpy.types.Object], gender: str, bottoms: str, headwear: str) -> None:
    """Shows one look's part sets for a render, as applyPlayerLook does at runtime."""
    for name, obj in player.items():
        if not name.startswith(VARIANT_PREFIXES):
            continue
        if name.startswith("player_bare_"):
            # The hair a hat would cover.
            keep = headwear == "bare" and name.startswith(f"player_bare_hair_{gender}_")
        elif name.startswith("player_hair_"):
            keep = headwear != "scarf" and name.startswith(f"player_hair_{gender}_")
        elif name.startswith("player_ear_"):
            # The head scarf covers the ears as well as the hair.
            keep = headwear != "scarf"
        else:
            keep = name.startswith((f"player_{bottoms}", f"player_{headwear}_"))
        obj.hide_render = not keep


def render_preview(player: dict[str, bpy.types.Object], height: float, directory: Path | None) -> None:
    """Renders each look from the front and one from behind, joined into the preview strip."""
    setup_preview_scene(height)
    render = bpy.context.scene.render
    frames: list[Path] = []
    for label, gender, bottoms, headwear in LOOKS:
        show_look(player, gender, bottoms, headwear)
        render.resolution_percentage = 70  # The frames side by side make the strip.
        for name, angle in (("front", 14.0), ("back", 166.0)) if label == "boy" else (("front", 14.0),):
            frames.append(TEXTURE_DIR / f"preview-{label}-{name}.png")
            shot(frames[-1], angle, height * 0.5, height * 2.6, 60.0)
        render.resolution_percentage = 100
        if directory:
            for name, angle, target, distance, lens, rise in VIEWS:
                shot(directory / f"{label}-{name}.png", angle, height * target, height * distance, lens, rise)
    show_look(player, *LOOKS[0][1:])

    strips = []
    for frame in frames:
        image = bpy.data.images.load(str(frame))
        width, tall = image.size
        strips.append(np.array(image.pixels[:], dtype=np.float32).reshape(tall, width, 4))
        bpy.data.images.remove(image)
    sheet = np.concatenate(strips, axis=1)
    preview = bpy.data.images.new("Realistic Player Preview", sheet.shape[1], sheet.shape[0])
    preview.pixels = sheet.ravel()
    preview.filepath_raw = str(PREVIEW_PATH)
    preview.file_format = "PNG"
    preview.save()
    bpy.data.images.remove(preview)


# The exported file must stay a sensible download for a browser game. It
# carries every look's parts at once: the hair only a bare head shows is
# 3,300 of these triangles.
MAX_TRIANGLES = 31_000
MAX_BYTES = 2_500_000
# The cloth that lies on the face, and moves with the skin under it when the face changes.
DRAPED_PARTS = ("player_beanie_knit", "player_scarf_wrap", "player_scarf_drape")
# Every mesh an emotion's face moves.
FACE_PARTS = ("player_body", "player_brows", "player_lashes", *DRAPED_PARTS)
REQUIRED_NODES = (
    "player_body", "player_ear_pair", "player_hair_boy_short", "player_hair_girl_long",
    "player_bare_hair_boy_short", "player_bare_hair_girl_long", "player_top",
    "player_trousers", "player_skirt", "player_skirt_leggings", "player_beanie_knit", "player_scarf_wrap",
    "player_scarf_drape", "player_shoes",
)


def validate_export() -> None:
    """Re-imports the GLB into an empty scene and checks it against the asset contract."""
    size = OUTPUT_PATH.stat().st_size
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(OUTPUT_PATH))
    # The importer adds a stand-in mesh for bone shapes; only the model's own parts count.
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith("player_")]
    names = {obj.name for obj in meshes}
    missing = [name for name in REQUIRED_NODES if name not in names]
    if missing:
        raise RuntimeError(f"{OUTPUT_PATH.name}: missing parts {missing}")
    clips = {action.name.split("_")[0] for action in bpy.data.actions}
    if clips != {"idle", "walk", *EMOTIONS}:
        raise RuntimeError(f"{OUTPUT_PATH.name}: expected idle, walk, and one clip per emotion, found {sorted(clips)}")
    for name in FACE_PARTS:
        keys = next(obj for obj in meshes if obj.name == name).data.shape_keys
        faces = [key.name for key in keys.key_blocks[1:]] if keys else []
        if faces != list(EMOTIONS):
            raise RuntimeError(f"{OUTPUT_PATH.name}: {name} should carry one face per emotion, found {faces}")

    bpy.context.view_layer.update()
    # Vertices rather than bounding boxes: a skinned mesh's box is not filled in on import.
    points = [obj.matrix_world @ vertex.co for obj in meshes for vertex in obj.data.vertices]
    low = min(point.z for point in points)  # glTF Y-up returns to Blender Z-up on import.
    tall = hatted_height(meshes) - low
    center_x = (min(point.x for point in points) + max(point.x for point in points)) / 2
    triangles = sum(len(polygon.vertices) - 2 for obj in meshes for polygon in obj.data.polygons)
    if abs(low) > 0.006:
        raise RuntimeError(f"{OUTPUT_PATH.name}: ground is z={low:.5f} m after import, expected 0")
    if abs(tall - PLAYROOM_HEIGHT) > 0.01:
        raise RuntimeError(f"{OUTPUT_PATH.name}: unexpected height {tall:.4f} m")
    if abs(center_x) > 0.01:
        raise RuntimeError(f"{OUTPUT_PATH.name}: not centered between the feet (x={center_x:.4f})")
    if triangles > MAX_TRIANGLES or size > MAX_BYTES:
        raise RuntimeError(f"{OUTPUT_PATH.name}: {triangles} triangles and {size} bytes exceed the budget")
    print(f"PASS {OUTPUT_PATH.name} {size} bytes | height={tall:.3f} m | triangles={triangles} | meshes={len(meshes)} | clips={sorted(clips)}")


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    # `-- --views <directory>` also saves close-up checks of every look.
    views = Path(arguments[arguments.index("--views") + 1]) if "--views" in arguments else None
    if views:
        views.mkdir(parents=True, exist_ok=True)
    # `-- --emotions <directory>` also saves every emotion: its face alone, and its face and body.
    emotions = Path(arguments[arguments.index("--emotions") + 1]).resolve() if "--emotions" in arguments else None
    if emotions:
        emotions.mkdir(parents=True, exist_ok=True)

    mpfb = require_mpfb()
    reset_scene()
    player = build_player(mpfb)
    rig = player.pop("rig")
    expressions = player.pop("expressions")
    meshes = list(player.values())

    relax_rest_pose(rig, meshes)
    ground(rig, meshes)
    # Rendered before the clips exist, so the preview shows the rest pose.
    render_preview(player, hatted_height(meshes), views)
    add_expressions(expressions, rig, player["player_body"], FACES, draped=tuple(player[name] for name in DRAPED_PARTS))
    animate_idle(rig)
    animate_walk(rig)
    animate_emotions(rig)
    slide = check_walk(rig)
    if slide > 0.006:
        raise RuntimeError(f"The planted foot slides {slide * 1000:.1f} mm during the walk")
    print(f"PASS walk: a planted foot stays within {slide * 1000:.1f} mm at {WALK_SPEED} m/s")
    gaps = check_clearance(rig, player)
    for label, (gap, where) in gaps.items():
        print(f"{'PASS' if gap >= MIN_CLEARANCE else 'FAIL'} arms {label}: {gap * 1000:.0f} mm at the closest, between {where}")
    if min(gap for gap, _ in gaps.values()) < MIN_CLEARANCE:
        raise RuntimeError(f"An arm comes within {MIN_CLEARANCE * 1000:.0f} mm of the body")
    # Rendered before the emotions are checked, so a clip that fails can be looked at.
    if emotions:
        render_emotions(rig, meshes, OUTPUT_PATH.stem, emotions)
    report_faces("the player", meshes)
    report_emotions("the player", rig, Clearance(rig, player), BODY_PARTS)
    # Everything above is measured on the child at its natural height. Only now
    # is it enlarged to stand as tall as the rest of the cast.
    factor = PLAYROOM_HEIGHT / hatted_height(meshes)
    enlarge(rig, meshes, factor)
    print(f"Enlarged {factor:.3f} times to {PLAYROOM_HEIGHT} m; its walk now covers {WALK_SPEED * factor:.2f} m/s")
    export_model(rig, meshes, OUTPUT_PATH, walk_speed=WALK_SPEED * factor)
    validate_export()

    print(f"Model:   {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
