"""Fetch the MoCapAnything V2 checkpoint, for run_server / the desktop installer.

One file, ~460 MB, MIT-licensed. Everything else the service needs
(briaai/RMBG-1.4, facebook/dinov2-large, t5-base) is pulled by transformers on
first use and cached in the usual Hugging Face cache, so it is not handled here.

Note the checkpoint is a TRAINING checkpoint (model + optimizer + epoch); the
loader takes the "model" key and drops the rest, so the resident model is about
half the file size.

    python download.py            # into ./checkpoints (or MOCAP_CKPT_DIR)
    python download.py --force    # re-download even if it is already there
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mocap_paths as P  # noqa: E402

REPO_ID = "kehong/MoCapAnythingV2-weights"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download even if present")
    args = ap.parse_args()

    dest = P.checkpoint_dir()
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / P.CHECKPOINT_NAME

    if target.exists() and not args.force:
        size = target.stat().st_size / 2**20
        print(f"Checkpoint already present: {target} ({size:.0f} MB)")
        return 0

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("huggingface_hub is not installed — run this inside the service venv.", file=sys.stderr)
        return 1

    print(f"Downloading {P.CHECKPOINT_NAME} from {REPO_ID} (~460 MB)…")
    try:
        got = hf_hub_download(
            repo_id=REPO_ID,
            filename=P.CHECKPOINT_NAME,
            local_dir=str(dest),
        )
    except Exception as exc:  # noqa: BLE001 - the message is what matters to the user
        print(f"Download failed: {exc}", file=sys.stderr)
        return 1

    print(f"Saved to {got}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
