"""Path resolution for the video-to-motion micro-service.

Mirrors thirdparty/kimodo/kimodo_paths.py: the packaged desktop app ships this
code directory READ-ONLY, so everything we write (per-rig bakes, temp video
frames) lives under a per-user data dir instead.

Unlike Kimodo, the model code is NOT vendored here. MoCapAnything V2 is a
separate checkout (github.com/phongdaot/MocapAnything) that the user points at,
because it carries its own torch/transformers pins and a ~2 GB checkpoint.
MOCAP_REPO is that checkout; Settings -> MoCap writes it.
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _first_existing(*candidates) -> Path | None:
    for c in candidates:
        if not c:
            continue
        p = Path(c)
        if p.exists():
            return p
    return None


# --- where MoCapAnything V2 itself lives -------------------------------------
# Vendored under MocapAnything/ (see its VENDORED.md) so the service is
# self-contained in this repo. MOCAP_REPO still overrides it, which is what a
# developer working against an upstream checkout wants.
REPO_DIR = Path(os.environ.get("MOCAP_REPO") or _first_existing(
    _HERE / "MocapAnything",
    Path.home() / "MocapAnything",
) or (_HERE / "MocapAnything")).resolve()

# --- writable state ----------------------------------------------------------
def _default_data_dir() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
    else:
        base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
    return Path(base) / "3DGenStudio" / "mocapanything"


DATA_DIR = Path(os.environ.get("MOCAP_DATA_DIR") or _default_data_dir()).resolve()
RIGS_DIR = DATA_DIR / "rigs"        # one baked "species" per rig hash
WORK_DIR = DATA_DIR / "work"        # scratch: uploaded videos, inference outputs

CHECKPOINT_NAME = os.environ.get("MOCAP_CKPT_NAME", "video2pos2rot_epoch60.pt")


def checkpoint_dir() -> Path:
    """Where the ~460 MB checkpoint lives.

    NOT under REPO_DIR: the packaged desktop app ships this code directory
    READ-ONLY, so a download into the vendored model tree fails there. It goes
    under the writable per-user DATA_DIR instead, which is already correct in
    both dev and the packaged app without the shell having to set anything.

    Resolution order:
      1. MOCAP_CKPT_DIR      -- Settings -> Video to Motion -> "Model folder",
                                passed through by the desktop shell.
      2. an existing repo-local checkpoint -- so an install made before this
                                changed keeps working instead of silently
                                re-downloading 460 MB somewhere else.
      3. DATA_DIR/checkpoints -- the normal answer.
    """
    explicit = str(os.environ.get("MOCAP_CKPT_DIR") or "").strip()
    if explicit:
        return Path(explicit).resolve()

    legacy = REPO_DIR / "checkpoints"
    if (legacy / CHECKPOINT_NAME).exists():
        return legacy

    return DATA_DIR / "checkpoints"


def checkpoint_path() -> Path:
    return checkpoint_dir() / CHECKPOINT_NAME


def repo_python() -> str:
    """The interpreter that has MoCapAnything's torch. Prefer its own venv."""
    explicit = os.environ.get("MOCAP_PYTHON")
    if explicit:
        return explicit
    rel = ".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python"
    # The service venv lives beside THIS file (run_server creates it there); the
    # vendored model tree has none of its own. Check both, service first.
    for base in (_HERE, REPO_DIR):
        venv = base / rel
        if venv.exists():
            return str(venv)
    import sys
    return sys.executable


def has_bpy(python_exe: str | None = None) -> bool:
    """Is Blender importable as a module in the service's interpreter?

    Preferred over an installed Blender: it is version-pinned with the rest of
    the environment and needs no separate install. Published for CPython 3.11
    and 3.13 only — there is NO 3.12 wheel — which is why run_server provisions
    3.13. Result is cached: this shells out, and the bake asks repeatedly.
    """
    import subprocess

    exe = python_exe or repo_python()
    cached = _HAS_BPY.get(exe)
    if cached is None:
        try:
            cached = subprocess.run(
                [exe, "-c", "import bpy"], capture_output=True, timeout=120,
            ).returncode == 0
        except Exception:
            cached = False
        _HAS_BPY[exe] = cached
    return cached


_HAS_BPY: dict = {}


def find_blender() -> str | None:
    """Blender 3.6+ binary — the FALLBACK for when bpy is not installed.

    Needed for the per-rig bake, not for inference.
    """
    explicit = os.environ.get("BLENDER") or os.environ.get("BLENDER_BIN")
    if explicit and Path(explicit).exists():
        return explicit
    found = shutil.which("blender")
    if found:
        return found
    if os.name == "nt":
        roots = [Path("C:/Program Files/Blender Foundation")]
        best = None
        for root in roots:
            if not root.is_dir():
                continue
            for child in sorted(root.iterdir(), reverse=True):
                candidate = child / "blender.exe"
                if candidate.exists():
                    best = best or str(candidate)
        if best:
            return best
    return None


def ensure_dirs() -> None:
    for d in (DATA_DIR, RIGS_DIR, WORK_DIR):
        d.mkdir(parents=True, exist_ok=True)
