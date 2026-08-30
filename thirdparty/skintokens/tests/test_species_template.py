"""Creature bone-renaming checks for ``rig_package.species_template``.

Unlike the humanoid suite next door, these run against REAL skeletons: five
meshes (a wild boar, an eagle, a spider, a whale and a snake) put through the
rigging service, with the resulting joints and parents captured into
``fixtures/generated_creature_rigs.json``. Only the skeleton is kept — the
renamer never sees geometry — which is why a 6 MB set of GLBs reduces to 11 KB.

They exist because the failure mode here is quiet. A creature template that
mistakes a boar's EARS for its front legs still returns a full set of plausible
names; nothing raises, and you find out when the retargeted walk cycle waggles
the head instead of the legs. Each case therefore asserts which specific bone
carries which slot, not merely that naming happened.

Run directly — needs only numpy::

    python thirdparty/skintokens/tests/test_species_template.py
"""
from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import numpy as np

if "omegaconf" not in sys.modules:  # pragma: no cover - import shim
    try:
        import omegaconf  # noqa: F401
    except ImportError:
        stub = types.ModuleType("omegaconf")
        stub.OmegaConf = types.SimpleNamespace(
            load=lambda _p: (_ for _ in ()).throw(AssertionError("humanoid fallback reached")))
        sys.modules["omegaconf"] = stub

HERE = Path(__file__).resolve().parent
# Import through the PACKAGE, exactly as the rig service does
# (src.rig_package.skeleton_template). Importing these files as top-level
# modules instead — by putting src/rig_package itself on sys.path — makes the
# package's own relative imports unresolvable, so a broken intra-package import
# would pass here and fail only in production. It has happened once already.
sys.path.insert(0, str(HERE.parent))
from src.rig_package import skeleton_template as st  # noqa: E402

FIXTURES = json.loads((HERE / "fixtures" / "generated_creature_rigs.json").read_text(encoding="utf-8"))


def rename(tag, species=None):
    data = FIXTURES[tag]
    joints = np.asarray(data["joints"], dtype=np.float32)
    parents = np.asarray(data["parents"], dtype=np.int32)
    names = [f"bone_{i}" for i in range(len(parents))]
    out = st.apply_asset_joint_name_template(
        joint_names=names, joints=joints, parents=parents,
        template=species or data["species"])
    return {i: out[i] for i in range(len(out))}


def check(label, tag, expect, species=None, unnamed=()):
    got = rename(tag, species)
    problems = [f"bone_{i} should be {slot}, got {got[i]}" for i, slot in expect.items()
                if got[i] != slot]
    # Bones the template must NOT claim — a boar's ears, an eagle's feathers.
    problems += [f"bone_{i} should have stayed unnamed, got {got[i]}"
                 for i in unnamed if not got[i].startswith("extra")]
    if len(set(got.values())) != len(got):
        problems.append("names are not unique")
    print(f"{'PASS' if not problems else 'FAIL'}  {label}")
    for problem in problems:
        print(f"        {problem}")
    return not problems


def main():
    results = []

    # Boar -> fox. Spine runs horizontally; front legs hang off mid-spine and
    # hind legs off the root. The ears (5-10) mirror each other as neatly as a
    # pair of limbs and must not take the front-leg slot.
    results.append(check("boar -> fox", "boar", {
        0: "Hips", 1: "Spine_1", 2: "Spine_2", 3: "Spine_2.001", 4: "Head",
        11: "Front_Leg_Shoulder_L", 12: "Front_Leg_Upper_L", 15: "Front_Leg_Foot_L",
        16: "Front_Leg_Shoulder_R", 20: "Front_Leg_Foot_R",
        21: "Back_Leg_Pelvis_R", 25: "Back_Leg_Foot_R",
        26: "Back_Leg_Pelvis_L", 30: "Back_Leg_Foot_L",
        31: "Tail_Base",
    }, unnamed=(5, 6, 7, 8, 9, 10)))

    # The same skeleton under the horse names — one detector, two name tables.
    results.append(check("boar -> horse", "boar", {
        0: "hips", 4: "head", 11: "front_scapula_l", 16: "front_scapula_r",
        21: "back_leg_pelvis_r", 26: "back_leg_pelvis_l", 31: "tail_1",
    }, species="horse", unnamed=(5, 6, 7, 8, 9, 10)))

    # The SAME boar mesh rigged a second time. The model samples, so it produced
    # a different skeleton — and a much nastier one: every limb hangs off a
    # zero-length stub sitting exactly on the mid line (1, 6, 12, 16), so a
    # branch's first joint says nothing about which side it is on; and the
    # snout (22) shares a position with both tusk stubs (23, 25), so the spine
    # has no direction to follow at that joint. Getting Head onto 22 rather than
    # onto a tusk is the whole point of the centrality tie-break.
    results.append(check("boar (mid-line stubs) -> fox", "boar_stubs", {
        0: "Hips", 11: "Spine_1", 20: "Spine_2", 21: "Spine_2.001", 22: "Head",
        1: "Back_Leg_Pelvis_L", 2: "Back_Leg_Upper_L", 5: "Back_Leg_Foot_L",
        6: "Back_Leg_Pelvis_R", 10: "Back_Leg_Foot_R",
        12: "Front_Leg_Shoulder_L", 13: "Front_Leg_Upper_L", 15: "Front_Leg_Ankle_L",
        16: "Front_Leg_Shoulder_R", 19: "Front_Leg_Ankle_R",
    }, unnamed=(24, 26)))

    # A THIRD rig of that boar. Here the hind legs are NESTED — the left leg's
    # stub (6) hangs off the right leg's stub (1) instead of beside it — so at
    # the hips there is one branch with no mirror twin, and taken at face value
    # both legs vanish inside it. Looking through zero-length stubs is what
    # recovers them; the stubs themselves stay unnamed, carrying no motion.
    results.append(check("boar (nested hind legs) -> fox", "boar_nested", {
        0: "Hips", 12: "Spine_1", 21: "Spine_2", 22: "Spine_2.001", 27: "Head",
        2: "Back_Leg_Pelvis_L", 3: "Back_Leg_Upper_L", 5: "Back_Leg_Ankle_L",
        7: "Back_Leg_Pelvis_R", 10: "Back_Leg_Ankle_R",
        13: "Front_Leg_Shoulder_L", 16: "Front_Leg_Ankle_L",
        17: "Front_Leg_Shoulder_R", 20: "Front_Leg_Ankle_R",
    }, unnamed=(1, 6, 11, 24, 26)))

    # Eagle -> bird. Wings AND legs hang off the same spine bone, so they are
    # told apart by where they sit along the body, not by what they attach to.
    # The feather fan at each wing tip (14, 16-18) is not part of the wing chain.
    results.append(check("eagle -> bird", "eagle", {
        0: "hips", 1: "spine_0", 5: "head",
        10: "wing_1_L", 13: "wing_4_L", 15: "wing_5_L",
        21: "wing_1_R", 24: "wing_4_R", 26: "wing_5_R",
        32: "UpperLeg_L", 35: "Foot_L", 40: "Toes_L",
        44: "UpperLeg_R", 47: "Foot_R", 52: "Toes_R",
        56: "tail_1", 57: "tail_2", 58: "tail_3",
    }, unnamed=(16, 17, 18, 27, 28, 29)))

    # Spider. The model gave this one TEN legs where mesh2motion names four, so
    # the four front-most pairs win a..d and the spare pair keeps extra names.
    results.append(check("spider -> spider", "spider", {
        0: "hips", 2: "head",
        14: "leg_a_1_l", 10: "leg_b_1_l", 6: "leg_c_1_l", 3: "leg_d_1_l",
        30: "leg_a_1_r", 34: "leg_b_1_r", 26: "leg_c_1_r", 22: "leg_d_1_r",
    }, unnamed=(18, 19, 20, 21, 38, 39, 40, 41)))

    # A second spider, with a short PEDIPALP pair at the very front. It mirrors
    # as cleanly as any leg, so ordering pairs nose-first alone handed it
    # "leg_a" and pushed the real REAR leg pair out of the four names entirely.
    # Reach is what separates them: every genuine limb pair across every rig
    # measured sits within 0.8-1.2x the median, this one at 0.31x.
    results.append(check("spider (with pedipalps) -> spider", "spider_palps", {
        0: "hips", 39: "head", 40: "tail_1",
        14: "leg_a_1_l", 18: "leg_a_1_r",
        22: "leg_b_1_l", 26: "leg_b_1_r",
        30: "leg_c_1_l", 34: "leg_c_1_r",
        1: "leg_d_1_l", 4: "leg_d_1_r",
    }, unnamed=(8, 9, 10, 11, 12, 13)))

    # Whale -> shark. Seven bones total: the head end is the one the pectoral
    # fins hang off, which is the only cue distinguishing nose from tail here.
    results.append(check("whale -> shark", "whale", {
        0: "head", 1: "neck", 2: "pelvis", 3: "tail_1", 4: "tail_2",
        5: "front_fin_1_l", 6: "front_fin_1_r",
    }))

    # Snake. One coiled chain: head, neck, then tail01 outward. Which END is the
    # head is read from where the side branches sit; see _head_end_is_root.
    got = rename("snake")
    chain_ok = got[27] == "head" and got[26] == "neck" and got[25] == "tail01"
    ordered = all(got[26 - i] == f"tail{i:02d}" for i in range(1, 15))
    print(f"{'PASS' if chain_ok and ordered else 'FAIL'}  snake -> snake (chain runs head to tail in order)")
    if not (chain_ok and ordered):
        print(f"        got 27={got[27]} 26={got[26]} 25={got[25]} 24={got[24]}")
    results.append(chain_ok and ordered)

    # A creature template must never fall through to the humanoid positional
    # map, which would scatter mixamo names over an animal by joint index.
    every = {tag: rename(tag) for tag in FIXTURES}
    leaked = {tag: n for tag, m in every.items() for n in m.values() if "mixamorig" in n}
    print(f"{'PASS' if not leaked else 'FAIL'}  no humanoid names leak into a creature rig")
    results.append(not leaked)

    print()
    print("ALL PASS" if all(results) else f"{results.count(False)} FAILED")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
