"""ClaimSight Synthetic Evidence Lab — generate labelled evidence clips with Blender (headless).

    blender -b -P blender/synth_evidence.py -- --out blender/out/lab --count 40 [--seed 7]
        [--twin-rate 0.4] [--damaged-rate 0.65] [--width 640 --height 360 --fps 12 --duration 4]

Writes <out>/<clip_id>.mp4 for every clip plus <out>/manifest.json with the ground truth:
product, damaged, damage_type, damage_location, group_id, twin_of, variant (lighting, background,
camera seed, mirrored). "Twins" are the same damaged item re-filmed under different lighting,
background, camera motion and (sometimes) mirrored — the fraud pattern ClaimSight must catch.
Phone-style handheld wobble is keyframed on the camera.
"""
import glob
import json
import os
import random
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import _products as P  # noqa: E402

DAMAGE_TYPES = {"rim": "chip", "handle": "crack", "base": "chip", "hinge": "crack", "headband": "crack", "cup": "scuff",
                "shade": "dent", "stem": "bend", "body": "crack", "neck": "chip", "collar": "tear", "fabric": "stain",
                "sleeve": "tear", "corner": "dent", "face": "scratch", "edge": "chip"}
FLOORS = {"dark": (0.06, 0.075, 0.125), "wood": (0.36, 0.24, 0.14), "white": (0.9, 0.9, 0.88), "gray": (0.45, 0.46, 0.48),
          "warm": (0.8, 0.7, 0.55)}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"out": "blender/out/lab", "count": 12, "seed": 7, "twin_rate": 0.4, "damaged_rate": 0.65,
            "width": 640, "height": 360, "fps": 12, "duration": 4.0, "samples": 8}
    i = 0
    while i < len(argv):
        key = argv[i][2:].replace("-", "_")
        if key in opts and i + 1 < len(argv):
            cur = opts[key]
            opts[key] = type(cur)(argv[i + 1]) if not isinstance(cur, bool) else argv[i + 1] == "1"
            i += 2
        else:
            i += 1
    return opts


def render_clip(clip, opts, out_dir):
    rnd = random.Random(clip["variant"]["camera_seed"])
    scene = P.reset_scene()
    fps = opts["fps"]
    frames = (1, max(2, int(round(fps * opts["duration"]))))
    v = clip["variant"]
    P.studio(scene, floor_color=FLOORS[v["background"]], world_color=tuple(c * 0.6 for c in FLOORS[v["background"]]),
             world_strength=v["world_strength"], key=v["key"], fill=v["fill"], rim=v["rim"], key_angle=v["key_angle"])
    bpy.ops.object.empty_add(type='PLAIN_AXES', location=(0, 0, 0))
    root = bpy.context.object
    parts, center, radius, points = P.build_product(clip["product"], color=tuple(v["color"]), parent=root)
    if clip["damaged"]:
        P.apply_damage(clip["product"], parts, clip["damage_location"], points[clip["damage_location"]], clip["severity"])
    if v["mirrored"]:
        root.scale = (-1, 1, 1)
    cam, pivot, target = P.camera_rig(scene, center, distance=max(2.0, radius * v["distance"]), height=radius * v["height"],
                                      lens=v["lens"], orbit_deg=v["orbit"], frames=frames, start_deg=v["start_deg"])
    P.handheld(cam, frames, seed=v["camera_seed"], amount=v["wobble"], step=max(3, fps // 3))
    tmp = tempfile.mkdtemp(prefix="synth_")
    P.configure_render(scene, tmp, width=opts["width"], height=opts["height"], fps=fps, frames=frames, samples=opts["samples"])
    bpy.ops.render.render(animation=True)
    if not glob.glob(os.path.join(tmp, "frame_*.png")):
        raise RuntimeError("no output frames")
    P.encode_video(tmp, fps, os.path.join(out_dir, clip["file"]))
    # poster (frame ~1s) for image search / thumbnails
    P.poster_frame(tmp, min(frames[1], frames[0] + fps), os.path.join(out_dir, clip["file"].replace(".mp4", ".png")))
    shutil.rmtree(tmp, ignore_errors=True)


def new_variant(rnd, product):
    base = P.PRODUCTS[product]["color"]
    jitter = [max(0.0, min(1.0, c + rnd.uniform(-0.08, 0.08))) for c in base]
    return {
        "color": jitter, "background": rnd.choice(list(FLOORS)), "world_strength": round(rnd.uniform(0.5, 1.4), 2),
        "key": round(rnd.uniform(500, 1600)), "fill": round(rnd.uniform(150, 500)), "rim": round(rnd.uniform(200, 900)),
        "key_angle": round(rnd.uniform(15, 75)), "lens": rnd.choice([28, 35, 50]), "distance": round(rnd.uniform(3.0, 4.2), 2),
        "height": round(rnd.uniform(0.5, 1.3), 2), "orbit": round(rnd.uniform(-60, 60)), "start_deg": round(rnd.uniform(-180, 180)),
        "wobble": round(rnd.uniform(0.02, 0.07), 3), "camera_seed": rnd.randint(1, 10**6), "mirrored": False,
    }


def main():
    opts = parse_args()
    rnd = random.Random(opts["seed"])
    out_dir = os.path.abspath(opts["out"])
    os.makedirs(out_dir, exist_ok=True)
    clips = []
    n = 0
    group = 0
    while len(clips) < opts["count"]:
        group += 1
        product = rnd.choice([k for k in P.PRODUCTS if k != "generic"])
        damaged = rnd.random() < opts["damaged_rate"]
        loc = rnd.choice(P.PRODUCTS[product]["damage"]) if damaged else None
        severity = round(rnd.uniform(0.7, 1.4), 2) if damaged else 0.0
        base = {"product": product, "damaged": damaged, "damage_location": loc, "damage_type": DAMAGE_TYPES.get(loc) if loc else None,
                "severity": severity, "group_id": f"g{group:03d}"}
        n += 1
        first = dict(base, clip_id=f"clip_{n:03d}", file=f"clip_{n:03d}.mp4", twin_of=None, variant=new_variant(rnd, product))
        clips.append(first)
        if damaged and rnd.random() < opts["twin_rate"] and len(clips) < opts["count"]:
            n += 1
            tv = new_variant(rnd, product)
            tv["color"] = first["variant"]["color"]  # same physical item
            tv["mirrored"] = rnd.random() < 0.4
            clips.append(dict(base, clip_id=f"clip_{n:03d}", file=f"clip_{n:03d}.mp4", twin_of=first["clip_id"], variant=tv))
    manifest = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": opts["seed"], "options": opts,
                "clips": clips}
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    t0 = time.time()
    for i, clip in enumerate(clips, 1):
        t1 = time.time()
        render_clip(clip, opts, out_dir)
        print(f"[lab] {i}/{len(clips)} {clip['clip_id']} {clip['product']} damaged={clip['damaged']} {clip['damage_type'] or ''} "
              f"twin_of={clip['twin_of']} mirrored={clip['variant']['mirrored']} ({time.time() - t1:.1f}s)")
    print(f"[lab] {len(clips)} clips in {time.time() - t0:.0f}s -> {out_dir}/manifest.json")


main()
