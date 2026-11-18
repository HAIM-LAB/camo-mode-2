"""Generate the cartoon cast and the prop assets for Camo Mode 2.

Run from the repository root:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/cast/generate_cast.py

The modeling space is Blender's Z-up space. Blender's glTF exporter converts it to
Y-up; models face Blender -Y so that the exported forward direction is glTF +Z.
No images, fonts, or other external assets are used. (The realistic cast, built
from CC0 MakeHuman assets, has its own scripts: generate_realistic_player.py and
generate_realistic_friends.py.)

Add `-- --views <directory>` to also save close-up renders of each character.
"""

from __future__ import annotations

import math
import sys
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
SOURCE_DIR = REPO_ROOT / "blender" / "cast"
OUTPUT_DIR = REPO_ROOT / "public" / "assets" / "cast"
BLEND_PATH = SOURCE_DIR / "camo-cast.blend"
PREVIEW_PATH = SOURCE_DIR / "cast-lineup.png"

SOURCE_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

ASSET_COLLECTIONS: dict[str, bpy.types.Collection] = {}
ASSET_ROOTS: dict[str, bpy.types.Object] = {}
CURRENT_COLLECTION: bpy.types.Collection | None = None
CURRENT_ROOT: bpy.types.Object | None = None
# The object new parts hang from: the asset root, or the pivot being filled.
CURRENT_PARENT: bpy.types.Object | None = None
PIVOT_ORIGINS: dict[str, Vector] = {}
MATERIALS: dict[str, bpy.types.Material] = {}
PLAYER_KEY = "player-cartoon"
FRIEND_A_KEY = "friend-a-cartoon"
FRIEND_B_KEY = "friend-b-cartoon"
LINEUP_HIDDEN_VARIANTS = ("player_hair_girl_", "player_skirt", "player_scarf_", "player_bare_")
FPS = 30


# -----------------------------------------------------------------------------
# Scene and material helpers


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (
        bpy.data.meshes,
        bpy.data.curves,
        bpy.data.materials,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        # Materials are rebuilt below; all other generated data is disposable too.
        for block in list(datablocks):
            datablocks.remove(block)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)

    scene = bpy.context.scene
    # Keep repeated generation from leaving Blender's automatic .blend1 backups.
    bpy.context.preferences.filepaths.save_version = 0
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.fps = FPS
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.resolution_percentage = 100
    scene.camera = None
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass


def material(name: str, rgba: tuple[float, float, float, float], *, metallic: float = 0.0, roughness: float = 0.78) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    MATERIALS[name] = mat
    return mat


def make_materials() -> None:
    # Shared facial and detail colors.
    material("Ink", (0.035, 0.045, 0.065, 1.0), roughness=0.9)
    material("Smile", (0.23, 0.055, 0.045, 1.0), roughness=0.95)
    material("Sole", (0.075, 0.09, 0.12, 1.0), roughness=0.9)
    material("Soft White", (0.92, 0.94, 0.92, 1.0), roughness=0.9)

    # Player: high-value gold backpack is deliberately readable from behind.
    material("Player Skin", (0.48, 0.235, 0.12, 1.0))
    material("Player Skin Light", (0.62, 0.34, 0.18, 1.0))
    material("Player Hair", (0.075, 0.035, 0.025, 1.0), roughness=0.92)
    material("Player Teal", (0.025, 0.39, 0.43, 1.0))
    material("Player Teal Dark", (0.018, 0.235, 0.28, 1.0))
    material("Player Coral", (0.82, 0.17, 0.17, 1.0))
    material("Player Gold", (1.0, 0.57, 0.045, 1.0))
    material("Player Gold Dark", (0.72, 0.30, 0.015, 1.0))
    # Variant parts get their own names so runtime outfit colours apply by name.
    # Authored like the parts they stand in for: scarf as beanie, skirt as hood.
    material("Player Scarf", (1.0, 0.57, 0.045, 1.0))
    material("Player Scarf Dark", (0.72, 0.30, 0.015, 1.0))
    material("Player Skirt", (0.018, 0.235, 0.28, 1.0))
    # The leggings under the skirt follow the trousers, the shoes the backpack.
    material("Player Leggings", (0.82, 0.17, 0.17, 1.0))
    material("Player Shoes", (1.0, 0.57, 0.045, 1.0))
    # The cheek color of the default skin tone in src/player-look.ts (#cc7461).
    material("Player Blush", (0.604, 0.175, 0.120, 1.0), roughness=0.9)

    # Friend A: twin puffs, a mint dress with lavender sleeves, plum shoes.
    material("A Skin", (0.23, 0.085, 0.04, 1.0))
    material("A Skin Light", (0.34, 0.14, 0.07, 1.0))
    material("A Hair", (0.055, 0.025, 0.06, 1.0), roughness=0.94)
    material("A Plum", (0.42, 0.10, 0.52, 1.0))
    material("A Lavender", (0.72, 0.43, 0.86, 1.0))
    material("A Mint", (0.12, 0.72, 0.61, 1.0))
    material("A Mint Dark", (0.06, 0.47, 0.41, 1.0))
    material("A Sun", (1.0, 0.67, 0.08, 1.0))
    # On deep skin the face is drawn darker and glossier than the shared ink, as
    # src/player-look.ts does for the player, so the eyes keep their catchlight.
    material("A Eyes", (0.004, 0.004, 0.006, 1.0), roughness=0.28)
    material("A Smile", (0.03, 0.01, 0.006, 1.0), roughness=0.4)
    material("A Blush", (0.42, 0.085, 0.055, 1.0), roughness=0.9)

    # Friend B: swept navy hair, a rust jacket over a sky shirt, navy trousers.
    material("B Skin", (0.72, 0.46, 0.26, 1.0))
    material("B Skin Light", (0.84, 0.59, 0.36, 1.0))
    material("B Hair", (0.025, 0.06, 0.13, 1.0), roughness=0.92)
    material("B Rust", (0.83, 0.25, 0.075, 1.0))
    material("B Rust Dark", (0.56, 0.10, 0.035, 1.0))
    material("B Sky", (0.08, 0.52, 0.82, 1.0))
    material("B Navy", (0.025, 0.10, 0.23, 1.0))
    material("B Lime", (0.65, 0.80, 0.12, 1.0))
    material("B Blush", (0.87, 0.31, 0.22, 1.0), roughness=0.9)

    # Props.
    material("Ball Cyan", (0.025, 0.70, 0.78, 1.0))
    material("Ball Coral", (0.95, 0.18, 0.18, 1.0))
    material("Ball Yellow", (1.0, 0.72, 0.04, 1.0))
    material("Ball Purple", (0.50, 0.16, 0.72, 1.0))
    material("Block Coral", (0.90, 0.18, 0.12, 1.0))
    material("Block Yellow", (1.0, 0.64, 0.035, 1.0))
    material("Block Teal", (0.02, 0.57, 0.52, 1.0))
    material("Block Purple", (0.43, 0.13, 0.68, 1.0))


def move_to_collection(obj: bpy.types.Object, collection: bpy.types.Collection) -> None:
    for old_collection in list(obj.users_collection):
        old_collection.objects.unlink(obj)
    collection.objects.link(obj)


def begin_asset(key: str, display_name: str, description: str) -> bpy.types.Object:
    global CURRENT_COLLECTION, CURRENT_ROOT, CURRENT_PARENT
    collection = bpy.data.collections.new(f"CAST_{key.upper().replace('-', '_')}")
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new(f"{key}_ROOT", None)
    collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.18
    root["asset"] = display_name
    root["description"] = description
    root["units"] = "meters"
    root["gltf_up"] = "+Y"
    root["gltf_forward"] = "+Z"
    root["ground"] = "y=0"
    ASSET_COLLECTIONS[key] = collection
    ASSET_ROOTS[key] = root
    CURRENT_COLLECTION = collection
    CURRENT_ROOT = root
    CURRENT_PARENT = root
    return root


def register_object(obj: bpy.types.Object) -> bpy.types.Object:
    if CURRENT_COLLECTION is None or CURRENT_PARENT is None:
        raise RuntimeError("begin_asset() must be called before adding asset geometry")
    move_to_collection(obj, CURRENT_COLLECTION)
    obj.parent = CURRENT_PARENT
    # Parts are placed in asset space; a pivot's children sit relative to it.
    obj.location = Vector(obj.location) - PIVOT_ORIGINS.get(CURRENT_PARENT.name, Vector())
    return obj


@contextmanager
def pivot(name: str, origin: tuple[float, float, float]):
    """Groups the parts added inside it under an empty at origin, so they animate as one."""
    global CURRENT_PARENT
    outer = CURRENT_PARENT
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "SPHERE"
    empty.empty_display_size = 0.03
    bpy.context.scene.collection.objects.link(empty)
    register_object(empty)
    empty.location = Vector(origin) - PIVOT_ORIGINS.get(outer.name, Vector())
    PIVOT_ORIGINS[name] = Vector(origin)
    CURRENT_PARENT = empty
    try:
        yield empty
    finally:
        CURRENT_PARENT = outer


def shade_smooth(obj: bpy.types.Object, *, sharp_caps: bool = False) -> None:
    """Smooth shading; sharp_caps keeps the flat ends of a cone or cylinder flat."""
    for polygon in obj.data.polygons:
        polygon.use_smooth = not (sharp_caps and abs(polygon.normal.z) > 0.9)


def apply_scale(obj: bpy.types.Object) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def add_rounded_cube(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    mat: bpy.types.Material,
    *,
    bevel: float = 0.025,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    apply_scale(obj)
    obj.data.materials.append(mat)
    if bevel > 0:
        modifier = obj.modifiers.new("Soft low-poly edges", "BEVEL")
        modifier.width = min(bevel, min(dimensions) * 0.22)
        modifier.segments = 2
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    return register_object(obj)


def add_ico(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
    *,
    subdivisions: int = 2,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    smooth: bool = False,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_scale(obj)
    obj.data.materials.append(mat)
    if smooth:
        shade_smooth(obj)
    return register_object(obj)


def add_dome(
    name: str,
    center: tuple[float, float, float],
    radii: tuple[float, float, float],
    mat: bpy.types.Material,
    *,
    plane_point: tuple[float, float, float],
    plane_normal: tuple[float, float, float],
) -> bpy.types.Object:
    """The part of a smooth ellipsoid on the normal's side of a plane, left open at the cut."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.scale = radii
    apply_scale(obj)
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    bmesh.ops.bisect_plane(
        mesh,
        geom=mesh.verts[:] + mesh.edges[:] + mesh.faces[:],
        plane_co=Vector(plane_point) - Vector(center),
        plane_no=Vector(plane_normal),
        clear_inner=True,
    )
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return register_object(obj)


def add_surface(
    name: str,
    vertices: list[Vector],
    faces: list[tuple[int, ...]],
    mat: bpy.types.Material,
) -> bpy.types.Object:
    """A smooth-shaded mesh from explicit asset-space vertices and faces."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(vertex) for vertex in vertices], [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return register_object(obj)


def add_cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    mat: bpy.types.Material,
    *,
    vertices: int = 10,
    scale_xy: tuple[float, float] = (1.0, 1.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    bevel: float = 0.0,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale.x = scale_xy[0]
    obj.scale.y = scale_xy[1]
    apply_scale(obj)
    obj.data.materials.append(mat)
    if bevel > 0:
        modifier = obj.modifiers.new("Rounded rims", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)
    return register_object(obj)


def add_cone(
    name: str,
    location: tuple[float, float, float],
    radius_bottom: float,
    radius_top: float,
    depth: float,
    scale_xy: tuple[float, float],
    mat: bpy.types.Material,
    *,
    vertices: int = 10,
    smooth: bool = False,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius_bottom,
        radius2=radius_top,
        depth=depth,
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale.x = scale_xy[0]
    obj.scale.y = scale_xy[1]
    apply_scale(obj)
    obj.data.materials.append(mat)
    if smooth:
        shade_smooth(obj, sharp_caps=True)
    return register_object(obj)


def add_torus(
    name: str,
    location: tuple[float, float, float],
    major_radius: float,
    minor_radius: float,
    mat: bpy.types.Material,
    *,
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0),
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
    segments: tuple[int, int] = (16, 6),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=segments[0],
        minor_segments=segments[1],
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_scale(obj)
    obj.data.materials.append(mat)
    return register_object(obj)


def add_segment(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    mat: bpy.types.Material,
    *,
    vertices: int = 10,
) -> bpy.types.Object:
    start_v = Vector(start)
    end_v = Vector(end)
    delta = end_v - start_v
    midpoint = (start_v + end_v) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=delta.length, location=midpoint)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    obj.rotation_mode = "XYZ"
    obj.data.materials.append(mat)
    return register_object(obj)


# -----------------------------------------------------------------------------
# Character modeling


# The cartoon player's head: an ellipsoid the face is painted onto.
HEAD_CENTER = Vector((0.0, 0.0, 0.86))
HEAD_RADII = Vector((0.30, 0.275, 0.265))
# Its hair behind and above the face: a second ellipsoid, sunk into the back of the head.
HAIR_BACK_CENTER = Vector((0.0, 0.05, 0.878))
HAIR_BACK_RADII = Vector((0.308, 0.262, 0.276))


def head_direction(yaw: float, pitch: float) -> Vector:
    """The way out of the head at an angle, as a unit vector.

    Angles are degrees from the middle of the face: yaw turns toward the
    character's +X side, pitch rises toward the crown.
    """
    yaw_r, pitch_r = math.radians(yaw), math.radians(pitch)
    return Vector((
        math.sin(yaw_r) * math.cos(pitch_r),
        -math.cos(yaw_r) * math.cos(pitch_r),
        math.sin(pitch_r),
    ))


def head_point(yaw: float, pitch: float, lift: float = 0.0) -> Vector:
    """A point on the head at head_direction's angles, lifted off the surface by lift meters."""
    direction = head_direction(yaw, pitch)
    surface = Vector(radius * axis for radius, axis in zip(HEAD_RADII, direction))
    return HEAD_CENTER + surface + direction * lift


def add_face_decal(
    name: str,
    yaw: float,
    pitch: float,
    half_width: float,
    half_height: float,
    mat: bpy.types.Material,
    *,
    lift: float = 0.004,
    tilt: float = 0.0,
) -> bpy.types.Object:
    """A painted-on oval: a patch of faces that follows the head's curve.

    Sizes are in meters along the surface; tilt (degrees) turns the oval in place.
    It bulges by lift at its middle and meets the head at its rim.
    """
    rings, segments = 3, 18
    tilt_r = math.radians(tilt)
    meters_per_yaw = math.radians(1.0) * HEAD_RADII.x * math.cos(math.radians(pitch))
    meters_per_pitch = math.radians(1.0) * HEAD_RADII.z
    vertices = [head_point(yaw, pitch, lift)]
    for ring in range(1, rings + 1):
        reach = ring / rings
        for segment in range(segments):
            angle = 2.0 * math.pi * segment / segments
            across, up = half_width * reach * math.cos(angle), half_height * reach * math.sin(angle)
            across, up = (
                across * math.cos(tilt_r) - up * math.sin(tilt_r),
                across * math.sin(tilt_r) + up * math.cos(tilt_r),
            )
            vertices.append(head_point(
                yaw + across / meters_per_yaw,
                pitch + up / meters_per_pitch,
                lift * (1.0 - 0.75 * reach * reach),
            ))
    faces: list[tuple[int, ...]] = []
    for segment in range(segments):
        following = (segment + 1) % segments
        faces.append((0, 1 + segment, 1 + following))
        for ring in range(1, rings):
            inner, outer = 1 + (ring - 1) * segments, 1 + ring * segments
            faces.append((inner + segment, outer + segment, outer + following, inner + following))
    return add_surface(name, vertices, faces, mat)


def add_smile(name: str, half_span: float, pitch: float, rise: float, thickness: float, mat: bpy.types.Material) -> bpy.types.Object:
    """A painted-on smile: an arc across the face whose ends curl up by rise degrees."""
    columns = 14
    vertices: list[Vector] = []
    for column in range(columns + 1):
        along = -1.0 + 2.0 * column / columns
        middle = pitch + rise * along * along
        # Tapered to rounded tips.
        half = max(thickness * math.sqrt(max(1.0 - along * along, 0.0)), 0.04)
        lift = 0.0035 * (1.0 - 0.6 * along * along)
        vertices.append(head_point(half_span * along, middle - half, lift))
        vertices.append(head_point(half_span * along, middle + half, lift))
    faces = [
        (2 * column, 2 * column + 2, 2 * column + 3, 2 * column + 1)
        for column in range(columns)
    ]
    return add_surface(name, vertices, faces, mat)


def build_player() -> None:
    """The cartoon player: a big round head on a small body, with a painted-on face.

    An original design in the proportions of cosy village-life games. Its
    material and part names are the runtime's customization API; see
    docs/asset-contract.md.
    """
    root = begin_asset(
        PLAYER_KEY,
        "Player (cartoon)",
        "Round-headed child explorer with stubby limbs and a painted-on face; the gold backpack reads from behind.",
    )
    root["height_m"] = 1.30
    root["pose"] = "relaxed stand; idle and walk clips animate the pivots"
    root["rear_read"] = "gold backpack and beanie, teal tunic"
    root["variants"] = "hair boy/girl, bottoms trousers/skirt, headwear beanie/head scarf/bare head; see add_player_hair() and add_player_headwear()"

    skin, skin_light = MATERIALS["Player Skin"], MATERIALS["Player Skin Light"]
    teal, teal_dark = MATERIALS["Player Teal"], MATERIALS["Player Teal Dark"]
    gold, gold_dark = MATERIALS["Player Gold"], MATERIALS["Player Gold Dark"]
    hair = MATERIALS["Player Hair"]

    # Legs hang from the hips and stay planted while the body bobs above them.
    for side, x in (("L", -0.095), ("R", 0.095)):
        with pivot(f"pivot_leg_{side}", (x, 0.0, 0.31)):
            add_ico(f"player_shoe_{side}", (x, -0.032, 0.058), (0.088, 0.128, 0.058), MATERIALS["Player Shoes"], smooth=True)
            add_ico(f"player_shoe_{side}_sole", (x, -0.032, 0.02), (0.092, 0.132, 0.02), MATERIALS["Sole"], smooth=True)
            add_cylinder(f"player_trousers_{side}", (x, 0.0, 0.205), 0.082, 0.25, MATERIALS["Player Coral"], vertices=14)
            shade_smooth(bpy.data.objects[f"player_trousers_{side}"], sharp_caps=True)
            # Slimmer leggings stand in for the trouser legs under the skirt.
            add_cylinder(f"player_skirt_leg_{side}", (x, 0.0, 0.205), 0.058, 0.25, MATERIALS["Player Leggings"], vertices=14)
            shade_smooth(bpy.data.objects[f"player_skirt_leg_{side}"], sharp_caps=True)

    with pivot("pivot_body", (0.0, 0.0, 0.30)):
        add_cone("player_tunic", (0.0, 0.0, 0.445), 0.215, 0.125, 0.37, (1.0, 0.82), teal, vertices=20, smooth=True)
        add_torus("player_tunic_hem", (0.0, 0.0, 0.268), 0.212, 0.024, teal_dark, scale=(1.0, 0.82, 1.0), segments=(24, 8))
        add_torus("player_tunic_collar", (0.0, 0.0, 0.622), 0.118, 0.03, teal_dark, scale=(1.0, 0.85, 1.0), segments=(20, 8))
        for name in ("player_tunic_hem", "player_tunic_collar"):
            shade_smooth(bpy.data.objects[name])
        add_cone("player_skirt", (0.0, 0.0, 0.235), 0.285, 0.185, 0.2, (1.0, 0.84), MATERIALS["Player Skirt"], vertices=20, smooth=True)

        # The bright pack is the player's primary rear-view identifier.
        add_rounded_cube("player_backpack", (0.0, 0.205, 0.44), (0.27, 0.13, 0.25), gold, bevel=0.05)
        add_rounded_cube("player_pack_flap", (0.0, 0.272, 0.495), (0.235, 0.03, 0.095), gold_dark, bevel=0.022)
        add_rounded_cube("player_pack_badge", (0.0, 0.273, 0.395), (0.07, 0.022, 0.07), teal, bevel=0.014, rotation=(0.0, math.radians(45.0), 0.0))

        # The arms are held well out, so the mitts and the lower sleeves keep a
        # clear gap from the tunic and the skirt (check_clearance() measures it).
        for side, sign in (("L", -1.0), ("R", 1.0)):
            with pivot(f"pivot_arm_{side}", (sign * 0.135, 0.0, 0.565)):
                add_segment(f"player_sleeve_{side}", (sign * 0.135, 0.0, 0.565), (sign * 0.312, -0.012, 0.455), 0.06, teal, vertices=12)
                shade_smooth(bpy.data.objects[f"player_sleeve_{side}"], sharp_caps=False)
                add_ico(f"player_hand_{side}", (sign * 0.34, -0.014, 0.436), (0.066, 0.06, 0.066), skin, smooth=True)

        with pivot("pivot_head", (0.0, 0.0, 0.62)):
            add_ico("player_head", tuple(HEAD_CENTER), tuple(HEAD_RADII), skin, subdivisions=4, smooth=True)
            # Hair sits behind and above the face; the fringes below finish each look.
            add_ico("player_hair_back", tuple(HAIR_BACK_CENTER), tuple(HAIR_BACK_RADII), hair, subdivisions=3, smooth=True)

            # The face is painted on: flat shapes that hug the head.
            ink, white = MATERIALS["Ink"], MATERIALS["Soft White"]
            for side, sign in (("L", -1.0), ("R", 1.0)):
                add_face_decal(f"player_eye_{side}", sign * 19.0, 1.0, 0.034, 0.056, ink, lift=0.005)
                add_face_decal(f"player_eye_{side}_glint", sign * 19.0 - 2.4, 6.0, 0.011, 0.014, white, lift=0.008)
                add_face_decal(f"player_cheek_{side}", sign * 35.0, -17.0, 0.046, 0.027, MATERIALS["Player Blush"], lift=0.0035)
            add_ico("player_nose", tuple(head_point(0.0, -8.0, -0.004)), (0.02, 0.016, 0.017), skin_light, smooth=True)
            add_smile("player_smile", 10.5, -27.0, 5.5, 1.5, MATERIALS["Smile"])

            add_player_headwear()

        add_scarf_drape()

    add_player_hair()


def add_player_hair() -> None:
    """Boy and Girl share one body; these fringes and bunches are the difference.

      player_hair_boy_*   a short tufted fringe under the beanie
      player_hair_girl_*  side-swept bangs and two low bunches
      player_bare_hair_*  the hair a hat covers, for the bare head: it joins
                          either fringe to the back hair over the top of the head
    """
    global CURRENT_PARENT
    hair = MATERIALS["Player Hair"]
    outer, CURRENT_PARENT = CURRENT_PARENT, bpy.data.objects["pivot_head"]
    try:
        # Both fringes are painted on like the face: they follow the forehead and
        # tuck up under the hat's cuff or the bare head's hair, leaving clear
        # forehead above the eyes.
        add_face_decal("player_hair_boy_fringe", -8.0, 25.0, 0.15, 0.032, hair, lift=0.012, tilt=-8.0)
        add_face_decal("player_hair_boy_tuft", 30.0, 26.5, 0.05, 0.025, hair, lift=0.01, tilt=20.0)

        add_face_decal("player_hair_girl_bangs", 0.0, 25.0, 0.215, 0.033, hair, lift=0.012)
        for side, sign in (("L", -1.0), ("R", 1.0)):
            add_ico(f"player_hair_girl_bunch_{side}", (sign * 0.325, 0.07, 0.7), (0.085, 0.085, 0.105), hair, smooth=True)
            add_ico(f"player_hair_girl_tie_{side}", (sign * 0.292, 0.06, 0.775), (0.04, 0.04, 0.03), MATERIALS["Player Gold"], smooth=True)

        add_hair_cap("player_bare_hair_top", hair)
    finally:
        CURRENT_PARENT = outer


def smoothstep(share: float) -> float:
    share = min(max(share, 0.0), 1.0)
    return share * share * (3.0 - 2.0 * share)


def lift_onto_hair_back(yaw: float, pitch: float) -> float:
    """How far a point of the head must be lifted to lie on the back hair.

    Negative where the head stands proud of that hair, as it does across the face.
    """
    # In the space where the back hair is a unit sphere, the lifted point is
    # start + step * lift; it is on the sphere at the root on the way out.
    start = Vector(axis / radius for axis, radius in zip(head_point(yaw, pitch) - HAIR_BACK_CENTER, HAIR_BACK_RADII))
    step = Vector(axis / radius for axis, radius in zip(head_direction(yaw, pitch), HAIR_BACK_RADII))
    along = start.dot(step)
    inside = along * along - step.dot(step) * (start.dot(start) - 1.0)
    return (-along + math.sqrt(inside)) / step.dot(step) if inside > 0.0 else -math.inf


# The bare head's hairline, in degrees. It runs level across the forehead,
# through the fringes, as far as the temples. From there it curves down in
# front of the back hair to the neck, and passes under the collar behind.
HAIRLINE_FOREHEAD = 22.5  # Pitch across the forehead.
HAIRLINE_NECK = -75.0  # Pitch around the back.
HAIRLINE_TEMPLE = 48.0  # Yaw where the hairline leaves the forehead.
HAIRLINE_JAW = 98.0  # Yaw where it reaches the neck.
HAIR_DEPTH = 0.022  # How thick the hair lies over the top of the head, in meters.


def hairline(yaw: float) -> float:
    """The pitch of the bare head's hairline at a yaw."""
    turn = (abs(yaw) - HAIRLINE_TEMPLE) / (HAIRLINE_JAW - HAIRLINE_TEMPLE)
    if turn <= 0.0:
        return HAIRLINE_FOREHEAD
    if turn >= 1.0:
        return HAIRLINE_NECK
    # Falls away gently at the temple and ever more steeply toward the jaw.
    return HAIRLINE_FOREHEAD - (HAIRLINE_FOREHEAD - HAIRLINE_NECK) * (1.0 - (1.0 - turn) ** (1.0 / 2.2))


def add_hair_cap(name: str, mat: bpy.types.Material) -> bpy.types.Object:
    """The hair of a bare head, from the hairline up to the crown.

    Its edge lies close on the skin, like the painted fringes. From there it
    swells to HAIR_DEPTH over the forehead and the temples, and behind them it
    lies just outside the back hair, which it covers whole, so the head of
    hair has no seam.
    """
    # Meridians every 9 degrees, as fine as the head itself, and every 3 where
    # the hairline drops past the jaw.
    yaws = sorted({-180.0 + 9.0 * step for step in range(40)} | {
        sign * (75.0 + 3.0 * step) for sign in (-1.0, 1.0) for step in range(9)
    })
    # Evenly spaced rings: close enough over the back that the flat faces
    # between them stay outside the back hair's curve.
    columns, rings = len(yaws), 14
    scalp = 0.27  # Meters of scalp per radian of pitch, near enough for spacing.
    vertices: list[Vector] = []
    for ring in range(rings):
        for yaw in yaws:
            pitch = hairline(yaw) + (90.0 - hairline(yaw)) * ring / rings
            reach = math.radians(pitch - hairline(yaw)) * scalp  # Meters in from the edge.
            over_scalp = 0.002 + (HAIR_DEPTH - 0.002) * smoothstep(reach / 0.07)
            over_back = lift_onto_hair_back(yaw, pitch) + 0.004
            # Whichever stands higher, eased into the other where they cross.
            ease = 0.02 * smoothstep(reach / 0.05)
            blend = max(ease - abs(over_scalp - over_back), 0.0)
            lift = max(over_scalp, over_back) + (blend * blend / (4.0 * ease) if ease else 0.0)
            vertices.append(head_point(yaw, pitch, lift))
    crown = len(vertices)
    vertices.append(head_point(0.0, 90.0, max(HAIR_DEPTH, lift_onto_hair_back(0.0, 90.0) + 0.004)))
    faces: list[tuple[int, ...]] = []
    for column in range(columns):
        following = (column + 1) % columns
        for ring in range(rings - 1):
            low, high = ring * columns, (ring + 1) * columns
            faces.append((low + column, low + following, high + following, high + column))
        faces.append(((rings - 1) * columns + column, (rings - 1) * columns + following, crown))
    return add_surface(name, vertices, faces, mat)


def add_player_headwear() -> None:
    """Both headwear sets, added under the head pivot.

      player_beanie_*  a bobble hat over the hair
      player_scarf_*   a head scarf; replaces the beanie and covers all hair
    """
    gold, gold_dark = MATERIALS["Player Gold"], MATERIALS["Player Gold Dark"]
    # A tall knit hat pulled down to the fringe, sitting lower at the back. Its
    # crown clears the hair by a centimetre; the rolled cuff hides the cut edge.
    tilt = math.radians(9.0)
    crown_center, crown_radii = (0.0, 0.035, 0.8), (0.33, 0.305, 0.4)
    cuff_height = 0.95
    add_dome(
        "player_beanie_crown",
        crown_center,
        crown_radii,
        gold,
        plane_point=(0.0, 0.0, cuff_height),
        plane_normal=(0.0, math.sin(tilt), math.cos(tilt)),
    )
    rim = math.sqrt(1.0 - ((cuff_height - crown_center[2]) / crown_radii[2]) ** 2)
    add_torus(
        "player_beanie_band",
        (crown_center[0], crown_center[1], cuff_height + 0.02),
        crown_radii[0] * rim - 0.008,
        0.02,
        gold_dark,
        scale=(1.0, crown_radii[1] / crown_radii[0], 1.7),
        rotation=(-tilt, 0.0, 0.0),
        segments=(32, 10),
    )
    shade_smooth(bpy.data.objects["player_beanie_band"])
    add_ico("player_beanie_bobble", (0.0, 0.035, 1.235), (0.066, 0.066, 0.066), gold_dark, smooth=True)

    # A full covering that frames the face. The hood encloses the head and hair
    # and is cut open at the plane y=-0.185, where the head is a 0.222 x 0.196 m
    # ellipse; the band closes the centimetre between that and the hood's edge.
    scarf, scarf_dark = MATERIALS["Player Scarf"], MATERIALS["Player Scarf Dark"]
    add_dome(
        "player_scarf_hood",
        (0.0, 0.03, 0.865),
        (0.325, 0.31, 0.295),
        scarf,
        plane_point=(0.0, -0.185, 0.865),
        plane_normal=(0.0, 1.0, 0.0),
    )
    add_torus(
        "player_scarf_band",
        (0.0, -0.186, 0.863),
        0.229,
        0.022,
        scarf_dark,
        scale=(1.0, 0.89, 1.0),
        rotation=(math.radians(90.0), 0.0, 0.0),
        segments=(32, 10),
    )
    shade_smooth(bpy.data.objects["player_scarf_band"])


def add_scarf_drape() -> None:
    """The scarf's capelet: it rests on the shoulders, so it follows the body, not the head."""
    add_cone("player_scarf_drape", (0.0, 0.01, 0.607), 0.24, 0.165, 0.14, (1.0, 0.9), MATERIALS["Player Scarf"], vertices=20, smooth=True)


# -----------------------------------------------------------------------------
# Player animation
#
# The clips turn and lift the pivots. Rotations are (x, y, z) degrees: a positive
# x swings a hanging limb backward and leans the body forward.

Pose = dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]]
STILL = (0.0, 0.0, 0.0)

WALK_FRAMES = 15  # 0.5 s per stride
IDLE_FRAMES = 90  # a 3 s loop


def walk_pose(phase: float) -> Pose:
    """A toddling walk in place: the legs and arms swing while the body rocks over them."""
    swing = math.sin(phase)  # +1: the L leg is fully forward
    rock = math.cos(phase)
    return {
        "pivot_leg_L": ((-36.0 * swing, 0.0, 0.0), STILL),
        "pivot_leg_R": ((36.0 * swing, 0.0, 0.0), STILL),
        "pivot_arm_L": ((40.0 * swing, 0.0, 0.0), STILL),
        "pivot_arm_R": ((-40.0 * swing, 0.0, 0.0), STILL),
        "pivot_body": ((4.0, 4.5 * rock, 0.0), (0.0, 0.0, 0.011 * (1.0 + math.cos(2.0 * phase)))),
        "pivot_head": ((-2.0 + 1.5 * math.cos(2.0 * phase), -3.0 * rock, 0.0), STILL),
    }


def idle_pose(phase: float) -> Pose:
    """Standing still: a soft breathing bob, swaying arms, and a slow head tilt."""
    breath = math.sin(2.0 * phase)
    sway = math.sin(phase)
    return {
        "pivot_leg_L": (STILL, STILL),
        "pivot_leg_R": (STILL, STILL),
        "pivot_arm_L": ((3.0 * sway, -1.5 * breath, 0.0), STILL),
        "pivot_arm_R": ((-3.0 * sway, 1.5 * breath, 0.0), STILL),
        "pivot_body": ((0.0, 0.8 * sway, 0.0), (0.0, 0.0, 0.004 * breath)),
        "pivot_head": ((1.2 * breath, 2.6 * sway, 0.0), STILL),
    }


# A clip: its name, its length in frames, the frames between keys, and its pose
# at a phase of the loop (radians).
Clip = tuple[str, int, int, Callable[[float], Pose]]
PLAYER_CLIPS: tuple[Clip, ...] = (("idle", IDLE_FRAMES, 3, idle_pose), ("walk", WALK_FRAMES, 1, walk_pose))


def animate(clips: tuple[Clip, ...], prefix: str = "") -> None:
    """Writes a character's clips, one NLA track per clip on every pivot.

    A pose names the pivots without the character's prefix. The exporter merges
    same-named tracks of the exported character into one glTF animation.
    """
    pivots = {name: bpy.data.objects[prefix + name] for name in clips[0][3](0.0)}
    rest = {name: obj.location.copy() for name, obj in pivots.items()}
    for clip, frames, step, pose in clips:
        for name, obj in pivots.items():
            obj.animation_data_create()
            obj.animation_data.action = bpy.data.actions.new(f"{clip} {obj.name}")
        for frame in range(0, frames + 1, step):
            for name, (rotation, offset) in pose(2.0 * math.pi * frame / frames).items():
                obj = pivots[name]
                obj.rotation_euler = [math.radians(angle) for angle in rotation]
                obj.location = rest[name] + Vector(offset)
                obj.keyframe_insert("rotation_euler", frame=frame + 1)
                obj.keyframe_insert("location", frame=frame + 1)
        for name, obj in pivots.items():
            action = obj.animation_data.action
            for curve in action.fcurves:
                for point in curve.keyframe_points:
                    point.interpolation = "LINEAR"
            track = obj.animation_data.nla_tracks.new()
            track.name = clip
            track.strips.new(clip, 1, action)
            obj.animation_data.action = None
            obj.rotation_euler = (0.0, 0.0, 0.0)
            obj.location = rest[name]


@dataclass(frozen=True)
class Arms:
    """A character's arms, what they must hang clear of, and the clips to measure them through."""

    key: str
    hands: tuple[str, ...]
    # Tubes with the share of their length, from the shoulder end, that joins
    # the body or the tube above: only the rest hangs free and is measured.
    tubes: tuple[tuple[str, float], ...]
    # What the arms could touch whatever the look, and what each look adds.
    body: tuple[str, ...]
    looks: dict[str, tuple[str, ...]]
    clips: tuple[Clip, ...]


PLAYER_ARMS = Arms(
    key=PLAYER_KEY,
    hands=("player_hand_L", "player_hand_R"),
    # The inner half of a sleeve joins the tunic at the shoulder, so it is not a gap.
    tubes=(("player_sleeve_L", 0.5), ("player_sleeve_R", 0.5)),
    body=("player_tunic", "player_tunic_hem", "player_backpack", "player_pack_flap", "player_shoe_L", "player_shoe_R"),
    looks={
        "trousers": ("player_trousers_L", "player_trousers_R"),
        "skirt": ("player_skirt", "player_skirt_leg_L", "player_skirt_leg_R"),
    },
    clips=PLAYER_CLIPS,
)
# The least gap, in meters, allowed between a hand or the free part of an arm and the body in any frame of any look.
MIN_CLEARANCE = 0.02


def check_clearance(arms: Arms) -> dict[str, tuple[float, str]]:
    """The smallest gap between a character's arms and body, and where it is, while standing and through each clip.

    The hands and the free part of each arm tube are measured against the
    body and whatever each look adds to it.
    """
    scene = bpy.context.scene
    pivots = [obj for obj in ASSET_COLLECTIONS[arms.key].objects if obj.type == "EMPTY" and obj.animation_data]
    gaps: dict[str, tuple[float, str]] = {}

    def measure(label: str) -> None:
        dependency = bpy.context.evaluated_depsgraph_get()

        def placed(name: str):
            obj = bpy.data.objects[name]
            return obj, obj.evaluated_get(dependency).matrix_world

        movers: list[tuple[str, Vector]] = []
        for name in arms.hands:
            hand, matrix = placed(name)
            movers += [(name, matrix @ vertex.co) for vertex in hand.data.vertices]
        for name, joined in arms.tubes:
            # A tube's own Z runs from its shoulder end to its far end, with
            # vertices only at the ends, so its free surface is sampled between
            # the two rings.
            tube, matrix = placed(name)
            far_ring = [vertex.co for vertex in tube.data.vertices if vertex.co.z > 0.0]
            for step in range(5):
                share = joined + (1.0 - joined) * step / 4.0
                movers += [(name, matrix @ Vector((co.x, co.y, co.z * (2.0 * share - 1.0)))) for co in far_ring]

        for look, parts in arms.looks.items():
            smallest = (math.inf, "")
            for name in arms.body + parts:
                obj, matrix = placed(name)
                surface = BVHTree.FromPolygons(
                    [matrix @ vertex.co for vertex in obj.data.vertices],
                    [tuple(polygon.vertices) for polygon in obj.data.polygons],
                )
                for mover, point in movers:
                    location, normal, _, distance = surface.find_nearest(point)
                    inside = (point - location).dot(normal) < 0.0 and distance < 0.03
                    smallest = min(smallest, (-distance if inside else distance, f"{mover} and {name}"))
            key = f"{label} in {look}" if look else label
            gaps[key] = min(gaps.get(key, (math.inf, "")), smallest)

    def play(clip: str | None) -> None:
        for obj in pivots:
            for track in obj.animation_data.nla_tracks:
                track.mute = True
            obj.animation_data.action = bpy.data.actions[f"{clip} {obj.name}"] if clip else None

    play(None)
    scene.frame_set(1)
    measure("standing")
    for clip, frames, step, _ in arms.clips:
        play(clip)
        for frame in range(1, frames + 2, step):
            scene.frame_set(frame)
            measure(clip)
    play(None)
    for obj in pivots:
        for track in obj.animation_data.nla_tracks:
            track.mute = False
    scene.frame_set(1)
    return gaps


def mute_clips() -> None:
    """Leaves the saved scene and its render in the rest pose rather than mid-clip."""
    for collection in ASSET_COLLECTIONS.values():
        for obj in collection.objects:
            if obj.animation_data:
                for track in obj.animation_data.nla_tracks:
                    track.mute = True


# -----------------------------------------------------------------------------
# Friends
#
# Friend A and Friend B are drawn in the cartoon player's style and at its
# proportions: the same round head and painted-on face over a small body, with
# their own hair, clothes, and stance. They share a scene with the player, so
# their pivots carry the friend's prefix.

# A garment's cone: the height of its middle, its bottom and top radii, its
# depth, and its (x, y) scale.
Cone = tuple[float, float, float, float, tuple[float, float]]


def add_garment(name: str, cone: Cone, mat: bpy.types.Material) -> bpy.types.Object:
    middle, bottom, top, depth, scale_xy = cone
    return add_cone(name, (0.0, 0.0, middle), bottom, top, depth, scale_xy, mat, vertices=28, smooth=True)


def cone_radius(cone: Cone, height: float) -> float:
    middle, bottom, top, depth, _ = cone
    return bottom + (top - bottom) * (height - (middle - depth / 2.0)) / depth


def cone_point(cone: Cone, angle: float, height: float, lift: float = 0.0) -> Vector:
    """A point on a garment at a height, lifted off its surface by lift meters.

    The angle is degrees around from the middle of the front toward the character's +X side.
    """
    scale_x, scale_y = cone[4]
    radius = cone_radius(cone, height)
    outward = Vector((math.sin(math.radians(angle)), -math.cos(math.radians(angle)), 0.0))
    return Vector((radius * scale_x * outward.x, radius * scale_y * outward.y, height)) + outward * lift


def add_garment_band(name: str, cone: Cone, height: float, thickness: float, mat: bpy.types.Material, *, tall: float = 1.0) -> bpy.types.Object:
    """A rolled band around a garment at a height: a hem, a collar, or a belt."""
    scale_x, scale_y = cone[4]
    band = add_torus(
        name, (0.0, 0.0, height), cone_radius(cone, height), thickness, mat,
        scale=(scale_x, scale_y, tall), segments=(28, 8),
    )
    shade_smooth(band)
    return band


def add_garment_patch(
    name: str,
    cone: Cone,
    angle: float,
    height: float,
    half_width: float,
    half_height: float,
    mat: bpy.types.Material,
    *,
    lift: float = 0.005,
    corner: float = 5.0,
    taper: float = 0.0,
) -> bpy.types.Object:
    """A sewn-on panel that follows a garment's curve: a rounded rectangle around (angle, height).

    Sizes are in meters along the surface. A higher corner squares the outline
    off; taper narrows the panel toward its bottom by that share of its width.
    """
    rings, segments = 3, 28
    vertices = [cone_point(cone, angle, height, lift)]
    for ring in range(1, rings + 1):
        reach = ring / rings
        for segment in range(segments):
            turn = 2.0 * math.pi * segment / segments
            extent = (abs(math.cos(turn) / half_width) ** corner + abs(math.sin(turn) / half_height) ** corner) ** (-1.0 / corner)
            across, up = extent * reach * math.cos(turn), extent * reach * math.sin(turn)
            across *= 1.0 - taper * (0.5 - up / (2.0 * half_height))
            meters_per_degree = math.radians(1.0) * cone_radius(cone, height + up) * (cone[4][0] + cone[4][1]) / 2.0
            vertices.append(cone_point(cone, angle + across / meters_per_degree, height + up, lift * (1.0 - 0.6 * reach ** 4)))
    faces: list[tuple[int, ...]] = []
    for segment in range(segments):
        following = (segment + 1) % segments
        faces.append((0, 1 + segment, 1 + following))
        for ring in range(1, rings):
            inner, outer = 1 + (ring - 1) * segments, 1 + ring * segments
            faces.append((inner + segment, outer + segment, outer + following, inner + following))
    return add_surface(name, vertices, faces, mat)


def add_friend_legs(prefix: str, shoe: bpy.types.Material, sole: bpy.types.Material, leg: bpy.types.Material, leg_radius: float, *, ahead: tuple[float, float] = (0.0, 0.0)) -> None:
    """Shoes and legs under their hip pivots; ahead moves the L and R foot forward, in meters."""
    for (side, x), forward in zip((("L", -0.095), ("R", 0.095)), ahead):
        with pivot(f"{prefix}_pivot_leg_{side}", (x, -forward, 0.31)):
            add_ico(f"{prefix}_shoe_{side}", (x, -0.032 - forward, 0.058), (0.088, 0.128, 0.058), shoe, smooth=True)
            add_ico(f"{prefix}_shoe_{side}_sole", (x, -0.032 - forward, 0.02), (0.092, 0.132, 0.02), sole, smooth=True)
            add_cylinder(f"{prefix}_leg_{side}", (x, -forward, 0.205), leg_radius, 0.25, leg, vertices=14)
            shade_smooth(bpy.data.objects[f"{prefix}_leg_{side}"], sharp_caps=True)


def add_friend_face(
    prefix: str,
    skin: bpy.types.Material,
    skin_light: bpy.types.Material,
    hair: bpy.types.Material,
    *,
    eyes: bpy.types.Material,
    smile: bpy.types.Material,
    blush: bpy.types.Material,
    eye_size: tuple[float, float],
    brow_tilt: float,
    smile_span: float,
    smile_rise: float,
) -> None:
    """The head and its painted-on face. brow_tilt (degrees) raises the brows' inner ends."""
    add_ico(f"{prefix}_head", tuple(HEAD_CENTER), tuple(HEAD_RADII), skin, subdivisions=4, smooth=True)
    for side, sign in (("L", -1.0), ("R", 1.0)):
        add_face_decal(f"{prefix}_eye_{side}", sign * 19.0, 1.0, *eye_size, eyes, lift=0.005)
        add_face_decal(f"{prefix}_eye_{side}_glint", sign * 19.0 - 2.4, 6.0, 0.011, 0.014, MATERIALS["Soft White"], lift=0.008)
        add_face_decal(f"{prefix}_brow_{side}", sign * 19.5, 17.5, 0.036, 0.0085, hair, lift=0.006, tilt=-sign * brow_tilt)
        add_face_decal(f"{prefix}_cheek_{side}", sign * 35.0, -17.0, 0.046, 0.027, blush, lift=0.0035)
    add_ico(f"{prefix}_nose", tuple(head_point(0.0, -8.0, -0.004)), (0.02, 0.016, 0.017), skin_light, smooth=True)
    add_smile(f"{prefix}_smile", smile_span, -27.0, smile_rise, 1.5, smile)


def add_friend_hair(name: str, forehead: float, nape: float, mat: bpy.types.Material, *, thickness: float = 0.006) -> bpy.types.Object:
    """A friend's hair lying close over the head, from the forehead back down to the nape.

    Both are pitches in degrees on the head: how far up the forehead the hair
    starts, and how far below the crown it ends at the back. The cap is cut
    straight between them. The player's bare head has a shaped hairline
    instead: see add_hair_cap().
    """
    front, back = head_point(0.0, forehead), head_point(180.0, nape)
    slope = (back.z - front.z) / (back.y - front.y)
    return add_dome(
        name,
        tuple(HEAD_CENTER),
        tuple(radius + thickness for radius in HEAD_RADII),
        mat,
        plane_point=tuple(front),
        plane_normal=(0.0, -slope, 1.0),
    )


def build_friend_a() -> None:
    """Friend A in the cartoon style: twin puffs, a mint dress, and an open, listening stance."""
    prefix = "friend_a"
    root = begin_asset(
        FRIEND_A_KEY,
        "Friend A (cartoon)",
        "Round-headed child with twin puffs tied in yellow, a mint dress with lavender sleeves, and open arms.",
    )
    root["height_m"] = 1.27
    root["pose"] = "open and curious; an idle clip animates the pivots"

    skin, skin_light, hair = MATERIALS["A Skin"], MATERIALS["A Skin Light"], MATERIALS["A Hair"]
    mint, mint_dark = MATERIALS["A Mint"], MATERIALS["A Mint Dark"]
    lavender, plum, sun = MATERIALS["A Lavender"], MATERIALS["A Plum"], MATERIALS["A Sun"]

    add_friend_legs(prefix, plum, sun, lavender, 0.058)

    with pivot(f"{prefix}_pivot_body", (0.0, 0.0, 0.30)):
        # A knee-length A-line dress with a yellow sash and a plum front panel.
        dress: Cone = (0.415, 0.268, 0.125, 0.43, (1.0, 0.84))
        add_garment(f"{prefix}_dress", dress, mint)
        add_garment_band(f"{prefix}_dress_hem", dress, 0.209, 0.022, mint_dark)
        add_garment_band(f"{prefix}_dress_collar", dress, 0.622, 0.03, lavender)
        add_garment_band(f"{prefix}_dress_sash", dress, 0.482, 0.02, sun, tall=1.5)
        add_garment_patch(f"{prefix}_dress_panel", dress, 0.0, 0.345, 0.062, 0.072, plum, taper=-0.12)

        # Short sleeves over bare forearms, held a little higher and further
        # forward than the player's: an open, listening stance.
        for side, sign in (("L", -1.0), ("R", 1.0)):
            with pivot(f"{prefix}_pivot_arm_{side}", (sign * 0.135, 0.0, 0.565)):
                shoulder, cuff, wrist = (sign * 0.135, 0.0, 0.565), (sign * 0.242, -0.016, 0.522), (sign * 0.332, -0.03, 0.486)
                add_segment(f"{prefix}_sleeve_{side}", shoulder, cuff, 0.066, lavender, vertices=12)
                add_segment(f"{prefix}_forearm_{side}", cuff, wrist, 0.047, skin, vertices=12)
                for name in (f"{prefix}_sleeve_{side}", f"{prefix}_forearm_{side}"):
                    shade_smooth(bpy.data.objects[name], sharp_caps=False)
                add_ico(f"{prefix}_hand_{side}", (sign * 0.358, -0.034, 0.474), (0.064, 0.058, 0.064), skin, smooth=True)

        with pivot(f"{prefix}_pivot_head", (0.0, 0.0, 0.62)):
            add_friend_face(
                prefix, skin, skin_light, hair,
                eyes=MATERIALS["A Eyes"], smile=MATERIALS["A Smile"], blush=MATERIALS["A Blush"],
                eye_size=(0.036, 0.055), brow_tilt=11.0, smile_span=8.5, smile_rise=3.5,
            )
            # Hair drawn back over the head into two round puffs, each held by a yellow tie.
            add_friend_hair(f"{prefix}_hair_cap", 41.0, -24.0, hair)
            for side, sign in (("L", -1.0), ("R", 1.0)):
                puff = Vector((sign * 0.238, 0.03, 1.118))
                outward = (puff - HEAD_CENTER).normalized()
                add_ico(f"{prefix}_puff_{side}", tuple(puff), (0.124, 0.118, 0.124), hair, subdivisions=3, smooth=True)
                # The tie rings the puff where it leaves the head.
                tie = add_torus(
                    f"{prefix}_hair_tie_{side}", tuple(puff - outward * 0.07), 0.103, 0.019, sun,
                    rotation=tuple(outward.to_track_quat("Z", "Y").to_euler()), segments=(24, 8),
                )
                shade_smooth(tie)


def build_friend_b() -> None:
    """Friend B in the cartoon style: swept navy hair, a rust jacket over a sky shirt, one arm across his front."""
    prefix = "friend_b"
    root = begin_asset(
        FRIEND_B_KEY,
        "Friend B (cartoon)",
        "Round-headed child with swept navy hair and a lime clip, a rust jacket open over a sky shirt, and an asymmetric stance.",
    )
    root["height_m"] = 1.15
    root["pose"] = "left arm held across the jacket, left foot forward; an idle clip animates the pivots"

    skin, skin_light, hair = MATERIALS["B Skin"], MATERIALS["B Skin Light"], MATERIALS["B Hair"]
    rust, rust_dark = MATERIALS["B Rust"], MATERIALS["B Rust Dark"]
    sky, navy, lime = MATERIALS["B Sky"], MATERIALS["B Navy"], MATERIALS["B Lime"]

    # One foot is a little forward of the other.
    add_friend_legs(prefix, navy, lime, navy, 0.082, ahead=(0.03, -0.012))

    with pivot(f"{prefix}_pivot_body", (0.0, 0.0, 0.30)):
        jacket: Cone = (0.445, 0.215, 0.125, 0.37, (1.0, 0.84))
        add_garment(f"{prefix}_jacket", jacket, rust)
        add_garment_band(f"{prefix}_jacket_hem", jacket, 0.268, 0.024, rust_dark)
        add_garment_band(f"{prefix}_collar", jacket, 0.622, 0.031, lime)
        # The jacket hangs open over the shirt, wider at the collar than at the hem.
        add_garment_patch(f"{prefix}_shirt", jacket, 0.0, 0.447, 0.062, 0.156, sky, corner=7.0, taper=0.3)

        # The right arm rests at his side.
        with pivot(f"{prefix}_pivot_arm_R", (0.135, 0.0, 0.565)):
            add_segment(f"{prefix}_sleeve_R", (0.135, 0.0, 0.565), (0.316, -0.012, 0.452), 0.06, rust, vertices=12)
            shade_smooth(bpy.data.objects[f"{prefix}_sleeve_R"], sharp_caps=False)
            add_ico(f"{prefix}_hand_R", (0.343, -0.014, 0.433), (0.066, 0.06, 0.066), skin, smooth=True)
        # The left bends at the elbow and comes across in front of the jacket.
        with pivot(f"{prefix}_pivot_arm_L", (-0.135, 0.0, 0.565)):
            shoulder, elbow, wrist = (-0.135, 0.0, 0.565), (-0.292, -0.06, 0.468), (-0.158, -0.262, 0.452)
            add_segment(f"{prefix}_sleeve_L", shoulder, elbow, 0.06, rust, vertices=12)
            add_ico(f"{prefix}_elbow_L", elbow, (0.06, 0.06, 0.06), rust, smooth=True)
            add_segment(f"{prefix}_forearm_L", elbow, wrist, 0.056, rust, vertices=12)
            for name in (f"{prefix}_sleeve_L", f"{prefix}_forearm_L"):
                shade_smooth(bpy.data.objects[name], sharp_caps=False)
            add_ico(f"{prefix}_hand_L", (-0.128, -0.288, 0.45), (0.066, 0.06, 0.066), skin, smooth=True)

        with pivot(f"{prefix}_pivot_head", (0.0, 0.0, 0.62)):
            add_friend_face(
                prefix, skin, skin_light, hair,
                eyes=MATERIALS["Ink"], smile=MATERIALS["Smile"], blush=MATERIALS["B Blush"],
                eye_size=(0.032, 0.052), brow_tilt=-9.0, smile_span=9.0, smile_rise=4.0,
            )
            # Short hair with a thick fringe swept across the brow to one side, where
            # it kicks up; a lime clip holds the other end back.
            add_friend_hair(f"{prefix}_hair_cap", 38.0, -27.0, hair, thickness=0.009)
            add_face_decal(f"{prefix}_hair_fringe", 6.0, 32.0, 0.215, 0.058, hair, lift=0.034, tilt=-11.0)
            add_ico(f"{prefix}_hair_kick", tuple(head_point(47.0, 37.0, 0.012)), (0.085, 0.07, 0.05), hair, subdivisions=3, smooth=True, rotation=(math.radians(-18.0), math.radians(34.0), math.radians(-24.0)))
            add_face_decal(f"{prefix}_hair_clip", -34.0, 29.0, 0.032, 0.013, lime, lift=0.03, tilt=26.0)


def friend_idle(*, tempo: int, breath: float, sway: float, look: float, nod: float, tilt: float, arms: tuple[float, float]) -> Callable[[float], Pose]:
    """A friend's idle: the player's breathing bob and sway, scaled to the friend's energy.

    tempo is breaths per loop. breath lifts the body (meters) and sway rocks it
    (degrees); look turns the head from side to side, around a nod and a tilt it
    always holds (degrees). arms is how far the L and R arm sway (degrees).
    """
    def pose(phase: float) -> Pose:
        lift = math.sin(tempo * phase)
        rock = math.sin(phase)
        return {
            "pivot_leg_L": (STILL, STILL),
            "pivot_leg_R": (STILL, STILL),
            "pivot_arm_L": ((arms[0] * rock, -0.5 * arms[0] * lift, 0.0), STILL),
            "pivot_arm_R": ((-arms[1] * rock, 0.5 * arms[1] * lift, 0.0), STILL),
            "pivot_body": ((0.0, sway * rock, 0.0), (0.0, 0.0, breath * lift)),
            "pivot_head": ((nod + 1.2 * lift, tilt + 2.2 * rock, look * math.sin(phase + 0.7)), STILL),
        }

    return pose


# Friend A is quiet and a little downcast: slow breaths, her head bowed and tilted.
FRIEND_A_CLIPS: tuple[Clip, ...] = (
    ("idle", IDLE_FRAMES, 3, friend_idle(tempo=2, breath=0.0035, sway=0.7, look=2.5, nod=3.5, tilt=3.0, arms=(2.5, 2.5))),
)
# Friend B cannot keep still: quicker breaths, rocking, his head turning to look about.
FRIEND_B_CLIPS: tuple[Clip, ...] = (
    ("idle", IDLE_FRAMES, 3, friend_idle(tempo=3, breath=0.0055, sway=1.6, look=7.0, nod=-1.5, tilt=-2.0, arms=(1.2, 3.5))),
)

FRIEND_A_ARMS = Arms(
    key=FRIEND_A_KEY,
    hands=("friend_a_hand_L", "friend_a_hand_R"),
    # Her short sleeves sit on the shoulders of the dress; the bare forearms are what hang free.
    tubes=(("friend_a_forearm_L", 0.0), ("friend_a_forearm_R", 0.0)),
    body=(
        "friend_a_dress", "friend_a_dress_hem", "friend_a_dress_sash", "friend_a_dress_panel",
        "friend_a_leg_L", "friend_a_leg_R", "friend_a_shoe_L", "friend_a_shoe_R",
    ),
    looks={"": ()},
    clips=FRIEND_A_CLIPS,
)
FRIEND_B_ARMS = Arms(
    key=FRIEND_B_KEY,
    hands=("friend_b_hand_L", "friend_b_hand_R", "friend_b_elbow_L"),
    # The bent arm's forearm is free along its whole length.
    tubes=(("friend_b_sleeve_L", 0.5), ("friend_b_sleeve_R", 0.5), ("friend_b_forearm_L", 0.0)),
    body=(
        "friend_b_jacket", "friend_b_jacket_hem", "friend_b_shirt",
        "friend_b_leg_L", "friend_b_leg_R", "friend_b_shoe_L", "friend_b_shoe_R",
    ),
    looks={"": ()},
    clips=FRIEND_B_CLIPS,
)


# -----------------------------------------------------------------------------
# Prop modeling


def build_ball() -> None:
    root = begin_asset("ball", "Ball", "Hand-carried 34 cm low-poly patchwork play ball.")
    root["diameter_m"] = 0.34
    root["carry_origin"] = "centered horizontally at ground contact"
    ball = add_ico("ball_patchwork", (0.0, 0.0, 0.17), (0.17, 0.17, 0.17), MATERIALS["Ball Cyan"], subdivisions=3)
    for mat_name in ("Ball Coral", "Ball Yellow", "Ball Purple"):
        ball.data.materials.append(MATERIALS[mat_name])
    # Deterministic material patches use face direction rather than an image texture.
    for index, polygon in enumerate(ball.data.polygons):
        normal = polygon.normal
        if normal.z > 0.52:
            polygon.material_index = 2
        elif normal.x > 0.50:
            polygon.material_index = 1
        elif normal.y < -0.55:
            polygon.material_index = 3
        elif index % 13 == 0:
            polygon.material_index = 2
        else:
            polygon.material_index = 0


def build_block() -> None:
    root = begin_asset("block", "Building Block", "Colorful rounded 30 cm toy building block with four grip studs.")
    root["size_m"] = "0.30 x 0.24 x 0.295"
    root["carry_origin"] = "centered horizontally at ground contact"
    body = add_rounded_cube("block_body", (0.0, 0.0, 0.13), (0.30, 0.24, 0.26), MATERIALS["Block Coral"], bevel=0.025)
    for mat_name in ("Block Yellow", "Block Teal", "Block Purple"):
        body.data.materials.append(MATERIALS[mat_name])
    for polygon in body.data.polygons:
        normal = polygon.normal
        if normal.z > 0.7:
            polygon.material_index = 1
        elif normal.x > 0.7:
            polygon.material_index = 2
        elif normal.x < -0.7:
            polygon.material_index = 3
        elif normal.y < -0.7:
            polygon.material_index = 1
        else:
            polygon.material_index = 0
    for x in (-0.075, 0.075):
        for y in (-0.045, 0.045):
            add_cylinder(
                f"block_stud_{'L' if x < 0 else 'R'}_{'F' if y < 0 else 'B'}",
                (x, y, 0.2775),
                0.044,
                0.035,
                MATERIALS["Block Yellow"] if y < 0 else MATERIALS["Block Teal"],
                vertices=12,
                bevel=0.006,
            )
    # Matching raised diamonds keep the carry bounds centered while providing a
    # clear front read from either side of the play space.
    add_rounded_cube("block_front_badge", (0.0, -0.129, 0.13), (0.10, 0.022, 0.10), MATERIALS["Block Purple"], bevel=0.015, rotation=(0.0, math.radians(45), 0.0))
    add_rounded_cube("block_back_badge", (0.0, 0.129, 0.13), (0.10, 0.022, 0.10), MATERIALS["Block Purple"], bevel=0.015, rotation=(0.0, math.radians(45), 0.0))


# -----------------------------------------------------------------------------
# Export, source scene, preview, and validation


def export_asset(key: str) -> Path:
    root = ASSET_ROOTS[key]
    bpy.ops.object.select_all(action="DESELECT")
    root.location = (0.0, 0.0, 0.0)
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.context.view_layer.objects.active = root
    destination = OUTPUT_DIR / f"{key}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(destination),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        # Props have no clips; each NLA track name of a character becomes one animation.
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_optimize_animation_size=True,
        # Clips start at time zero, so a loop is exactly as long as its stride.
        export_anim_slide_to_zero=True,
    )
    return destination


def add_studio_object(obj: bpy.types.Object, collection: bpy.types.Collection) -> bpy.types.Object:
    move_to_collection(obj, collection)
    return obj


def point_at(obj: bpy.types.Object, target: tuple[float, float, float]) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def create_preview_scene() -> None:
    scene = bpy.context.scene
    studio = bpy.data.collections.new("STUDIO_PREVIEW_NOT_EXPORTED")
    scene.collection.children.link(studio)

    # Every player variant exports together; the lineup shows the runtime default
    # look (boy hair, trousers, beanie) so alternatives do not overlap it.
    mute_clips()
    for obj in ASSET_COLLECTIONS[PLAYER_KEY].objects:
        if obj.name.startswith(LINEUP_HIDDEN_VARIANTS):
            obj.hide_render = True
            obj.hide_set(True)

    # Source lineup remains editable while every GLB was exported at local origin.
    ASSET_ROOTS[PLAYER_KEY].location = (-2.75, 0.0, 0.0)
    # The preview deliberately shows the controllable player from the rear to
    # demonstrate the backpack/hood read expected from a third-person camera.
    ASSET_ROOTS[PLAYER_KEY].rotation_euler.z = math.radians(180.0)
    ASSET_ROOTS[FRIEND_A_KEY].location = (-1.25, 0.0, 0.0)
    ASSET_ROOTS[FRIEND_B_KEY].location = (0.30, 0.0, 0.0)
    ASSET_ROOTS["ball"].location = (1.45, 0.0, 0.0)
    ASSET_ROOTS["block"].location = (2.20, 0.0, 0.0)

    bpy.ops.mesh.primitive_plane_add(size=20.0, location=(0.0, 0.0, -0.006))
    ground = bpy.context.object
    ground.name = "Preview Ground"
    add_studio_object(ground, studio)
    ground_mat = bpy.data.materials.new("Preview Ground Material")
    ground_mat.diffuse_color = (0.11, 0.16, 0.19, 1.0)
    ground.data.materials.append(ground_mat)

    # Soft backdrop panel.
    bpy.ops.mesh.primitive_plane_add(size=12.0, location=(0.0, 1.15, 2.2), rotation=(math.radians(90.0), 0.0, 0.0))
    backdrop = bpy.context.object
    backdrop.name = "Preview Backdrop"
    add_studio_object(backdrop, studio)
    backdrop.data.materials.append(ground_mat)

    label_specs = (
        ("CARTOON PLAYER", -2.75),
        ("FRIEND A", -1.25),
        ("FRIEND B", 0.30),
        ("BALL", 1.45),
        ("BLOCK", 2.20),
    )
    for text_value, x in label_specs:
        curve = bpy.data.curves.new(f"Label {text_value}", "FONT")
        curve.body = text_value
        curve.align_x = "CENTER"
        curve.size = 0.16
        curve.extrude = 0.004
        label = bpy.data.objects.new(f"Label {text_value}", curve)
        studio.objects.link(label)
        label.location = (x, -0.47, 0.012)
        label.rotation_euler = (math.radians(90.0), 0.0, 0.0)
        curve.materials.append(MATERIALS["Soft White"])

    camera_data = bpy.data.cameras.new("Lineup Camera")
    camera = bpy.data.objects.new("Lineup Camera", camera_data)
    studio.objects.link(camera)
    camera.location = (-0.15, -8.1, 3.25)
    camera_data.lens = 46
    point_at(camera, (-0.15, 0.0, 0.72))
    scene.camera = camera

    def area_light(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float]) -> None:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        studio.objects.link(obj)
        obj.location = location
        point_at(obj, (0.0, 0.0, 0.72))

    area_light("Key Light", (-3.7, -4.8, 6.0), 1150.0, 4.0, (1.0, 0.82, 0.66))
    area_light("Fill Light", (4.5, -2.4, 3.6), 900.0, 4.0, (0.62, 0.78, 1.0))
    area_light("Rim Light", (0.5, 2.0, 4.0), 1200.0, 3.0, (0.70, 0.88, 1.0))

    world = bpy.data.worlds.new("Preview World") if not bpy.data.worlds else bpy.data.worlds[0]
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.035, 0.055, 0.075, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.32

    scene.render.filepath = "//cast-lineup.png"
    scene.render.image_settings.file_format = "PNG"


def world_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points: list[Vector] = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError("Imported file contains no mesh geometry")
    mins = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    maxs = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return mins, maxs


def validate_exports(paths: list[Path]) -> None:
    expected_heights = {
        PLAYER_KEY: (1.25, 1.36),
        FRIEND_A_KEY: (1.20, 1.30),
        FRIEND_B_KEY: (1.10, 1.20),
        "ball": (0.30, 0.38),
        "block": (0.27, 0.33),
    }
    expected_clips = {PLAYER_KEY: {"idle", "walk"}, FRIEND_A_KEY: {"idle"}, FRIEND_B_KEY: {"idle"}}
    print("\n=== Independent GLB validation ===")
    for path in paths:
        if not path.is_file() or path.stat().st_size < 1024:
            raise RuntimeError(f"Export is missing or unexpectedly small: {path}")
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=str(path))
        imported = list(bpy.context.scene.objects)
        meshes = [obj for obj in imported if obj.type == "MESH"]
        mins, maxs = world_bounds(meshes)
        height = maxs.z - mins.z  # glTF Y-up returns to Blender Z-up on import.
        low, high = expected_heights[path.stem]
        if not (low <= height <= high):
            raise RuntimeError(f"{path.name}: unexpected height {height:.4f} m")
        if abs(mins.z) > 0.006:
            raise RuntimeError(f"{path.name}: ground is z={mins.z:.5f} m after import, expected 0")
        # The importer names each pivot's action after its clip and the pivot.
        clips = {action.name.split("_")[0] for action in bpy.data.actions}
        if clips != expected_clips.get(path.stem, set()):
            raise RuntimeError(f"{path.name}: unexpected clips {sorted(clips)}")
        if path.stem in {"ball", "block"}:
            center_x = (mins.x + maxs.x) * 0.5
            center_y = (mins.y + maxs.y) * 0.5
            if abs(center_x) > 0.004 or abs(center_y) > 0.004:
                raise RuntimeError(f"{path.name}: prop is not centered horizontally")
        print(
            f"PASS {path.name:21} {path.stat().st_size:7d} bytes | "
            f"bounds=({mins.x:.3f},{mins.y:.3f},{mins.z:.3f}).."
            f"({maxs.x:.3f},{maxs.y:.3f},{maxs.z:.3f}) | meshes={len(meshes)} | clips={sorted(clips)}"
        )


# Close-up angles for `--views`: the camera's angle around the character (0 is
# its front), the height it looks at and its distance as multiples of the
# character's height, and the lens.
VIEWS = (
    ("front", 0.0, 0.5, 3.0, 60.0),
    ("threeq", 35.0, 0.5, 3.0, 60.0),
    ("back", 180.0, 0.5, 3.0, 60.0),
    ("face", 12.0, 0.72, 1.4, 70.0),
)


def render_views(directory: Path, heights: dict[str, float]) -> None:
    """Saves close-ups of each character alone, turned in front of the lineup's lights and backdrop."""
    scene = bpy.context.scene
    lineup_camera, resolution = scene.camera, (scene.render.resolution_x, scene.render.resolution_y)
    camera_data = bpy.data.cameras.new("View Camera")
    camera = bpy.data.objects.new("View Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y = 640, 860
    labels = [obj for obj in bpy.data.objects if obj.name.startswith("Label ")]
    for obj in labels:
        obj.hide_render = True
    for key, height in heights.items():
        for other, collection in ASSET_COLLECTIONS.items():
            collection.hide_render = other != key
        root = ASSET_ROOTS[key]
        placed = (root.location.copy(), root.rotation_euler.z)
        root.location = (0.0, 0.0, 0.0)
        for name, angle, target, distance, lens in VIEWS:
            # The character turns; the camera stays in front, where the lights are.
            root.rotation_euler.z = math.radians(angle)
            camera_data.lens = lens
            camera.location = (0.0, -height * distance, height * (target + distance * 0.08))
            point_at(camera, (0.0, 0.0, height * target))
            scene.render.filepath = str(directory / f"{key}-{name}.png")
            bpy.ops.render.render(write_still=True)
        root.location, root.rotation_euler.z = placed
    for collection in ASSET_COLLECTIONS.values():
        collection.hide_render = False
    for obj in labels:
        obj.hide_render = False
    bpy.data.objects.remove(camera)
    scene.camera = lineup_camera
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.filepath = "//cast-lineup.png"


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    views = Path(arguments[arguments.index("--views") + 1]).resolve() if "--views" in arguments else None
    if views:
        views.mkdir(parents=True, exist_ok=True)

    reset_scene()
    make_materials()
    build_player()
    animate(PLAYER_CLIPS)
    build_friend_a()
    animate(FRIEND_A_CLIPS, "friend_a_")
    build_friend_b()
    animate(FRIEND_B_CLIPS, "friend_b_")
    for name, arms in (("player", PLAYER_ARMS), ("Friend A", FRIEND_A_ARMS), ("Friend B", FRIEND_B_ARMS)):
        gaps = check_clearance(arms)
        for label, (gap, where) in gaps.items():
            print(f"{'PASS' if gap >= MIN_CLEARANCE else 'FAIL'} {name} arms {label}: {gap * 1000:.0f} mm at the closest, between {where}")
        if min(gap for gap, _ in gaps.values()) < MIN_CLEARANCE:
            raise RuntimeError(f"{name}'s arms come within {MIN_CLEARANCE * 1000:.0f} mm of the body")
    build_ball()
    build_block()

    exported = [export_asset(key) for key in (PLAYER_KEY, FRIEND_A_KEY, FRIEND_B_KEY, "ball", "block")]
    create_preview_scene()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    bpy.ops.render.render(write_still=True)
    if views:
        render_views(views, {key: float(ASSET_ROOTS[key]["height_m"]) for key in (PLAYER_KEY, FRIEND_A_KEY, FRIEND_B_KEY)})
    validate_exports(exported)
    print(f"\nSource:  {BLEND_PATH.relative_to(REPO_ROOT)}")
    print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")
    print("Generated and independently validated all five cast assets.")


if __name__ == "__main__":
    main()
