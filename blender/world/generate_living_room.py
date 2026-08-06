#!/usr/bin/env python3
"""Generate the Camo Mode 2 living-room environment.

Run from the repository root:
    /Applications/Blender.app/Contents/MacOS/Blender --background \
        --python blender/world/generate_living_room.py

The scene is authored through helpers that accept glTF contract coordinates:
X right, Y up, +Z forward. Blender's exporter converts its native Z-up scene to
Y-up glTF. No external textures or linked files are used.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterable

import bpy
from mathutils import Vector


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[2]
BLEND_PATH = SCRIPT_PATH.with_name("living-room.blend")
PREVIEW_PATH = SCRIPT_PATH.with_name("living-room-preview.png")
GLB_PATH = REPO_ROOT / "public" / "assets" / "world" / "living-room.glb"

ROOM_X = (-6.0, 6.0)
ROOM_Z = (-4.5, 4.5)
ANCHORS = {
    "Camo": (-3.0, 0.0, -2.0),
    "Friend_A": (2.0, 0.0, -1.0),
    "Friend_B": (3.5, 0.0, -1.0),
    "Ball": (-1.0, 0.0, 1.0),
    "Block": (0.5, 0.0, 1.0),
    "Player_Spawn": (-4.0, 0.0, 3.0),
}

COLLECTIONS: dict[str, bpy.types.Collection] = {}
MATERIALS: dict[str, bpy.types.Material] = {}
OBSTACLES: list[tuple[str, float, float, float, float]] = []


def gltf_to_blender(point: Iterable[float]) -> tuple[float, float, float]:
    """Map contract (X right, Y up, Z forward) into Blender (X, Y, Z-up)."""
    x, y, z = point
    return (x, -z, y)


def color(hex_value: str) -> tuple[float, float, float, float]:
    value = hex_value.lstrip("#")
    rgb = tuple(int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    # Convert sRGB colors to linear values for Blender's material inputs.
    linear = tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in rgb)
    return (*linear, 1.0)


def material(
    name: str,
    hex_value: str,
    *,
    roughness: float = 0.72,
    metallic: float = 0.0,
    emission: str | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color(hex_value)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color(hex_value)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    if emission:
        shader.inputs["Emission Color"].default_value = color(emission)
        shader.inputs["Emission Strength"].default_value = emission_strength
    MATERIALS[name] = mat
    return mat


def move_to_collection(obj: bpy.types.Object, collection_name: str) -> None:
    target = COLLECTIONS[collection_name]
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)


def assign_material(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    if hasattr(obj.data, "materials"):
        obj.data.materials.append(mat)


def box(
    name: str,
    loc: tuple[float, float, float],
    size: tuple[float, float, float],
    mat: bpy.types.Material,
    collection: str,
    *,
    bevel: float = 0.0,
    yaw: float = 0.0,
) -> bpy.types.Object:
    """Create a box using contract location/dimensions (X width, Y height, Z depth)."""
    bpy.ops.mesh.primitive_cube_add(location=gltf_to_blender(loc), rotation=(0.0, 0.0, yaw))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (size[0], size[2], size[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_material(obj, mat)
    if bevel > 0.0:
        modifier = obj.modifiers.new("Soft edges", "BEVEL")
        modifier.width = min(bevel, min(size) * 0.24)
        modifier.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    move_to_collection(obj, collection)
    return obj


def cylinder(
    name: str,
    loc: tuple[float, float, float],
    radius: float,
    height: float,
    mat: bpy.types.Material,
    collection: str,
    *,
    vertices: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=height,
        location=gltf_to_blender(loc),
    )
    obj = bpy.context.object
    obj.name = name
    assign_material(obj, mat)
    move_to_collection(obj, collection)
    return obj


def cone(
    name: str,
    loc: tuple[float, float, float],
    radius1: float,
    radius2: float,
    height: float,
    mat: bpy.types.Material,
    collection: str,
    *,
    vertices: int = 12,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius1,
        radius2=radius2,
        depth=height,
        location=gltf_to_blender(loc),
    )
    obj = bpy.context.object
    obj.name = name
    assign_material(obj, mat)
    move_to_collection(obj, collection)
    return obj


def ico_sphere(
    name: str,
    loc: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
    collection: str,
    *,
    subdivisions: int = 1,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=subdivisions,
        radius=1.0,
        location=gltf_to_blender(loc),
    )
    obj = bpy.context.object
    obj.name = name
    obj.scale = (scale[0], scale[2], scale[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_material(obj, mat)
    move_to_collection(obj, collection)
    return obj


def cylinder_between(
    name: str,
    start: tuple[float, float, float],
    end: tuple[float, float, float],
    radius: float,
    mat: bpy.types.Material,
    collection: str,
    *,
    vertices: int = 10,
) -> bpy.types.Object:
    start_b = Vector(gltf_to_blender(start))
    end_b = Vector(gltf_to_blender(end))
    delta = end_b - start_b
    midpoint = (start_b + end_b) * 0.5
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=delta.length,
        location=midpoint,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = delta.to_track_quat("Z", "Y")
    assign_material(obj, mat)
    move_to_collection(obj, collection)
    return obj


def register_obstacle(name: str, center_x: float, center_z: float, width: float, depth: float) -> None:
    OBSTACLES.append((name, center_x, center_z, width, depth))


def rotate_offset(origin: tuple[float, float], offset: tuple[float, float], yaw: float) -> tuple[float, float]:
    ox, oz = origin
    dx, dz = offset
    return (
        ox + math.cos(yaw) * dx + math.sin(yaw) * dz,
        oz - math.sin(yaw) * dx + math.cos(yaw) * dz,
    )


def add_plant(
    prefix: str,
    x: float,
    z: float,
    scale: float,
    *,
    outdoor: bool = False,
    leaf_materials: tuple[bpy.types.Material, ...] | None = None,
) -> None:
    collection = "Outdoor" if outdoor else "Greenery"
    pot_mat = MATERIALS["Patio Pot"] if outdoor else MATERIALS["Terracotta"]
    leaves = leaf_materials or (MATERIALS["Leaf Sage"], MATERIALS["Leaf Deep"])
    cylinder(f"{prefix}_Pot", (x, 0.24 * scale, z), 0.31 * scale, 0.48 * scale, pot_mat, collection)
    cylinder(f"{prefix}_Soil", (x, 0.49 * scale, z), 0.25 * scale, 0.035 * scale, MATERIALS["Soil"], collection)

    stem_specs = [
        ((0.0, 0.48, 0.0), (-0.18, 1.28, 0.06)),
        ((0.02, 0.48, 0.0), (0.22, 1.10, -0.09)),
        ((-0.02, 0.48, 0.0), (0.10, 1.42, 0.15)),
        ((0.0, 0.48, 0.02), (-0.28, 0.96, -0.12)),
    ]
    for index, (start, end) in enumerate(stem_specs):
        start_world = (x + start[0] * scale, start[1] * scale, z + start[2] * scale)
        end_world = (x + end[0] * scale, end[1] * scale, z + end[2] * scale)
        cylinder_between(
            f"{prefix}_Stem_{index + 1}",
            start_world,
            end_world,
            0.025 * scale,
            MATERIALS["Stem"],
            collection,
            vertices=8,
        )
        ico_sphere(
            f"{prefix}_Leaf_{index + 1}",
            end_world,
            (0.27 * scale, 0.16 * scale, 0.38 * scale),
            leaves[index % len(leaves)],
            collection,
            subdivisions=1,
        )


def add_shrub(prefix: str, x: float, z: float, scale: float) -> None:
    for index, (dx, dy, dz, radius) in enumerate(
        [
            (-0.34, 0.42, 0.02, 0.48),
            (0.12, 0.54, 0.08, 0.58),
            (0.48, 0.38, -0.04, 0.42),
            (-0.02, 0.75, -0.08, 0.44),
        ]
    ):
        ico_sphere(
            f"{prefix}_{index + 1}",
            (x + dx * scale, dy * scale, z + dz * scale),
            (radius * scale, radius * 0.85 * scale, radius * scale),
            MATERIALS["Outdoor Leaf A"] if index % 2 == 0 else MATERIALS["Outdoor Leaf B"],
            "Outdoor",
            subdivisions=1,
        )


def add_tree(prefix: str, x: float, z: float, scale: float) -> None:
    cylinder(f"{prefix}_Trunk", (x, 1.1 * scale, z), 0.16 * scale, 2.2 * scale, MATERIALS["Bark"], "Outdoor", vertices=9)
    canopy_specs = [
        (-0.38, 2.25, 0.05, 0.78),
        (0.35, 2.20, 0.08, 0.82),
        (0.00, 2.75, -0.04, 0.92),
        (0.10, 3.18, 0.02, 0.64),
    ]
    for index, (dx, dy, dz, radius) in enumerate(canopy_specs):
        ico_sphere(
            f"{prefix}_Canopy_{index + 1}",
            (x + dx * scale, dy * scale, z + dz * scale),
            (radius * scale, radius * 0.9 * scale, radius * scale),
            MATERIALS["Outdoor Leaf A"] if index % 2 == 0 else MATERIALS["Outdoor Leaf B"],
            "Outdoor",
            subdivisions=2,
        )


def create_collections() -> None:
    for name in ("Architecture", "Furniture", "Decor", "Greenery", "Outdoor", "Contract", "Lighting"):
        collection = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(collection)
        COLLECTIONS[name] = collection


def create_materials() -> None:
    material("Warm White", "#F2E7D5")
    material("Trim White", "#FFF8EC")
    material("Oak Floor", "#C98F57")
    material("Oak Light", "#D9A66F")
    material("Oak Dark", "#855737")
    material("Walnut", "#62402F")
    material("Sage Sofa", "#74806B")
    material("Sage Sofa Dark", "#56614F")
    material("Cream Fabric", "#E9DCC4")
    material("Mustard Fabric", "#C6923F")
    material("Coral", "#C96D52")
    material("Rug Clay", "#B95F49")
    material("Rug Border", "#E5C69F")
    material("Charcoal", "#25282A", roughness=0.48)
    material("Screen", "#182526", roughness=0.28)
    material("Brass", "#B48A49", roughness=0.34, metallic=0.55)
    material("Terracotta", "#A85439")
    material("Patio Pot", "#D1C0A3")
    material("Soil", "#35271E")
    material("Stem", "#466044")
    material("Leaf Sage", "#708764")
    material("Leaf Deep", "#385A43")
    material("Patio Stone", "#B8ADA0")
    material("Patio Stone Light", "#CFC5B7")
    material("Grass", "#668B55")
    material("Fence", "#9C7652")
    material("Bark", "#684834")
    material("Outdoor Leaf A", "#4E7A48")
    material("Outdoor Leaf B", "#79A35E")
    material("Sky Accent", "#BFD9D8")
    material("Lamp Glow", "#F7C979", emission="#F7C979", emission_strength=1.7)
    material("Frame Green", "#31514B")


def build_architecture() -> None:
    # Floor top is exactly contract Y=0. The room footprint is exactly 12m x 9m.
    box("Floor_Slab_12x9m", (0.0, -0.09, 0.0), (12.0, 0.18, 9.0), MATERIALS["Oak Floor"], "Architecture")

    # Subtle inset plank lines add warmth without textures or expensive geometry.
    for index, z in enumerate((-3.75, -3.0, -2.25, -1.5, -0.75, 0.0, 0.75, 1.5, 2.25, 3.0, 3.75)):
        box(f"Floor_Plank_Line_{index + 1:02d}", (0.0, 0.002, z), (11.72, 0.004, 0.018), MATERIALS["Oak Dark"], "Architecture")
    for index, x in enumerate((-4.0, -2.0, 0.0, 2.0, 4.0)):
        box(f"Floor_Board_Joint_{index + 1:02d}", (x, 0.003, 0.0), (0.015, 0.005, 8.72), MATERIALS["Oak Light"], "Architecture")

    wall = MATERIALS["Warm White"]
    trim = MATERIALS["Trim White"]
    # Side walls and an open camera-facing front keep the whole room readable.
    box("Wall_Left", (-5.9, 1.65, 0.0), (0.20, 3.3, 9.0), wall, "Architecture")
    box("Wall_Right", (5.9, 1.65, 0.0), (0.20, 3.3, 9.0), wall, "Architecture")

    # Rear wall has a 4.8m-wide patio opening from X=-0.8 to X=4.0.
    box("Wall_Back_Left", (-3.4, 1.65, -4.4), (5.2, 3.3, 0.20), wall, "Architecture")
    box("Wall_Back_Right", (5.0, 1.65, -4.4), (2.0, 3.3, 0.20), wall, "Architecture")
    box("Wall_Back_Header", (1.6, 2.98, -4.4), (4.8, 0.64, 0.20), wall, "Architecture")

    # Baseboards and doorway framing are intentionally high contrast at gameplay distance.
    box("Baseboard_Left", (-5.76, 0.11, 0.0), (0.08, 0.22, 8.7), trim, "Architecture", bevel=0.025)
    box("Baseboard_Right", (5.76, 0.11, 0.0), (0.08, 0.22, 8.7), trim, "Architecture", bevel=0.025)
    box("Baseboard_Back_Left", (-3.38, 0.11, -4.27), (4.95, 0.22, 0.08), trim, "Architecture", bevel=0.025)
    box("Baseboard_Back_Right", (5.0, 0.11, -4.27), (1.72, 0.22, 0.08), trim, "Architecture", bevel=0.025)
    for name, x in (("Patio_Frame_Left", -0.72), ("Patio_Frame_Mullion", 1.18), ("Patio_Frame_Right", 3.92)):
        box(name, (x, 1.33, -4.27), (0.10, 2.66, 0.12), MATERIALS["Frame Green"], "Architecture", bevel=0.02)
    box("Patio_Frame_Top", (1.6, 2.63, -4.27), (4.68, 0.10, 0.12), MATERIALS["Frame Green"], "Architecture", bevel=0.02)
    box("Patio_Threshold", (1.6, 0.025, -4.34), (4.68, 0.05, 0.24), MATERIALS["Brass"], "Architecture", bevel=0.018)

    # A pale fixed panel implies a sliding door while the right 2.7m remains visibly open.
    box("Patio_Fixed_Glass_Stylized", (0.22, 1.34, -4.31), (1.76, 2.42, 0.025), MATERIALS["Sky Accent"], "Architecture", bevel=0.01)
    # Inner inset makes the opaque stylized panel read as glazing, not a solid door.
    box("Patio_Glass_Highlight", (0.22, 1.45, -4.285), (1.48, 2.02, 0.018), MATERIALS["Trim White"], "Architecture", bevel=0.015)
    box("Patio_Glass_View", (0.22, 1.45, -4.27), (1.34, 1.88, 0.015), MATERIALS["Sky Accent"], "Architecture", bevel=0.015)


def build_rug_and_seating() -> None:
    # Thin rug is walkable and spans the ball/block area without occupying it.
    box("Rug_Border", (0.55, 0.018, 1.90), (5.35, 0.036, 3.35), MATERIALS["Rug Border"], "Furniture", bevel=0.16)
    box("Rug_Clay_Inset", (0.55, 0.039, 1.90), (4.88, 0.022, 2.88), MATERIALS["Rug Clay"], "Furniture", bevel=0.14)
    for index, x in enumerate((-0.95, -0.45, 0.05, 0.55, 1.05, 1.55, 2.05)):
        box(f"Rug_Dash_{index + 1}", (x, 0.054, 1.90), (0.26, 0.016, 0.06), MATERIALS["Rug Border"], "Decor", bevel=0.02)

    # Three-seat sofa runs along the right wall, leaving the central anchors open.
    sofa_x, sofa_z = 4.93, 2.25
    box("Sofa_Base", (sofa_x, 0.34, sofa_z), (1.48, 0.56, 3.45), MATERIALS["Sage Sofa Dark"], "Furniture", bevel=0.16)
    box("Sofa_Back", (5.48, 0.93, sofa_z), (0.34, 1.22, 3.45), MATERIALS["Sage Sofa"], "Furniture", bevel=0.14)
    box("Sofa_Arm_Front", (4.93, 0.72, 3.84), (1.45, 0.82, 0.28), MATERIALS["Sage Sofa"], "Furniture", bevel=0.13)
    box("Sofa_Arm_Back", (4.93, 0.72, 0.66), (1.45, 0.82, 0.28), MATERIALS["Sage Sofa"], "Furniture", bevel=0.13)
    for index, z in enumerate((1.18, 2.25, 3.32)):
        box(f"Sofa_Seat_Cushion_{index + 1}", (4.72, 0.67, z), (1.03, 0.24, 0.94), MATERIALS["Sage Sofa"], "Furniture", bevel=0.13)
        box(f"Sofa_Back_Cushion_{index + 1}", (5.20, 1.13, z), (0.30, 0.78, 0.88), MATERIALS["Sage Sofa"], "Furniture", bevel=0.13)
    box("Sofa_Pillow_Cream", (4.72, 1.02, 0.92), (0.62, 0.62, 0.18), MATERIALS["Cream Fabric"], "Decor", bevel=0.12, yaw=math.radians(-8))
    box("Sofa_Pillow_Coral", (4.72, 1.03, 3.50), (0.58, 0.58, 0.18), MATERIALS["Coral"], "Decor", bevel=0.12, yaw=math.radians(9))
    register_obstacle("Sofa", sofa_x, sofa_z, 1.55, 3.55)

    # Angled accent chair faces the rug and makes the seating group instantly legible.
    chair_origin = (-4.58, 0.48)
    chair_yaw = math.radians(-22)
    for name, offset, y, size, mat_name in (
        ("Chair_Base", (0.0, 0.0), 0.32, (1.42, 0.48, 1.38), "Walnut"),
        ("Chair_Seat", (0.0, -0.05), 0.64, (1.20, 0.25, 1.08), "Mustard Fabric"),
        ("Chair_Back", (0.0, -0.56), 1.09, (1.30, 1.05, 0.24), "Mustard Fabric"),
        ("Chair_Arm_Left", (-0.65, 0.0), 0.79, (0.18, 0.55, 1.22), "Walnut"),
        ("Chair_Arm_Right", (0.65, 0.0), 0.79, (0.18, 0.55, 1.22), "Walnut"),
    ):
        px, pz = rotate_offset(chair_origin, offset, chair_yaw)
        box(name, (px, y, pz), size, MATERIALS[mat_name], "Furniture", bevel=0.10, yaw=chair_yaw)
    register_obstacle("Accent Chair", chair_origin[0], chair_origin[1], 1.65, 1.65)


def build_tables_and_storage() -> None:
    # Low oval-ish coffee table assembled from softly beveled geometry.
    table_x, table_z = 1.45, 3.05
    box("Coffee_Table_Top", (table_x, 0.43, table_z), (2.15, 0.16, 0.90), MATERIALS["Oak Light"], "Furniture", bevel=0.18)
    for index, (dx, dz) in enumerate(((-0.78, -0.25), (0.78, -0.25), (-0.78, 0.25), (0.78, 0.25))):
        cylinder(f"Coffee_Table_Leg_{index + 1}", (table_x + dx, 0.22, table_z + dz), 0.075, 0.42, MATERIALS["Walnut"], "Furniture", vertices=10)
    box("Coffee_Table_Book", (1.18, 0.545, 3.06), (0.58, 0.07, 0.38), MATERIALS["Coral"], "Decor", bevel=0.035, yaw=math.radians(-8))
    register_obstacle("Coffee Table", table_x, table_z, 2.25, 1.0)

    # Media console and screen occupy the solid rear wall, away from all anchors.
    console_x, console_z = -3.45, -4.02
    box("Media_Console_Body", (console_x, 0.43, console_z), (3.35, 0.66, 0.55), MATERIALS["Walnut"], "Furniture", bevel=0.09)
    for index, x in enumerate((-4.42, -3.45, -2.48)):
        box(f"Media_Console_Door_{index + 1}", (x, 0.44, -3.72), (0.82, 0.45, 0.035), MATERIALS["Oak Dark"], "Furniture", bevel=0.04)
        cylinder(f"Media_Console_Knob_{index + 1}", (x, 0.44, -3.685), 0.035, 0.035, MATERIALS["Brass"], "Decor", vertices=10)
    for index, x in enumerate((-4.72, -2.18)):
        cylinder(f"Media_Console_Leg_{index + 1}", (x, 0.12, -4.02), 0.055, 0.25, MATERIALS["Walnut"], "Furniture", vertices=10)
    box("Television_Frame", (-3.45, 1.63, -4.21), (2.55, 1.35, 0.12), MATERIALS["Charcoal"], "Furniture", bevel=0.08)
    box("Television_Screen", (-3.45, 1.63, -4.135), (2.34, 1.14, 0.035), MATERIALS["Screen"], "Furniture", bevel=0.045)
    box("Television_Stand", (-3.45, 0.87, -4.08), (0.55, 0.13, 0.24), MATERIALS["Charcoal"], "Furniture", bevel=0.035)
    register_obstacle("Media Console", console_x, console_z, 3.45, 0.75)

    # Narrow open shelving in the rear-right corner.
    shelf_x, shelf_z = 5.12, -3.98
    for index, y in enumerate((0.18, 0.82, 1.46, 2.10)):
        box(f"Shelf_Board_{index + 1}", (shelf_x, y, shelf_z), (1.15, 0.10, 0.55), MATERIALS["Oak Dark"], "Furniture", bevel=0.035)
    for index, x in enumerate((4.62, 5.62)):
        box(f"Shelf_Upright_{index + 1}", (x, 1.14, shelf_z), (0.10, 2.18, 0.52), MATERIALS["Oak Dark"], "Furniture", bevel=0.03)
    box("Shelf_Book_1", (4.87, 0.54, -3.96), (0.12, 0.50, 0.34), MATERIALS["Coral"], "Decor", bevel=0.018)
    box("Shelf_Book_2", (5.04, 0.49, -3.96), (0.12, 0.40, 0.34), MATERIALS["Mustard Fabric"], "Decor", bevel=0.018)
    cylinder("Shelf_Vase", (5.22, 1.18, -3.98), 0.16, 0.38, MATERIALS["Sky Accent"], "Decor", vertices=12)
    register_obstacle("Bookshelf", shelf_x, shelf_z, 1.3, 0.75)


def build_decor_and_greenery() -> None:
    # Side-wall art gives scale and color without consuming walkable floor.
    box("Wall_Art_Frame", (-5.77, 1.72, -1.18), (0.08, 1.30, 1.62), MATERIALS["Walnut"], "Decor", bevel=0.03)
    box("Wall_Art_Cream", (-5.72, 1.72, -1.18), (0.035, 1.12, 1.42), MATERIALS["Cream Fabric"], "Decor", bevel=0.02)
    box("Wall_Art_Sun", (-5.69, 1.82, -1.42), (0.025, 0.54, 0.54), MATERIALS["Mustard Fabric"], "Decor", bevel=0.04)
    box("Wall_Art_Horizon", (-5.685, 1.50, -0.95), (0.02, 0.18, 0.64), MATERIALS["Coral"], "Decor", bevel=0.03)

    # Floor lamp tucks behind the sofa's far end.
    lamp_x, lamp_z = 4.02, 4.02
    cylinder("Floor_Lamp_Base", (lamp_x, 0.055, lamp_z), 0.28, 0.11, MATERIALS["Brass"], "Decor", vertices=16)
    cylinder("Floor_Lamp_Stem", (lamp_x, 0.94, lamp_z), 0.035, 1.78, MATERIALS["Brass"], "Decor", vertices=10)
    cone("Floor_Lamp_Shade", (lamp_x, 1.81, lamp_z), 0.36, 0.22, 0.48, MATERIALS["Cream Fabric"], "Decor", vertices=16)
    cylinder("Floor_Lamp_Glow", (lamp_x, 1.63, lamp_z), 0.13, 0.10, MATERIALS["Lamp Glow"], "Decor", vertices=12)
    register_obstacle("Floor Lamp", lamp_x, lamp_z, 0.65, 0.65)

    add_plant("Indoor_Plant_Left", -5.12, -3.42, 1.02)
    add_plant("Indoor_Plant_Window", 4.55, -3.30, 0.78)
    register_obstacle("Left Plant", -5.12, -3.42, 0.72, 0.72)
    register_obstacle("Window Plant", 4.55, -3.30, 0.58, 0.58)


def build_outdoor_glimpse() -> None:
    # A shallow 2.4m patio and 2.0m lawn strip suggest a backyard without building
    # an explorable exterior. They sit behind the room's rear opening (Z < -4.5).
    box("Patio_Base", (0.0, -0.08, -5.70), (10.6, 0.16, 2.40), MATERIALS["Patio Stone"], "Outdoor")
    tile_width = 1.62
    tile_depth = 0.68
    for row, z in enumerate((-4.88, -5.62, -6.36)):
        offset = 0.42 if row % 2 else 0.0
        for col, x in enumerate((-4.15, -2.45, -0.75, 0.95, 2.65, 4.35)):
            box(
                f"Patio_Paver_{row + 1}_{col + 1}",
                (x + offset, 0.012, z),
                (tile_width, 0.024, tile_depth),
                MATERIALS["Patio Stone Light"] if (row + col) % 2 else MATERIALS["Patio Stone"],
                "Outdoor",
                bevel=0.035,
            )

    box("Backyard_Lawn", (0.0, -0.07, -7.75), (12.0, 0.14, 2.0), MATERIALS["Grass"], "Outdoor")

    # Low fence and shrubs terminate the view and communicate a compact yard.
    for index, x in enumerate((-5.4, -3.6, -1.8, 0.0, 1.8, 3.6, 5.4)):
        box(f"Fence_Post_{index + 1}", (x, 0.67, -8.72), (0.12, 1.34, 0.12), MATERIALS["Fence"], "Outdoor", bevel=0.025)
    for index, y in enumerate((0.34, 0.98)):
        box(f"Fence_Rail_{index + 1}", (0.0, y, -8.70), (12.0, 0.11, 0.12), MATERIALS["Fence"], "Outdoor", bevel=0.025)
    for index, x in enumerate((-4.95, -3.75, -2.55, -1.35, -0.15, 1.05, 2.25, 3.45, 4.65)):
        box(f"Fence_Slat_{index + 1}", (x, 0.65, -8.68), (0.78, 1.18, 0.08), MATERIALS["Fence"], "Outdoor", bevel=0.035)

    add_shrub("Backyard_Shrub_Left", -3.85, -7.86, 1.05)
    add_shrub("Backyard_Shrub_Right", 3.55, -7.75, 1.15)
    add_plant("Patio_Plant", 4.70, -5.56, 0.92, outdoor=True)
    add_tree("Backyard_Tree_Left", -5.05, -8.05, 0.78)
    add_tree("Backyard_Tree_Right", 5.15, -8.12, 0.72)

    # A tiny birdbath is a readable backyard silhouette, not a gameplay prop.
    cylinder("Birdbath_Base", (-1.75, 0.10, -7.50), 0.26, 0.20, MATERIALS["Patio Stone Light"], "Outdoor", vertices=12)
    cylinder("Birdbath_Stem", (-1.75, 0.52, -7.50), 0.09, 0.68, MATERIALS["Patio Stone Light"], "Outdoor", vertices=12)
    cylinder("Birdbath_Bowl", (-1.75, 0.84, -7.50), 0.36, 0.10, MATERIALS["Patio Stone Light"], "Outdoor", vertices=16)


def add_contract_anchors() -> None:
    collection = COLLECTIONS["Contract"]
    for label, position in ANCHORS.items():
        empty = bpy.data.objects.new(f"Anchor_{label}", None)
        empty.empty_display_type = "CIRCLE"
        empty.empty_display_size = 0.35
        empty.location = gltf_to_blender(position)
        empty["contract_position"] = list(position)
        empty["clearance_radius_m"] = 0.70 if label not in {"Ball", "Block"} else 0.45
        collection.objects.link(empty)
    collection.hide_render = True


def validate_clearances() -> None:
    failures: list[str] = []
    for anchor_name, (x, _y, z) in ANCHORS.items():
        clearance = 0.70 if anchor_name not in {"Ball", "Block"} else 0.45
        for obstacle_name, ox, oz, width, depth in OBSTACLES:
            # Distance from point to an axis-aligned furniture footprint.
            dx = max(abs(x - ox) - width * 0.5, 0.0)
            dz = max(abs(z - oz) - depth * 0.5, 0.0)
            distance = math.hypot(dx, dz)
            if distance < clearance:
                failures.append(f"{anchor_name} is only {distance:.2f}m from {obstacle_name}")
    if failures:
        raise RuntimeError("Anchor clearance validation failed:\n  " + "\n  ".join(failures))
    print(f"Validated {len(ANCHORS)} clear gameplay anchors against {len(OBSTACLES)} furniture footprints")


def add_camera_and_lighting() -> None:
    world = bpy.context.scene.world
    world.use_nodes = True
    world.color = (0.08, 0.08, 0.08)
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = color("#BFD6D7")
    background.inputs["Strength"].default_value = 0.34

    def light(name: str, kind: str, contract_loc: tuple[float, float, float], energy: float, light_color: str, size: float = 1.0) -> bpy.types.Object:
        data = bpy.data.lights.new(name=name, type=kind)
        data.energy = energy
        data.color = color(light_color)[:3]
        if kind == "AREA":
            data.shape = "DISK"
            data.size = size
        obj = bpy.data.objects.new(name, data)
        obj.location = gltf_to_blender(contract_loc)
        COLLECTIONS["Lighting"].objects.link(obj)
        return obj

    key = light("Daylight_From_Patio", "AREA", (1.6, 2.55, -3.90), 1250.0, "#FFF1D2", 4.2)
    point_camera(key, (0.8, 0.25, 0.6))
    fill = light("Warm_Interior_Fill", "AREA", (-2.4, 2.75, 2.2), 880.0, "#FFD9AE", 4.0)
    point_camera(fill, (0.0, 0.25, 0.8))
    sun = light("Backyard_Sun", "SUN", (-4.0, 7.0, -8.0), 2.0, "#FFF4DB")
    sun.rotation_euler = (math.radians(27), math.radians(-18), math.radians(-28))

    camera_data = bpy.data.cameras.new("Living_Room_Preview_Camera")
    camera = bpy.data.objects.new("Living_Room_Preview_Camera", camera_data)
    COLLECTIONS["Lighting"].objects.link(camera)
    camera.location = gltf_to_blender((-7.7, 6.2, 11.2))
    camera_data.lens = 42.0
    camera_data.sensor_width = 36.0
    point_camera(camera, (0.25, 0.80, -0.95))
    bpy.context.scene.camera = camera


def point_camera(obj: bpy.types.Object, contract_target: tuple[float, float, float]) -> None:
    target = Vector(gltf_to_blender(contract_target))
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def configure_scene() -> None:
    scene = bpy.context.scene
    scene.name = "Camo_Mode_2_Living_Room"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    scene["runtime_url"] = "/assets/world/living-room.glb"
    scene["coordinate_contract"] = "meters; glTF Y-up; ground Y=0; forward +Z; origin at room center"
    scene["room_footprint"] = "x=-6..6, z=-4.5..4.5"
    scene["generator"] = "blender/world/generate_living_room.py"

    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 760
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(PREVIEW_PATH)
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.look = "AgX - Medium High Contrast"


def save_render_export() -> None:
    BLEND_PATH.parent.mkdir(parents=True, exist_ok=True)
    GLB_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Save first so the editable source captures camera, lights, contract empties, and metadata.
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), check_existing=False)
    bpy.ops.render.render(write_still=True)

    # Cameras and lights are useful in the source/preview but omitted from the runtime asset.
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_materials="EXPORT",
        export_texcoords=False,
        export_normals=True,
        export_tangents=False,
        export_attributes=False,
    )

    size = GLB_PATH.stat().st_size
    if size < 50_000:
        raise RuntimeError(f"Exported GLB unexpectedly small: {size} bytes")
    print(f"Saved source:  {BLEND_PATH}")
    print(f"Saved preview: {PREVIEW_PATH}")
    print(f"Exported GLB: {GLB_PATH} ({size / 1024:.1f} KiB)")


def main() -> None:
    # Deterministically clear Blender's startup scene and orphaned data blocks.
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    for material_block in list(bpy.data.materials):
        bpy.data.materials.remove(material_block)

    create_collections()
    create_materials()
    configure_scene()
    build_architecture()
    build_rug_and_seating()
    build_tables_and_storage()
    build_decor_and_greenery()
    build_outdoor_glimpse()
    add_contract_anchors()
    validate_clearances()
    add_camera_and_lighting()
    save_render_export()


if __name__ == "__main__":
    main()
