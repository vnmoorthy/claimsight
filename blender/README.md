# Blender layer

Two headless `bpy` pipelines, driven by JSON, that run on this laptop or on the AWS EC2 host.

| Script | What it makes | Time (M3, Eevee) |
|---|---|---|
| `damage_twin.py` | The **Damage Twin receipt**: a 3D proxy of the product with a pulsing marker where Memories.ai saw the damage, the customer's frame and the decision as a HUD, one camera orbit. H.264 MP4 + PNG poster. | 960×540 · 5 s · 120 frames ≈ 50 s; 800×450 · 4 s ≈ 25 s |
| `synth_evidence.py` | The **Synthetic Evidence Lab**: labelled evidence clips (products with/without damage, random lighting, backgrounds, phone-style handheld camera, deliberate "twins" of the same damaged item re-filmed under different conditions and sometimes mirrored) plus `manifest.json` ground truth. | 640×360 · 4 s ≈ 6 s per clip |

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender      # or `blender` on Linux
$B -b -P blender/damage_twin.py -- --spec spec.json --out out/twin.mp4 --poster out/twin.png
$B -b -P blender/synth_evidence.py -- --out blender/out/lab --count 40 --seed 7 --twin-rate 1.0
```

`spec.json` fields: `product` (mug · headphones · lamp · vase · tshirt), `damage_location` (per product: rim/handle/base, hinge/headband/cup, shade/stem/base, body/neck/base, collar/fabric/sleeve), `damage_type`, `severity`, `display_id`, `order_id`, `customer_name`, `evidence_line`, `evidence_time`, `action`, `amount`, `txn_id`, `policy_clauses`, `frame_path`, `width`, `height`, `fps`, `duration_s`, `samples`.

Rendering is a PNG sequence encoded by the system `ffmpeg` (works on every Blender build, including 5.x where video output moved). `_products.py` holds the procedural products, damage cutters, marker, studio lighting, camera rig, handheld wobble and HUD helpers.
