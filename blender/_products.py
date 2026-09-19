"""Procedural product proxies + damage markers for ClaimSight's Blender renders (bpy, headless).

Shared by damage_twin.py (receipt renders) and synth_evidence.py (synthetic evidence clips).
Products are schematic on purpose: the point is where the damage is, not a photoreal model.
"""
import math
import os
import random
import bpy
from mathutils import Vector

PRODUCTS = {
    "mug": {"damage": ["rim", "handle", "base"], "color": (0.95, 0.95, 0.92)},
    "headphones": {"damage": ["hinge", "headband", "cup"], "color": (0.06, 0.06, 0.07)},
    "lamp": {"damage": ["shade", "stem", "base"], "color": (0.93, 0.85, 0.62)},
    "vase": {"damage": ["body", "neck", "base"], "color": (0.72, 0.84, 0.92)},
    "tshirt": {"damage": ["collar", "fabric", "sleeve"], "color": (0.23, 0.35, 0.62)},
    "generic": {"damage": ["corner", "face", "edge"], "color": (0.8, 0.8, 0.8)},
}

# ---------------------------------------------------------------- helpers

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    return scene


def pick_engine(scene):
    items = {e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
    for cand in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'BLENDER_WORKBENCH'):
        if cand in items:
            scene.render.engine = cand
            return cand
    return scene.render.engine


def material(name, color, roughness=0.4, metallic=0.0, emission=None, emission_strength=0.0, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.blend_method = 'BLEND' if hasattr(mat, 'blend_method') else mat.blend_method
    return mat


def smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def boolean_cut(target, cutter, name="cut"):
    mod = target.modifiers.new(name, 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    try:
        mod.solver = 'EXACT'
    except Exception:
        pass
    cutter.hide_render = True
    cutter.hide_viewport = True
    cutter.display_type = 'WIRE'


def add(op, **kw):
    op(**kw)
    return bpy.context.object


# ---------------------------------------------------------------- products

def build_product(kind, color=None, parent=None):
    """Returns (parts:list[Object], center:Vector, radius:float, damage_points:dict[str, Vector])."""
    spec = PRODUCTS.get(kind, PRODUCTS["generic"])
    base = color or spec["color"]
    parts = []
    points = {}
    if kind == "mug":
        body = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.42, depth=0.95, vertices=64, location=(0, 0, 0.475))
        inner = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.36, depth=0.95, vertices=64, location=(0, 0, 0.55))
        boolean_cut(body, inner, "hollow")
        handle = add(bpy.ops.mesh.primitive_torus_add, major_radius=0.24, minor_radius=0.055, major_segments=48, minor_segments=16,
                     location=(0.5, 0, 0.5), rotation=(math.radians(90), 0, 0))
        mat = material("mug", base, roughness=0.3)
        for o in (body, handle):
            smooth(o); assign(o, mat); parts.append(o)
        parts.append(inner)
        points = {"rim": Vector((-0.30, -0.28, 0.95)), "handle": Vector((0.72, 0, 0.5)), "base": Vector((0.2, -0.36, 0.02))}
        radius = 0.9
    elif kind == "headphones":
        band = add(bpy.ops.mesh.primitive_torus_add, major_radius=0.85, minor_radius=0.07, major_segments=64, minor_segments=16,
                   location=(0, 0, 0.9), rotation=(math.radians(90), 0, 0))
        cutter = add(bpy.ops.mesh.primitive_cube_add, size=2.4, location=(0, 0, -0.3))
        boolean_cut(band, cutter, "half")
        cups = []
        for sx in (-1, 1):
            cup = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.32, depth=0.16, vertices=48,
                      location=(sx * 0.9, 0, 0.75), rotation=(0, math.radians(90), 0))
            pad = add(bpy.ops.mesh.primitive_torus_add, major_radius=0.24, minor_radius=0.07, location=(sx * 0.82, 0, 0.75),
                      rotation=(0, math.radians(90), 0))
            cups += [cup, pad]
        mat = material("headphones", base, roughness=0.45)
        pad_mat = material("pads", (0.12, 0.12, 0.13), roughness=0.8)
        for o in [band] + cups:
            smooth(o); assign(o, pad_mat if o.type == 'MESH' and 'Torus' in o.name and o is not band else mat); parts.append(o)
        parts.append(cutter)
        points = {"hinge": Vector((0.88, 0, 1.25)), "headband": Vector((0, 0, 1.76)), "cup": Vector((-1.1, 0, 0.75))}
        radius = 1.6
    elif kind == "lamp":
        foot = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.38, depth=0.06, vertices=64, location=(0, 0, 0.03))
        stem = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.035, depth=1.3, vertices=24, location=(0, 0, 0.7))
        shade = add(bpy.ops.mesh.primitive_cone_add, radius1=0.55, radius2=0.28, depth=0.55, vertices=64, location=(0, 0, 1.55))
        metal = material("lamp_metal", (0.25, 0.25, 0.27), roughness=0.35, metallic=0.9)
        shade_mat = material("shade", base, roughness=0.7)
        for o, m in ((foot, metal), (stem, metal), (shade, shade_mat)):
            smooth(o); assign(o, m); parts.append(o)
        points = {"shade": Vector((0.42, -0.3, 1.6)), "stem": Vector((0.05, -0.05, 0.9)), "base": Vector((0.3, -0.25, 0.06))}
        radius = 1.5
    elif kind == "vase":
        body = add(bpy.ops.mesh.primitive_uv_sphere_add, radius=0.5, segments=64, ring_count=32, location=(0, 0, 0.55))
        body.scale = (1.0, 1.0, 1.25)
        neck = add(bpy.ops.mesh.primitive_cylinder_add, radius=0.2, depth=0.5, vertices=48, location=(0, 0, 1.3))
        lip = add(bpy.ops.mesh.primitive_torus_add, major_radius=0.2, minor_radius=0.05, location=(0, 0, 1.55))
        mat = material("vase", base, roughness=0.15)
        for o in (body, neck, lip):
            smooth(o); assign(o, mat); parts.append(o)
        points = {"body": Vector((0.4, -0.35, 0.6)), "neck": Vector((0.18, -0.12, 1.35)), "base": Vector((0.25, -0.3, 0.05))}
        radius = 1.4
    elif kind == "tshirt":
        torso = add(bpy.ops.mesh.primitive_cube_add, size=1.0, location=(0, 0, 0.55))
        torso.scale = (0.55, 0.06, 0.65)
        sleeves = []
        for sx in (-1, 1):
            s = add(bpy.ops.mesh.primitive_cube_add, size=1.0, location=(sx * 0.7, 0, 0.95), rotation=(0, math.radians(-sx * 25), 0))
            s.scale = (0.22, 0.06, 0.24)
            sleeves.append(s)
        mat = material("tshirt", base, roughness=0.9)
        for o in [torso] + sleeves:
            assign(o, mat); parts.append(o)
        points = {"collar": Vector((0, -0.08, 1.15)), "fabric": Vector((0.15, -0.08, 0.5)), "sleeve": Vector((0.78, -0.08, 0.95))}
        radius = 1.3
    else:
        box = add(bpy.ops.mesh.primitive_cube_add, size=1.0, location=(0, 0, 0.5))
        mat = material("generic", base, roughness=0.5)
        assign(box, mat); parts.append(box)
        points = {"corner": Vector((0.5, -0.5, 1.0)), "face": Vector((0, -0.5, 0.5)), "edge": Vector((0.5, 0, 0.5))}
        radius = 1.2
    if parent is not None:
        for o in parts:
            o.parent = parent
    center = Vector((0, 0, radius * 0.45))
    return parts, center, radius, points


def apply_damage(kind, parts, location, point, severity=1.0):
    """Cut a chip/crack into the product near `point` (a boolean cutter) so the damage is visible."""
    target = None
    for o in parts:
        if o.hide_render:
            continue
        target = o
        break
    if kind == "mug":
        target = parts[0]
    elif kind == "headphones":
        target = parts[0]
    elif kind == "lamp":
        target = parts[2] if location == "shade" else parts[1]
    elif kind == "vase":
        target = parts[0]
    if target is None:
        return None
    r = 0.09 * severity
    if location in ("rim", "hinge", "shade", "corner", "collar"):
        cutter = add(bpy.ops.mesh.primitive_uv_sphere_add, radius=r, segments=24, ring_count=12, location=tuple(point))
    else:
        cutter = add(bpy.ops.mesh.primitive_cube_add, size=1.0, location=tuple(point))
        cutter.scale = (0.012, 0.25, 0.25 * severity)
        cutter.rotation_euler = (0, math.radians(20), math.radians(random.uniform(-30, 30)))
    boolean_cut(target, cutter, f"damage_{location}")
    return cutter


def damage_marker(point, color=(1.0, 0.25, 0.2), frames=(1, 120), strength=(4.0, 14.0)):
    """Emissive ring that pulses at the damage point (the 'here' callout)."""
    ring = add(bpy.ops.mesh.primitive_torus_add, major_radius=0.11, minor_radius=0.012, major_segments=48, minor_segments=12,
               location=tuple(point))
    mat = material("marker", (0.05, 0.02, 0.02), roughness=0.5, emission=color, emission_strength=strength[1])
    assign(ring, mat)
    cam = bpy.context.scene.camera
    if cam is not None:
        con = ring.constraints.new('TRACK_TO')
        con.target = cam
        con.track_axis = 'TRACK_Z'
        con.up_axis = 'UP_Y'
    no_shadow(ring)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    inp = bsdf.inputs["Emission Strength"]
    f0, f1 = frames
    step = max(6, (f1 - f0) // 8)
    for i, f in enumerate(range(f0, f1 + 1, step)):
        inp.default_value = strength[1] if i % 2 == 0 else strength[0]
        inp.keyframe_insert("default_value", frame=f)
    dot = add(bpy.ops.mesh.primitive_uv_sphere_add, radius=0.03, segments=16, ring_count=8, location=tuple(point))
    assign(dot, mat)
    return [ring, dot]


# ---------------------------------------------------------------- scene dressing

def studio(scene, floor_color=(0.06, 0.075, 0.125), world_color=(0.06, 0.075, 0.125), world_strength=0.9,
           key=1200.0, fill=350.0, rim=700.0, key_angle=35.0):
    floor = add(bpy.ops.mesh.primitive_plane_add, size=30, location=(0, 0, 0))
    assign(floor, material("floor", floor_color, roughness=0.95))
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs[0].default_value = (*world_color, 1.0)
    bg.inputs[1].default_value = world_strength
    scene.world = world
    a = math.radians(key_angle)
    lights = []
    for name, energy, loc, size in (
        ("key", key, (2.6 * math.cos(a), -2.6 * math.sin(a), 3.2), 2.5),
        ("fill", fill, (-3.0, -2.0, 1.8), 4.0),
        ("rim", rim, (0.5, 3.2, 3.0), 2.0),
    ):
        bpy.ops.object.light_add(type='AREA', location=loc)
        l = bpy.context.object
        l.name = name
        l.data.energy = energy
        l.data.size = size
        con = l.constraints.new('TRACK_TO')
        con.track_axis = 'TRACK_NEGATIVE_Z'
        con.up_axis = 'UP_Y'
        lights.append(l)
    return floor, lights


def camera_rig(scene, target_loc, distance, height, lens=50.0, orbit_deg=360.0, frames=(1, 120), start_deg=-30.0):
    """Camera parented to an empty that orbits the target."""
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=tuple(target_loc))
    pivot = bpy.context.object
    pivot.name = "orbit"
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=tuple(target_loc))
    target = bpy.context.object
    target.name = "look_at"
    bpy.ops.object.camera_add(location=(target_loc.x, target_loc.y - distance, target_loc.z + height))
    cam = bpy.context.object
    cam.data.lens = lens
    cam.parent = pivot
    cam.matrix_parent_inverse = pivot.matrix_world.inverted()
    con = cam.constraints.new('TRACK_TO')
    con.target = target
    con.track_axis = 'TRACK_NEGATIVE_Z'
    con.up_axis = 'UP_Y'
    f0, f1 = frames
    try:  # new keyframes linear (works for classic and layered actions, Blender 4.x/5.x)
        bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'
    except Exception:
        pass
    pivot.rotation_euler = (0, 0, math.radians(start_deg))
    pivot.keyframe_insert("rotation_euler", frame=f0)
    pivot.rotation_euler = (0, 0, math.radians(start_deg + orbit_deg))
    pivot.keyframe_insert("rotation_euler", frame=f1)
    try:
        bpy.context.preferences.edit.keyframe_new_interpolation_type = 'BEZIER'
    except Exception:
        pass
    scene.camera = cam
    for l in bpy.data.objects:
        if l.type == 'LIGHT':
            for c in l.constraints:
                if c.type == 'TRACK_TO' and c.target is None:
                    c.target = target
    return cam, pivot, target


def handheld(cam, frames, seed=0, amount=0.05, step=6):
    """Phone-style wobble: small random offsets keyframed every `step` frames (bezier smoothed)."""
    rnd = random.Random(seed)
    base = cam.location.copy()
    f0, f1 = frames
    for f in range(f0, f1 + 1, step):
        cam.location = base + Vector((rnd.uniform(-amount, amount), rnd.uniform(-amount, amount), rnd.uniform(-amount, amount)))
        cam.keyframe_insert("location", frame=f)
    cam.location = base


def configure_render(scene, frames_dir, width=960, height=540, fps=24, frames=(1, 120), samples=16):
    """Render a PNG sequence into frames_dir (encode with encode_video). Works on every Blender build."""
    engine = pick_engine(scene)
    scene.frame_start, scene.frame_end = frames
    scene.render.fps = fps
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    if hasattr(scene, "eevee"):
        try:
            scene.eevee.taa_render_samples = samples
        except Exception:
            pass
    try:
        scene.view_settings.view_transform = 'AgX'
    except Exception:
        pass
    try:
        scene.render.image_settings.media_type = 'IMAGE'
    except Exception:
        pass
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    scene.render.use_file_extension = True
    scene.render.filepath = os.path.join(frames_dir, "frame_")
    return engine


def encode_video(frames_dir, fps, out_path, crf=20):
    """PNG sequence -> H.264 MP4 with the system ffmpeg (yuv420p so browsers play it)."""
    import subprocess
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i", os.path.join(frames_dir, "frame_%04d.png"),
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf), "-movflags", "+faststart", out_path]
    subprocess.run(cmd, check=True)
    return out_path


def poster_frame(frames_dir, index, out_path):
    import shutil
    src = os.path.join(frames_dir, f"frame_{index:04d}.png")
    if os.path.exists(src):
        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
        shutil.copyfile(src, out_path)
        return out_path
    return None


def no_shadow(obj):
    for attr in ("visible_shadow",):
        try:
            setattr(obj, attr, False)
        except Exception:
            pass
    try:
        obj.cycles_visibility.shadow = False
    except Exception:
        pass


def hud_text(cam, text, x, y, size=0.028, color=(0.91, 0.93, 0.96), font=None, depth=1.2, align='LEFT'):
    bpy.ops.object.text_add()
    t = bpy.context.object
    t.data.body = text
    t.data.size = size
    t.data.align_x = align
    if font is not None:
        t.data.font = font
    t.parent = cam
    t.location = (x, y, -depth)
    t.rotation_euler = (0, 0, 0)
    assign(t, material(f"hud_{text[:8]}", (0, 0, 0), emission=color, emission_strength=1.6))
    no_shadow(t)
    return t


def hud_scrim(cam, x, y, width, height, depth=1.25, alpha=0.55):
    """Translucent dark band parented to the camera, behind HUD text, for legibility."""
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    band = bpy.context.object
    band.scale = (width, height, 1)
    band.parent = cam
    band.location = (x, y, -depth)
    band.rotation_euler = (0, 0, 0)
    mat = bpy.data.materials.new("hud_scrim")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.02, 0.025, 0.04, 1.0)
    bsdf.inputs["Alpha"].default_value = alpha
    for attr, val in (("surface_render_method", 'BLENDED'), ("blend_method", 'BLEND')):
        try:
            setattr(mat, attr, val)
        except Exception:
            pass
    assign(band, mat)
    no_shadow(band)
    return band


def hud_image(cam, image_path, x, y, width, depth=1.2):
    try:
        img = bpy.data.images.load(image_path)
    except Exception:
        return None
    ratio = img.size[1] / max(1, img.size[0])
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    plane = bpy.context.object
    plane.scale = (width, width * ratio, 1)
    plane.parent = cam
    plane.location = (x, y, -depth)
    plane.rotation_euler = (0, 0, 0)
    mat = bpy.data.materials.new("hud_image")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
    assign(plane, mat)
    # frame border
    bpy.ops.mesh.primitive_plane_add(size=1.0)
    border = bpy.context.object
    border.scale = (width * 1.03, width * ratio * 1.03 + 0.004, 1)
    border.parent = cam
    border.location = (x, y, -depth - 0.002)
    assign(border, material("hud_border", (0, 0, 0), emission=(0.22, 0.53, 0.9), emission_strength=1.2))
    no_shadow(plane); no_shadow(border)
    return plane


def load_font():
    for path in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return bpy.data.fonts.load(path)
        except Exception:
            continue
    return None
