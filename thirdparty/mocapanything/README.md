# Video-to-motion service (MoCapAnything V2)

Drives the Mesh Editor's **Auto Rig → MoCap** tab: a video of something moving
becomes an animation on the user's own rig.

The model code is vendored under `MocapAnything/` (MIT, upstream commit 2f7bdf9)
so the service is self-contained; only the ~460 MB checkpoint is downloaded.

## Setup

Nothing to clone: the model code is **vendored** under `MocapAnything/` (see its
`VENDORED.md` for provenance and the local modifications).

```
run_server.bat        # Windows
bash run_server.sh    # Linux
```

First run provisions Python 3.13 via `uv`, installs `requirements.txt`, a
CUDA-matched torch **and torchvision** (the bake imports `torchvision.transforms`),
and the ~460 MB checkpoint. Binds `0.0.0.0:8401`; the Node
backend proxies it at `/api/mocap/*` and the port is
`settings.apis.mocaptools.port`.

`GET /health` reports whether the checkpoint and Blender were found, and which
Blender runner is in use (`blender_mode`: `"bpy"` or `"exe"`) — check it first
when the panel says it cannot reach the service.

### Where the checkpoint goes

Never inside the vendored `MocapAnything/` tree: the packaged desktop app ships
the code directory **read-only**, so a download there fails. `checkpoint_dir()`
resolves, in order:

1. `MOCAP_CKPT_DIR` — Settings → Video to Motion → "Model folder", passed
   through by the desktop shell (as `motiontools.modelsPath` is for Kimodo).
2. an existing `MocapAnything/checkpoints/<ckpt>` — so a dev install made before
   this changed keeps working instead of re-downloading 460 MB elsewhere.
3. `MOCAP_DATA_DIR/checkpoints` — the normal answer, per-user and writable in
   both dev and the packaged app.

### Blender comes from pip, not an install

The per-rig bake needs Blender. It is installed as **`bpy`**, Blender as an
importable module, so there is no separate Blender to install or keep in step.

That is why the launcher provisions **Python 3.13**: `bpy` publishes wheels for
CPython **3.11 and 3.13 only — there is no 3.12 wheel**. 3.13 also matches the
rigging service.

Two of the three Blender steps are invoked directly. The third lives inside
`preprocess/render_bvh_videos_fast.py`, which builds its own Blender command
line and takes `--blender` as a single executable — `blender_shim.py` plus a
generated one-line wrapper is what that flag points at.

A real Blender install is still supported as a fallback: set `BLENDER`, or
install with `MOCAP_SKIP_BPY=1`. `mocap_paths.find_blender()` also auto-detects
one on PATH and in the usual Windows location.

## Sharing an environment with the rigging service

**They are compatible.** Measured, not assumed: inference was run end to end at
the rigging service's exact versions — Python 3.13, torch 2.10.0+cu130,
transformers 5.13.1, numpy 2.5.2 — and produced a correct 100-frame capture.
`bpy` 5.2.1 coexists with all of it, and does not disturb numpy.

Upstream pins `transformers==4.57.1` and `numpy<2`, but this code touches only
`AutoImageProcessor`, `Dinov2Model`, `T5EncoderModel` and `T5Tokenizer` — all
present in transformers 5.x — and uses none of the numpy aliases removed in 2.0.
So `requirements.txt` keeps those ranges open deliberately.

**They are still separate services on purpose**, for a reason that has nothing to
do with packaging: **GPU memory.** Rigging holds ~14 GB while loaded, and a
301-frame capture peaks around 10.4 GB reserved. In one process both models
would be resident together and would not fit on a 16 GB card. As separate
services each can be stopped from Settings to free its VRAM, which is exactly
what a single-GPU machine needs. Merging them would also couple their release
cycles and drag `bpy` into the rigging environment for no benefit.

(Kimodo, by contrast, *cannot* share an environment at all: it pins
`transformers==5.1.0` for its bidirectional text encoder, and on any newer
version the encoder silently runs causally and returns plausible-but-wrong
embeddings.)

## How it works

Two steps, because the model is *conditioned on the target rig*:

- **`POST /mocap/prepare`** bakes a rigged GLB into a "species": skeleton
  topology, T5 joint-name embeddings, a reference pose and a DINOv2 embedding of
  a rendered view. Needs Blender, takes ~2–3 minutes, cached under
  `%LOCALAPPDATA%/3DGenStudio/mocapanything/rigs/<rig id>`.
- **`POST /mocap/generate`** drives that rig with a video (~70 s for 200 frames).

The payoff is that the returned BVH carries **the rig's own joint names and
hierarchy** — no cross-skeleton bone mapping, unlike every other tab.

The bake is keyed on the *skeleton* (`rigKey`), not the GLB bytes: the browser
re-exports the mesh on every check and glTF export is not byte-stable, so a byte
hash would miss its own cache every time.

## Known limits (all upstream, all measured)

| Limit | Detail |
|---|---|
| **In place only** | Root translation is hardcoded to zero in `utils/npy2bvh.py`. A captured walk runs on the spot. |
| **30 fps output** | `frametime` is hardcoded to 1/30 regardless of the source video's rate. |
| **301 frames** | Hard cap; longer video is silently truncated. |
| **VRAM** | ~2 GB of weights + ~16 MiB per frame. Reserved peak ≈6.5 GB at 100 frames, ≈10.4 GB at 301. |

## Upstream fixes this service applies

The checkout is built for Truebones quadrupeds on an older Blender. `pipeline.py`
applies two source patches idempotently (`ensure_patches()`) and works around
several more. Every one of these failed *silently* or reported a misleading
error — the usual symptom was `torch.cat(): expected a non-empty list of
Tensors`, which upstream `RUN.md` blames on an outdated NVIDIA driver.

| Problem | Handling |
|---|---|
| `fix_fbx` needs an action on every FBX and uses `action.fcurves` (removed in Blender 4.4+) | stage skipped; it only strips 3ds-Max Biped `*Nub` bones, which our export never makes |
| Facing inference is a **quadruped** heuristic — on an upright biped it returns a *vertical* vector and writes it without complaint | facing computed from bone geometry (`compute_front`) and supplied explicitly |
| Extraction maps Blender → BVH as `(z, y, -x)`, so a glTF rig lands X-up, which the yaw-only aligner can never fix | rig pre-oriented in `glb_to_fbx.py` |
| `wm.obj_export` defaults to `up_axis='Y'` while the skeleton BVH is Z-up — mesh 90° off its own skeleton | **patched** to `forward_axis='Y', up_axis='Z'` |
| `scale=0.01` hardcodes a centimetre source; glTF is metres | **patched** to `MOCAP_BVH_SCALE` (default 0.01 keeps Truebones working) |
| Blender's glTF importer injects a stray unparented 42-vertex `Icosphere` into every import, which becomes `base_mesh.obj` | unparented meshes dropped before export |
| Relative `ZOO_ROOT` makes Blender render to `C:\zoo` | absolute paths throughout |
| `-pattern_type glob` is unimplemented in Windows ffmpeg | the mp4 encode is not needed; its failure is tolerated and the PNGs used directly |
| `extract_bvh_pose.py` ignores `ZOO_ROOT` and hardcodes `zoo/` | run with `cwd` set to the rig folder |
| `image_folder.split("/")[-2]` dies on native Windows paths, and the per-clip handler swallows it (exit 0, no output) | every config path written POSIX-style |
