# Vendored: MoCapAnything V2

Source: https://github.com/phongdaot/MocapAnything
Commit: 2f7bdf9 (2026-08-21)
License: MIT (see LICENSE) — an unofficial reimplementation of
"MoCapAnything V2: End-to-End Motion Capture for Arbitrary Skeletons"
(arXiv 2604.28130). Model weights are MIT and downloaded separately.

## What was copied

Only what inference and the per-rig bake need:

    inference/   models/   utils/   preprocess/   LICENSE   README.upstream.md

Deliberately NOT copied: `demo/` (1.7 GB of downloaded sample data), `train/`,
`examples/`, `assets/`, `configs/` (the service generates its own config), and
the upstream `.venv`.

## Local modifications

Two files carry fixes without which a rig exported from glTF bakes wrongly, and
both fail SILENTLY upstream. `../pipeline.py:ensure_patches()` re-applies them
if this tree is ever refreshed from upstream, so they cannot be lost in an
update.

- `preprocess/extract_character_from_fbx.py`
  - `wm.obj_export` pinned to `forward_axis='Y', up_axis='Z'`. Its default
    (`up_axis='Y'`) writes the mesh 90 degrees off the skeleton BVH beside it,
    which is Blender-native Z-up.
  - the hardcoded `scale=0.01` (a centimetre assumption from Truebones rigs) is
    now `MOCAP_BVH_SCALE`, defaulting to 0.01 so upstream data is unaffected.
    Metre-native glTF sources set it to 1.0.
- `utils/visualization.py`
  - `-pattern_type glob` is not implemented in Windows ffmpeg builds; the
    numeric `%05d` sequence is used there instead. POSIX behaviour is unchanged.

Everything else the pipeline needs is worked around in `../pipeline.py` rather
than patched here, so this tree stays as close to upstream as possible.
