"""ClaimSight Damage Twin — render a 3D receipt for one claim (headless Blender).

    blender -b -P blender/damage_twin.py -- --spec spec.json --out out.mp4 [--poster out.png]

spec.json (all keys optional except product):
{
  "product": "mug", "damage_location": "rim", "damage_type": "chip", "severity": 1.0,
  "display_id": "C-A1042-81D3", "order_id": "A1042", "customer_name": "Alice Moreno",
  "evidence_line": "White ceramic mug, chip on the rim at 0:03", "evidence_time": "0:03",
  "action": "refund", "amount": 24.0, "txn_id": "txn_…", "policy_clauses": ["P2", "P4"],
  "frame_path": "/abs/path/customer_frame.jpg", "color": [0.95, 0.95, 0.92],
  "duration_s": 5, "fps": 24, "width": 960, "height": 540, "samples": 16
}
The camera orbits the product once; an emissive ring pulses at the damage location Memories.ai
described; the customer's frame and the decision are composited as a HUD. Output: H.264 MP4 (+ PNG poster).
"""
import glob
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402
import _products as P  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = {"spec": None, "out": None, "poster": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--spec", "--out", "--poster") and i + 1 < len(argv):
            out[a[2:]] = argv[i + 1]
            i += 2
        else:
            i += 1
    if not out["spec"] or not out["out"]:
        raise SystemExit("usage: blender -b -P damage_twin.py -- --spec spec.json --out out.mp4 [--poster out.png]")
    return out


def money(v):
    try:
        return f"${float(v):,.2f}"
    except Exception:
        return str(v)


def main():
    args = parse_args()
    with open(args["spec"]) as fh:
        spec = json.load(fh)
    t0 = time.time()
    scene = P.reset_scene()
    fps = int(spec.get("fps", 24))
    duration = float(spec.get("duration_s", 5))
    frames = (1, max(2, int(round(fps * duration))))
    kind = spec.get("product", "generic")
    if kind not in P.PRODUCTS:
        kind = "generic"
    location = spec.get("damage_location") or P.PRODUCTS[kind]["damage"][0]
    if location not in P.PRODUCTS[kind]["damage"]:
        location = P.PRODUCTS[kind]["damage"][0]
    color = tuple(spec["color"]) if spec.get("color") else None

    floor, lights = P.studio(scene)
    parts, center, radius, points = P.build_product(kind, color=color)
    point = points[location]
    P.apply_damage(kind, parts, location, point, float(spec.get("severity", 1.0)))

    import math
    # start the orbit so the damage faces the camera at ~24% of the clip (the poster frame)
    az = math.degrees(math.atan2(point.y, point.x))
    start_deg = az + 90.0 - 360.0 * 0.24
    cam, pivot, target = P.camera_rig(scene, center, distance=max(3.4, radius * 3.6), height=radius * 0.95, lens=40.0,
                                      frames=frames, orbit_deg=360.0, start_deg=start_deg)
    P.damage_marker(point, frames=frames)
    font = P.load_font()
    P.hud_scrim(cam, 0.0, -0.205, 0.9, 0.09)   # bottom band
    P.hud_scrim(cam, -0.22, 0.175, 0.46, 0.12)  # top-left band

    # 3D callout above the damage (billboard)
    label = spec.get("damage_type", "damage")
    t = P.hud_text(cam, f"{label} · {location}" + (f" · {spec['evidence_time']}" if spec.get("evidence_time") else ""), 0, 0, size=0.09,
                   color=(1.0, 0.45, 0.4), font=font)
    t.parent = None
    t.location = point + Vector((0.18, -0.12, 0.10))
    P.no_shadow(t)
    con = t.constraints.new('TRACK_TO')
    con.target = cam
    con.track_axis = 'TRACK_Z'
    con.up_axis = 'UP_Y'

    # HUD (parented to the camera): identity, evidence, decision, customer frame
    P.hud_text(cam, "CLAIMSIGHT · DAMAGE TWIN", -0.40, 0.205, size=0.018, color=(0.55, 0.6, 0.7), font=font)
    P.hud_text(cam, spec.get("display_id", ""), -0.40, 0.165, size=0.032, font=font)
    who = " · ".join(x for x in (spec.get("customer_name"), f"Order {spec['order_id']}" if spec.get("order_id") else None) if x)
    if who:
        P.hud_text(cam, who, -0.40, 0.135, size=0.018, color=(0.7, 0.74, 0.82), font=font)
    if spec.get("evidence_line"):
        P.hud_text(cam, spec["evidence_line"][:70], -0.40, -0.19, size=0.02, font=font)
    P.hud_text(cam, "What Memories.ai saw" + (f" · frame at {spec['evidence_time']}" if spec.get("evidence_time") else ""), -0.40, -0.218,
               size=0.015, color=(0.55, 0.6, 0.7), font=font)
    action = str(spec.get("action", "")).lower()
    amount = money(spec.get("amount", 0))
    if action in ("refund", "approved"):
        line, col = f"Refund issued · {amount}", (0.24, 0.8, 0.42)
    elif action == "replacement":
        line, col = f"Replacement sent · {amount}", (0.24, 0.8, 0.42)
    elif action == "escalated":
        line, col = f"Escalated to a teammate · {amount} at stake", (0.94, 0.66, 0.23)
    elif action == "denied":
        line, col = "Claim denied", (1.0, 0.42, 0.42)
    else:
        line, col = "Needs more information", (0.7, 0.74, 0.82)
    P.hud_text(cam, line, 0.40, -0.19, size=0.024, color=col, font=font, align='RIGHT')
    sub = " · ".join(x for x in (
        ("Clauses " + " ".join(spec["policy_clauses"])) if spec.get("policy_clauses") else None,
        spec.get("txn_id"),
    ) if x)
    if sub:
        P.hud_text(cam, sub, 0.40, -0.218, size=0.015, color=(0.55, 0.6, 0.7), font=font, align='RIGHT')
    if spec.get("frame_path") and os.path.exists(spec["frame_path"]):
        P.hud_image(cam, spec["frame_path"], 0.29, 0.135, width=0.22)
        P.hud_text(cam, "customer evidence", 0.40, 0.055, size=0.014, color=(0.55, 0.6, 0.7), font=font, align='RIGHT')

    tmp = tempfile.mkdtemp(prefix="twin_")
    engine = P.configure_render(scene, tmp, width=int(spec.get("width", 960)), height=int(spec.get("height", 540)),
                                fps=fps, frames=frames, samples=int(spec.get("samples", 16)))
    print(f"[twin] engine={engine} product={kind} damage={label}@{location} frames={frames} -> {args['out']}")
    bpy.ops.render.render(animation=True)
    if not glob.glob(os.path.join(tmp, "frame_*.png")):
        raise SystemExit("render produced no frames")
    P.encode_video(tmp, fps, args["out"])
    if args.get("poster"):
        P.poster_frame(tmp, min(frames[1], frames[0] + int(fps * 1.2)), args["poster"])
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"[twin] done in {time.time() - t0:.1f}s -> {args['out']}" + (f" + {args['poster']}" if args.get("poster") else ""))


main()
