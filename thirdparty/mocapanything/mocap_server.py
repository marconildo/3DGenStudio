"""Video-to-motion micro-service for 3D Gen Studio (MoCapAnything V2).

A FastAPI app wrapping MoCapAnything's video2pose2rot model so the Node backend
can turn a video of a moving subject into an animation on the user's own rig.
It mirrors the request/response contract of the text-to-motion service
(thirdparty/kimodo/motion_server.py) so the Node proxy and the browser client
treat the two identically:

  Request  : multipart/form-data (a mesh, or a video + rigId)
  Response : text/event-stream (SSE)
               {"type":"progress","stage":"render","frac":0.6,"message":"..."}
               {"type":"done","format":"bvh","bvh":"HIERARCHY...","stats":{...}}
               {"type":"error","detail":"..."}

Why a separate service (not part of Kimodo's, which also owns a GPU model):
MoCapAnything pins torch 2.9 / transformers 4.57, while Kimodo pins
transformers==5.1.0 for its bidirectional text encoder. The two cannot share a
venv, exactly as Kimodo cannot share the rigging service's.

The model code IS vendored, under MocapAnything/ (see its VENDORED.md), so this
service is self-contained. MOCAP_REPO overrides that with an upstream checkout,
which is what a developer working against upstream wants.

Two-step by nature. A video can only drive a rig that has been BAKED first
(skeleton topology, joint-name embeddings, a reference pose and a rendered view).
That bake needs Blender -- installed as the `bpy` module, so there is no separate
Blender to install -- and takes minutes. It is cached per SKELETON, so it happens
once per rig, not once per clip.

Run it from THIS directory, inside the MoCapAnything venv:

    python mocap_server.py         # binds MOCAP_HOST:MOCAP_PORT (0.0.0.0:8401)
"""
from __future__ import annotations

import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import traceback
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import mocap_paths as P            # noqa: E402
import pipeline                    # noqa: E402

from fastapi import FastAPI, File, Form, UploadFile   # noqa: E402
from fastapi.responses import StreamingResponse       # noqa: E402

app = FastAPI(title="3D Gen Studio — MoCapAnything")

HOST = os.environ.get("MOCAP_HOST", "0.0.0.0")
PORT = int(os.environ.get("MOCAP_PORT", "8401"))

_SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

# One GPU model, one Blender at a time. Requests queue rather than thrash VRAM:
# a 301-frame clip peaks around 10 GB reserved, so two at once will OOM a 16 GB
# card. Serialising also keeps the per-rig bake off the GPU while a clip runs.
_lock = threading.Lock()


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@app.get("/health")
def health() -> dict:
    # Report the runner the bake will ACTUALLY use, not just whether a Blender
    # executable happens to be installed. bpy is the normal path and an installed
    # Blender is only the fallback, so naming the executable here made it look
    # like the module was being ignored.
    try:
        blender_mode, blender = pipeline.blender_runner()
    except Exception as exc:  # noqa: BLE001 - reported, not raised: /health must answer
        blender_mode, blender = None, str(exc)
    ckpt = P.checkpoint_path()
    prepared = []
    if P.RIGS_DIR.exists():
        for d in sorted(P.RIGS_DIR.iterdir()):
            info = pipeline.prepared_info(d.name)
            if info and pipeline.is_prepared(d.name):
                prepared.append({"rig_id": d.name, "rig": info.get("rig"),
                                 "joints": info.get("joints")})
    return {
        "status": "ok",
        "repo": str(P.REPO_DIR),
        "repo_present": (P.REPO_DIR / "inference" / "video2pose2rot.py").exists(),
        "checkpoint": str(ckpt),
        "checkpoint_present": ckpt.exists(),
        "python": P.repo_python(),
        "blender": blender,
        "blender_mode": blender_mode,          # "bpy" | "exe" | None
        "blender_present": blender_mode is not None,
        "data_dir": str(P.DATA_DIR),
        "prepared_rigs": prepared,
        "max_frames": pipeline.MAX_FRAMES,
        # Stated up front so the UI never has to discover these by surprise.
        "limits": {"in_place_only": True, "output_fps": 30, "max_frames": pipeline.MAX_FRAMES},
    }


def _stream(work_fn):
    """Run work_fn(report) on a thread and stream its progress as SSE."""
    events: "queue.Queue" = queue.Queue()
    holder: dict = {}

    def report(stage, frac=None, message=""):
        events.put({"type": "progress", "stage": stage,
                    "frac": round(float(frac), 4) if frac is not None else None,
                    "message": message})

    def worker():
        try:
            with _lock:
                holder["payload"] = work_fn(report)
        except Exception as exc:  # noqa: BLE001 - surfaced as an error event
            print(traceback.format_exc(), file=sys.stderr)
            holder["error"] = str(exc)
        finally:
            events.put(None)

    threading.Thread(target=worker, daemon=True).start()

    def gen():
        yield _sse({"type": "progress", "stage": "start", "frac": 0.0, "message": "Starting…"})
        while True:
            try:
                item = events.get(timeout=15)
            except queue.Empty:
                # Blender and the first CUDA init emit nothing for minutes; keep
                # bytes flowing so the Node proxy's body timeout holds off.
                yield ": keepalive\n\n"
                continue
            if item is None:
                break
            yield _sse(item)
        if "error" in holder:
            yield _sse({"type": "error", "detail": holder["error"]})
        else:
            yield _sse({"type": "done", **holder["payload"]})

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)


@app.post("/mocap/prepare")
async def prepare(meshFile: UploadFile = File(...), rigName: str = Form("rig"),
                  rigKey: str = Form("")):
    """Bake a rigged GLB so videos can drive it. Cached by content hash."""
    data = await meshFile.read()
    if not data:
        return {"error": "meshFile is empty"}

    def work(report):
        info = pipeline.prepare(data, report, rig_name=rigName, rig_key=rigKey)
        return {"format": "rig", **info}

    return _stream(work)


@app.post("/mocap/inspect")
async def inspect(meshFile: UploadFile = File(...), rigKey: str = Form("")):
    """Is this exact mesh already baked? Cheap: hashes bytes, touches no GPU."""
    data = await meshFile.read()
    rig_id = pipeline.rig_id_for(data, rigKey)
    info = pipeline.prepared_info(rig_id) if pipeline.is_prepared(rig_id) else None
    return {"rig_id": rig_id, "prepared": bool(info), "info": info}


@app.post("/mocap/generate")
async def generate(videoFile: UploadFile = File(...), rigId: str = Form(...),
                   maxFrames: int = Form(pipeline.MAX_FRAMES)):
    """Drive a prepared rig with a video, returning BVH on that rig's bones."""
    suffix = Path(videoFile.filename or "clip.mp4").suffix.lower() or ".mp4"
    tmp = Path(tempfile.mkdtemp(prefix="mocap-vid-")) / f"clip{suffix}"
    with tmp.open("wb") as fh:
        shutil.copyfileobj(videoFile.file, fh)

    frames = max(32, min(int(maxFrames or pipeline.MAX_FRAMES), pipeline.MAX_FRAMES))

    def work(report):
        try:
            out = pipeline.generate(rigId, tmp, report, max_frames=frames)
        finally:
            shutil.rmtree(tmp.parent, ignore_errors=True)
        return {"format": "bvh", **out}

    return _stream(work)


@app.delete("/mocap/rigs/{rig_id}")
def forget_rig(rig_id: str) -> dict:
    """Drop a baked rig. The bake is a few hundred MB of cache, not user data."""
    d = pipeline.rig_dir(rig_id)
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)
    return {"status": "ok", "rig_id": rig_id}


if __name__ == "__main__":
    import uvicorn

    P.ensure_dirs()
    print(f"[mocap] repo       : {P.REPO_DIR}")
    print(f"[mocap] checkpoint : {P.checkpoint_path()} "
          f"({'present' if P.checkpoint_path().exists() else 'MISSING'})")
    try:
        _mode, _where = pipeline.blender_runner()
        print(f"[mocap] blender    : {'bpy module' if _mode == 'bpy' else 'application'} ({_where})")
    except Exception as _exc:  # noqa: BLE001 - a warning, not a startup failure
        print(f"[mocap] blender    : NOT FOUND -- rig preparation will fail ({_exc})")
    print(f"[mocap] data       : {P.DATA_DIR}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
