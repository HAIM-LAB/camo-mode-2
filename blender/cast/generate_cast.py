"""Generate the original low-poly cast and prop assets for Camo Mode 2.

Run from the repository root:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/cast/generate_cast.py

The modeling space is Blender's Z-up space. Blender's glTF exporter converts it to
Y-up; models face Blender -Y so that the exported forward direction is glTF +Z.
No images, fonts, or other external assets are used.
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


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
MATERIALS: dict[str, bpy.types.Material] = {}


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

    # Friend A: rounded plum/mint silhouette and open pose.
    material("A Skin", (0.23, 0.085, 0.04, 1.0))
    material("A Skin Light", (0.34, 0.14, 0.07, 1.0))
    material("A Hair", (0.055, 0.025, 0.06, 1.0), roughness=0.94)
    material("A Plum", (0.42, 0.10, 0.52, 1.0))
    material("A Lavender", (0.72, 0.43, 0.86, 1.0))
    material("A Mint", (0.12, 0.72, 0.61, 1.0))
    material("A Sun", (1.0, 0.67, 0.08, 1.0))

    # Friend B: angular navy/rust silhouette and grounded pose.
    material("B Skin", (0.72, 0.46, 0.26, 1.0))
    material("B Skin Light", (0.84, 0.59, 0.36, 1.0))
    material("B Hair", (0.025, 0.06, 0.13, 1.0), roughness=0.92)
    material("B Rust", (0.83, 0.25, 0.075, 1.0))
    material("B Rust Dark", (0.56, 0.10, 0.035, 1.0))
    material("B Sky", (0.08, 0.52, 0.82, 1.0))
    material("B Navy", (0.025, 0.10, 0.23, 1.0))
    material("B Lime", (0.65, 0.80, 0.12, 1.0))

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
    global CURRENT_COLLECTION, CURRENT_ROOT
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
    return root


def register_object(obj: bpy.types.Object) -> bpy.types.Object:
    if CURRENT_COLLECTION is None or CURRENT_ROOT is None:
        raise RuntimeError("begin_asset() must be called before adding asset geometry")
    move_to_collection(obj, CURRENT_COLLECTION)
    obj.parent = CURRENT_ROOT
    return obj


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
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_scale(obj)
    obj.data.materials.append(mat)
    return register_object(obj)


def add_uv_sphere(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=7, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    apply_scale(obj)
    obj.data.materials.append(mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
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


def add_face(
    prefix: str,
    skin: bpy.types.Material,
    skin_light: bpy.types.Material,
    *,
    center_y: float = -0.035,
    center_z: float = 1.175,
    head_scale: tuple[float, float, float] = (0.215, 0.19, 0.215),
) -> None:
    add_ico(f"{prefix}_head", (0.0, center_y, center_z), head_scale, skin, subdivisions=2)
    front_y = center_y - head_scale[1] * 0.91
    add_uv_sphere(f"{prefix}_eye_L", (-0.072, front_y - 0.008, center_z + 0.035), (0.027, 0.018, 0.034), MATERIALS["Ink"])
    add_uv_sphere(f"{prefix}_eye_R", (0.072, front_y - 0.008, center_z + 0.035), (0.027, 0.018, 0.034), MATERIALS["Ink"])
    add_ico(f"{prefix}_nose", (0.0, front_y - 0.010, center_z - 0.006), (0.024, 0.018, 0.025), skin_light, subdivisions=1)
    # Three tiny beads form a readable, restrained smile without textures.
    add_ico(f"{prefix}_smile_L", (-0.035, front_y - 0.012, center_z - 0.070), (0.017, 0.010, 0.012), MATERIALS["Smile"], subdivisions=1)
    add_ico(f"{prefix}_smile_C", (0.0, front_y - 0.013, center_z - 0.078), (0.017, 0.010, 0.012), MATERIALS["Smile"], subdivisions=1)
    add_ico(f"{prefix}_smile_R", (0.035, front_y - 0.012, center_z - 0.070), (0.017, 0.010, 0.012), MATERIALS["Smile"], subdivisions=1)
    add_ico(f"{prefix}_ear_L", (-head_scale[0] * 0.96, center_y, center_z), (0.032, 0.025, 0.048), skin, subdivisions=1)
    add_ico(f"{prefix}_ear_R", (head_scale[0] * 0.96, center_y, center_z), (0.032, 0.025, 0.048), skin, subdivisions=1)


def add_shoe(name: str, x: float, y: float, main_mat: bpy.types.Material, accent_mat: bpy.types.Material, *, angle: float = 0.0) -> None:
    add_rounded_cube(name, (x, y - 0.025, 0.075), (0.20, 0.30, 0.15), main_mat, bevel=0.035, rotation=(0.0, 0.0, angle))
    add_rounded_cube(f"{name}_sole", (x, y - 0.055, 0.018), (0.205, 0.305, 0.036), MATERIALS["Sole"], bevel=0.012, rotation=(0.0, 0.0, angle))
    add_rounded_cube(f"{name}_stripe", (x, y - 0.184, 0.083), (0.13, 0.016, 0.032), accent_mat, bevel=0.008, rotation=(0.0, 0.0, angle))


# -----------------------------------------------------------------------------
# Character modeling


def build_player() -> None:
    root = begin_asset(
        "player",
        "Player",
        "Friendly child explorer; teal hoodie and gold backpack are optimized for a third-person rear view.",
    )
    root["height_m"] = 1.405
    root["pose"] = "balanced ready stance"
    root["rear_read"] = "gold backpack, teal hood, coral trousers"

    add_shoe("player_shoe_L", -0.135, 0.005, MATERIALS["Player Teal Dark"], MATERIALS["Player Gold"], angle=-0.035)
    add_shoe("player_shoe_R", 0.135, 0.005, MATERIALS["Player Teal Dark"], MATERIALS["Player Gold"], angle=0.035)
    add_cylinder("player_leg_L", (-0.13, 0.015, 0.34), 0.092, 0.42, MATERIALS["Player Coral"], vertices=10, scale_xy=(0.88, 1.0))
    add_cylinder("player_leg_R", (0.13, 0.015, 0.34), 0.092, 0.42, MATERIALS["Player Coral"], vertices=10, scale_xy=(0.88, 1.0))
    add_cone("player_hoodie", (0.0, 0.0, 0.76), 0.25, 0.215, 0.45, (1.0, 0.75), MATERIALS["Player Teal"])
    add_rounded_cube("player_hoodie_pocket", (0.0, -0.195, 0.70), (0.25, 0.045, 0.13), MATERIALS["Player Teal Dark"], bevel=0.025)
    add_cylinder("player_neck", (0.0, 0.0, 0.995), 0.075, 0.105, MATERIALS["Player Skin"], vertices=10)

    # Relaxed, slightly splayed arms leave a strong controllable-character outline.
    add_segment("player_sleeve_L", (-0.205, -0.005, 0.91), (-0.295, -0.018, 0.635), 0.082, MATERIALS["Player Teal"])
    add_segment("player_sleeve_R", (0.205, -0.005, 0.91), (0.295, -0.018, 0.635), 0.082, MATERIALS["Player Teal"])
    add_ico("player_hand_L", (-0.31, -0.02, 0.57), (0.07, 0.055, 0.075), MATERIALS["Player Skin"], subdivisions=2)
    add_ico("player_hand_R", (0.31, -0.02, 0.57), (0.07, 0.055, 0.075), MATERIALS["Player Skin"], subdivisions=2)

    # Hood and hair sit behind the face. Blender +Y is exported character-back (-Z).
    add_ico("player_hood", (0.0, 0.105, 1.045), (0.225, 0.115, 0.185), MATERIALS["Player Teal Dark"], subdivisions=2)
    add_ico("player_hair_back", (0.0, 0.035, 1.195), (0.235, 0.185, 0.215), MATERIALS["Player Hair"], subdivisions=2)
    add_face("player", MATERIALS["Player Skin"], MATERIALS["Player Skin Light"], center_z=1.175, head_scale=(0.215, 0.19, 0.215))
    # A simple low beanie gives a crisp top silhouette without gender coding.
    add_ico("player_beanie_crown", (0.0, -0.002, 1.335), (0.232, 0.195, 0.070), MATERIALS["Player Gold"], subdivisions=2)
    add_rounded_cube("player_beanie_band", (0.0, -0.005, 1.300), (0.445, 0.34, 0.068), MATERIALS["Player Gold Dark"], bevel=0.025)

    # The bright pack is the player's primary rear-view identifier.
    add_rounded_cube("player_backpack", (0.0, 0.205, 0.765), (0.34, 0.145, 0.365), MATERIALS["Player Gold"], bevel=0.055)
    add_rounded_cube("player_pack_flap", (0.0, 0.284, 0.835), (0.30, 0.035, 0.12), MATERIALS["Player Gold Dark"], bevel=0.025)
    add_rounded_cube("player_pack_badge", (0.0, 0.307, 0.740), (0.095, 0.025, 0.095), MATERIALS["Player Teal"], bevel=0.018, rotation=(0.0, math.radians(45.0), 0.0))
    add_rounded_cube("player_pack_strap_L", (-0.105, 0.286, 0.935), (0.055, 0.025, 0.16), MATERIALS["Player Gold Dark"], bevel=0.018)
    add_rounded_cube("player_pack_strap_R", (0.105, 0.286, 0.935), (0.055, 0.025, 0.16), MATERIALS["Player Gold Dark"], bevel=0.018)


def build_friend_a() -> None:
    root = begin_asset(
        "friend-a",
        "Friend A",
        "Rounded child silhouette with twin puffs, mint dress, and a calm open pose.",
    )
    root["height_m"] = 1.405
    root["pose"] = "open and curious"

    add_shoe("friend_a_shoe_L", -0.13, 0.0, MATERIALS["A Plum"], MATERIALS["A Sun"], angle=-0.09)
    add_shoe("friend_a_shoe_R", 0.13, 0.0, MATERIALS["A Plum"], MATERIALS["A Sun"], angle=0.09)
    add_cylinder("friend_a_leg_L", (-0.125, 0.015, 0.35), 0.077, 0.42, MATERIALS["A Lavender"], vertices=10)
    add_cylinder("friend_a_leg_R", (0.125, 0.015, 0.35), 0.077, 0.42, MATERIALS["A Lavender"], vertices=10)
    add_cone("friend_a_dress", (0.0, 0.0, 0.72), 0.29, 0.205, 0.49, (1.0, 0.76), MATERIALS["A Mint"])
    add_rounded_cube("friend_a_waist_band", (0.0, -0.015, 0.835), (0.405, 0.29, 0.075), MATERIALS["A Sun"], bevel=0.025)
    add_rounded_cube("friend_a_front_panel", (0.0, -0.204, 0.70), (0.16, 0.035, 0.25), MATERIALS["A Plum"], bevel=0.018)
    add_cylinder("friend_a_neck", (0.0, 0.0, 0.99), 0.073, 0.105, MATERIALS["A Skin"], vertices=10)

    # Symmetric open arms communicate an outgoing/listening neutral stance.
    add_segment("friend_a_sleeve_L", (-0.195, -0.005, 0.89), (-0.315, -0.025, 0.755), 0.082, MATERIALS["A Lavender"])
    add_segment("friend_a_forearm_L", (-0.315, -0.025, 0.755), (-0.385, -0.055, 0.675), 0.061, MATERIALS["A Skin"])
    add_segment("friend_a_sleeve_R", (0.195, -0.005, 0.89), (0.315, -0.025, 0.755), 0.082, MATERIALS["A Lavender"])
    add_segment("friend_a_forearm_R", (0.315, -0.025, 0.755), (0.385, -0.055, 0.675), 0.061, MATERIALS["A Skin"])
    add_ico("friend_a_hand_L", (-0.395, -0.06, 0.655), (0.068, 0.052, 0.070), MATERIALS["A Skin"], subdivisions=2)
    add_ico("friend_a_hand_R", (0.395, -0.06, 0.655), (0.068, 0.052, 0.070), MATERIALS["A Skin"], subdivisions=2)

    # Large rounded hair masses and puffs make Friend A unmistakable in silhouette.
    add_ico("friend_a_hair_back", (0.0, 0.025, 1.19), (0.245, 0.20, 0.235), MATERIALS["A Hair"], subdivisions=2)
    add_ico("friend_a_puff_L", (-0.235, 0.01, 1.305), (0.105, 0.095, 0.105), MATERIALS["A Hair"], subdivisions=2)
    add_ico("friend_a_puff_R", (0.235, 0.01, 1.305), (0.105, 0.095, 0.105), MATERIALS["A Hair"], subdivisions=2)
    add_cylinder("friend_a_hair_tie_L", (-0.171, 0.01, 1.285), 0.032, 0.055, MATERIALS["A Sun"], vertices=8, rotation=(0.0, math.radians(90.0), 0.0))
    add_cylinder("friend_a_hair_tie_R", (0.171, 0.01, 1.285), 0.032, 0.055, MATERIALS["A Sun"], vertices=8, rotation=(0.0, math.radians(90.0), 0.0))
    add_face("friend_a", MATERIALS["A Skin"], MATERIALS["A Skin Light"], center_z=1.17, head_scale=(0.21, 0.188, 0.21))


def build_friend_b() -> None:
    root = begin_asset(
        "friend-b",
        "Friend B",
        "Angular child silhouette with swept navy hair, rust jacket, and a composed asymmetric pose.",
    )
    root["height_m"] = 1.415
    root["pose"] = "grounded and thoughtful"

    # One shoe is subtly forward; the stance remains static and animation-free.
    add_shoe("friend_b_shoe_L", -0.13, -0.035, MATERIALS["B Navy"], MATERIALS["B Lime"], angle=-0.025)
    add_shoe("friend_b_shoe_R", 0.13, 0.035, MATERIALS["B Navy"], MATERIALS["B Lime"], angle=0.025)
    add_cylinder("friend_b_leg_L", (-0.13, -0.01, 0.35), 0.088, 0.43, MATERIALS["B Navy"], vertices=8, scale_xy=(0.9, 1.0))
    add_cylinder("friend_b_leg_R", (0.13, 0.03, 0.35), 0.088, 0.43, MATERIALS["B Navy"], vertices=8, scale_xy=(0.9, 1.0))
    add_rounded_cube("friend_b_jacket", (0.0, 0.0, 0.76), (0.46, 0.30, 0.45), MATERIALS["B Rust"], bevel=0.055)
    add_cone("friend_b_shirt", (0.0, -0.165, 0.77), 0.16, 0.14, 0.36, (1.0, 0.22), MATERIALS["B Sky"], vertices=8)
    add_rounded_cube("friend_b_zip", (0.0, -0.184, 0.73), (0.026, 0.024, 0.35), MATERIALS["B Rust Dark"], bevel=0.006)
    add_rounded_cube("friend_b_collar_L", (-0.095, -0.186, 0.94), (0.16, 0.025, 0.08), MATERIALS["B Lime"], bevel=0.014, rotation=(0.0, math.radians(-18), 0.0))
    add_rounded_cube("friend_b_collar_R", (0.095, -0.186, 0.94), (0.16, 0.025, 0.08), MATERIALS["B Lime"], bevel=0.014, rotation=(0.0, math.radians(18), 0.0))
    add_cylinder("friend_b_neck", (0.0, 0.0, 1.005), 0.074, 0.11, MATERIALS["B Skin"], vertices=10)

    # Left arm crosses lightly toward the jacket; right arm rests down.
    add_segment("friend_b_sleeve_L_upper", (-0.205, 0.0, 0.91), (-0.27, -0.035, 0.715), 0.083, MATERIALS["B Rust"])
    add_segment("friend_b_forearm_L", (-0.27, -0.035, 0.715), (-0.13, -0.19, 0.655), 0.061, MATERIALS["B Skin"])
    add_ico("friend_b_hand_L", (-0.11, -0.195, 0.65), (0.07, 0.052, 0.07), MATERIALS["B Skin"], subdivisions=2)
    add_segment("friend_b_sleeve_R", (0.205, 0.0, 0.91), (0.275, 0.0, 0.64), 0.083, MATERIALS["B Rust"])
    add_ico("friend_b_hand_R", (0.285, 0.0, 0.575), (0.07, 0.052, 0.074), MATERIALS["B Skin"], subdivisions=2)

    add_ico("friend_b_hair_back", (0.0, 0.025, 1.195), (0.24, 0.195, 0.22), MATERIALS["B Hair"], subdivisions=2)
    add_face("friend_b", MATERIALS["B Skin"], MATERIALS["B Skin Light"], center_z=1.17, head_scale=(0.212, 0.188, 0.212))
    # Offset facets create an angular swept top, contrasting Friend A's twin circles.
    add_ico("friend_b_sweep_main", (0.075, -0.005, 1.335), (0.185, 0.15, 0.080), MATERIALS["B Hair"], subdivisions=1, rotation=(0.0, math.radians(-10), math.radians(-12)))
    add_ico("friend_b_sweep_tip", (0.195, -0.008, 1.326), (0.105, 0.125, 0.078), MATERIALS["B Hair"], subdivisions=1, rotation=(0.0, math.radians(-15), math.radians(-22)))
    add_ico("friend_b_hair_clip", (-0.145, -0.183, 1.295), (0.04, 0.018, 0.055), MATERIALS["B Lime"], subdivisions=1, rotation=(0.0, math.radians(15), 0.0))


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

    # Source lineup remains editable while every GLB was exported at local origin.
    ASSET_ROOTS["player"].location = (-2.75, 0.0, 0.0)
    # The preview deliberately shows the controllable player from the rear to
    # demonstrate the backpack/hood read expected from a third-person camera.
    ASSET_ROOTS["player"].rotation_euler.z = math.radians(180.0)
    ASSET_ROOTS["friend-a"].location = (-1.25, 0.0, 0.0)
    ASSET_ROOTS["friend-b"].location = (0.30, 0.0, 0.0)
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
        ("PLAYER · REAR", -2.75),
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
        "player": (1.34, 1.47),
        "friend-a": (1.34, 1.47),
        "friend-b": (1.34, 1.47),
        "ball": (0.30, 0.38),
        "block": (0.27, 0.33),
    }
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
        if path.stem in {"ball", "block"}:
            center_x = (mins.x + maxs.x) * 0.5
            center_y = (mins.y + maxs.y) * 0.5
            if abs(center_x) > 0.004 or abs(center_y) > 0.004:
                raise RuntimeError(f"{path.name}: prop is not centered horizontally")
        print(
            f"PASS {path.name:13} {path.stat().st_size:7d} bytes | "
            f"bounds=({mins.x:.3f},{mins.y:.3f},{mins.z:.3f}).."
            f"({maxs.x:.3f},{maxs.y:.3f},{maxs.z:.3f}) | meshes={len(meshes)}"
        )


def main() -> None:
    reset_scene()
    make_materials()
    build_player()
    build_friend_a()
    build_friend_b()
    build_ball()
    build_block()

    exported = [export_asset(key) for key in ("player", "friend-a", "friend-b", "ball", "block")]
    create_preview_scene()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH))
    bpy.ops.render.render(write_still=True)
    validate_exports(exported)
    print(f"\nSource:  {BLEND_PATH.relative_to(REPO_ROOT)}")
    print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")
    print("Generated and independently validated all five cast assets.")


if __name__ == "__main__":
    main()
