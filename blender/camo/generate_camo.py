#!/usr/bin/env python3
"""Procedurally build and export the Camo guide character.

Run from the repository root:
    /Applications/Blender.app/Contents/MacOS/Blender --background \
      --python blender/camo/generate_camo.py

Authoring coordinates use Blender's Z-up convention. Blender's glTF exporter maps
Blender -Y to glTF +Z, so Camo faces -Y here and +Z in the exported GLB.
All dimensions are in meters and all materials are procedural/texture-free.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector


HERE = Path(__file__).resolve().parent
BLEND_PATH = HERE / "camo.blend"
GLB_PATH = HERE.parent.parent / "public" / "assets" / "camo" / "camo.glb"
PREVIEW_PATH = HERE / "camo_preview.png"

ASSET_COLLECTION = None
PREVIEW_COLLECTION = None
ROOT = None
ASSET_OBJECTS = []


def hex_color(value: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """Convert an sRGB hex color to Blender's linear color space."""
    value = value.lstrip("#")
    rgb = [int(value[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def linear(channel: float) -> float:
        return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4

    return linear(rgb[0]), linear(rgb[1]), linear(rgb[2]), alpha


def material(name: str, color: str, roughness: float = 0.72, metallic: float = 0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = hex_color(color)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = hex_color(color)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return mat


def move_to_collection(obj, collection):
    for old_collection in list(obj.users_collection):
        old_collection.objects.unlink(obj)
    collection.objects.link(obj)


def register_asset(obj, mat=None):
    move_to_collection(obj, ASSET_COLLECTION)
    obj.parent = ROOT
    if mat is not None:
        obj.data.materials.append(mat)
    ASSET_OBJECTS.append(obj)
    return obj


def add_ellipsoid(name, location, scale, mat, subdivisions=2, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler = rotation
    for polygon in obj.data.polygons:
        polygon.use_smooth = False
    return register_asset(obj, mat)


def add_cone(name, location, radius1, radius2, depth, mat, vertices=8, rotation=None):
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=radius1,
        radius2=radius2,
        depth=depth,
        end_fill_type="NGON",
        location=location,
    )
    obj = bpy.context.object
    obj.name = name
    if rotation is not None:
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = rotation
    return register_asset(obj, mat)


def add_segment(name, start, end, radius_start, radius_end, mat, vertices=8):
    start = Vector(start)
    end = Vector(end)
    direction = end - start
    midpoint = (start + end) * 0.5
    rotation = direction.to_track_quat("Z", "Y")
    return add_cone(
        name,
        midpoint,
        radius_start,
        radius_end,
        direction.length,
        mat,
        vertices=vertices,
        rotation=rotation,
    )


def add_triangle_prism(name, front_vertices, thickness, mat):
    """Create a small triangular prism facing Blender -Y."""
    front = [Vector(vertex) for vertex in front_vertices]
    back = [Vector((vertex.x, vertex.y + thickness, vertex.z)) for vertex in front]
    vertices = [tuple(vertex) for vertex in front + back]
    faces = [
        (0, 2, 1),
        (3, 4, 5),
        (0, 1, 4, 3),
        (1, 2, 5, 4),
        (2, 0, 3, 5),
    ]
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    ASSET_COLLECTION.objects.link(obj)
    obj.parent = ROOT
    ASSET_OBJECTS.append(obj)
    return obj


def catmull_rom(points, samples_per_span=5):
    vectors = [Vector(point) for point in points]
    padded = [vectors[0]] + vectors + [vectors[-1]]
    result = []
    for index in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[index - 1 : index + 3]
        for sample in range(samples_per_span):
            t = sample / samples_per_span
            t2 = t * t
            t3 = t2 * t
            point = 0.5 * (
                (2.0 * p1)
                + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
            )
            result.append(point)
    result.append(vectors[-1])
    return result


def add_tail(base_mat, stripe_mat):
    """Build a tapered, striped tube around a vertical-plane spiral."""
    control_points = [
        # The tail eases toward Camo's right side before curling. This keeps the
        # signature spiral legible from both front and three-quarter cameras.
        (0.00, 0.32, 0.36),
        (0.10, 0.45, 0.38),
        (0.23, 0.60, 0.32),
        (0.31, 0.64, 0.20),
        (0.33, 0.57, 0.105),
        (0.335, 0.45, 0.085),
        (0.332, 0.37, 0.15),
        (0.330, 0.37, 0.245),
        (0.328, 0.44, 0.30),
        (0.326, 0.52, 0.28),
        (0.324, 0.545, 0.22),
        (0.322, 0.50, 0.18),
        (0.320, 0.455, 0.205),
    ]
    centers = catmull_rom(control_points, samples_per_span=5)
    sides = 8
    vertices = []
    faces = []
    stripe_ranges = ((0.16, 0.23), (0.36, 0.43), (0.57, 0.64), (0.76, 0.82))

    for index, center in enumerate(centers):
        progress = index / (len(centers) - 1)
        radius = 0.012 + 0.073 * ((1.0 - progress) ** 0.72)
        previous = centers[max(0, index - 1)]
        following = centers[min(len(centers) - 1, index + 1)]
        tangent = (following - previous).normalized()
        axis_x = Vector((1.0, 0.0, 0.0))
        axis_plane = tangent.cross(axis_x).normalized()
        for side in range(sides):
            angle = math.tau * side / sides
            offset = radius * (math.cos(angle) * axis_x + math.sin(angle) * axis_plane)
            vertices.append(tuple(center + offset))

    for ring in range(len(centers) - 1):
        progress = ring / (len(centers) - 1)
        for side in range(sides):
            next_side = (side + 1) % sides
            faces.append(
                (
                    ring * sides + side,
                    ring * sides + next_side,
                    (ring + 1) * sides + next_side,
                    (ring + 1) * sides + side,
                )
            )
    faces.append(tuple(reversed(range(sides))))
    last_ring = (len(centers) - 1) * sides
    faces.append(tuple(last_ring + side for side in range(sides)))

    mesh = bpy.data.meshes.new("Tail_Curl_Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(base_mat)
    mesh.materials.append(stripe_mat)
    obj = bpy.data.objects.new("Tail_Curl", mesh)
    ASSET_COLLECTION.objects.link(obj)
    obj.parent = ROOT
    ASSET_OBJECTS.append(obj)

    for ring in range(len(centers) - 1):
        progress = ring / (len(centers) - 1)
        material_index = int(any(start <= progress <= end for start, end in stripe_ranges))
        for polygon_index in range(ring * sides, (ring + 1) * sides):
            mesh.polygons[polygon_index].material_index = material_index
    return obj


def add_foot(prefix, center, toe_direction, mat_foot, mat_toe):
    x, y, _ = center
    add_ellipsoid(f"{prefix}_Palm", (x, y, 0.036), (0.095, 0.105, 0.036), mat_foot, subdivisions=1)
    # The contact pad guarantees a precise z=0 floor while remaining nearly invisible.
    add_cone(f"{prefix}_ContactPad", (x, y, 0.006), 0.043, 0.037, 0.012, mat_foot, vertices=8)
    for index, spread in enumerate((-0.055, 0.0, 0.055), start=1):
        start = (x + spread * 0.25, y + toe_direction * 0.025, 0.023)
        end = (x + spread, y + toe_direction * (0.115 - abs(spread) * 0.25), 0.021)
        add_segment(f"{prefix}_Toe_{index}", start, end, 0.020, 0.013, mat_toe, vertices=6)
        add_ellipsoid(f"{prefix}_ToeTip_{index}", end, (0.017, 0.022, 0.014), mat_toe, subdivisions=1)


def add_leg(prefix, shoulder, knee, ankle, foot_center, toe_direction, mats):
    limb, joints, foot, toe = mats
    add_segment(f"{prefix}_UpperLeg", shoulder, knee, 0.064, 0.052, limb)
    add_ellipsoid(f"{prefix}_Knee", knee, (0.071, 0.066, 0.064), joints, subdivisions=1)
    add_segment(f"{prefix}_LowerLeg", knee, ankle, 0.050, 0.039, limb)
    add_ellipsoid(f"{prefix}_Ankle", ankle, (0.050, 0.048, 0.043), joints, subdivisions=1)
    add_foot(prefix, foot_center, toe_direction, foot, toe)


def add_face_details(mats):
    eye_shell, eye_cream, iris, pupil, catchlight, mouth_mat, accent = mats
    eye_specs = [
        ("Left", (-0.145, -0.435, 0.575), (-0.012, -0.006, 0.010)),
        ("Right", (0.145, -0.422, 0.584), (0.014, -0.006, -0.006)),
    ]
    for name, center_tuple, glance_tuple in eye_specs:
        center = Vector(center_tuple)
        glance = Vector(glance_tuple)
        add_ellipsoid(f"Eye_{name}_Turret", center, (0.088, 0.076, 0.086), eye_shell, subdivisions=2)
        iris_center = center + Vector((glance.x * 0.35, -0.071, glance.z * 0.35))
        add_ellipsoid(
            f"Eye_{name}_Cream",
            iris_center,
            (0.059, 0.019, 0.058),
            eye_cream,
            subdivisions=2,
        )
        pupil_center = iris_center + Vector((glance.x, -0.017, glance.z))
        add_ellipsoid(
            f"Eye_{name}_Iris",
            pupil_center,
            (0.034, 0.010, 0.036),
            iris,
            subdivisions=2,
        )
        add_ellipsoid(
            f"Eye_{name}_Pupil",
            pupil_center + Vector((0.0, -0.009, 0.0)),
            (0.017, 0.006, 0.025),
            pupil,
            subdivisions=2,
        )
        add_ellipsoid(
            f"Eye_{name}_Catchlight",
            pupil_center + Vector((-0.007, -0.015, 0.012)),
            (0.006, 0.004, 0.007),
            catchlight,
            subdivisions=1,
        )

    # A simple upturned mouth reads cleanly even at third-person camera distance.
    smile_points = [
        (-0.122, -0.588, 0.392),
        (-0.065, -0.601, 0.374),
        (0.000, -0.605, 0.369),
        (0.065, -0.601, 0.374),
        (0.122, -0.588, 0.392),
    ]
    for index in range(len(smile_points) - 1):
        add_segment(
            f"Smile_{index + 1}",
            smile_points[index],
            smile_points[index + 1],
            0.009,
            0.009,
            mouth_mat,
            vertices=6,
        )
    add_ellipsoid("Smile_Left_Dimple", smile_points[0], (0.016, 0.010, 0.016), accent, subdivisions=1)
    add_ellipsoid("Smile_Right_Dimple", smile_points[-1], (0.016, 0.010, 0.016), accent, subdivisions=1)
    add_ellipsoid("Nostril_Left", (-0.060, -0.601, 0.442), (0.013, 0.008, 0.010), pupil, subdivisions=1)
    add_ellipsoid("Nostril_Right", (0.060, -0.601, 0.442), (0.013, 0.008, 0.010), pupil, subdivisions=1)


def build_camo():
    global ASSET_COLLECTION, PREVIEW_COLLECTION, ROOT

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0
    scene = bpy.context.scene
    scene.name = "Camo_Guide_Scene"
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    ASSET_COLLECTION = bpy.data.collections.new("CAMO_ASSET")
    scene.collection.children.link(ASSET_COLLECTION)
    PREVIEW_COLLECTION = bpy.data.collections.new("PREVIEW_ONLY")
    scene.collection.children.link(PREVIEW_COLLECTION)

    ROOT = bpy.data.objects.new("Camo_Root", None)
    ROOT.empty_display_type = "CIRCLE"
    ROOT.empty_display_size = 0.16
    ROOT["asset_url"] = "/assets/camo/camo.glb"
    ROOT["units"] = "meters"
    ROOT["gltf_up"] = "+Y"
    ROOT["gltf_forward"] = "+Z"
    ROOT["character"] = "Camo — friendly chameleon guide"
    ASSET_COLLECTION.objects.link(ROOT)

    mats = {
        "body": material("Camo_Body_Green", "#55B85A", 0.78),
        "head": material("Camo_Head_Lime", "#6ACA62", 0.76),
        "limb": material("Camo_Limb_Green", "#3D9B56", 0.82),
        "joint": material("Camo_Joint_Green", "#49AD58", 0.80),
        "belly": material("Camo_Belly_Cream", "#D7E98A", 0.84),
        "spot": material("Camo_Teal_Markings", "#197966", 0.79),
        "crest": material("Camo_Sunlit_Crest", "#F2C94C", 0.73),
        "foot": material("Camo_Feet_Lime", "#9DDA58", 0.82),
        "toe": material("Camo_Toes_Gold", "#D8B83E", 0.80),
        "scarf": material("Camo_Guide_Coral", "#EF714B", 0.76),
        "scarf_dark": material("Camo_Guide_Coral_Shadow", "#BF4937", 0.79),
        "eye_shell": material("Camo_Eye_Turret", "#2F8B50", 0.77),
        "eye_cream": material("Camo_Eye_Cream", "#FFF4C2", 0.64),
        "iris": material("Camo_Iris_Amber", "#E7A72E", 0.52),
        "pupil": material("Camo_Pupil", "#173B32", 0.48),
        "white": material("Camo_Eye_Spark", "#FFFFFF", 0.35),
        "mouth": material("Camo_Smile", "#315044", 0.74),
    }

    # Main low-poly masses: a compact body, lifted neck, and oversized friendly head.
    add_ellipsoid("Body", (0.0, 0.075, 0.325), (0.275, 0.365, 0.215), mats["body"], subdivisions=2)
    add_ellipsoid("Belly_Patch", (0.0, -0.267, 0.325), (0.175, 0.035, 0.145), mats["belly"], subdivisions=2)
    add_ellipsoid("Neck", (0.0, -0.180, 0.400), (0.225, 0.205, 0.175), mats["head"], subdivisions=2)
    add_ellipsoid("Head", (0.0, -0.355, 0.475), (0.255, 0.225, 0.178), mats["head"], subdivisions=2)
    add_ellipsoid("Muzzle", (0.0, -0.535, 0.420), (0.185, 0.074, 0.094), mats["belly"], subdivisions=2)

    # Bold side camouflage spots make the color blocking visible from either 3/4 view.
    spot_specs = [
        (-0.045, 0.405, 0.083, 0.095),
        (0.105, 0.385, 0.070, 0.082),
        (0.245, 0.355, 0.057, 0.070),
    ]
    for side_name, side in (("Left", -1.0), ("Right", 1.0)):
        for index, (y, z, width, height) in enumerate(spot_specs, start=1):
            add_ellipsoid(
                f"{side_name}_CamoSpot_{index}",
                (side * 0.267, y, z),
                (0.018, width, height),
                mats["spot"],
                subdivisions=1,
            )

    # Sunny triangular crest: a recognizable chameleon silhouette without visual noise.
    crest_specs = [
        (-0.170, 0.570, 0.070),
        (-0.055, 0.575, 0.082),
        (0.070, 0.565, 0.078),
        (0.195, 0.540, 0.068),
        (0.310, 0.505, 0.056),
    ]
    for index, (y, z, depth) in enumerate(crest_specs, start=1):
        add_cone(f"Dorsal_Crest_{index}", (0.0, y, z + depth * 0.5), 0.038, 0.0, depth, mats["crest"], vertices=5)

    add_tail(mats["body"], mats["spot"])

    # Four planted feet and a subtly asymmetric stepping stance.
    leg_mats = (mats["limb"], mats["joint"], mats["foot"], mats["toe"])
    add_leg(
        "Front_Left",
        (-0.205, -0.155, 0.365),
        (-0.355, -0.235, 0.215),
        (-0.360, -0.350, 0.080),
        (-0.355, -0.405, 0.036),
        -1.0,
        leg_mats,
    )
    add_leg(
        "Front_Right",
        (0.205, -0.155, 0.365),
        (0.365, -0.205, 0.225),
        (0.385, -0.325, 0.080),
        (0.390, -0.375, 0.036),
        -1.0,
        leg_mats,
    )
    add_leg(
        "Back_Left",
        (-0.220, 0.245, 0.330),
        (-0.390, 0.315, 0.195),
        (-0.340, 0.435, 0.075),
        (-0.325, 0.480, 0.036),
        1.0,
        leg_mats,
    )
    add_leg(
        "Back_Right",
        (0.220, 0.245, 0.330),
        (0.395, 0.295, 0.205),
        (0.350, 0.420, 0.075),
        (0.345, 0.465, 0.036),
        1.0,
        leg_mats,
    )

    add_face_details(
        (
            mats["eye_shell"],
            mats["eye_cream"],
            mats["iris"],
            mats["pupil"],
            mats["white"],
            mats["mouth"],
            mats["crest"],
        )
    )

    # Coral kerchief is Camo's guide-role identifier and a high-contrast focal point.
    add_segment("Guide_Kerchief_Band", (-0.175, -0.325, 0.445), (0.175, -0.325, 0.445), 0.030, 0.030, mats["scarf"], vertices=8)
    add_ellipsoid("Guide_Kerchief_Knot", (0.0, -0.362, 0.415), (0.052, 0.036, 0.047), mats["scarf_dark"], subdivisions=1)
    add_triangle_prism(
        "Guide_Kerchief_Point",
        [(-0.066, -0.350, 0.410), (0.066, -0.350, 0.410), (0.018, -0.355, 0.265)],
        0.020,
        mats["scarf"],
    )

    return scene


def add_preview_setup(scene):
    ground_mat = material("Preview_Ground", "#DDE8D4", 0.92)
    bpy.ops.mesh.primitive_plane_add(size=200.0, location=(0.0, 0.0, -0.006))
    ground = bpy.context.object
    ground.name = "Preview_Ground"
    ground.data.materials.append(ground_mat)
    move_to_collection(ground, PREVIEW_COLLECTION)

    world = bpy.data.worlds.new("Camo_Preview_World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = hex_color("#D9EBDD")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.36
    scene.world = world

    def area_light(name, location, energy, size, color):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = size
        data.color = color
        obj = bpy.data.objects.new(name, data)
        PREVIEW_COLLECTION.objects.link(obj)
        obj.location = location
        aim_at(obj, (0.0, 0.0, 0.30))
        return obj

    area_light("Preview_Key", (2.2, -2.8, 3.2), 390.0, 3.0, (1.0, 0.86, 0.70))
    area_light("Preview_Fill", (-2.5, -1.1, 1.8), 220.0, 2.7, (0.67, 0.82, 1.0))
    area_light("Preview_Rim", (0.5, 2.5, 2.4), 310.0, 2.0, (0.75, 1.0, 0.78))

    camera_data = bpy.data.cameras.new("Preview_Camera")
    camera = bpy.data.objects.new("Preview_Camera", camera_data)
    PREVIEW_COLLECTION.objects.link(camera)
    camera.location = (1.95, -1.65, 1.05)
    camera_data.lens = 58.0
    aim_at(camera, (0.0, 0.02, 0.32))
    scene.camera = camera

    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 768
    scene.render.resolution_y = 768
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.filepath = str(PREVIEW_PATH)
    scene.render.image_settings.color_depth = "8"
    scene.render.resolution_percentage = 100
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass


def aim_at(obj, target):
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def asset_bounds():
    minimum = Vector((float("inf"), float("inf"), float("inf")))
    maximum = Vector((float("-inf"), float("-inf"), float("-inf")))
    for obj in ASSET_OBJECTS:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ Vector(corner)
            minimum.x = min(minimum.x, world_corner.x)
            minimum.y = min(minimum.y, world_corner.y)
            minimum.z = min(minimum.z, world_corner.z)
            maximum.x = max(maximum.x, world_corner.x)
            maximum.y = max(maximum.y, world_corner.y)
            maximum.z = max(maximum.z, world_corner.z)
    return minimum, maximum


def validate_glb_contract(data):
    """Validate GLB structure, raw glTF axes, bounds, origin, and self-containment."""
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise RuntimeError("GLB JSON chunk is missing")
    gltf = json.loads(data[20 : 20 + json_length].rstrip(b" \\0"))
    if any("uri" in buffer for buffer in gltf.get("buffers", [])):
        raise RuntimeError("GLB unexpectedly references an external buffer")
    if any("uri" in image for image in gltf.get("images", [])):
        raise RuntimeError("GLB unexpectedly references an external image")

    def local_matrix(node):
        if "matrix" in node:
            values = node["matrix"]
            return Matrix([[values[column * 4 + row] for column in range(4)] for row in range(4)])
        translation = Matrix.Translation(Vector(node.get("translation", (0.0, 0.0, 0.0))))
        x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
        rotation = Quaternion((w, x, y, z)).to_matrix().to_4x4()
        sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
        scale = Matrix.Diagonal(Vector((sx, sy, sz, 1.0)))
        return translation @ rotation @ scale

    minimum = Vector((float("inf"), float("inf"), float("inf")))
    maximum = Vector((float("-inf"), float("-inf"), float("-inf")))

    def visit(node_index, parent_matrix):
        nonlocal minimum, maximum
        node = gltf["nodes"][node_index]
        world_matrix = parent_matrix @ local_matrix(node)
        if "mesh" in node:
            mesh = gltf["meshes"][node["mesh"]]
            for primitive in mesh["primitives"]:
                accessor = gltf["accessors"][primitive["attributes"]["POSITION"]]
                low = accessor["min"]
                high = accessor["max"]
                for x in (low[0], high[0]):
                    for y in (low[1], high[1]):
                        for z in (low[2], high[2]):
                            point = world_matrix @ Vector((x, y, z))
                            minimum.x = min(minimum.x, point.x)
                            minimum.y = min(minimum.y, point.y)
                            minimum.z = min(minimum.z, point.z)
                            maximum.x = max(maximum.x, point.x)
                            maximum.y = max(maximum.y, point.y)
                            maximum.z = max(maximum.z, point.z)
        for child_index in node.get("children", []):
            visit(child_index, world_matrix)

    scene = gltf["scenes"][gltf.get("scene", 0)]
    for root_index in scene["nodes"]:
        visit(root_index, Matrix.Identity(4))

    dimensions = maximum - minimum
    nodes_by_name = {node.get("name"): node for node in gltf["nodes"]}
    root_node = nodes_by_name.get("Camo_Root")
    if root_node is None or any(abs(value) > 1e-6 for value in root_node.get("translation", (0, 0, 0))):
        raise RuntimeError("Camo_Root must remain at the glTF origin")
    # Authoring -Y must become glTF +Z: the muzzle is in front of the body.
    if nodes_by_name["Muzzle"]["translation"][2] <= nodes_by_name["Body"]["translation"][2]:
        raise RuntimeError("Camo does not face glTF +Z")
    if not (-0.001 <= minimum.y <= 0.002):
        raise RuntimeError(f"glTF floor contact must be y=0; got {minimum.y:.4f}")
    if not (1.10 <= dimensions.z <= 1.40 and 0.59 <= dimensions.y <= 0.75):
        raise RuntimeError(f"Raw glTF dimensions violate the contract: {tuple(dimensions)}")
    print(
        "CAMO_GLTF_CONTRACT_OK "
        f"min=({minimum.x:.3f}, {minimum.y:.3f}, {minimum.z:.3f}) "
        f"dimensions=({dimensions.x:.3f} wide, {dimensions.y:.3f} high, {dimensions.z:.3f} long) "
        "up=+Y forward=+Z root=(0,0,0) self_contained=yes"
    )


def render_and_export(scene):
    HERE.mkdir(parents=True, exist_ok=True)
    GLB_PATH.parent.mkdir(parents=True, exist_ok=True)

    minimum, maximum = asset_bounds()
    dimensions = maximum - minimum
    print(
        "CAMO_BOUNDS_BLENDER_METERS "
        f"min=({minimum.x:.3f}, {minimum.y:.3f}, {minimum.z:.3f}) "
        f"max=({maximum.x:.3f}, {maximum.y:.3f}, {maximum.z:.3f}) "
        f"dimensions=({dimensions.x:.3f} wide, {dimensions.y:.3f} long, {dimensions.z:.3f} high)"
    )
    if not (-0.001 <= minimum.z <= 0.002):
        raise RuntimeError(f"Camo must contact the floor at z=0; got {minimum.z:.4f}")
    if not (1.10 <= dimensions.y <= 1.40 and 0.59 <= dimensions.z <= 0.75):
        raise RuntimeError(f"Camo dimensions are outside the contract target: {tuple(dimensions)}")

    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)
    scene.render.filepath = str(PREVIEW_PATH)
    bpy.ops.render.render(write_still=True)

    bpy.ops.object.select_all(action="DESELECT")
    ROOT.select_set(True)
    for obj in ASSET_OBJECTS:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = ROOT

    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_animations=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )

    data = GLB_PATH.read_bytes()
    if len(data) < 10_000:
        raise RuntimeError(f"GLB unexpectedly small: {len(data)} bytes")
    magic, version, declared_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or declared_length != len(data):
        raise RuntimeError("Exported GLB header failed validation")
    validate_glb_contract(data)
    print(f"CAMO_EXPORT_OK {GLB_PATH} ({len(data):,} bytes)")
    print(f"CAMO_SOURCE_OK {BLEND_PATH} ({BLEND_PATH.stat().st_size:,} bytes)")
    print(f"CAMO_PREVIEW_OK {PREVIEW_PATH} ({PREVIEW_PATH.stat().st_size:,} bytes)")


if __name__ == "__main__":
    scene = build_camo()
    add_preview_setup(scene)
    render_and_export(scene)
