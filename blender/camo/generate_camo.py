"""Generate Camo, the guide chameleon, in both styles of the cast.

Run from the repository root:
  /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
    --python blender/camo/generate_camo.py

It writes public/assets/camo/camo-cartoon.glb and camo-realistic.glb, and here
camo.blend and camo_preview.png. Add `-- --views <directory>` to also save
close-up renders of each.

Both are the same Camo: a plump green chameleon with a cream belly and muzzle,
teal bars on its flanks and tail, a sunny crest, amber turret eyes, a curled
tail, and the coral kerchief that marks it as the guide. Both are original
work; no outside asset is used.

  cartoon    drawn with the cartoon cast's kit (blender/cast/generate_cast.py):
             smooth round shapes and a painted-on face
  realistic  a skin sculpted over a drawn skeleton, painted and scaled here,
             on a small rig

The modeling space is Blender's Z-up space; Camo faces -Y, which the glTF
exporter turns into +Z. Each carries an `idle` clip, in place.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
# The cast's generators are imported as modules; no bytecode cache is left beside them.
sys.dont_write_bytecode = True
sys.path.insert(0, str(REPO_ROOT / "blender" / "cast"))
import generate_cast as kit  # noqa: E402
import generate_realistic_player as rp  # noqa: E402

GLB_DIR = REPO_ROOT / "public" / "assets" / "camo"
BLEND_PATH = HERE / "camo.blend"
PREVIEW_PATH = HERE / "camo_preview.png"
CARTOON_KEY, REALISTIC_KEY = "camo-cartoon", "camo-realistic"

# Camo's colors. The realistic Camo wears the same hues a little deeper.
BODY, HEAD, LIMB, BELLY = "#55b85a", "#6aca62", "#3d9b56", "#d7e98a"
TEAL, SUN, FOOT, TOE = "#197966", "#f2c94c", "#9dda58", "#d8b83e"
CORAL, CORAL_DARK = "#ef714b", "#bf4937"
EYE_SHELL, EYE_CREAM, IRIS, PUPIL, MOUTH = "#2f8b50", "#fff4c2", "#e7a72e", "#173b32", "#315044"

# Where Camo's four feet stand: (name, side, the leg's top, its ankle, the foot).
LEGS = (
    ("front_L", -1.0, (-0.16, -0.12, 0.3), (-0.3, -0.25, 0.09), (-0.31, -0.3, 0.0)),
    ("front_R", 1.0, (0.16, -0.12, 0.3), (0.3, -0.25, 0.09), (0.31, -0.3, 0.0)),
    ("back_L", -1.0, (-0.17, 0.3, 0.28), (-0.31, 0.4, 0.09), (-0.32, 0.43, 0.0)),
    ("back_R", 1.0, (0.17, 0.3, 0.28), (0.31, 0.4, 0.09), (0.32, 0.43, 0.0)),
)
# The share of the tail's length each teal stripe covers.
TAIL_STRIPES = ((0.16, 0.23), (0.36, 0.43), (0.57, 0.64), (0.76, 0.82))
FPS = 30
IDLE_FRAMES = 120  # a 4 s loop


def tail_line() -> list[Vector]:
    """The middle of the tail: it leaves the body, eases to Camo's side, and curls up on itself."""
    controls = [Vector(point) for point in (
        (0.0, 0.36, 0.36), (0.1, 0.49, 0.38), (0.23, 0.63, 0.32), (0.31, 0.67, 0.2),
        (0.33, 0.6, 0.105), (0.335, 0.48, 0.085), (0.332, 0.4, 0.15), (0.33, 0.4, 0.245),
        (0.328, 0.47, 0.3), (0.326, 0.55, 0.28), (0.324, 0.575, 0.22), (0.322, 0.53, 0.18), (0.32, 0.485, 0.205),
    )]
    padded = [controls[0], *controls, controls[-1]]
    line = []
    for index in range(1, len(padded) - 2):
        before, start, end, after = padded[index - 1:index + 3]
        for step in range(5):
            t = step / 5
            line.append(0.5 * (
                2.0 * start + (end - before) * t
                + (2.0 * before - 5.0 * start + 4.0 * end - after) * t * t
                + (3.0 * start - before - 3.0 * end + after) * t ** 3
            ))
    line.append(controls[-1])
    return line


def tail_radius(share: float) -> float:
    return 0.012 + 0.073 * (1.0 - share) ** 0.72


def striped(share: float) -> bool:
    return any(start <= share <= end for start, end in TAIL_STRIPES)


def smoothstep(low: float, high: float, value: float) -> float:
    share = min(max((value - low) / (high - low), 0.0), 1.0)
    return share * share * (3.0 - 2.0 * share)


# -----------------------------------------------------------------------------
# Cartoon Camo

# The cartoon Camo's round masses: (center, radii).
C_BODY = (Vector((0.0, 0.1, 0.31)), Vector((0.255, 0.37, 0.205)))
C_HEAD = (Vector((0.0, -0.36, 0.47)), Vector((0.235, 0.225, 0.19)))
C_MUZZLE = (Vector((0.0, -0.5, 0.425)), Vector((0.175, 0.11, 0.1)))


def cartoon_material(name: str, color: str, roughness: float = 0.78) -> bpy.types.Material:
    return kit.material(f"Camo {name}", rp.hex_rgba(color), roughness=roughness)


def add_cartoon_tail(base: bpy.types.Material, stripe: bpy.types.Material) -> None:
    """A smooth tapered tube along the tail's curl, with its teal stripes."""
    line, sides = tail_line(), 12
    vertices, faces, stripes = [], [], []
    for index, middle in enumerate(line):
        along = (line[min(index + 1, len(line) - 1)] - line[max(index - 1, 0)]).normalized()
        across = Vector((1.0, 0.0, 0.0))
        up = along.cross(across).normalized()
        radius = tail_radius(index / (len(line) - 1))
        for side in range(sides):
            angle = 2.0 * math.pi * side / sides
            vertices.append(middle + radius * (math.cos(angle) * across + math.sin(angle) * up))
    for ring in range(len(line) - 1):
        for side in range(sides):
            following = (side + 1) % sides
            faces.append((ring * sides + side, ring * sides + following, (ring + 1) * sides + following, (ring + 1) * sides + side))
            stripes.append(striped(ring / (len(line) - 1)))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple((len(line) - 1) * sides + side for side in range(sides)))
    tail = kit.add_surface("camo_tail", vertices, faces, base)
    tail.data.materials.append(stripe)
    for polygon, on_stripe in zip(tail.data.polygons, stripes):
        polygon.material_index = int(on_stripe)


def build_cartoon() -> None:
    """Camo in the cartoon cast's style: round, smooth, with a painted-on face."""
    root = kit.begin_asset(CARTOON_KEY, "Camo (cartoon)", "Plump green chameleon guide with turret eyes, a sunny crest, a curled striped tail, and a coral kerchief.")
    root["pose"] = "four feet planted; an idle clip animates the pivots"
    body, head, limb, belly = (cartoon_material(name, color) for name, color in (("Body", BODY), ("Head", HEAD), ("Limb", LIMB), ("Belly", BELLY)))
    teal, sun, foot, toe = (cartoon_material(name, color) for name, color in (("Teal", TEAL), ("Sun", SUN), ("Foot", FOOT), ("Toe", TOE)))
    coral, coral_dark = cartoon_material("Coral", CORAL), cartoon_material("Coral Dark", CORAL_DARK)
    shell, cream = cartoon_material("Eye Shell", EYE_SHELL), cartoon_material("Eye Cream", EYE_CREAM, 0.6)
    iris, pupil = cartoon_material("Iris", IRIS, 0.5), cartoon_material("Pupil", PUPIL, 0.35)
    mouth, blush = cartoon_material("Mouth", MOUTH, 0.9), cartoon_material("Blush", "#f29a7c", 0.9)
    white = kit.MATERIALS.get("Soft White") or kit.material("Soft White", (0.92, 0.94, 0.92, 1.0), roughness=0.9)

    # The legs and feet stay planted while the body breathes above them.
    for name, sign, top, ankle, sole in LEGS:
        forward = -1.0 if name.startswith("front") else -0.6
        kit.shade_smooth(kit.add_segment(f"camo_leg_{name}", top, (sole[0], sole[1] + 0.03, 0.06), 0.055, limb, vertices=12))
        kit.add_ico(f"camo_foot_{name}", (sole[0], sole[1], 0.046), (0.08, 0.1, 0.046), foot, smooth=True)
        for index, spread in enumerate((-0.052, 0.0, 0.052)):
            kit.add_ico(
                f"camo_toe_{name}_{index}",
                (sole[0] + spread + sign * 0.012, sole[1] + forward * (0.088 - abs(spread) * 0.35), 0.026),
                (0.025, 0.03, 0.026), toe, smooth=True,
            )

    center, radii = C_BODY
    with kit.pivot("camo_pivot_body", (0.0, 0.1, 0.2)):
        kit.add_ico("camo_body", tuple(center), tuple(radii), body, subdivisions=4, smooth=True)
        kit.add_ico("camo_belly", (0.0, 0.08, 0.245), (0.212, 0.315, 0.16), belly, subdivisions=3, smooth=True)
        # Teal bars on each flank and a row of soft sunny spikes down the back.
        for side, sign in (("L", -1.0), ("R", 1.0)):
            for index, (y, z, width, tall) in enumerate(((-0.02, 0.385, 0.05, 0.085), (0.13, 0.375, 0.046, 0.078), (0.265, 0.35, 0.04, 0.066))):
                x = radii.x * math.sqrt(max(1.0 - ((y - center.y) / radii.y) ** 2 - ((z - center.z) / radii.z) ** 2, 0.0))
                kit.add_ico(f"camo_bar_{side}_{index}", (sign * (x - 0.006), y, z), (0.016, width, tall), teal, subdivisions=3, smooth=True)
        for index, (y, tall) in enumerate(((-0.14, 0.07), (-0.01, 0.082), (0.12, 0.078), (0.245, 0.066), (0.355, 0.052))):
            top = center.z + radii.z * math.sqrt(1.0 - ((y - center.y) / radii.y) ** 2)
            kit.add_cone(f"camo_crest_{index}", (0.0, y, top + tall * 0.42), 0.044, 0.008, tall, (0.75, 1.0), sun, vertices=14, smooth=True)

        # The kerchief: a band round the neck with its knot and point under the chin.
        kit.shade_smooth(kit.add_torus("camo_kerchief_band", (0.0, -0.215, 0.405), 0.166, 0.03, coral, rotation=(math.radians(90.0), 0.0, 0.0), segments=(28, 10)))
        kit.add_ico("camo_kerchief_knot", (0.0, -0.3, 0.27), (0.05, 0.036, 0.042), coral_dark, smooth=True)
        kit.add_cone("camo_kerchief_point", (0.0, -0.315, 0.18), 0.004, 0.085, 0.15, (1.0, 0.28), coral, vertices=14, smooth=True)

        with kit.pivot("camo_pivot_tail", (0.0, 0.4, 0.34)):
            add_cartoon_tail(body, teal)

        with kit.pivot("camo_pivot_head", (0.0, -0.2, 0.4)):
            kit.add_ico("camo_head", tuple(C_HEAD[0]), tuple(C_HEAD[1]), head, subdivisions=4, smooth=True)
            kit.add_ico("camo_muzzle", tuple(C_MUZZLE[0]), tuple(C_MUZZLE[1]), belly, subdivisions=3, smooth=True)
            kit.add_smile("camo_smile", 40.0, -14.0, 9.0, 2.6, mouth, head=C_MUZZLE)
            for side, sign in (("L", -1.0), ("R", 1.0)):
                kit.add_face_decal(f"camo_nostril_{side}", sign * 17.0, 34.0, 0.011, 0.007, pupil, lift=0.004, head=C_MUZZLE)
                kit.add_face_decal(f"camo_cheek_{side}", sign * 58.0, -16.0, 0.04, 0.026, blush, lift=0.0035, head=C_HEAD)
                # Each eye is a turret that swivels on its own, as a chameleon's do.
                turret = (Vector((sign * 0.152, -0.435, 0.6)), Vector((0.088, 0.082, 0.088)))
                with kit.pivot(f"camo_pivot_eye_{side}", tuple(turret[0])):
                    kit.add_ico(f"camo_eye_{side}_turret", tuple(turret[0]), tuple(turret[1]), shell, subdivisions=3, smooth=True)
                    look = sign * 14.0
                    kit.add_face_decal(f"camo_eye_{side}_cream", look, 4.0, 0.056, 0.056, cream, lift=0.004, head=turret)
                    kit.add_face_decal(f"camo_eye_{side}_iris", look, 4.0, 0.039, 0.041, iris, lift=0.007, head=turret)
                    kit.add_face_decal(f"camo_eye_{side}_pupil", look, 4.0, 0.02, 0.029, pupil, lift=0.01, head=turret)
                    kit.add_face_decal(f"camo_eye_{side}_glint", look - 9.0, 17.0, 0.0085, 0.011, white, lift=0.013, head=turret)


def cartoon_idle(phase: float) -> kit.Pose:
    """Camo at rest: slow breaths, a tilt of the head, a sway of the tail, and eyes that wander apart."""
    breath = math.sin(2.0 * phase)
    sway = math.sin(phase)
    still = kit.STILL
    return {
        "pivot_body": ((0.6 * breath, 0.0, 0.0), (0.0, 0.0, 0.005 * (1.0 + breath))),
        "pivot_head": ((1.5 * breath, 2.5 * sway, 5.0 * math.sin(phase + 0.6)), still),
        "pivot_tail": ((0.0, 0.0, 4.0 * sway), still),
        "pivot_eye_L": ((7.0 * math.sin(phase + 1.0), 0.0, 13.0 * math.sin(2.0 * phase + 1.0)), still),
        "pivot_eye_R": ((8.0 * math.sin(2.0 * phase), 0.0, 11.0 * math.sin(phase + 2.2)), still),
    }


CARTOON_CLIPS: tuple[kit.Clip, ...] = (("idle", IDLE_FRAMES, 3, cartoon_idle),)


# -----------------------------------------------------------------------------
# Realistic Camo
#
# The skin is sculpted over lines of points, each with the body's radius there:
# one line from the snout down the spine to the tip of the tail, and one per leg.

R_BODY, R_BACK, R_HEAD, R_LIMB, R_BELLY = "#4fa856", "#3b8948", "#62b85d", "#43975a", "#cfdc8f"
R_TEAL, R_CREST, R_FOOT, R_TOE, R_CORAL = "#1f7a69", "#d9bf55", "#86bf58", "#c9ad48", "#d96a4b"

# The spine from the snout to the hips: (y, z, radius). The tail carries on from it.
SPINE = (
    (-0.6, 0.4, 0.042), (-0.545, 0.405, 0.072), (-0.47, 0.425, 0.104), (-0.385, 0.455, 0.124), (-0.3, 0.46, 0.122),
    (-0.215, 0.425, 0.106), (-0.115, 0.4, 0.148), (0.02, 0.405, 0.186), (0.17, 0.4, 0.178), (0.3, 0.375, 0.136),
)
NECK = (-0.3, -0.15)  # Between these the head's movement eases into the body's.
TILE = 0.16  # Meters of skin one repeat of the scale texture covers.


def realistic_tail() -> list[Vector]:
    """The tail's line from where it leaves the hips, at the spacing the skin is sculpted at."""
    return tail_line()[2::2]


def skin_over(name: str, points: list[tuple[Vector, float]], smoothing: int = 2) -> bpy.types.Object:
    """An organic tube: a skin over a line of (middle, radius) points, smoothed."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(middle) for middle, _ in points], [(index, index + 1) for index in range(len(points) - 1)], [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    rp.select_only(obj)
    skin = obj.modifiers.new("Skin", "SKIN")
    if not mesh.skin_vertices:
        bpy.ops.mesh.customdata_skin_add()
    for index, (vertex, (_, radius)) in enumerate(zip(mesh.skin_vertices[0].data, points)):
        vertex.radius = (radius, radius)
        vertex.use_root = index == 0
    modifiers = [skin]
    if smoothing:
        modifiers.append(obj.modifiers.new("Smooth", "SUBSURF"))
        modifiers[-1].levels = smoothing
    for modifier in modifiers:
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def primitive(add, name: str, middle: Vector, radii: tuple[float, float, float], turn=None, **settings) -> bpy.types.Object:
    """A primitive mesh scaled to radii, turned, and moved to its place, with those baked in."""
    add(location=(0.0, 0.0, 0.0), **settings)
    obj = bpy.context.object
    obj.name = obj.data.name = name
    for vertex in obj.data.vertices:
        co = Vector(axis * radius for axis, radius in zip(vertex.co, radii))
        vertex.co = middle + (turn @ co if turn else co)
    return obj


class Sample:
    """A point on a skeleton line: where it is, the body's radius there, and which part it belongs to."""

    def __init__(self, middle: Vector, radius: float, part: str, share: float) -> None:
        self.middle, self.radius, self.part, self.share = middle, radius, part, share


def skeleton() -> tuple[dict[str, list[tuple[Vector, float]]], list[Sample]]:
    """The lines the skin is sculpted over, and close-set samples of them for painting and rigging."""
    spine = [(Vector((0.0, y, z)), radius) for y, z, radius in SPINE]
    tail = realistic_tail()
    lines = {"spine": spine + [(middle, tail_radius(index / (len(tail) - 1))) for index, middle in enumerate(tail)]}
    for name, sign, top, ankle, sole in LEGS:
        # Each leg bends out and up at the elbow or knee before it comes down to the foot.
        elbow = Vector(top).lerp(Vector(ankle), 0.45) + Vector((sign * 0.04, 0.0, 0.035))
        lines[name] = [(Vector(top), 0.064), (elbow, 0.05), (Vector(ankle), 0.037), (Vector((sole[0], sole[1], 0.03)), 0.03)]
    samples = []
    for name, points in lines.items():
        for index, ((start, wide), (end, narrow)) in enumerate(zip(points, points[1:])):
            for step in range(8):
                along = step / 8
                if name != "spine":
                    part, share = "leg", (index + along) / (len(points) - 1)
                elif index < len(spine) - 1:
                    part, share = "body", 0.0
                else:
                    part, share = "tail", (index - (len(spine) - 1) + along) / len(tail)
                samples.append(Sample(start.lerp(end, along), wide + (narrow - wide) * along, part, share))
    return lines, samples


def paint(obj: bpy.types.Object, color) -> None:
    """Gives every vertex the color color(position, normal) returns, as linear RGB."""
    attribute = obj.data.color_attributes.new("Color", "FLOAT_COLOR", "POINT")
    for vertex in obj.data.vertices:
        attribute.data[vertex.index].color = (*color(vertex.co, vertex.normal), 1.0)


def linear(color: str) -> Vector:
    return Vector(rp.hex_rgba(color)[:3])


def nearest_sample(samples: list[Sample]):
    """A lookup of the skeleton sample closest to a position."""
    tree = KDTree(len(samples))
    for index, sample in enumerate(samples):
        tree.insert(sample.middle, index)
    tree.balance()
    return lambda co: samples[tree.find(co)[1]]


def skin_color(samples: list[Sample]):
    """Camo's markings: a pale belly and throat, a darker back, teal bars on the flanks, a striped tail."""
    near = nearest_sample(samples)
    body, back, head, limb, belly, teal, foot = (linear(color) for color in (R_BODY, R_BACK, R_HEAD, R_LIMB, R_BELLY, R_TEAL, R_FOOT))

    def color(co: Vector, normal: Vector) -> Vector:
        sample = near(co)
        if sample.part == "leg":
            return limb.lerp(foot, smoothstep(0.6, 0.95, sample.share))
        if sample.part == "tail":
            edge = min((abs(sample.share - bound) for stripe in TAIL_STRIPES for bound in stripe), default=1.0)
            return body.lerp(teal, smoothstep(0.0, 0.012, edge) if striped(sample.share) else 0.0)
        height = (co.z - sample.middle.z) / sample.radius  # -1 under the body, +1 along its back
        shade = body.lerp(head, 1.0 - smoothstep(NECK[0], NECK[1], co.y))
        shade = shade.lerp(back, smoothstep(0.5, 0.95, height))
        under = smoothstep(-0.2, -0.7, height)
        flank = smoothstep(0.25, 0.6, abs(normal.x)) * (1.0 - under) * smoothstep(NECK[1], NECK[1] + 0.06, co.y)
        bar = max(1.0 - smoothstep(0.02, 0.04, abs(co.y - middle)) for middle in (-0.01, 0.13, 0.26))
        # A pale muzzle, as the cartoon Camo has: the front of the head from the mouth down.
        muzzle = smoothstep(-0.45, -0.52, co.y) * smoothstep(-0.05, -0.3, height)
        return shade.lerp(teal, bar * flank).lerp(belly, max(under, muzzle))

    return color


def scale_textures(size: int = 256, cells: int = 190) -> tuple[Path, Path]:
    """Small reptile scales as a tiling shade map and the normal map of the same bumps. Drawn here."""
    random = np.random.default_rng(5)
    centers = random.random((cells, 2)).astype(np.float32)
    tone = 0.8 + 0.2 * random.random(cells).astype(np.float32)
    grid = (np.indices((size, size), dtype=np.float32).transpose(1, 2, 0) + 0.5) / size  # (row, column) -> (v, u)
    first = np.full((size, size), np.inf, dtype=np.float32)
    second = np.full((size, size), np.inf, dtype=np.float32)
    owner = np.zeros((size, size), dtype=np.int64)
    for index, center in enumerate(centers):
        # The nearest copy of the cell's center, so the pattern repeats without a seam.
        offset = np.abs(grid - center[None, None, :])
        distance = np.hypot(*np.moveaxis(np.minimum(offset, 1.0 - offset), 2, 0))
        closer = distance < first
        second = np.where(closer, first, np.minimum(second, distance))
        owner = np.where(closer, index, owner)
        first = np.where(closer, distance, first)
    seam = np.clip((second - first) / 0.012, 0.0, 1.0)  # 0 in the groove between two scales
    shade = tone[owner] * (0.72 + 0.28 * seam)
    pixels = np.ones((size, size, 4), dtype=np.float32)
    pixels[..., :3] = rp.linear_to_srgb(shade)[..., None]
    color = rp.save_pixels("camo-scales", pixels, alpha=False)

    height = seam * (1.0 - 0.5 * np.clip(first / 0.05, 0.0, 1.0) ** 2)
    slope_u = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 1.6
    slope_v = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 1.6
    normal = np.stack([-slope_u, -slope_v, np.ones_like(height)], axis=2)
    normal /= np.linalg.norm(normal, axis=2, keepdims=True)
    pixels[..., :3] = normal * 0.5 + 0.5
    return color, rp.save_pixels("camo-scales-normal", pixels, alpha=False)


def box_wrap(obj: bpy.types.Object) -> None:
    """Lays the texture over the skin from the three axes, at one scale everywhere."""
    mesh = obj.data
    layer = mesh.uv_layers.active or mesh.uv_layers.new(name="UVMap")
    for polygon in mesh.polygons:
        axis = max(range(3), key=lambda index: abs(polygon.normal[index]))
        across, up = [index for index in range(3) if index != axis]
        for loop in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop].vertex_index].co
            layer.data[loop].uv = (co[across] / TILE, co[up] / TILE)


def painted_material(name: str, roughness: float, shade: Path | None = None, bumps: Path | None = None, *, double_sided: bool = False) -> bpy.types.Material:
    """A material colored by the mesh's painted vertices, times a shade map, with a normal map for its bumps."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.use_backface_culling = not double_sided
    tree = material.node_tree
    shader = tree.nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    color = tree.nodes.new("ShaderNodeVertexColor")
    color.layer_name = "Color"
    if shade:
        image = tree.nodes.new("ShaderNodeTexImage")
        image.image = bpy.data.images.load(str(shade))
        mix = tree.nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        tree.links.new(image.outputs["Color"], mix.inputs["A"])
        tree.links.new(color.outputs["Color"], mix.inputs["B"])
        tree.links.new(mix.outputs["Result"], shader.inputs["Base Color"])
    else:
        tree.links.new(color.outputs["Color"], shader.inputs["Base Color"])
    if bumps:
        image = tree.nodes.new("ShaderNodeTexImage")
        image.image = bpy.data.images.load(str(bumps))
        image.image.colorspace_settings.name = "Non-Color"
        relief = tree.nodes.new("ShaderNodeNormalMap")
        relief.inputs["Strength"].default_value = 0.7
        tree.links.new(image.outputs["Color"], relief.inputs["Color"])
        tree.links.new(relief.outputs["Normal"], shader.inputs["Normal"])
    return material


def weigh(obj: bpy.types.Object, weights) -> None:
    """Skins a mesh: weights(position) returns the share of each bone that moves a vertex there."""
    for vertex in obj.data.vertices:
        for bone, weight in weights(vertex.co).items():
            if weight > 0.0:
                group = obj.vertex_groups.get(bone) or obj.vertex_groups.new(name=bone)
                group.add([vertex.index], weight, "REPLACE")


def on(bone: str):
    return lambda co: {bone: 1.0}


def build_realistic() -> tuple[bpy.types.Object, list[bpy.types.Object]]:
    """Camo as a naturalistic chameleon: one sculpted, scaled skin on a small rig."""
    lines, samples = skeleton()
    tail = realistic_tail()
    eye_axes = {"l": Vector((0.34, -1.0, 0.08)).normalized(), "r": Vector((-0.34, -1.0, 0.08)).normalized()}
    turrets = {"l": Vector((0.1, -0.425, 0.5)), "r": Vector((-0.1, -0.425, 0.5))}

    # --- The rig: the body rides on the planted legs; the head, the eyes, and the tail turn on it.
    armature = bpy.data.armatures.new("camo_rig")
    rig = bpy.data.objects.new("camo_rig", armature)
    bpy.context.scene.collection.objects.link(rig)
    rp.select_only(rig)
    bpy.ops.object.mode_set(mode="EDIT")

    def bone(name: str, head: Vector, end: Vector, parent: str | None = None) -> None:
        added = armature.edit_bones.new(name)
        added.head, added.tail = head, end
        if parent:
            added.parent = armature.edit_bones[parent]

    bone("root", Vector((0.0, 0.1, 0.0)), Vector((0.0, 0.1, 0.12)))
    bone("body", Vector((0.0, 0.32, 0.37)), Vector((0.0, -0.12, 0.4)), "root")
    bone("head", Vector((0.0, -0.2, 0.42)), Vector((0.0, -0.5, 0.44)), "body")
    for side, middle in turrets.items():
        bone(f"eye_{side}", middle, middle + eye_axes[side] * 0.09, "head")
    joints = [tail[0], tail[len(tail) // 3], tail[2 * len(tail) // 3], tail[-1]]
    for index, (start, end) in enumerate(zip(joints, joints[1:]), start=1):
        bone(f"tail_{index}", start, end, "body" if index == 1 else f"tail_{index - 1}")
    bpy.ops.object.mode_set(mode="OBJECT")

    # --- The skin: spine and tail, the four legs, and what is sculpted onto them.
    skin_parts = [skin_over(f"camo_{name}", points) for name, points in lines.items()]
    crest_parts, toe_parts, turret_parts = [], [], []
    # The skin lies a little inside the radii it was sculpted from, so what sits
    # on the body is placed by looking for the skin itself.
    spine = skin_parts[0].data
    surface = BVHTree.FromPolygons([vertex.co.copy() for vertex in spine.vertices], [tuple(polygon.vertices) for polygon in spine.polygons])
    body_samples = [sample for sample in samples if sample.part == "body"]

    def on_skin(y: float, toward: Vector) -> Vector:
        """Where the body's skin is at a point along the spine, seen from a direction."""
        middle = min(body_samples, key=lambda item: abs(item.middle.y - y)).middle
        hit, _, _, _ = surface.ray_cast(Vector((0.0, y, middle.z)) + toward * 0.5, -toward)
        if hit is None:
            raise SystemExit(f"Camo has no skin at y={y}")
        return hit

    # A casque rising behind the eyes, and a low crest of soft spikes down the back.
    casque = primitive(
        bpy.ops.mesh.primitive_uv_sphere_add, "camo_casque", Vector((0.0, -0.3, 0.545)), (0.05, 0.15, 0.07),
        Matrix.Rotation(math.radians(-22.0), 3, "X"), segments=20, ring_count=10,
    )
    for index, (y, tall) in enumerate(((-0.2, 0.03), (-0.1, 0.04), (0.0, 0.046), (0.1, 0.046), (0.2, 0.04), (0.29, 0.032))):
        crest_parts.append(primitive(
            bpy.ops.mesh.primitive_cone_add, f"camo_crest_{index}", on_skin(y, Vector((0.0, 0.0, 1.0))) + Vector((0.0, 0.0, tall * 0.5 - 0.008)), (0.022, 0.034, tall),
            vertices=10, radius1=1.0, radius2=0.15, depth=1.0,
        ))
    # Each foot is a pad under the ankle with two bundles of toes, splayed the way a chameleon's grip.
    pad_parts = []
    for name, sign, _, _, sole in LEGS:
        pad = Vector((sole[0], sole[1] - 0.012, 0.024))
        pad_parts.append(primitive(bpy.ops.mesh.primitive_uv_sphere_add, f"camo_pad_{name}", pad, (0.046, 0.056, 0.024), segments=14, ring_count=8))
        for index, spread in enumerate((-1.0, 1.0)):
            toe_parts.append(primitive(
                bpy.ops.mesh.primitive_uv_sphere_add, f"camo_toe_{name}_{index}",
                pad + Vector((spread * 0.034, -0.046, -0.004)), (0.021, 0.042, 0.019),
                Matrix.Rotation(math.radians(spread * 28.0), 3, "Z"), segments=12, ring_count=8,
            ))
    for side, middle in turrets.items():
        turret_parts.append(primitive(bpy.ops.mesh.primitive_uv_sphere_add, f"camo_turret_{side}", middle, (0.068, 0.066, 0.068), segments=20, ring_count=12))

    color = skin_color(samples)
    for part in skin_parts:
        paint(part, color)
    head_green, crest, toe, shell = linear(R_HEAD), linear(R_CREST), linear(R_TOE), linear(EYE_SHELL)
    paint(casque, lambda co, normal: head_green.lerp(linear(R_BACK), smoothstep(0.6, 0.66, co.z)))
    for part in crest_parts:
        paint(part, lambda co, normal: crest)
    for part in toe_parts:
        paint(part, lambda co, normal: toe)
    for part in pad_parts:
        paint(part, lambda co, normal: linear(R_FOOT))
    for part in turret_parts:
        paint(part, lambda co, normal: shell.lerp(head_green, 0.35))

    # Each part follows its bone; the skin eases from one bone to the next along the body.
    near = nearest_sample(samples)

    def along_body(co: Vector) -> dict[str, float]:
        sample = near(co)
        if sample.part == "leg":
            return {"root": 1.0}
        if sample.part == "tail":
            second = smoothstep(0.28, 0.4, sample.share)
            third = smoothstep(0.6, 0.72, sample.share)
            first = smoothstep(0.0, 0.1, sample.share)
            return {"body": 1.0 - first, "tail_1": first * (1.0 - second), "tail_2": second * (1.0 - third), "tail_3": third}
        turned = 1.0 - smoothstep(NECK[0], NECK[1], co.y)
        return {"head": turned, "body": 1.0 - turned}

    for part in skin_parts:
        weigh(part, along_body)
    weigh(casque, on("head"))
    for part in crest_parts:
        weigh(part, along_body)
    for part in toe_parts + pad_parts:
        weigh(part, on("root"))
    for side, part in zip(turrets, turret_parts):
        weigh(part, on(f"eye_{side}"))
    skin = rp.join(skin_parts + [casque] + crest_parts + pad_parts + toe_parts + turret_parts, "camo_skin")
    # Sculpted smoother than the game camera ever sees: thinned, it keeps its shape, paint, and weights.
    rp.simplify(skin, 0.62)
    box_wrap(skin)
    shade, bumps = scale_textures()
    rp.assign(skin, painted_material("Camo Skin", 0.62, shade, bumps))

    # --- The eyes: a cream ring, an amber iris, and a dark pupil looking out of each turret.
    eye_parts = []
    cream, iris, pupil = linear(EYE_CREAM), linear(IRIS), linear(PUPIL)
    for side, middle in turrets.items():
        axis = eye_axes[side]
        turn = axis.to_track_quat("Z", "Y").to_matrix()
        ball = primitive(bpy.ops.mesh.primitive_uv_sphere_add, f"camo_eye_{side}", middle + axis * 0.03, (0.046, 0.046, 0.042), turn, segments=24, ring_count=16)

        def ringed(co: Vector, normal: Vector, middle=middle, axis=axis) -> Vector:
            away = (co - (middle + axis * 0.03)).normalized().angle(axis)
            return pupil if away < 0.3 else iris if away < 0.68 else cream if away < 0.98 else shell

        paint(ball, ringed)
        glint = primitive(
            bpy.ops.mesh.primitive_uv_sphere_add, f"camo_glint_{side}", middle + axis * 0.07 + Vector((0.011 if side == "r" else -0.011, 0.0, 0.015)), (0.006, 0.006, 0.006),
            segments=8, ring_count=6,
        )
        paint(glint, lambda co, normal: Vector((1.0, 1.0, 1.0)))
        for part in (ball, glint):
            weigh(part, on(f"eye_{side}"))
            eye_parts.append(part)
    eyes = rp.join(eye_parts, "camo_eyes")
    rp.assign(eyes, painted_material("Camo Eye", 0.22))

    # --- The mouth: a fine line along each jaw that turns up at the corner, a quiet smile.
    mouth_parts = []
    for sign in (-1.0, 1.0):
        points = []
        for y, lift in ((-0.575, -0.2), (-0.53, -0.2), (-0.48, -0.17), (-0.43, -0.08), (-0.395, 0.08)):
            outward = Vector((sign * math.cos(math.asin(lift)), 0.0, lift))
            points.append((on_skin(y, outward) + outward * 0.001, 0.0038))
        mouth_parts.append(skin_over(f"camo_mouth_{'r' if sign < 0 else 'l'}", points, smoothing=0))
    mouth = rp.join(mouth_parts, "camo_mouth")
    paint(mouth, lambda co, normal: linear(MOUTH))
    weigh(mouth, on("head"))
    rp.assign(mouth, painted_material("Camo Mouth", 0.8))

    # --- The kerchief: cloth round the neck, knotted under the chin, its point on the chest.
    neck = -0.215
    top, bottom, side = on_skin(neck, Vector((0.0, 0.0, 1.0))), on_skin(neck, Vector((0.0, 0.0, -1.0))), on_skin(neck, Vector((1.0, 0.0, 0.0)))
    band = primitive(
        bpy.ops.mesh.primitive_torus_add, "camo_kerchief_band", (top + bottom) / 2.0, (1.0, 1.0, 1.0), Vector((0.0, 1.0, 0.0)).to_track_quat("Z", "Y").to_matrix(),
        major_radius=max(side.x, (top.z - bottom.z) / 2.0) + 0.004, minor_radius=0.02, major_segments=28, minor_segments=8,
    )
    under = bottom + Vector((0.0, -0.03, -0.014))
    knot = primitive(bpy.ops.mesh.primitive_uv_sphere_add, "camo_kerchief_knot", under, (0.034, 0.026, 0.028), segments=12, ring_count=8)
    point = primitive(
        bpy.ops.mesh.primitive_cone_add, "camo_kerchief_point", under + Vector((0.0, -0.012, -0.07)), (0.07, 0.012, 0.13),
        vertices=12, radius1=0.04, radius2=1.0, depth=1.0,
    )
    kerchief = rp.join([band, knot, point], "camo_kerchief")
    paint(kerchief, lambda co, normal: linear(R_CORAL))
    weigh(kerchief, on("body"))
    rp.assign(kerchief, painted_material("Camo Kerchief", 0.9, double_sided=True))

    meshes = [skin, eyes, mouth, kerchief]
    for obj in meshes:
        obj.parent = rig
        obj.modifiers.new("Armature", "ARMATURE").object = rig
    return rig, meshes


def animate_realistic(rig: bpy.types.Object) -> None:
    """The same idle as the cartoon Camo's, on the rig."""
    action = rp.new_clip(rig, "idle")
    bones = rig.pose.bones
    names = tuple(bone.name for bone in bones)
    for frame in range(0, IDLE_FRAMES + 1, 3):
        phase = 2.0 * math.pi * frame / IDLE_FRAMES
        breath = math.sin(2.0 * phase)
        sway = math.sin(phase)
        rp.shift(bones["body"], (0.0, 0.0, 0.004 * (1.0 + breath)))
        rp.turn(bones["body"], ("X", 0.6 * breath))
        rp.turn(bones["head"], ("X", 1.5 * breath), ("Y", 2.5 * sway), ("Z", 5.0 * math.sin(phase + 0.6)))
        rp.turn(bones["eye_l"], ("X", 7.0 * math.sin(phase + 1.0)), ("Z", 13.0 * math.sin(2.0 * phase + 1.0)))
        rp.turn(bones["eye_r"], ("X", 8.0 * math.sin(2.0 * phase)), ("Z", 11.0 * math.sin(phase + 2.2)))
        rp.turn(bones["tail_1"], ("Z", 2.5 * sway))
        rp.turn(bones["tail_2"], ("Z", 2.0 * sway), ("X", 1.5 * breath))
        rp.turn(bones["tail_3"], ("X", 3.0 * breath))
        rp.key(rig, frame + 1, names, location=("body",))
    rp.finish_clip(rig, action)


# The furthest, in meters, a foot may move while Camo idles.
MAX_FOOT_DRIFT = 0.001


def check_feet(rig: bpy.types.Object, skin: bpy.types.Object) -> float:
    """Plays the idle and returns how far any point of a foot strays from where it stands, in meters."""
    scene = bpy.context.scene
    # The feet and toes: what the legs' own bone holds at floor level. (The tail's curl dips as low.)
    legs = skin.vertex_groups["root"].index
    feet = [
        vertex.index for vertex in skin.data.vertices
        if vertex.co.z < 0.04 and any(item.group == legs and item.weight > 0.99 for item in vertex.groups)
    ]
    rig.animation_data.action = bpy.data.actions["idle"]
    drift = 0.0
    for frame in range(0, IDLE_FRAMES + 1, 6):
        scene.frame_set(frame + 1)
        posed = skin.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
        drift = max(drift, max((posed.vertices[index].co - skin.data.vertices[index].co).length for index in feet))
    rig.animation_data.action = None
    rp.reset_pose(rig)
    scene.frame_set(1)
    return drift


# -----------------------------------------------------------------------------
# Preview and validation

# How long and how tall Camo is, in meters, in either style.
LENGTH, HEIGHT = (1.1, 1.4), (0.59, 0.75)
MAX_BYTES = {CARTOON_KEY: 450_000, REALISTIC_KEY: 900_000}


def area_light(name: str, location: tuple[float, float, float], energy: float, size: float, color: tuple[float, float, float]) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size, data.color = energy, "DISK", size, color
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    kit.point_at(obj, (0.0, 0.0, 0.3))


def set_stage() -> bpy.types.Object:
    """A ground, soft lights, and a camera for the preview and the close-ups."""
    scene = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=60.0, location=(0.0, 0.0, -0.004))
    ground = bpy.context.object
    ground.name = "Preview Ground"
    ground.data.materials.append(kit.material("Preview Ground", rp.hex_rgba("#dde8d4"), roughness=0.92))
    world = bpy.data.worlds.new("Preview World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = rp.hex_rgba("#d9ebdd")
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.4
    scene.world = world
    area_light("Preview Key", (2.2, -2.8, 3.2), 420.0, 3.0, (1.0, 0.86, 0.7))
    area_light("Preview Fill", (-2.5, -1.4, 1.8), 240.0, 2.7, (0.67, 0.82, 1.0))
    area_light("Preview Rim", (0.5, 2.5, 2.4), 300.0, 2.0, (0.75, 1.0, 0.78))
    camera = bpy.data.objects.new("Preview Camera", bpy.data.cameras.new("Preview Camera"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.image_settings.file_format = "PNG"
    return camera


def shot(camera: bpy.types.Object, path: Path, target: tuple[float, float, float], offset: tuple[float, float, float], lens: float, size: tuple[int, int]) -> None:
    scene = bpy.context.scene
    camera.data.lens = lens
    camera.location = Vector(target) + Vector(offset)
    kit.point_at(camera, target)
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def validate(key: str) -> None:
    """Re-imports a GLB into an empty scene and checks it against the asset contract."""
    path = GLB_DIR / f"{key}.glb"
    size = path.stat().st_size
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.startswith("camo_")]
    bpy.context.view_layer.update()
    points = {obj.name: [obj.matrix_world @ vertex.co for vertex in obj.data.vertices] for obj in meshes}
    everything = [point for group in points.values() for point in group]
    low = min(point.z for point in everything)  # glTF Y-up returns to Blender Z-up on import.
    tall = max(point.z for point in everything) - low
    front, rear = min(point.y for point in everything), max(point.y for point in everything)
    eyes = [point.y for name, group in points.items() if "eye" in name for point in group]
    clips = {action.name.split("_")[0] for action in bpy.data.actions}
    triangles = sum(len(polygon.vertices) - 2 for obj in meshes for polygon in obj.data.polygons)
    if abs(low) > 0.006:
        raise RuntimeError(f"{path.name}: ground is z={low:.5f} m after import, expected 0")
    if not (HEIGHT[0] <= tall <= HEIGHT[1] and LENGTH[0] <= rear - front <= LENGTH[1]):
        raise RuntimeError(f"{path.name}: {rear - front:.3f} m long and {tall:.3f} m tall is outside Camo's size")
    # Camo faces glTF +Z, Blender's -Y: the eyes are at that end.
    if not eyes or sum(eyes) / len(eyes) > front + 0.35:
        raise RuntimeError(f"{path.name}: Camo does not face forward")
    if clips != {"idle"}:
        raise RuntimeError(f"{path.name}: expected an idle clip, found {sorted(clips)}")
    if size > MAX_BYTES[key]:
        raise RuntimeError(f"{path.name}: {size} bytes exceeds the budget")
    print(f"PASS {path.name} {size} bytes | {rear - front:.3f} m long, {tall:.3f} m tall | triangles={triangles} | meshes={len(meshes)} | clips={sorted(clips)}")


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    views = Path(arguments[arguments.index("--views") + 1]).resolve() if "--views" in arguments else None
    if views:
        views.mkdir(parents=True, exist_ok=True)
    GLB_DIR.mkdir(parents=True, exist_ok=True)

    kit.reset_scene()
    bpy.context.scene.render.fps = FPS
    build_cartoon()
    kit.animate(CARTOON_CLIPS, "camo_")
    kit.export_asset(CARTOON_KEY, GLB_DIR)

    rig, meshes = build_realistic()
    animate_realistic(rig)
    drift = check_feet(rig, meshes[0])
    print(f"{'PASS' if drift <= MAX_FOOT_DRIFT else 'FAIL'} realistic Camo idle: the planted feet stay within {drift * 1000:.1f} mm")
    if drift > MAX_FOOT_DRIFT:
        raise RuntimeError(f"Camo's feet slide {drift * 1000:.1f} mm during the idle")
    rp.export_model(rig, meshes, GLB_DIR / f"{REALISTIC_KEY}.glb")

    # The two side by side, at rest, in the saved scene and its render.
    kit.mute_clips()
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    cartoon = kit.ASSET_ROOTS[CARTOON_KEY]
    cartoon.location.x, rig.location.x = -0.62, 0.62
    camera = set_stage()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)
    shot(camera, PREVIEW_PATH, (0.0, 0.0, 0.3), (2.2, -3.6, 1.5), 62.0, (1400, 700))
    if views:
        shown = {CARTOON_KEY: list(kit.ASSET_COLLECTIONS[CARTOON_KEY].objects), REALISTIC_KEY: [rig, *meshes]}
        for key, x in ((CARTOON_KEY, cartoon.location.x), (REALISTIC_KEY, rig.location.x)):
            for other, objects in shown.items():
                for obj in objects:
                    obj.hide_render = other != key
            for name, offset, lens in (("threeq", (1.5, -2.2, 0.9), 62.0), ("front", (0.0, -2.6, 0.5), 62.0), ("side", (2.6, 0.0, 0.5), 62.0), ("back", (-1.2, 2.3, 0.9), 62.0), ("face", (0.5, -1.3, 0.35), 70.0)):
                target = (x, -0.3, 0.42) if name == "face" else (x, 0.02, 0.32)
                shot(camera, views / f"{key}-{name}.png", target, offset, lens, (800, 640))

    for key in (CARTOON_KEY, REALISTIC_KEY):
        validate(key)
    print(f"Source:  {BLEND_PATH.relative_to(REPO_ROOT)}")
    print(f"Preview: {PREVIEW_PATH.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
