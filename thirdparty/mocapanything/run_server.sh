#!/usr/bin/env bash
# Start the 3D Gen Studio video-to-motion micro-service (mocap_server.py).
# Linux/macOS counterpart of run_server.bat.
#
# On first run this uses `uv` to provision a pinned standalone Python (3.13),
# create a local virtual environment, and install this folder's
# requirements.txt, a CUDA-matched torch and the model checkpoint (~460 MB).
#
# Python 3.13 is not arbitrary: `bpy` (Blender as an importable module, which
# the per-rig bake needs) publishes wheels for CPython 3.11 and 3.13 ONLY —
# there is no 3.12 wheel. 3.13 also matches the rigging service, so the two can
# share an environment if you ever want them to.
#
# The model code itself is vendored under MocapAnything/ — nothing is cloned.
#
# Env overrides:
#   MOCAP_PORT=8401            bind port (also MOCAP_HOST)
#   MOCAP_CUDA=12.8            force the CUDA build to target (skip nvidia-smi)
#   MOCAP_CKPT_DIR=...         where the checkpoint is kept
#   MOCAP_DATA_DIR=...         where per-rig bakes are cached
#   MOCAP_SKIP_MODEL=1         don't download the checkpoint
#   MOCAP_SKIP_BPY=1           don't install bpy (use a Blender executable)
#   BLENDER=/path/to/blender   use this Blender instead of the bpy module
set -u
cd "$(dirname "$0")"
PYVER=3.13

# macOS has no CUDA, so this service cannot run there. Say so rather than
# spending several GB proving it.
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Video-to-motion needs an NVIDIA GPU; skipping on macOS."
  exit 0
fi

ensure_uv() {
  if command -v uv >/dev/null 2>&1; then UV=uv; return 0; fi
  if [[ -x "$HOME/.local/bin/uv" ]]; then UV="$HOME/.local/bin/uv"; return 0; fi
  echo "Installing uv (Python toolchain manager)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh || return 1
  UV="$HOME/.local/bin/uv"
}

setup() {
  echo "Provisioning Python $PYVER via uv..."
  "$UV" python install "$PYVER" || return 1

  echo "Creating virtual environment (Python $PYVER)..."
  "$UV" venv .venv --python "$PYVER" || return 1
  # shellcheck disable=SC1091
  source .venv/bin/activate

  echo
  echo "Installing video-to-motion requirements (includes bpy, ~323 MB)..."
  "$UV" pip install -r requirements.txt || return 1
  if [[ -n "${MOCAP_SKIP_BPY:-}" ]]; then
    echo "MOCAP_SKIP_BPY set — removing bpy; a Blender executable will be needed."
    "$UV" pip uninstall bpy >/dev/null 2>&1
  fi

  # --- torch ----------------------------------------------------------------
  # After requirements, so nothing in that list can drag it off-version.
  # --reinstall-package is required for the same reason as in the Kimodo
  # launcher: a CPU torch can already satisfy the version (local +cuXXX tag and
  # all), so uv would "audit" it and leave the service on the CPU.
  echo
  echo "Detecting CUDA to select a torch build..."
  TORCHARGS="$(python select_torch.py)"
  if [[ -n "$TORCHARGS" ]]; then
    echo "Installing torch: $TORCHARGS"
    # shellcheck disable=SC2086
    "$UV" pip install --reinstall-package torch --reinstall-package torchvision $TORCHARGS || return 1
  else
    echo "[warn] No NVIDIA GPU detected — installing CPU torch."
    echo "       Video-to-motion will be unusably slow without a CUDA GPU."
    "$UV" pip install torch torchvision || return 1
  fi

  if ! python -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" 2>/dev/null; then
    echo
    echo "[warn] torch cannot see a CUDA GPU. Capturing will run on the CPU and be"
    echo "       very slow. Check 'nvidia-smi', then reinstall torch with:"
    echo "         source .venv/bin/activate && uv pip install --reinstall-package torch --reinstall-package torchvision $TORCHARGS"
  fi

  # --- Blender --------------------------------------------------------------
  # Report which one the bake will use, so a missing Blender is found now rather
  # than minutes into the first prepare.
  echo
  if python -c "import bpy" 2>/dev/null; then
    python -c "import bpy; print('Blender (bpy module):', bpy.app.version_string)"
  elif python -c "import sys; sys.path.insert(0,'.'); import mocap_paths as p; sys.exit(0 if p.find_blender() else 1)" 2>/dev/null; then
    python -c "import sys; sys.path.insert(0,'.'); import mocap_paths as p; print('Blender executable:', p.find_blender())"
  else
    echo "[warn] No bpy module and no Blender executable found. Capturing motion will"
    echo "       work, but PREPARING a rig will fail. Install Blender 3.6+ and set"
    echo "       BLENDER, or reinstall without MOCAP_SKIP_BPY."
  fi

  # --- weights --------------------------------------------------------------
  echo
  if [[ -n "${MOCAP_SKIP_MODEL:-}" ]]; then
    echo "MOCAP_SKIP_MODEL set — skipping checkpoint download."
  else
    echo "Downloading the MoCapAnything checkpoint (~460 MB; first run only)..."
    python download.py || echo '[warn] checkpoint download failed; run "python download.py" manually.'
  fi

  echo
  echo "Setup complete."
}

ensure_uv || { echo "Setup failed: could not install uv."; exit 1; }

if [[ ! -x ".venv/bin/python" ]]; then
  setup || { echo; echo "Setup failed. See the messages above."; exit 1; }
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

exec python mocap_server.py
