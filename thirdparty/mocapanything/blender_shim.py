"""Run a Blender script through the `bpy` module instead of a Blender executable.

The bake shells out to Blender three times. Two of those we invoke ourselves and
can call however we like, but `preprocess/render_bvh_videos_fast.py` builds its
own command line —

    [args.blender, "-b", "--python", script, "--", "--jobs-file", ...]

— and takes `--blender` as a single executable. This shim is what that flag can
point at: it accepts Blender's CLI shape, throws away the flags that only mean
something to the real binary, and execs the target script in a process where
`import bpy` works.

Invoked through a tiny generated wrapper (blender_bpy.bat / .sh) so it can be
passed as one "executable" path. See pipeline.blender_runner().
"""
from __future__ import annotations

import runpy
import sys

# Flags that configure the Blender application itself. Importing bpy already
# gives us a headless session, so they have no meaning here.
_IGNORED = {"-b", "--background", "--factory-startup", "--quiet", "-noaudio"}


def main() -> int:
    argv = sys.argv[1:]
    script = None
    tail: list[str] = []

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in _IGNORED:
            i += 1
        elif arg in ("--python", "-P"):
            script = argv[i + 1] if i + 1 < len(argv) else None
            i += 2
        elif arg == "--":
            tail = argv[i + 1:]
            break
        else:
            i += 1

    if not script:
        print("blender_shim: no --python script given", file=sys.stderr)
        return 2

    try:
        import bpy  # noqa: F401  - proves the module is importable before we start
    except ImportError as exc:
        print(f"blender_shim: bpy is not installed ({exc})", file=sys.stderr)
        return 3

    # Blender scripts read their own arguments as everything after "--", so the
    # separator has to survive into the child's argv.
    sys.argv = [script] + (["--"] + tail if tail else [])
    runpy.run_path(script, run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
