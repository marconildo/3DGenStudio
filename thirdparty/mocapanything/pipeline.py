"""Per-rig bake + video inference for MoCapAnything V2.

Two operations:

  prepare(glb_bytes, report) -> rig_id
      A rigged GLB becomes a "species": skeleton topology, joint-name T5
      embeddings, a reference pose and a DINOv2 embedding of a render of it.
      Slow (Blender), cached by content hash, done once per rig.

  generate(rig_id, video_path, report) -> bvh_text
      A video drives that rig. The BVH comes back on the rig's OWN joint names
      and hierarchy, so the browser can bind it without a bone-mapping step.

Everything here exists because the upstream pipeline is built for Truebones
quadrupeds and assumes an older Blender. The deviations are called out inline;
each one was a silent failure, not an error, when it was missing.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import mocap_paths as P

# ----------------------------------------------------------------- patching --
# Two upstream defaults are wrong for any rig that did not come from Truebones.
# Applied textually and idempotently so a clean checkout works, and so an
# upgrade of the checkout does not silently revert them.

_PATCH_OBJ_AXES = (
    """    bpy.ops.wm.obj_export(
        filepath=export_path,
        export_selected_objects=True,
        export_materials=True,
        export_uv=True,
        export_normals=True,
    )""",
    """    bpy.ops.wm.obj_export(
        filepath=export_path,
        export_selected_objects=True,
        export_materials=True,
        export_uv=True,
        export_normals=True,
        # wm.obj_export defaults to up_axis='Y', but the skeleton BVH written
        # beside it is Blender-native Z-up -> the mesh ends up 90deg off its own
        # skeleton and every render is garbage. Export unconverted.
        forward_axis='Y',
        up_axis='Z',
    )""",
)

_PATCH_SCALE = (
    "def face_forward_bvh_external(bvh_path, scale=0.01, out_path=None):",
    """# 0.01 assumes the source rig is in CENTIMETRES (Truebones: a 126cm eagle).
# A metre-native source (anything out of glTF) needs 1.0, or the rig bakes 100x
# too small and the fixed-distance render camera ends up inside it.
_BVH_SCALE = float(os.environ.get("MOCAP_BVH_SCALE", "0.01"))


def face_forward_bvh_external(bvh_path, scale=_BVH_SCALE, out_path=None):""",
)


def ensure_patches() -> list[str]:
    """Make the checkout usable. Returns a list of what was changed."""
    target = P.REPO_DIR / "preprocess" / "extract_character_from_fbx.py"
    if not target.exists():
        raise RuntimeError(f"MoCapAnything checkout not found at {P.REPO_DIR}")
    src = target.read_text(encoding="utf-8")
    applied = []

    if "forward_axis='Y'" not in src:
        if _PATCH_OBJ_AXES[0] not in src:
            raise RuntimeError("cannot patch obj_export axes: upstream code changed shape")
        src = src.replace(*_PATCH_OBJ_AXES, 1)
        applied.append("obj_export axes")

    if "_BVH_SCALE" not in src:
        if _PATCH_SCALE[0] not in src:
            raise RuntimeError("cannot patch bvh scale: upstream code changed shape")
        src = src.replace(*_PATCH_SCALE, 1)
        src = src.replace("face_forward_bvh_external(rest_bvh_path, scale=0.01, out_path=ffs_path)",
                          "face_forward_bvh_external(rest_bvh_path, scale=_BVH_SCALE, out_path=ffs_path)")
        src = src.replace("face_forward_bvh_external(bvh_pth, scale=0.01)",
                          "face_forward_bvh_external(bvh_pth, scale=_BVH_SCALE)")
        applied.append("bvh scale env override")

    if applied:
        target.write_text(src, encoding="utf-8")
    return applied


# ------------------------------------------------------------------ helpers --

def rig_id_for(glb_bytes: bytes, rig_key: str = "") -> str:
    """Cache key for a bake.

    Prefer an explicit rig_key describing the SKELETON (bone names, parents,
    rest offsets) over a hash of the GLB bytes. The browser re-exports the mesh
    on every check, and glTF export is not guaranteed byte-identical between
    runs — keying on bytes would report "not prepared" every time and re-bake a
    rig that is already on disk. A skeleton key changes when the skeleton
    changes, which is exactly when the bake stops describing the rig.
    """
    if rig_key:
        return hashlib.sha256(rig_key.encode("utf-8")).hexdigest()[:16]
    return hashlib.sha256(glb_bytes).hexdigest()[:16]


def rig_dir(rig_id: str) -> Path:
    return P.RIGS_DIR / rig_id


def is_prepared(rig_id: str) -> bool:
    d = rig_dir(rig_id)
    marker = d / "prepared.json"
    if not marker.exists():
        return False
    try:
        info = json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return False
    zoo = d / "zoo"
    ref = info.get("ref_seq") or ""
    return bool(ref) and (zoo / "npz_train_image_only" / f"{ref}.npz").exists() \
        and (zoo / "species_info_dict.npy").exists()


def prepared_info(rig_id: str) -> dict | None:
    marker = rig_dir(rig_id) / "prepared.json"
    if not marker.exists():
        return None
    try:
        return json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return None


def _run(cmd, cwd, env, label, report=None):
    """Run a stage, streaming nothing but surfacing the tail on failure."""
    if report:
        report(label)
    proc = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        tail = (proc.stdout or "")[-1500:] + "\n" + (proc.stderr or "")[-2500:]
        raise RuntimeError(f"{label} failed (exit {proc.returncode}):\n{tail.strip()}")
    return proc


def _stage_env(zoo_root: Path, data_root: Path) -> dict:
    env = dict(os.environ)
    env.update({
        "PYTHONPATH": str(P.REPO_DIR),
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
        "DATA_ROOT": str(data_root),
        "ZOO_ROOT": str(zoo_root),        # MUST be absolute: Blender resolves a
                                          # relative one against the drive root
        "MOCAP_BVH_SCALE": "1.0",         # glTF is metres, not centimetres
    })
    return env


# ------------------------------------------------------------ blender mode --
# The bake needs Blender three times. It is normally the `bpy` MODULE (installed
# from requirements.txt, version-pinned with everything else, no separate
# install); a Blender executable is the fallback for platforms with no wheel.
#
# Two of the three calls are ours, so they can be invoked either way directly.
# The third is inside render_bvh_videos_fast.py, which builds its own Blender
# command line and takes --blender as a single executable — hence the generated
# one-line wrapper around blender_shim.py.


def blender_runner() -> tuple[str, str]:
    """('bpy', python_exe) or ('exe', blender_path). Raises if neither exists."""
    py = P.repo_python()
    if P.has_bpy(py):
        return "bpy", py
    exe = P.find_blender()
    if exe:
        return "exe", exe
    raise RuntimeError(
        "Preparing a rig needs Blender, and neither the bpy module nor a Blender "
        "executable was found. Install bpy (pip install bpy, needs Python 3.11 or "
        "3.13) or install Blender 3.6+ and set BLENDER."
    )


def blender_cmd(script: Path, args: list[str] | None = None) -> list[str]:
    """A command that runs `script` with bpy available."""
    mode, exe = blender_runner()
    args = args or []
    if mode == "bpy":
        return [exe, str(script), *(["--", *args] if args else [])]
    return [exe, "--background", "--factory-startup", "--python", str(script),
            *(["--", *args] if args else [])]


def blender_exe_for_subtools() -> str:
    """What to hand tools that spawn Blender themselves via a --blender flag.

    In bpy mode that is a generated wrapper, written next to the cache so the
    interpreter path is baked in and the file is not part of the repo.
    """
    mode, exe = blender_runner()
    if mode == "exe":
        return exe
    P.ensure_dirs()
    shim = Path(__file__).resolve().parent / "blender_shim.py"
    if os.name == "nt":
        wrapper = P.DATA_DIR / "blender_bpy.bat"
        body = f'@echo off\r\n"{exe}" "{shim}" %*\r\n'
    else:
        wrapper = P.DATA_DIR / "blender_bpy.sh"
        body = f'#!/bin/sh\nexec "{exe}" "{shim}" "$@"\n'
    if not wrapper.exists() or wrapper.read_text(encoding="utf-8") != body:
        wrapper.write_text(body, encoding="utf-8")
        if os.name != "nt":
            wrapper.chmod(0o755)
    return str(wrapper)


# --------------------------------------------------------- facing direction --
# align_character_face_zplus infers facing with a QUADRUPED heuristic: it fits a
# plane through the midline joints, whose principal axis is "forward" only when
# the animal is horizontal. On an upright biped those joints are vertical, so it
# confidently returns a vertical vector, writes it, and every downstream stage
# silently uses a rig lying on its face. We compute it from the rig instead.
#
# Our export guarantees Y-up, so forward is whatever horizontal direction the
# feet point (biped) or the head leads (quadruped, tail-to-head).

_TOE = ("toe", "toebase", "ball")
_FOOT = ("foot", "ankle")
_HEAD = ("head", "skull")
_ROOT = ("hips", "pelvis", "root", "spine")


def _pick(names, keys, exclude=()):
    for i, n in enumerate(names):
        low = n.lower()
        if any(k in low for k in keys) and not any(x in low for x in exclude):
            return i
    return None


def compute_front(rest_bvh: Path) -> list[float]:
    sys.path.insert(0, str(P.REPO_DIR))
    import numpy as np
    from utils import bvh as BVH  # type: ignore

    anim, names, _ = BVH.load(str(rest_bvh))
    off, par = anim.offsets, anim.parents

    def world(i):
        p = np.zeros(3)
        c = i
        while c != -1:
            p = p + off[c]
            c = par[c]
        return p

    pos = np.array([world(i) for i in range(len(names))])

    toe, foot = _pick(names, _TOE), _pick(names, _FOOT, exclude=_TOE)
    head, root = _pick(names, _HEAD), _pick(names, _ROOT)

    vec = None
    if toe is not None and foot is not None:
        vec = pos[toe] - pos[foot]              # bipeds: feet point forward
    elif head is not None and root is not None:
        vec = pos[head] - pos[root]             # quadrupeds: head leads
    if vec is None:
        return []

    vec = np.asarray(vec, dtype=float)
    vec[1] = 0.0                                # keep it horizontal (Y is up)
    n = float(np.linalg.norm(vec))
    if n < 1e-6:
        return []
    return [float(x) for x in (vec / n)]


# ------------------------------------------------------------- joint naming --
# build_species_info embeds each joint's NAME with T5, after stripping trailing
# digits. On a Mixamo rig that collapses 52 joints to 30 unique names: all three
# spine joints become "Spine", every finger segment becomes one name. Spelling
# the ordinals out restores a distinct embedding per joint.

_ORD = {"1": "One", "2": "Two", "3": "Three", "4": "Four", "5": "Five",
        "6": "Six", "7": "Seven", "8": "Eight", "9": "Nine"}


def build_joint_name_map(rig: str, names: list[str]) -> dict:
    sys.path.insert(0, str(P.REPO_DIR))
    from preprocess.build_species_info import auto_clean  # type: ignore

    out = {}
    for n in names:
        base = auto_clean(n)
        m = re.search(r"(\d+)$", n)
        out[n] = f"{base} {_ORD[m.group(1)]}" if (m and m.group(1) in _ORD) else base
    return {rig: out}


# ---------------------------------------------------------------- prepare ----

def prepare(glb_bytes: bytes, report, rig_name: str = "rig", rig_key: str = "") -> dict:
    """Bake a rigged GLB into the artifacts inference needs. Idempotent."""
    P.ensure_dirs()
    rig_id = rig_id_for(glb_bytes, rig_key)
    if is_prepared(rig_id):
        report("cached", 1.0, "This rig is already prepared.")
        return {**(prepared_info(rig_id) or {}), "rig_id": rig_id, "cached": True}

    applied = ensure_patches()
    if applied:
        report("patch", 0.02, f"Applied checkout fixes: {', '.join(applied)}")

    mode, _ = blender_runner()          # raises with guidance if neither exists
    report("blender", 0.03, "Blender: " + ("bpy module" if mode == "bpy" else "installed application"))

    rig = re.sub(r"[^A-Za-z0-9_-]", "", rig_name) or "rig"
    root = rig_dir(rig_id)
    if root.exists():
        shutil.rmtree(root, ignore_errors=True)
    data_root = root / "src"
    zoo_root = root / "zoo"
    (data_root / rig).mkdir(parents=True, exist_ok=True)

    glb_path = root / "mesh.glb"
    glb_path.write_bytes(glb_bytes)

    env = _stage_env(zoo_root, data_root)
    py = P.repo_python()

    # 1. GLB -> base FBX + a motion FBX (drops importer debris, pre-orients Y-up)
    report("export", 0.05, "Exporting the rig for baking…")
    _run(blender_cmd(Path(__file__).resolve().parent / "glb_to_fbx.py",
                     [str(glb_path), str(data_root / rig), rig]),
         cwd=P.REPO_DIR, env=env, label="Blender FBX export")

    # 2. FBX -> base mesh + skin weights + rest.bvh + per-motion BVH
    #    fix_fbx is skipped on purpose: it needs an action on EVERY fbx and uses
    #    action.fcurves, which Blender 4.4+ removed (slotted actions). It only
    #    strips 3ds-Max Biped `*Nub` leaves, which our export never produces.
    report("extract", 0.15, "Extracting mesh, weights and rest pose…")
    _run(blender_cmd(P.REPO_DIR / "preprocess" / "extract_character_from_fbx.py"),
         cwd=P.REPO_DIR, env=env, label="extract_character_from_fbx")

    # 3. facing: computed from the rig, never inferred (see compute_front)
    rest_bvh = zoo_root / "characters_fix_facezplus" / rig / "rest.bvh"
    if not rest_bvh.exists():
        raise RuntimeError("extraction produced no rest.bvh — is the GLB actually rigged?")
    front = compute_front(rest_bvh)
    align_ref = root / "align_ref" / rig
    align_ref.mkdir(parents=True, exist_ok=True)
    if front:
        import numpy as np
        np.save(align_ref / "front.npy", np.array(front, dtype=float))
        report("align", 0.3, f"Facing direction {['%.2f' % v for v in front]}")
    else:
        report("align", 0.3, "Could not derive facing from bone names — using the built-in guess.")

    align_cmd = [py, "preprocess/align_character_face_zplus.py",
                 "--input_root", str(zoo_root / "characters_fix_facezplus"),
                 "--output_root", str(zoo_root / "characters_face_zplus"),
                 "--motion_root", str(zoo_root / "motions"),
                 "--motion_output_root", str(zoo_root / "motions_face_zplus")]
    if front:
        align_cmd += ["--ref_dir", str(root / "align_ref")]
    _run(align_cmd, cwd=P.REPO_DIR, env=env, label="align_character_face_zplus")

    # 4. yaw variants + per-BVH pose npz. Only y0 is ever read back, but the
    #    rotation stage is what writes zoo/bvh at all.
    report("pose", 0.4, "Building reference poses…")
    _run([py, "preprocess/rotate_bvh_parallel.py"], cwd=P.REPO_DIR, env=env, label="rotate_bvh_parallel")
    # extract_bvh_pose is the one stage that ignores ZOO_ROOT: it hardcodes
    # `zoo_root = "zoo"` relative to the working directory. Run it from the rig's
    # own folder (which contains zoo/) instead of patching it. Its imports are
    # anchored to __file__, so a different cwd is safe.
    _run([py, str(P.REPO_DIR / "preprocess" / "extract_bvh_pose.py")],
         cwd=root, env=env, label="extract_bvh_pose")

    # 5. skeleton topology + joint-name embeddings (with ordinals spelled out)
    report("species", 0.5, "Encoding the skeleton…")
    bones = json.loads((data_root / rig / "_bones.json").read_text(encoding="utf-8"))["bones"]
    name_map = root / "joint_name_map.json"
    name_map.write_text(json.dumps(build_joint_name_map(rig, bones), indent=1), encoding="utf-8")
    _run([py, "preprocess/build_species_info.py", "--dataset_root", str(zoo_root),
          "--joint_name_map", str(name_map)], cwd=P.REPO_DIR, env=env, label="build_species_info")
    _run([py, "preprocess/build_scale_cache.py"], cwd=P.REPO_DIR, env=env, label="build_scale_cache")

    # 6. render one view + embed it. Only y0 is needed, so we render one of the
    #    twelve. The stage's own mp4 encode uses `-pattern_type glob`, which
    #    Windows ffmpeg builds do not implement — we do not need the mp4, so its
    #    failure is tolerated and the PNGs are used directly.
    report("render", 0.6, "Rendering the reference view…")
    try:
        _run([py, "preprocess/render_bvh_videos_fast.py", "--zoo-root", str(zoo_root),
              "--blender", blender_exe_for_subtools(), "--views", "y0"],
             cwd=P.REPO_DIR, env=env, label="render_bvh_videos_fast")
    except RuntimeError as exc:
        if "glob" not in str(exc) and "No image files" not in str(exc):
            raise

    jobs = zoo_root / "video_fast_work" / "jobs"
    copied = 0
    for images in jobs.glob("*/*/images"):
        motion, view = images.parent.parent.name, images.parent.name
        dst = zoo_root / "image" / motion / view
        dst.mkdir(parents=True, exist_ok=True)
        for png in images.glob("*.png"):
            shutil.copy2(png, dst / png.name)
            copied += 1
    if not copied:
        raise RuntimeError("the render stage produced no frames — check the Blender log")

    report("embed", 0.8, "Embedding the reference view…")
    _run([py, "preprocess/preprocess_image_only.py", "--dataset_root", str(zoo_root)],
         cwd=P.REPO_DIR, env=env, label="preprocess_image_only")

    # 7. resolve the reference sequence inference will actually read
    ref_seq = None
    train_root = zoo_root / "npz_train_image_only"
    for motion_dir in sorted(train_root.glob("*")):
        for view in ("y0", "y90", "y30"):
            if (motion_dir / f"{view}.npz").exists() and \
               (zoo_root / "bvh_pose" / motion_dir.name / f"{view}.npz").exists():
                ref_seq = f"{motion_dir.name}/{view}"
                break
        if ref_seq:
            break
    if not ref_seq:
        raise RuntimeError("no usable reference view was produced")

    info = {
        "rig_id": rig_id,
        "rig": rig,
        "ref_seq": ref_seq,
        "joints": len(bones),
        "bones": bones,
        "front": front,
        "cached": False,
    }
    (root / "prepared.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
    # The renders and per-frame OBJs are large and never read again.
    shutil.rmtree(zoo_root / "video_fast_work", ignore_errors=True)
    report("done", 1.0, f"Rig prepared ({len(bones)} bones).")
    return info


# --------------------------------------------------------------- generate ----

MAX_FRAMES = 301          # upstream hard cap; longer input is silently truncated


def generate(rig_id: str, video_path: Path, report, max_frames: int = MAX_FRAMES) -> dict:
    """Drive a prepared rig with a video. Returns {'bvh': ..., 'stats': {...}}."""
    info = prepared_info(rig_id)
    if not info or not is_prepared(rig_id):
        raise RuntimeError("This rig has not been prepared yet.")

    root = rig_dir(rig_id)
    zoo_root = root / "zoo"
    rig = info["rig"]

    work = P.WORK_DIR / f"{rig_id}-{os.getpid()}"
    if work.exists():
        shutil.rmtree(work, ignore_errors=True)
    videos = work / "videos"
    videos.mkdir(parents=True, exist_ok=True)
    # The clip's filename prefix is how wild_mode resolves the reference rig.
    clip = videos / f"{rig}#clip{video_path.suffix.lower() or '.mp4'}"
    shutil.copy2(video_path, clip)

    # Every path in this config is written POSIX-style on purpose. The inference
    # script derives names with `image_folder.split("/")[-2]`, so a native
    # Windows path (all backslashes) yields a one-element list and dies with
    # "list index out of range" — swallowed per-clip, leaving an exit code of 0
    # and no output. Forward slashes work fine on Windows.
    def _p(path):
        return Path(path).as_posix()

    cfg = {
        "runtime": {"device": "cuda", "seed": 42},
        "weights": {
            "video2pose_ckpt_root": _p(P.checkpoint_dir()),
            "rmbg_weights_dir": "briaai/RMBG-1.4",
            "ckpt_name": P.CHECKPOINT_NAME,
        },
        "experiment": {"exp": ""},
        "ablate_no_t5": False,
        "model": _MODEL_CFG,
        "data": {
            "base_dir": _p(zoo_root),
            "character_dir": _p(zoo_root / "characters_face_zplus"),
            "memory_pkl_path": "",
            "scale_dict_path": _p(zoo_root / "cache" / "__mesh2pose1002_species_scale_cache.pkl"),
            "bvh_roots": [_p(zoo_root / "bvh")],
            "video_roots": [_p(videos)],
            "image_roots": [_p(videos)],
            "frames_tmp_root": _p(work / "frames"),
            "retarget": {"toggle": False, "ref_seq": info["ref_seq"], "ref_idx": 0},
            "wild_flag": True,
            "wild_mode": True,
            "eval_seq_len": int(max_frames),
            "max_pts": 1024,
        },
        "output": {
            "blender_path": None,          # no mesh render: we only want the BVH
            "output_tag": "mocap",
            "save_dir": _p(work / "out"),
            "fps": 30,
            "export_gt_mesh": False,
            "export_gt_video": False,
        },
        "use_lab_model": False,
    }
    cfg_path = work / "inference.yaml"
    import yaml
    cfg_path.write_text(yaml.safe_dump(cfg, sort_keys=False), encoding="utf-8")

    report("infer", 0.15, "Reading the video…")
    env = _stage_env(zoo_root, root / "src")
    _run([P.repo_python(), "inference/video2pose2rot.py", "--config", str(cfg_path)],
         cwd=P.REPO_DIR, env=env, label="video2pose2rot")

    found = sorted((work / "out").rglob("*_rot6d_pred.bvh"))
    if not found:
        raise RuntimeError("inference produced no BVH — the clip may contain no visible subject")

    bvh_text = found[0].read_text(encoding="utf-8")
    stats = _bvh_stats(bvh_text)
    shutil.rmtree(work, ignore_errors=True)
    report("done", 1.0, "Motion ready.")
    return {"bvh": bvh_text, "stats": {**stats, "rig": rig, "rig_id": rig_id}}


def _bvh_stats(text: str) -> dict:
    lines = text.splitlines()
    try:
        i = lines.index("MOTION")
        frames = int(lines[i + 1].split(":")[1])
        frame_time = float(lines[i + 2].split(":")[1])
    except Exception:
        return {}
    joints = sum(1 for l in lines[:i] if l.strip().startswith(("ROOT ", "JOINT ")))
    return {
        "frames": frames,
        "frame_time": frame_time,
        "fps": round(1.0 / frame_time, 3) if frame_time else None,
        "joints": joints,
        # Root translation is hardcoded to zero upstream (utils/npy2bvh.py), so
        # every clip is in-place. Said here so the UI never implies otherwise.
        "in_place": True,
    }


# The architecture has to match the checkpoint exactly; lifted from the repo's
# own inference config rather than re-derived.
_MODEL_CFG = {
    "target": "models.v2.video2pose2rot.model.Video2Pose2RotModel",
    "params": {
        "v2p_cfg": {
            "target": "models.v2.video2pose.model.RefGuidedVideo2PoseModel",
            "params": {
                "q_dim": 256, "num_layers": 8, "num_heads": 8, "ref_layers": 4,
                "img_dim": 1024, "num_joints": 150,
                "use_graph_ref_outer": False, "use_graph_ref_inner": True,
                "use_graph_temporal_outer": False, "use_graph_temporal_inner": True,
                "use_joint_embed": True,
            },
        },
        "p2r_cfg": {
            "target": "models.v2.pose2rot.model.Pose2RotMemoryRestModel",
            "params": {
                "q_dim": 256, "rest_layers": 4, "pose_layers": 4, "memory_layers": 4,
                "decoder_layers": 8, "num_heads": 8, "joint_embed_dim": 768,
                "temporal_window": 2, "temporal_dropout": 0.1,
                "decoder_cond_mode": "add", "pose_rest_film": True,
                "memory_rest_film": True, "decoder_rest_film": True,
                "pose_use_graph": True, "use_grad_checkpoint": False,
                "decoder_use_cross_layers": 6,
            },
        },
    },
    "attention_kwargs": {
        "seq_len": 32, "selfatt_temporal_layer_flag": [], "selfatt_temporal": True,
        "crossatt2_temporal": True, "selfatt_slidwindow": 5, "crossatt2_slidwindow": 5,
    },
}
