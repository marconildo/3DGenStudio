"""Bone-renaming checks for ``rig_package.skeleton_template``.

Auto Rig can rename the generated skeleton to the Mixamo or Unreal humanoid
convention, which is what makes a rig retargetable in the Animations tab. The
naming is purely geometric — the model hands back joints and parents, with no
labels — so it has to work out which branch is an arm and which is a leg from
shape alone.

That is easy on a bare humanoid and hard on a character whose clothes are rigged
too. A cape hanging off the chest reaches as far sideways as an arm, a robe off
the hips reaches the floor like a leg, and a sleeve off the wrist looks like a
long finger. Getting those wrong is not cosmetic: the slots are taken, so the
real limbs fall back to "Extra" names, and the labels people see in the viewport
sit on the wrong bones (a leg name on a cape panel, a finger name on a hem).

Run directly — these need only numpy, not the rig service or its model::

    python thirdparty/skintokens/tests/test_skeleton_template.py
"""
from __future__ import annotations

import math
import sys
import types
from pathlib import Path

import numpy as np

# omegaconf is only reached by the positional fallback, which none of these
# cases should hit. Stub it so the suite runs outside the rig service's env.
if "omegaconf" not in sys.modules:  # pragma: no cover - import shim
    try:
        import omegaconf  # noqa: F401
    except ImportError:
        stub = types.ModuleType("omegaconf")

        def _no_fallback(_path):
            raise AssertionError("positional fallback reached; geometry pass failed")

        stub.OmegaConf = types.SimpleNamespace(load=_no_fallback)
        sys.modules["omegaconf"] = stub

# Import through the PACKAGE, exactly as the rig service does
# (src.rig_package.skeleton_template). Importing these files as top-level
# modules instead — by putting src/rig_package itself on sys.path — makes the
# package's own relative imports unresolvable, so a broken intra-package import
# would pass here and fail only in production. It has happened once already.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.rig_package import skeleton_template as st  # noqa: E402


# Joints arrive in Blender space: Z up, and these skeletons face -Y, which makes
# +X the character's own left.
class Skeleton:
    def __init__(self):
        self.names: list[str] = []
        self.pos: list[tuple[float, float, float]] = []
        self.parents: list[int] = []

    def add(self, name, xyz, parent=None):
        self.names.append(name)
        self.pos.append(tuple(float(v) for v in xyz))
        self.parents.append(-1 if parent is None else self.names.index(parent))
        return name

    def chain(self, prefix, start, step, count, parent):
        node = parent
        for i in range(count):
            node = self.add(f"{prefix}{i}", [start[k] + step[k] * i for k in range(3)], node)
        return node

    def arrays(self):
        return (
            list(self.names),
            np.asarray(self.pos, dtype=np.float32),
            np.asarray(self.parents, dtype=np.int32),
        )


def humanoid(arm_angle_deg=0.0, toes=True, clavicles=True, fingers=True):
    """A 1.7m humanoid. ``arm_angle_deg``: 0 = T-pose, 45 = A-pose, 75 = arms down."""
    s = Skeleton()
    s.add("hips", (0, 0, 1.00))
    s.add("spine", (0, 0, 1.15), "hips")
    s.add("spine1", (0, 0, 1.30), "spine")
    s.add("spine2", (0, 0, 1.45), "spine1")
    s.add("neck", (0, 0, 1.55), "spine2")
    s.add("head", (0, 0, 1.68), "neck")
    angle = math.radians(arm_angle_deg)
    cos, sin = math.cos(angle), math.sin(angle)
    for side, sx in (("L", 1.0), ("R", -1.0)):
        parent = s.add(f"clav{side}", (0.05 * sx, 0, 1.45), "spine2") if clavicles else "spine2"
        for name, reach in (("uarm", 0.13), ("farm", 0.40), ("hand", 0.63)):
            s.add(f"{name}{side}", (0.05 * sx + reach * cos * sx, 0, 1.45 - reach * sin), parent)
            parent = f"{name}{side}"
        hx, hy, hz = s.pos[s.names.index(f"hand{side}")]
        if fingers:
            # The thumb splays forward and down, away from the other four.
            s.chain(f"thumb{side}", (hx + 0.04 * cos * sx, hy - 0.05, hz - 0.04 * sin - 0.02),
                    (0.035 * cos * sx, -0.02, -0.035 * sin - 0.01), 3, f"hand{side}")
            for i, finger in enumerate(("index", "middle", "ring", "pinky")):
                s.chain(f"{finger}{side}", (hx + 0.04 * cos * sx, hy - 0.03 + i * 0.02, hz - 0.04 * sin),
                        (0.04 * cos * sx, 0, -0.04 * sin), 3, f"hand{side}")
        s.add(f"upleg{side}", (0.09 * sx, 0, 0.98), "hips")
        s.add(f"lowleg{side}", (0.09 * sx, -0.015, 0.55), f"upleg{side}")  # knee slightly forward
        s.add(f"foot{side}", (0.09 * sx, 0, 0.10), f"lowleg{side}")
        if toes:
            s.add(f"toe{side}", (0.09 * sx, -0.12, 0.03), f"foot{side}")
    return s


def with_cape(s):
    """A cape off the chest: spreads as wide as the arms and falls to the floor."""
    for side, sx in (("L", 1.0), ("R", -1.0)):
        s.chain(f"cape{side}", (0.14 * sx, 0.10, 1.44), (0.20 * sx, 0.02, -0.35), 5, "spine2")
    return s


def with_robe(s):
    """A floor-length robe off the hips: four panels that reach the ground like legs."""
    for i, (sx, sy) in enumerate(((1, 1), (1, -1), (-1, 1), (-1, -1))):
        s.chain(f"robe{i}", (0.16 * sx, 0.16 * sy, 0.95), (0.03 * sx, 0.03 * sy, -0.31), 4, "hips")
    return s


def with_sleeves(s):
    """Hanging cloth rigged off each wrist, longer than any finger."""
    for side, sx in (("L", 1.0), ("R", -1.0)):
        s.chain(f"sleeve{side}", (0.70 * sx, 0.05, 1.40), (0.02 * sx, 0.02, -0.12), 3, f"hand{side}")
    return s


def quadruped():
    """A four-legged creature — not a humanoid; naming must not raise or collide."""
    s = Skeleton()
    s.add("root", (0, 0, 0.60))
    s.chain("spine", (0, -0.15, 0.62), (0, -0.15, 0.01), 4, "root")
    s.chain("neck", (0, -0.75, 0.70), (0, -0.10, 0.06), 3, "spine3")
    s.chain("tail", (0, 0.15, 0.58), (0, 0.15, -0.05), 4, "root")
    for tag, sx in (("l", 1.0), ("r", -1.0)):
        s.chain(f"front{tag}", (0.15 * sx, -0.60, 0.55), (0, 0, -0.18), 3, "spine3")
        s.chain(f"back{tag}", (0.15 * sx, 0.10, 0.55), (0, 0, -0.18), 3, "root")
    return s


SLOTS = {
    "mixamo": {
        "hips": "mixamorig:Hips", "spine": "mixamorig:Spine", "spine1": "mixamorig:Spine1",
        "spine2": "mixamorig:Spine2", "neck": "mixamorig:Neck", "head": "mixamorig:Head",
        "clavL": "mixamorig:LeftShoulder", "uarmL": "mixamorig:LeftArm",
        "farmL": "mixamorig:LeftForeArm", "handL": "mixamorig:LeftHand",
        "clavR": "mixamorig:RightShoulder", "uarmR": "mixamorig:RightArm",
        "farmR": "mixamorig:RightForeArm", "handR": "mixamorig:RightHand",
        "uplegL": "mixamorig:LeftUpLeg", "lowlegL": "mixamorig:LeftLeg",
        "footL": "mixamorig:LeftFoot", "toeL": "mixamorig:LeftToeBase",
        "uplegR": "mixamorig:RightUpLeg", "lowlegR": "mixamorig:RightLeg",
        "footR": "mixamorig:RightFoot", "toeR": "mixamorig:RightToeBase",
        "thumbL0": "mixamorig:LeftHandThumb1", "indexL0": "mixamorig:LeftHandIndex1",
        "middleL0": "mixamorig:LeftHandMiddle1", "ringL0": "mixamorig:LeftHandRing1",
        "pinkyL0": "mixamorig:LeftHandPinky1",
        "thumbR0": "mixamorig:RightHandThumb1", "indexR0": "mixamorig:RightHandIndex1",
        "middleR0": "mixamorig:RightHandMiddle1", "ringR0": "mixamorig:RightHandRing1",
        "pinkyR0": "mixamorig:RightHandPinky1",
    },
    "ue5": {
        "hips": "pelvis", "spine": "spine_01", "spine1": "spine_02", "spine2": "spine_03",
        "neck": "neck_01", "head": "head",
        "clavL": "clavicle_l", "uarmL": "upperarm_l", "farmL": "lowerarm_l", "handL": "hand_l",
        "clavR": "clavicle_r", "uarmR": "upperarm_r", "farmR": "lowerarm_r", "handR": "hand_r",
        "uplegL": "thigh_l", "lowlegL": "calf_l", "footL": "foot_l", "toeL": "ball_l",
        "uplegR": "thigh_r", "lowlegR": "calf_r", "footR": "foot_r", "toeR": "ball_r",
        "thumbL0": "thumb_01_l", "indexL0": "index_01_l", "middleL0": "middle_01_l",
        "ringL0": "ring_01_l", "pinkyL0": "pinky_01_l",
        "thumbR0": "thumb_01_r", "indexR0": "index_01_r", "middleR0": "middle_01_r",
        "ringR0": "ring_01_r", "pinkyR0": "pinky_01_r",
    },
}

CLOTH_PREFIXES = ("cape", "robe", "sleeve")


def check(label, skeleton, template="mixamo"):
    names, joints, parents = skeleton.arrays()
    renamed = st.apply_asset_joint_name_template(
        joint_names=names, joints=joints, parents=parents, template=template,
    )
    mapping = dict(zip(names, renamed))

    problems = []
    for bone, slot in SLOTS[template].items():
        if bone in mapping and mapping[bone] != slot:
            problems.append(f"{bone} should be {slot}, got {mapping[bone]}")
    # A humanoid slot on a clothing bone is the bug this suite exists for: it
    # both mislabels the cloth and denies the slot to the limb that owned it.
    body_slots = set(SLOTS[template].values())
    for bone in names:
        if bone.startswith(CLOTH_PREFIXES) and mapping[bone] in body_slots:
            problems.append(f"clothing bone {bone} took the {mapping[bone]} slot")

    print(f"{'PASS' if not problems else 'FAIL'}  {label}")
    for problem in problems:
        print(f"        {problem}")
    return not problems


def main():
    results = [
        check("T-pose humanoid", humanoid(0)),
        check("A-pose humanoid", humanoid(45)),
        check("arms hanging down", humanoid(75)),
        check("no toe bones", humanoid(0, toes=False)),
        check("no clavicles", humanoid(0, clavicles=False)),
        check("no fingers", humanoid(0, fingers=False)),
        check("cape off the chest", with_cape(humanoid(0))),
        check("robe off the hips", with_robe(humanoid(0))),
        check("sleeves off the wrists", with_sleeves(humanoid(0))),
        check("cape + robe + sleeves", with_sleeves(with_robe(with_cape(humanoid(0))))),
        check("A-pose, fully clothed", with_sleeves(with_robe(with_cape(humanoid(45))))),
        check("ue5, T-pose", humanoid(0), template="ue5"),
        check("ue5, fully clothed", with_sleeves(with_robe(with_cape(humanoid(45)))), template="ue5"),
    ]

    names, joints, parents = quadruped().arrays()
    renamed = st.apply_asset_joint_name_template(
        joint_names=names, joints=joints, parents=parents, template="mixamo")
    ok = len(renamed) == len(names) and len(set(renamed)) == len(renamed)
    print(f"{'PASS' if ok else 'FAIL'}  quadruped keeps one unique name per joint")
    results.append(ok)

    print()
    print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
