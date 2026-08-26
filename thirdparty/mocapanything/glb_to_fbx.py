"""Blender-side half of the per-rig bake: a rigged GLB -> the two FBX files
MoCapAnything's preprocessing expects.

Run as:  blender --background --factory-startup --python glb_to_fbx.py -- <glb> <outdir> <rigName>

Three things here are load-bearing, each one a silent-failure otherwise:

1. Blender's glTF importer (5.x) injects a stray unparented 42-vertex
   "Icosphere" into EVERY import. Exporting it makes it the character's
   base_mesh.obj downstream, and the render stage then draws a sphere from the
   inside. Unparented meshes are dropped.

2. The rig is pre-oriented so the extracted BVH lands Y-UP. The extraction
   stage maps Blender (x,y,z) -> BVH (z, y, -x); a glTF import is Z-up in
   Blender, so without correction the BVH comes out X-up. Nothing downstream
   can fix that: align_character_face_zplus only ever yaws about Y. Q maps
   Blender +Z (up) -> +Y, which holds for any glTF-sourced rig.

3. Preprocessing needs at least one FBX carrying a MOTION (the reference pose
   is frame 0 of it). A freshly rigged mesh has no animation, so a short
   procedural idle is generated on the rig's own bones. Only frame 0 is used
   semantically at inference, but the sequence has to exist.

Bones are exported without leaf bones: Blender's `*_end` leaves would become
real joints and shift every joint index away from the source rig.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix

argv = sys.argv[sys.argv.index("--") + 1:]
GLB, OUTDIR, RIG = argv[0], argv[1], argv[2]
os.makedirs(OUTDIR, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
if not arms:
    print("MOCAP_ERROR no armature in the GLB - the mesh is not rigged")
    sys.exit(1)
arm = arms[0]

# (1) drop importer debris / anything not skinned to the armature
for stray in [o for o in bpy.data.objects if o.type == "MESH" and o.parent is None]:
    print(f"MOCAP_INFO dropped stray mesh {stray.name} ({len(stray.data.vertices)} verts)")
    bpy.data.objects.remove(stray, do_unlink=True)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
if not meshes:
    print("MOCAP_ERROR no skinned mesh left after dropping unparented objects")
    sys.exit(1)

# (2) pre-orient: Blender +Z (up) -> +Y so the extracted BVH is Y-up
Q = Matrix(((0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 0), (0, 0, 0, 1)))
bpy.context.view_layer.objects.active = arm
arm.matrix_world = Q @ arm.matrix_world
bpy.ops.object.select_all(action="DESELECT")
arm.select_set(True)
for m in meshes:
    m.select_set(True)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)


def export(path, with_anim):
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.fbx(
        filepath=path,
        use_selection=False,
        add_leaf_bones=False,
        bake_anim=with_anim,
        bake_anim_use_all_bones=True,
        bake_anim_use_nla_strips=False,
        bake_anim_use_all_actions=False,
        bake_anim_simplify_factor=0.0,
        object_types={"ARMATURE", "MESH"},
        path_mode="COPY",
    )
    print(f"MOCAP_INFO exported {os.path.basename(path)} ({os.path.getsize(path)} bytes)")


export(os.path.join(OUTDIR, f"{RIG}.fbx"), False)

# (3) procedural idle on whatever bones this rig actually has. Names are matched
# loosely so it works on non-humanoid rigs too; a rig that matches nothing still
# gets a valid (static) action, which is enough for a reference pose.
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="POSE")
FRAMES = 120
WANT = [
    (("spine", "chest", "torso", "body"), "X", 4.0, 1),
    (("neck", "head"), "X", 3.0, 2),
    (("upperarm", "arm", "shoulder", "wing"), "Z", 9.0, 1),
    (("forearm", "elbow"), "Y", 7.0, 2),
    (("upleg", "thigh", "hip", "leg"), "X", 6.0, 1),
    (("tail",), "Y", 8.0, 1),
]
tracks = []
for pb in arm.pose.bones:
    low = pb.name.lower()
    for keys, axis, amp, cyc in WANT:
        if any(k in low for k in keys):
            side = -1.0 if ("right" in low or low.endswith("_r") or ".r" in low) else 1.0
            tracks.append((pb, axis, amp * side, cyc))
            break
tracks = tracks[:40]          # keep the action small; this is only a reference
print(f"MOCAP_INFO animating {len(tracks)} of {len(arm.pose.bones)} bones")

for pb in arm.pose.bones:
    pb.rotation_mode = "XYZ"
for f in range(FRAMES):
    bpy.context.scene.frame_set(f)
    for pb, axis, amp, cyc in tracks:
        ang = math.radians(amp) * math.sin(2 * math.pi * cyc * f / FRAMES)
        pb.rotation_euler = (
            ang if axis == "X" else 0.0,
            ang if axis == "Y" else 0.0,
            ang if axis == "Z" else 0.0,
        )
        pb.keyframe_insert(data_path="rotation_euler", frame=f)
    if not tracks:            # still needs keys, or the FBX carries no action
        arm.pose.bones[0].keyframe_insert(data_path="rotation_euler", frame=f)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.scene.frame_start = 0
bpy.context.scene.frame_end = FRAMES - 1

export(os.path.join(OUTDIR, f"{RIG}-Idle.fbx"), True)

with open(os.path.join(OUTDIR, "_bones.json"), "w", encoding="utf-8") as fh:
    json.dump({"rig": RIG, "bones": [b.name for b in arm.data.bones]}, fh, indent=1)

print("MOCAP_DONE")
