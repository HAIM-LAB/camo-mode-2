"""Generate the realistic player for Camo Mode 2 with MPFB (MakeHuman for Blender).

Run from the repository root (see blender/cast/README.md for the one-time MPFB setup):
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/cast/generate_realistic_player.py

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
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


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


# A ten-year-old (MakeHuman age 0.1875) of average build. Boy and Girl share
# this one body, as on the cartoon player; only the hair differs.
CHILD_MACROS = {
    "gender": 0.5,
    "age": 0.1875,
    "muscle": 0.5,
    "weight": 0.5,
    "proportions": 0.5,
    "height": 0.5,
    "cupsize": 0.5,
    "firmness": 0.5,
    "race": {"asian": 0.33, "caucasian": 0.34, "african": 0.33},
}

# Morphs on top of the macros that keep the face friendly rather than blank:
# a soft closed-mouth smile, rounder cheeks, and slightly larger eyes.
FACE_TARGETS = {
    "mouth-corner-puller": 0.55,
    "l-cheek-volume-incr": 0.35,
    "r-cheek-volume-incr": 0.35,
    "l-eye-scale-incr": 0.55,
    "r-eye-scale-incr": 0.55,
    "head-round": 0.3,
}


def build_body(mpfb: dict) -> bpy.types.Object:
    human, targets = mpfb["HumanService"], mpfb["TargetService"]
    body = human.create_human(scale=0.1, macro_detail_dict=CHILD_MACROS)
    for name, weight in FACE_TARGETS.items():
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


def skin_texture(mpfb: dict, body: bpy.types.Object, ears: bpy.types.Object, size: int = 1024) -> Path:
    """The skin as a neutral detail map: multiplied by a tone it gives that tone.

    Only the texels the visible skin uses are kept. Everything the clothes cover
    is flattened, so no unclothed body texture ships in the file.
    """
    subdir, fragment, filename = SKIN
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / filename, size)
    linear = srgb_to_linear(pixels[..., :3])
    used = uv_coverage(body.data, size, margin=4) | uv_coverage(ears.data, size, margin=4)
    # The typical skin value becomes white, so the tone the runtime multiplies
    # in is the tone the child sees; lips, creases, and brows stay relative to it.
    reference = np.percentile(linear[used], 75, axis=0)
    neutral = np.clip(linear / reference, 0.0, 1.0)
    neutral[~used] = 1.0
    pixels[..., :3] = linear_to_srgb(neutral)
    pixels[..., 3] = 1.0
    return save_pixels("player-skin", pixels, alpha=False)


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


def hair_texture(mpfb: dict, part: tuple[str, str, str], name: str, size: int = 512) -> Path:
    """Strand detail in one shared hair color, keeping the pack's alpha."""
    subdir, fragment, _ = part
    stem = Path(fragment).stem
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / f"{stem}_diffuse.png", size)
    strands = luminance(srgb_to_linear(pixels[..., :3]))
    opaque = pixels[..., 3] > 0.5
    level = np.median(strands[opaque])
    shade = np.clip(0.3 + 0.7 * strands / level, 0.0, 1.9)
    tint = np.array(hex_rgba(HAIR_HEX)[:3], dtype=np.float32)
    pixels[..., :3] = linear_to_srgb(np.clip(shade[..., None] * tint, 0.0, 1.0))
    return save_pixels(name, pixels, alpha=True)


def tinted_alpha_texture(mpfb: dict, part: tuple[str, str, str], name: str, tint_hex: str, size: int = 256) -> Path:
    """An eyebrow or eyelash card: the pack's alpha in one flat color."""
    subdir, fragment, _ = part
    stem = Path(fragment).stem
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / f"{stem}.png", size)
    pixels[..., :3] = linear_to_srgb(np.array(hex_rgba(tint_hex)[:3], dtype=np.float32))
    return save_pixels(name, pixels, alpha=True)


def eye_texture(mpfb: dict, size: int = 256) -> Path:
    subdir, fragment, filename = EYE_TEXTURE
    pixels = load_pixels(asset_path(mpfb, subdir, fragment).parent / filename, size)
    # The pack's eye whites are grey; lifted so the eyes read from the game camera.
    pixels[..., :3] = np.clip(pixels[..., :3] * 1.3, 0.0, 1.0)
    pixels[..., 3] = 1.0
    return save_pixels("player-eyes", pixels, alpha=False)


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


# Where the beanie's edge and the head scarf's face opening sit on this head,
# in meters before the model is grounded. The brim runs from above the brows
# down to the nape, clipping the tops of the ears.
BRIM_FRONT = (-0.125, 1.25)  # (y, z) on the forehead
BRIM_BACK = (0.045, 1.185)  # (y, z) on the back of the head
BRIM_SLOPE = (BRIM_BACK[1] - BRIM_FRONT[1]) / (BRIM_BACK[0] - BRIM_FRONT[0])
CUFF_HEIGHT = 0.034
# The scarf frames the face with an oval, seen from the front: brow line to under the chin.
FACE_CENTER_Z = 1.186
FACE_HALF_WIDTH = 0.061
FACE_HALF_HEIGHT = 0.08
NECK_BASE = 1.0
# The scarf's capelet ends on a plane across the chest that rises toward the back.
DRAPE_FRONT = (-0.09, 1.0)  # (y, z)
DRAPE_SLOPE = 0.3


def above_brim(co: Vector) -> float:
    """Height of a point above the beanie's brim plane."""
    return co.z - (BRIM_FRONT[1] + BRIM_SLOPE * (co.y - BRIM_FRONT[0]))


def face_oval(co: Vector) -> float:
    """Below 1 inside the scarf's face opening, above 1 outside it."""
    if co.y > -0.02:
        return 2.0
    return math.hypot(co.x / FACE_HALF_WIDTH, (co.z - FACE_CENTER_Z) / FACE_HALF_HEIGHT)


def cut_face_opening(mesh: bmesh.types.BMesh, sides: int = 32) -> None:
    """Cuts the scarf's face opening out of a head mesh, leaving a clean edge.

    The oval is cut as a many-sided polygon: each side scores the faces around
    the opening along one tangent of the oval, then what lies inside goes.
    """
    tangents = []
    for side in range(sides):
        angle = 2.0 * math.pi * side / sides
        point = Vector((FACE_HALF_WIDTH * math.cos(angle), 0.0, FACE_CENTER_Z + FACE_HALF_HEIGHT * math.sin(angle)))
        normal = Vector((math.cos(angle) / FACE_HALF_WIDTH, 0.0, math.sin(angle) / FACE_HALF_HEIGHT)).normalized()
        tangents.append((point, normal))
        around = [face for face in mesh.faces if 0.7 < face_oval(face.calc_center_median()) < 1.4]
        geometry = set(around)
        for face in around:
            geometry.update(face.edges)
            geometry.update(face.verts)
        bmesh.ops.bisect_plane(mesh, geom=list(geometry), plane_co=point, plane_no=normal)

    def inside(center: Vector) -> bool:
        return center.y < -0.02 and all((center - point).dot(normal) < 0.0 for point, normal in tangents)

    opening = [face for face in mesh.faces if inside(face.calc_center_median())]
    bmesh.ops.delete(mesh, geom=opening, context="FACES")


def build_headwear(body: bpy.types.Object, top: bpy.types.Object, hair: list[bpy.types.Object]) -> dict[str, bpy.types.Object]:
    brim_plane = ((0.0, BRIM_FRONT[0], BRIM_FRONT[1]), (0.0, -BRIM_SLOPE, 1.0))

    # The hair is only ever seen under the beanie (the scarf covers it whole),
    # so what the beanie would hide is cut away rather than left to poke through.
    for piece in hair:
        bisect(piece, brim_plane[0], tuple(-component for component in brim_plane[1]))

    beanie = fitted_layer(
        body,
        "player_beanie_knit",
        lambda vertex, layer: vertex.co.z > NECK_BASE and above_brim(vertex.co) > -0.02,
        cut=brim_plane,
        # A rolled cuff: the lowest band of the hat stands further off the head.
        thickness=lambda vertex: 0.022 if above_brim(vertex.co) < CUFF_HEIGHT else 0.012,
        smoothing=6,
    )
    # Scored where the cuff ends, so its darker color stops on a clean line.
    bisect(beanie, (0.0, BRIM_FRONT[0], BRIM_FRONT[1] + CUFF_HEIGHT), brim_plane[1], keep_both=True)

    ears = body.vertex_groups["ears"].index

    def shape_scarf(mesh: bmesh.types.BMesh) -> None:
        # Cloth bridges an ear rather than following its folds: each ear is
        # replaced by a flat patch across its outline. (The look hides the ears
        # themselves under the scarf.)
        deform = mesh.verts.layers.deform.verify()

        def on_ear(element) -> bool:
            return all(group_weight(vertex, deform, ears) > 0 for vertex in element.verts)

        bmesh.ops.delete(mesh, geom=[face for face in mesh.faces if on_ear(face)], context="FACES")
        outlines = [edge for edge in mesh.edges if edge.is_boundary and on_ear(edge)]
        patches = bmesh.ops.holes_fill(mesh, edges=outlines, sides=0)["faces"]
        bmesh.ops.triangulate(mesh, faces=patches)
        # The skin still dips toward the ear canal around each patch; ironed flat here.
        around = [
            vertex for vertex in mesh.verts
            if (vertex.co - Vector((math.copysign(0.066, vertex.co.x), -0.036, 1.192))).length < 0.04
        ]
        for _ in range(12):
            bmesh.ops.smooth_vert(mesh, verts=around, factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
        cut_face_opening(mesh)

    scarf = fitted_layer(
        body,
        "player_scarf_wrap",
        lambda vertex, layer: vertex.co.z > NECK_BASE,
        shape=shape_scarf,
        thickness=lambda vertex: 0.014,
        smoothing=14,
        detail=0.45,
    )
    # A capelet over the collar and shoulders, cut from the top it rests on.
    drape_plane = ((0.0, DRAPE_FRONT[0], DRAPE_FRONT[1]), (0.0, -DRAPE_SLOPE, 1.0))
    drape = fitted_layer(
        top,
        "player_scarf_drape",
        lambda vertex, layer: vertex.co.z > DRAPE_FRONT[1] + DRAPE_SLOPE * (vertex.co.y - DRAPE_FRONT[0]) - 0.04,
        cut=drape_plane,
        thickness=lambda vertex: 0.009,
        smoothing=3,
    )
    return {"player_beanie_knit": beanie, "player_scarf_wrap": scarf, "player_scarf_drape": drape}


def split_ears(body: bpy.types.Object) -> bpy.types.Object:
    """Moves the ears into their own mesh, so the head scarf's look can hide them."""
    index = body.vertex_groups["ears"].index
    ears = duplicate(body, "player_ear_pair")
    keep_vertices(ears, lambda vertex, layer: group_weight(vertex, layer, index) > 0)

    mesh = bmesh.new()
    mesh.from_mesh(body.data)
    layer = mesh.verts.layers.deform.verify()
    on_ear = [face for face in mesh.faces if all(group_weight(vertex, layer, index) > 0 for vertex in face.verts)]
    bmesh.ops.delete(mesh, geom=on_ear, context="FACES")
    mesh.to_mesh(body.data)
    mesh.free()
    body.data.update()
    return ears


def lighten_body(body: bpy.types.Object) -> bpy.types.Object:
    """Drops skin no look ever shows and thins the hands, which the camera never studies."""
    # Rings of ankle skin are left between the shoes' and the trousers' masks,
    # under the socks. The hands are well above them while the arms are raised.
    keep_vertices(body, lambda vertex, layer: vertex.co.z > 0.5)
    # The hands are separate pieces of the mesh, so they can be thinned on
    # their own and the face and neck keep every vertex.
    hands = duplicate(body, "hands")
    keep_vertices(hands, lambda vertex, layer: vertex.co.z < NECK_BASE)
    simplify(hands, 0.34)
    keep_vertices(body, lambda vertex, layer: vertex.co.z >= NECK_BASE)
    return join([body, hands], body.name)


# -----------------------------------------------------------------------------
# Build


def build_player(mpfb: dict) -> dict[str, bpy.types.Object]:
    body = build_body(mpfb)
    rig = mpfb["HumanService"].add_builtin_rig(body, "game_engine", import_weights=True)
    rig.name = rig.data.name = "player_rig"

    eyes = add_part(mpfb, body, EYES)
    brows = add_part(mpfb, body, BROWS)
    lashes = add_part(mpfb, body, LASHES)
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
    # The leggings stop just inside the socks' tops, so neither shows through the other.
    leggings = helper_garment(body, "player_skirt_leggings", "helper-tights", 0.166, hip + 0.05)

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

    parts = {
        "player_body": body,
        "player_eyes": eyes,
        "player_brows": brows,
        "player_lashes": lashes,
        "player_hair_boy_short": hair_boy,
        "player_hair_girl_long": hair_girl,
        "player_top": top,
        "player_trousers": trousers,
        "player_skirt": skirt,
        "player_skirt_leggings": leggings,
        "player_socks": socks,
        "player_shoes": shoes,
        **build_headwear(body, top, [hair_boy, hair_girl]),
    }
    parts["player_ear_pair"] = ears = split_ears(body)
    parts["player_body"] = body = lighten_body(body)
    # Small on screen and simple in shape: half the faces lose nothing visible.
    for obj in (ears, shoes, leggings):
        simplify(obj, 0.5)
    for name, obj in parts.items():
        obj.name = obj.data.name = name
        strip_modifiers(obj)

    clothes_map = clothes_texture(mpfb, top, trousers)
    skin = make_material("Player Skin", SKIN_HEX, texture=skin_texture(mpfb, body, ears), roughness=0.62)
    assign(body, skin)
    assign(ears, skin)
    assign(eyes, make_material("Player Eyes", "#ffffff", texture=eye_texture(mpfb), roughness=0.25))
    assign(brows, make_material("Player Brows", "#ffffff", texture=tinted_alpha_texture(mpfb, BROWS, "player-brows", "#3a2820"), roughness=0.9, alpha="BLEND"))
    assign(lashes, make_material("Player Lashes", "#ffffff", texture=tinted_alpha_texture(mpfb, LASHES, "player-lashes", "#241a16"), roughness=0.9, alpha="BLEND"))
    assign(hair_boy, make_material("Player Hair Boy", "#ffffff", texture=hair_texture(mpfb, HAIR_BOY, "player-hair-boy"), roughness=0.8, alpha="CLIP", double_sided=True))
    assign(hair_girl, make_material("Player Hair Girl", "#ffffff", texture=hair_texture(mpfb, HAIR_GIRL, "player-hair-girl"), roughness=0.8, alpha="CLIP", double_sided=True))
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
    split_material(parts["player_beanie_knit"], accent_dark, lambda center: above_brim(center) < CUFF_HEIGHT)
    scarf = make_material("Player Scarf", ACCENT_HEX, roughness=0.9, double_sided=True)
    assign(parts["player_scarf_wrap"], scarf)
    assign(parts["player_scarf_drape"], scarf)

    return {"rig": rig, **parts}


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
    # Arms hang by the sides with a soft bend at the elbow, feet a little closer.
    for side, sign in (("l", 1.0), ("r", -1.0)):
        upper = aim(bones[f"upperarm_{side}"], (sign * 0.13, 0.03, -1.0))
        aim(bones[f"lowerarm_{side}"], (sign * 0.05, -0.2, -1.0), upper)
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
    rig.animation_data.action = None
    reset_pose(rig)


def bump(phase: float, center: float, sharpness: float = 1.0) -> float:
    """A smooth 0..1 pulse centered on a phase, half a cycle wide."""
    return max(0.0, math.cos(phase - center)) ** sharpness


# 0.6 s per stride at 30 fps. The stride covers about 1.3 m of ground, which is
# the speed src/player-avatar.ts plays this clip at full rate for.
WALK_FRAMES = 18

LEG_BONES = ("thigh", "calf", "foot")
ARM_BONES = ("upperarm", "lowerarm")
TRUNK_BONES = ("pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head")


def limb_names(bones: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(f"{bone}_{side}" for bone in bones for side in ("l", "r"))


def animate_walk(rig: bpy.types.Object) -> None:
    """A brisk child's walk in place: phase 0 is the left leg passing under the body."""
    action = new_clip(rig, "walk")
    bones = rig.pose.bones
    for frame in range(WALK_FRAMES + 1):
        cycle = 2.0 * math.pi * frame / WALK_FRAMES
        for side, sign, phase in (("l", 1.0, cycle), ("r", -1.0, cycle + math.pi)):
            swing = math.sin(phase)  # +1: this leg is fully forward
            thigh = -31.0 * swing - 5.0
            knee = 7.0 + 58.0 * bump(phase, -0.55, 1.6) + 9.0 * bump(phase, math.pi / 2 + 0.55, 4.0)
            # Toes lift into the heel strike and point down at push-off.
            foot_pitch = -swing * (14.0 if swing > 0 else 24.0)
            turn(bones[f"thigh_{side}"], ("X", thigh))
            turn(bones[f"calf_{side}"], ("X", knee))
            turn(bones[f"foot_{side}"], ("X", foot_pitch - thigh - knee))
            # Arms swing against the legs, elbows bending more as they come forward.
            turn(bones[f"upperarm_{side}"], ("X", 27.0 * swing + 4.0), ("Y", sign * -3.0))
            turn(bones[f"lowerarm_{side}"], ("X", -(30.0 - 18.0 * swing)))

        sway = math.sin(cycle)
        turn(bones["pelvis"], ("X", 4.0), ("Z", -5.0 * sway), ("Y", 2.0 * math.cos(cycle)))
        shift(bones["pelvis"], (-0.012 * math.cos(cycle), 0.0, 0.014 * math.cos(2.0 * cycle) - 0.012))
        for name in ("spine_01", "spine_02", "spine_03"):
            turn(bones[name], ("X", 1.0), ("Z", 3.4 * sway), ("Y", -0.7 * math.cos(cycle)))
        turn(bones["neck_01"], ("X", -2.5), ("Z", -2.6 * sway))
        turn(bones["head"], ("X", -2.5), ("Z", -2.6 * sway))
        key(rig, frame + 1, limb_names(LEG_BONES) + limb_names(ARM_BONES) + TRUNK_BONES, location=("pelvis",))
    finish_clip(rig, action)


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


def export_player(rig: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    bpy.context.scene.render.fps = FPS
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for obj in meshes:
        obj.hide_render = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_skins=True,
        export_morph=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_optimize_animation_size=True,
        export_anim_single_armature=True,
    )


# -----------------------------------------------------------------------------
# Preview


VIEWS = (
    # name, camera angle around the child (0 = front), look-at height as a fraction of the child, distance, lens
    ("front", 0.0, 0.5, 4.2, 60.0),
    ("threeq", 35.0, 0.5, 4.2, 60.0),
    ("back", 180.0, 0.5, 4.2, 60.0),
    ("face", 12.0, 0.9, 1.5, 70.0),
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


def shot(path: Path, angle: float, target_z: float, distance: float, lens: float) -> None:
    scene = bpy.context.scene
    camera = scene.camera
    camera.data.lens = lens
    radians = math.radians(angle)
    camera.location = (math.sin(radians) * distance, -math.cos(radians) * distance, target_z + distance * 0.08)
    camera.rotation_euler = (Vector((0, 0, target_z)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


LOOKS = (
    # label, hair shown, bottoms shown, headwear shown
    ("boy", "player_hair_boy_", "player_trousers", "player_beanie_"),
    ("girl", "player_hair_girl_", "player_skirt", "player_beanie_"),
    ("scarf", None, "player_skirt", "player_scarf_"),
)
VARIANT_PREFIXES = ("player_hair_", "player_trousers", "player_skirt", "player_beanie_", "player_scarf_", "player_ear_")


def show_look(player: dict[str, bpy.types.Object], hair: str | None, bottoms: str, headwear: str) -> None:
    """Shows one look's part sets for a render, as applyPlayerLook does at runtime."""
    shown = tuple(prefix for prefix in (hair, bottoms, headwear) if prefix)
    for name, obj in player.items():
        if name.startswith(VARIANT_PREFIXES):
            # The head scarf covers the ears as well as the hair.
            keep = name.startswith(shown) or (name.startswith("player_ear_") and headwear != "player_scarf_")
            obj.hide_render = not keep


def render_preview(player: dict[str, bpy.types.Object], height: float, directory: Path | None) -> None:
    """Renders each look from the front and one from behind, joined into the preview strip."""
    setup_preview_scene(height)
    render = bpy.context.scene.render
    frames: list[Path] = []
    for label, hair, bottoms, headwear in LOOKS:
        show_look(player, hair, bottoms, headwear)
        render.resolution_percentage = 70  # Four frames side by side make the strip.
        for name, angle in (("front", 14.0), ("back", 166.0)) if label == "boy" else (("front", 14.0),):
            frames.append(TEXTURE_DIR / f"preview-{label}-{name}.png")
            shot(frames[-1], angle, height * 0.5, 3.4, 60.0)
        render.resolution_percentage = 100
        if directory:
            for name, angle, target, distance, lens in VIEWS:
                shot(directory / f"{label}-{name}.png", angle, height * target, distance, lens)
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


# The exported file must stay a sensible download for a browser game.
MAX_TRIANGLES = 28_000
MAX_BYTES = 2_500_000
REQUIRED_NODES = (
    "player_body", "player_ear_pair", "player_hair_boy_short", "player_hair_girl_long", "player_top",
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
    if not {"idle", "walk"} <= clips:
        raise RuntimeError(f"{OUTPUT_PATH.name}: expected idle and walk clips, found {sorted(clips)}")

    bpy.context.view_layer.update()
    # Vertices rather than bounding boxes: a skinned mesh's box is not filled in on import.
    points = [obj.matrix_world @ vertex.co for obj in meshes for vertex in obj.data.vertices]
    low = min(point.z for point in points)  # glTF Y-up returns to Blender Z-up on import.
    tall = max(point.z for point in points) - low
    center_x = (min(point.x for point in points) + max(point.x for point in points)) / 2
    triangles = sum(len(polygon.vertices) - 2 for obj in meshes for polygon in obj.data.polygons)
    if abs(low) > 0.006:
        raise RuntimeError(f"{OUTPUT_PATH.name}: ground is z={low:.5f} m after import, expected 0")
    if not 1.28 <= tall <= 1.4:
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

    mpfb = require_mpfb()
    reset_scene()
    player = build_player(mpfb)
    rig = player.pop("rig")
    meshes = list(player.values())

    relax_rest_pose(rig, meshes)
    ground(rig, meshes)
    # Rendered before the clips exist, so the preview shows the rest pose.
    render_preview(player, max(world_z_range(obj)[1] for obj in meshes), views)
    animate_idle(rig)
    animate_walk(rig)
    export_player(rig, meshes)
    validate_export()

    print(f"Model:   {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
