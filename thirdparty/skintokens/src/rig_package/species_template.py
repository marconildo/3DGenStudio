"""Rename a generated skeleton to one of the mesh2motion creature conventions.

The humanoid templates in :mod:`skeleton_template` cover bipeds. This module
covers the eight animal reference rigs the Animations tab retargets from —
bird, dragon, fox, horse, kaiju, shark, snake and spider.

Why the names matter: ``autoMapBones`` in the app is name-based. Give a
generated rig mesh2motion's OWN bone names and Auto-Map pairs them by exact
token; leave them as ``bone_12`` and every bone has to be mapped by hand. So the
slot tables below are the reference rigs' literal names, lifted from
``resources/rigs/rig-<species>.glb``, including their inconsistent casing
(``Front_Leg_Upper_L`` for fox, ``front_leg_upper_l`` for horse) and Blender's
duplicate suffixes (``Spine_2.001``). They are not a convention we invented and
must not be tidied up.

Decorative bones are deliberately absent from the tables — ears, horns, teeth,
mouths, feathers, the ``_leaf``/``_tip`` terminators and the zero-length anchors
(``legs_anchor_1_l``). A generated rig rarely has counterparts, and the retarget
does not drive them, so they keep "extra" names.

Everything here works in the asset's Blender space: X lateral, Y front/back with
the creature facing -Y, Z up.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence

import numpy as np

from .skeleton_template import (
    SKELETON_TEMPLATE_SPECIES as _TEMPLATE_SPECIES,
    _build_children,
    _build_extra_names,
    _compute_subtree_stats,
    _make_unique_names,
    _normalize,
    _resolve_source_names,
)

X_AXIS, Y_AXIS, Z_AXIS = 0, 1, 2

SPECIES_BIRD = "bird"
SPECIES_DRAGON = "dragon"
SPECIES_FOX = "fox"
SPECIES_HORSE = "horse"
SPECIES_KAIJU = "kaiju"
SPECIES_SHARK = "shark"
SPECIES_SNAKE = "snake"
SPECIES_SPIDER = "spider"

# Ordered root-to-tip names per body part, exactly as the reference rigs spell
# them. A chain shorter than its slot list simply stops early — generated rigs
# range from 7 bones (a whale) to 59 (an eagle), and the retarget's matcher
# copes with a partly filled chain far better than with a wrong name.
SPECIES_SLOTS: Dict[str, Dict[str, List[str]]] = {
    SPECIES_SNAKE: {
        # One unbroken chain: the spine slots run straight on into the tail.
        "chain": ["head", "neck"] + [f"tail{i:02d}" for i in range(1, 21)],
    },
    SPECIES_SHARK: {
        "chain": ["head", "neck", "pelvis"] + [f"tail_{i}" for i in range(1, 9)],
        "front_fin_l": ["front_fin_1_l", "front_fin_2_l"],
        "front_fin_r": ["front_fin_1_r", "front_fin_2_r"],
        "back_fin_l": ["back_fin_1_l", "back_fin_2_l"],
        "back_fin_r": ["back_fin_1_r", "back_fin_2_r"],
    },
    SPECIES_SPIDER: {
        "spine": ["hips", "spine_1", "spine_2", "head"],
        "tail": ["tail_1", "tail_2", "tail_3"],
        "leg_a_l": ["leg_a_1_l", "leg_a_2_l", "leg_a_3_l"],
        "leg_b_l": ["leg_b_1_l", "leg_b_2_l", "leg_b_3_l"],
        "leg_c_l": ["leg_c_1_l", "leg_c_2_l", "leg_c_3_l"],
        "leg_d_l": ["leg_d_1_l", "leg_d_2_l", "leg_d_3_l"],
        "leg_a_r": ["leg_a_1_r", "leg_a_2_r", "leg_a_3_r"],
        "leg_b_r": ["leg_b_1_r", "leg_b_2_r", "leg_b_3_r"],
        "leg_c_r": ["leg_c_1_r", "leg_c_2_r", "leg_c_3_r"],
        "leg_d_r": ["leg_d_1_r", "leg_d_2_r", "leg_d_3_r"],
    },
    SPECIES_FOX: {
        "spine": ["Hips", "Spine_1", "Spine_2", "Spine_2.001", "Spine_3", "Spine_4", "Head"],
        "tail": ["Tail_Base", "Tail_Mid", "Tail_Mid.001", "Tail_End"],
        "front_l": ["Front_Leg_Shoulder_L", "Front_Leg_Upper_L", "Front_Leg_Lower_L",
                    "Front_Leg_Ankle_L", "Front_Leg_Foot_L"],
        "front_r": ["Front_Leg_Shoulder_R", "Front_Leg_Upper_R", "Front_Leg_Lower_R",
                    "Front_Leg_Ankle_R", "Front_Leg_Foot_R"],
        "hind_l": ["Back_Leg_Pelvis_L", "Back_Leg_Upper_L", "Back_Leg_Lower_L",
                   "Back_Leg_Ankle_L", "Back_Leg_Foot_L", "Back_Leg_Foot_1_L"],
        "hind_r": ["Back_Leg_Pelvis_R", "Back_Leg_Upper_R", "Back_Leg_Lower_R",
                   "Back_Leg_Ankle_R", "Back_Leg_Foot_R", "Back_Leg_Foot_1_R"],
    },
    SPECIES_HORSE: {
        "spine": ["hips", "spine_1", "spine_2", "spine_3", "spine_4", "spine_5",
                  "spine_6", "head"],
        "tail": ["tail_1", "tail_2", "tail_3", "tail_4"],
        "front_l": ["front_scapula_l", "front_humerus_l", "front_leg_upper_l",
                    "front_leg_lower_l", "front_leg_ankle_l", "front_leg_foot_l"],
        "front_r": ["front_scapula_r", "front_humerus_r", "front_leg_upper_r",
                    "front_leg_lower_r", "front_leg_ankle_r", "front_leg_foot_r"],
        "hind_l": ["back_leg_pelvis_l", "back_leg_upper_l", "back_leg_lower_l",
                   "back_leg_ankle_l", "back_leg_foot_l", "back_leg_toe_l"],
        "hind_r": ["back_leg_pelvis_r", "back_leg_upper_r", "back_leg_lower_r",
                   "back_leg_ankle_r", "back_leg_foot_r", "back_leg_toe_r"],
    },
    SPECIES_BIRD: {
        "spine": ["hips", "spine_0", "spine_1", "spine_2", "spine_3", "head"],
        "tail": ["tail_1", "tail_2", "tail_3"],
        "front_l": ["wing_1_L", "wing_2_L", "wing_3_L", "wing_4_L", "wing_5_L"],
        "front_r": ["wing_1_R", "wing_2_R", "wing_3_R", "wing_4_R", "wing_5_R"],
        "hind_l": ["UpperLeg_L", "LowerLeg_L", "AnkleLeg_L", "Foot_L", "Toes_L"],
        "hind_r": ["UpperLeg_R", "LowerLeg_R", "AnkleLeg_R", "Foot_R", "Toes_R"],
    },
    SPECIES_KAIJU: {
        "spine": ["Hips", "Spine_1", "Spine_2", "Spine_2.001", "Spine_3", "Spine_4", "Head"],
        "tail": ["Tail_Base", "Tail_Mid", "Tail_Mid.001", "Tail_Mid.002", "Tail_Mid.003"],
        "front_l": ["Front_Leg_Shoulder_L", "Front_Leg_Upper_L", "Front_Leg_Lower_L", "Hand_L"],
        "front_r": ["Front_Leg_Shoulder_R", "Front_Leg_Upper_R", "Front_Leg_Lower_R", "Hand_R"],
        "hind_l": ["Back_Leg_Pelvis_L", "Back_Leg_Upper_L", "Back_Leg_Lower_L",
                   "Back_Leg_Ankle_L", "Back_Leg_Foot_L", "Back_Leg_Foot_1_L",
                   "Back_Leg_Foot_2_L"],
        "hind_r": ["Back_Leg_Pelvis_R", "Back_Leg_Upper_R", "Back_Leg_Lower_R",
                   "Back_Leg_Ankle_R", "Back_Leg_Foot_R", "Back_Leg_Foot_1_R",
                   "Back_Leg_Foot_2_R"],
    },
    SPECIES_DRAGON: {
        "spine": ["hips", "spine_0", "spine_1", "spine_2", "spine_3", "spine_4", "head"],
        "tail": ["tail_1", "tail_2", "tail_3", "tail_4", "tail_5", "tail_6"],
        "front_l": ["front_leg_collar_l", "front_leg_l", "front_ankle_l",
                    "front_foot_l", "front_toes_l"],
        "front_r": ["front_leg_collar_r", "front_leg_r", "front_ankle_r",
                    "front_foot_r", "front_toes_r"],
        "hind_l": ["back_leg_hip_l", "back_leg_l", "back_ankle_l", "back_foot_l",
                   "back_toes_l"],
        "hind_r": ["back_leg_hip_r", "back_leg_r", "back_ankle_r", "back_foot_r",
                   "back_toes_r"],
        "wing_l": ["shoulder_l", "wing_1_l", "wing_2_l", "wing_3_l", "wing_4_l", "wing_5_l"],
        "wing_r": ["shoulder_r", "wing_1_r", "wing_2_r", "wing_3_r", "wing_4_r", "wing_5_r"],
    },
}

# skeleton_template carries a literal copy of this list because it needs the
# choices at import time and importing this module there would cycle. Fail loudly
# at import rather than let a species exist in one list and not the other.
assert set(SPECIES_SLOTS) == set(_TEMPLATE_SPECIES), (
    "species lists have drifted: "
    f"{sorted(set(SPECIES_SLOTS) ^ set(_TEMPLATE_SPECIES))}"
)

# Which parts each species actually has. "front" is whatever hangs off the
# spine: a walking leg for the quadrupeds, a wing for the bird, an arm for the
# kaiju. The dragon is the only one carrying both front legs AND wings.
SPECIES_PLAN = {
    SPECIES_SNAKE: {"limbs": "none"},
    SPECIES_SHARK: {"limbs": "fins"},
    SPECIES_SPIDER: {"limbs": "many", "leg_pairs": 4},
    SPECIES_FOX: {"limbs": "quadruped"},
    SPECIES_HORSE: {"limbs": "quadruped"},
    SPECIES_BIRD: {"limbs": "quadruped", "front_is_wing": True},
    SPECIES_KAIJU: {"limbs": "quadruped", "front_is_arm": True},
    SPECIES_DRAGON: {"limbs": "quadruped", "wings": True},
}


# --------------------------------------------------------------------- helpers


def _limb_candidates(
    node: int,
    children: List[List[int]],
    joints: np.ndarray,
    scale: float,
    skip: set,
) -> List[int]:
    """The branches off ``node`` that could each be one limb.

    Rigs thread limbs through zero-length stubs, and not always as siblings:
    this model gave a boar its two hind legs nested, the left leg's stub hanging
    off the right leg's stub rather than beside it. Taken at face value the
    outer stub is a single branch with no mirror twin, so BOTH legs disappear
    inside it. A stub carries no motion, only structure, so where one forks into
    several branches we look straight through it; where it leads to just one, it
    is the start of that limb and is kept.
    """
    out: List[int] = []
    stack = [(child, node) for child in children[node] if child not in skip]
    while stack:
        child, parent = stack.pop()
        kids = [k for k in children[child] if k not in skip]
        is_stub = float(np.linalg.norm(joints[child] - joints[parent])) < 0.02 * scale
        if is_stub and len(kids) > 1:
            stack.extend((k, child) for k in kids)
            continue
        out.append(child)
    return out


def _lateral_reach(node: int, stats: dict, centre_x: float) -> float:
    """How far the node's whole subtree strays from the body's mid line."""
    return max(abs(float(stats["max_x"][node]) - centre_x),
               abs(float(stats["min_x"][node]) - centre_x))


def _chain_from(
    start: int,
    children: List[List[int]],
    joints: np.ndarray,
    direction: Optional[np.ndarray],
    stats: dict,
    blocked: Optional[set] = None,
    max_length: int = 64,
    centre_x: Optional[float] = None,
    scale: float = 1.0,
) -> List[int]:
    """Walk down from ``start``, following the chain's own heading.

    At each joint the child that best continues the current direction wins;
    where nothing clearly continues it, the child with the largest subtree does.
    That is all a limb, a spine or a tail needs — they are each a run of joints
    heading one way — and it keeps a chain from turning off into a side branch
    (a wing into its feather fan, a leg into a toe).

    Pass ``centre_x`` when following a SPINE or TAIL, which run down the body's
    mid line. Rigs commonly branch through stub joints that all sit at the same
    spot — this model gave a boar a snout and two tusks starting from one point —
    and with identical positions there is no direction to compare and the larger
    subtree wins, which hands the spine to a tusk. A mild preference for staying
    central resolves it — a snout is on the mid line, a tusk is not — and it is
    deliberately mild: a coiled snake's body wanders far off its own root's mid
    line, so this must never outweigh the direction the chain is actually going.
    """
    subtree_size = stats["size"]
    blocked = blocked or set()
    chain = [start]
    current = start
    heading = None if direction is None else _normalize(np.asarray(direction, dtype=np.float32))
    while len(chain) < max_length:
        options = [c for c in children[current] if c not in blocked and c not in chain]
        if not options:
            break
        best, best_score = None, float("-inf")
        for child in options:
            step = joints[child] - joints[current]
            norm = float(np.linalg.norm(step))
            align = 0.0 if (heading is None or norm < 1e-8) else float(np.dot(step / norm, heading))
            score = 2.0 * align + 0.15 * float(subtree_size[child]) / max(len(joints), 1)
            if centre_x is not None:
                score -= 0.25 * _lateral_reach(child, stats, centre_x) / scale
            if score > best_score:
                best_score, best = score, child
        if best is None:
            break
        step = joints[best] - joints[current]
        if float(np.linalg.norm(step)) > 1e-8:
            new_heading = _normalize(step)
            # Ease toward the new heading so a chain can curve (a leg bending at
            # the knee, a coiled snake) without a single sharp joint capturing it.
            heading = new_heading if heading is None else _normalize(heading * 0.5 + new_heading)
        chain.append(best)
        current = best
    return chain


def _pair_up(
    candidates: List[int],
    joints: np.ndarray,
    centre_x: float,
    scale: float,
    stats: dict,
) -> List[tuple]:
    """Greedily pair branches with their mirror twin across the body's mid line.

    Returns ``[(+X node, -X node), ...]``. Limbs come in mirrored pairs and the
    stray bones a generated rig throws in usually do not, so pairing is both how
    sides are decided and a filter on what counts as a limb at all.

    Which SIDE a branch is on comes from its whole subtree, because rigs
    routinely hang a limb off a stub sitting exactly on the mid line — this
    model gave a boar four of them — and a first-joint test reads those as
    neither left nor right, so both legs of a pair are silently dropped.

    How WELL two branches mirror is judged at the first joint, with the subtree
    only breaking ties. The subtree cannot lead here: the model gave this
    spider one three-bone leg opposite a four-bone twin, and comparing subtree
    extents makes a genuine pair look 0.5 body-lengths apart. Where limbs attach
    stays symmetric even when their lengths do not.
    """
    def profile(node):
        """(side-most x in the subtree, subtree centre in y, in z)."""
        lo_x, hi_x = float(stats["min_x"][node]), float(stats["max_x"][node])
        side_x = hi_x if abs(hi_x - centre_x) >= abs(lo_x - centre_x) else lo_x
        return (
            side_x,
            0.5 * (float(stats["min_y"][node]) + float(stats["max_y"][node])),
            0.5 * (float(stats["min_z"][node]) + float(stats["max_z"][node])),
        )

    shape = {n: profile(n) for n in candidates}
    positive = [n for n in candidates if shape[n][0] - centre_x > 0]
    negative = [n for n in candidates if shape[n][0] - centre_x < 0]
    scored = []
    for a in positive:
        for b in negative:
            attach = (
                abs((float(joints[a][X_AXIS]) - centre_x) + (float(joints[b][X_AXIS]) - centre_x))
                + abs(float(joints[a][Y_AXIS]) - float(joints[b][Y_AXIS]))
                + abs(float(joints[a][Z_AXIS]) - float(joints[b][Z_AXIS]))
            ) / scale
            pa, pb = shape[a], shape[b]
            span = (
                abs((pa[0] - centre_x) + (pb[0] - centre_x))
                + abs(pa[1] - pb[1])
                + abs(pa[2] - pb[2])
            ) / scale
            err = attach + 0.25 * span
            scored.append((err, a, b))
    scored.sort()
    pairs, used = [], set()
    for err, a, b in scored:
        if a in used or b in used or err > 0.35:
            continue
        used.add(a)
        used.add(b)
        pairs.append((a, b))
    return pairs


def _assign(target: List[str], chain: Sequence[int], slot_names: Sequence[str]) -> None:
    for node, name in zip(chain, slot_names):
        target[node] = name


# ------------------------------------------------------------------ body plan


class _Body:
    """The parts a creature skeleton decomposes into, before naming."""

    def __init__(self, root, children, joints, subtree_stats, scale):
        self.root = root
        self.children = children
        self.joints = joints
        self.stats = subtree_stats
        self.scale = scale
        self.spine: List[int] = []
        self.tail: List[int] = []
        # Limb pairs, ordered nose-first by where they meet the spine.
        self.limb_pairs: List[tuple] = []


def _decompose(joints: np.ndarray, parents: np.ndarray) -> Optional[_Body]:
    """Split a creature skeleton into spine, tail and mirrored limb pairs.

    The one rule that does the heavy lifting: pair up the root's branches, and
    whatever has no mirror twin is body, not limb. Limbs come in twos, a spine
    and a tail do not — and that holds whether the animal has two legs, four,
    or the ten this model gave a spider. It also sidesteps the trap that a
    spider's body chain is SMALLER than any one of its legs, so "biggest
    subtree wins" would have picked a leg as the spine.
    """
    try:
        root, children = _build_children(parents=parents)
    except ValueError:
        return None
    if joints.shape[0] < 4:
        return None

    stats = _compute_subtree_stats(
        joints=joints, children=children, root=root, x_axis=X_AXIS, z_axis=Z_AXIS)
    extent = joints.max(axis=0) - joints.min(axis=0)
    scale = max(float(extent.max()), 1e-6)
    body = _Body(root, children, joints, stats, scale)
    centre_x = float(joints[root][X_AXIS])

    root_kids = children[root]
    if not root_kids:
        return None
    root_pairs = _pair_up(root_kids, joints, centre_x, scale, stats)
    paired_at_root = {n for pair in root_pairs for n in pair}
    unpaired = [n for n in root_kids if n not in paired_at_root]

    if not unpaired:
        # Every branch found a twin, so the root itself is the whole body.
        return body

    def reach(node):
        chain = _chain_from(node, children, joints, joints[node] - joints[root], stats,
                            centre_x=centre_x, scale=scale)
        return float(np.linalg.norm(joints[chain[-1]] - joints[root])), chain

    scored = sorted(((reach(n), n) for n in unpaired), key=lambda item: -item[0][0])
    body.spine = [root] + scored[0][0][1]
    spine_dir = _normalize(joints[body.spine[-1]] - joints[root])

    # Every branch off the spine is a limb, a tail, or decoration. Collect them
    # from the WHOLE spine including the root: where the limbs attach varies by
    # animal — this model hung a boar's hind legs off the root but an eagle's
    # off the first spine bone — so anchoring on the root alone silently loses
    # half the rig.
    # What hangs off the head end is an ear, a horn or a jaw, never a limb — and
    # a pair of ears mirrors as neatly as a pair of legs, so they will win a limb
    # slot outright unless excluded here. The skull usually spans the last two
    # spine joints (this model gave a boar its ears off the joint BEFORE the
    # head), but only trust that on a spine long enough to have a neck: on a
    # three-joint spine the second-to-last joint is the chest, and the front
    # limbs are attached to it.
    skull = set(body.spine[-2:]) if len(body.spine) >= 4 else set(body.spine[-1:])
    spine_set = set(body.spine)
    branches = []
    for node in body.spine:
        if node in skull:
            continue
        branches.extend(_limb_candidates(node, children, joints, scale, skip=spine_set))

    body.limb_pairs = _pair_up(branches, joints, centre_x, scale, stats)
    claimed = {n for pair in body.limb_pairs for n in pair}

    # A tail is the unpaired branch heading away from the head, and the longest
    # one at that — a rump or a fin stub can also point backwards.
    best_tail, best_reach = None, 0.0
    for node in branches:
        if node in claimed:
            continue
        chain = _chain_from(node, children, joints, joints[node] - joints[root], stats,
                            centre_x=centre_x, scale=scale)
        # Measured from the ROOT, not along the branch: a one-bone tail — which
        # is all this model gave a boar — has no direction of its own to read.
        direction = _normalize(joints[chain[-1]] - joints[root])
        if float(np.dot(direction, spine_dir)) >= 0.0:
            continue
        span = float(np.linalg.norm(joints[chain[-1]] - joints[root]))
        if span > best_reach:
            best_reach, best_tail = span, chain
    if best_tail:
        body.tail = best_tail

    # Not everything that mirrors is a limb. A spider's pedipalps sit right at
    # the front and pair as neatly as any leg, so ordering nose-first hands them
    # "leg_a" and pushes a real leg pair out of the four mesh2motion names.
    # Limbs on one animal are all about the same length whatever its
    # proportions, so a pair far shorter than the rest is mouthparts, an ear or
    # a stub — measured across every rig seen so far, genuine pairs land within
    # 0.8-1.2x the median and a pedipalp pair at 0.31x.
    if len(body.limb_pairs) > 1:
        reach = {}
        for pair in body.limb_pairs:
            spans = [
                float(np.linalg.norm(joints[_chain_from(
                    node, children, joints, joints[node] - joints[root], stats)[-1]] - joints[node]))
                for node in pair
            ]
            reach[pair] = 0.5 * sum(spans)
        cutoff = 0.5 * float(np.median(list(reach.values())))
        kept = [pair for pair in body.limb_pairs if reach[pair] >= cutoff]
        if kept:
            body.limb_pairs = kept

    # Nose-first, so the front pair and the hind pair are simply the ends.
    body.limb_pairs = _order_pairs_front_to_back(body.limb_pairs, joints, spine_dir)
    return body


def _order_pairs_front_to_back(pairs, joints, forward) -> List[tuple]:
    """Sort limb pairs along the body axis, nose first."""
    return sorted(pairs, key=lambda pr: -float(np.dot(
        0.5 * (joints[pr[0]] + joints[pr[1]]), forward)))


# --------------------------------------------------------------------- naming


def _head_end_is_root(body: _Body) -> bool:
    """For a one-chain animal, decide which end of the chain is the head.

    Geometry alone cannot tell a snake's nose from its tail-tip, or a spider's
    head from its abdomen — both ends are a tapering chain. What does carry the
    signal is where the SIDE branches sit: a jaw, a palp or a pectoral fin hangs
    off the front of an animal, never off the far end of its tail. So the head
    is whichever end those branches cluster nearer. With no side branches at all
    there is nothing to read, and the root end is the better default — it is
    where mesh2motion's own snake and shark put the head.
    """
    chain = body.spine
    if len(chain) < 3:
        return True
    branch_positions = [
        index for index, node in enumerate(chain)
        if len([c for c in body.children[node] if c not in chain]) > 0
    ]
    if not branch_positions:
        return True
    mean = sum(branch_positions) / len(branch_positions)
    return mean < (len(chain) - 1) / 2.0


def _name_single_chain(body: _Body, names: List[str], slots) -> None:
    """Snake and shark: one chain running head -> neck -> ... -> tail tip."""
    chain = list(body.spine)
    if not _head_end_is_root(body):
        chain.reverse()
    _assign(names, chain, slots["chain"])

    # A shark's fins are the only paired branches it has. The pair nearer the
    # head is the pectoral (front) pair.
    fin_pairs = list(body.limb_pairs)
    if not fin_pairs or "front_fin_l" not in slots:
        return
    head_pos = body.joints[chain[0]]
    fin_pairs.sort(key=lambda pr: float(np.linalg.norm(
        0.5 * (body.joints[pr[0]] + body.joints[pr[1]]) - head_pos)))
    for which, pair in zip(("front_fin", "back_fin"), fin_pairs):
        for node, side in zip(pair, ("l", "r")):
            fin = _chain_from(node, body.children, body.joints,
                              body.joints[node] - head_pos, body.stats, max_length=4)
            _assign(names, fin, slots[f"{which}_{side}"])


def _name_spider(body: _Body, names: List[str], slots, leg_pairs: int) -> None:
    """Legs a..d run front to back; a generated rig may offer more pairs than
    the four mesh2motion names, and the spare ones keep extra names."""
    chain = list(body.spine)
    if not _head_end_is_root(body):
        chain.reverse()
    _assign(names, chain, slots["spine"])
    if 2 <= len(chain) < len(slots["spine"]):
        names[chain[-1]] = slots["spine"][-1]
    if body.tail:
        _assign(names, body.tail, slots["tail"])

    forward = _normalize(body.joints[chain[-1]] - body.joints[chain[0]])
    pairs = _order_pairs_front_to_back(body.limb_pairs, body.joints, forward)
    for letter, pair in zip("abcd"[:leg_pairs], pairs):
        for node, side in zip(pair, ("l", "r")):
            leg = _chain_from(node, body.children, body.joints,
                              body.joints[node] - body.joints[body.root],
                              body.stats, max_length=5)
            _assign(names, leg, slots[f"leg_{letter}_{side}"])


def _name_quadruped(body: _Body, names: List[str], slots, plan) -> None:
    """Fox, horse, bird, kaiju, dragon: spine + tail + a hind pair + a front pair.

    Hind limbs hang off the root, front limbs off the spine — the same layout as
    a humanoid, which is why the rest of this reads so much like it. The only
    genuinely new part is the tail, and the fact that a quadruped's front limbs
    go DOWN where a humanoid's arms go out.
    """
    _assign(names, body.spine, slots["spine"])
    # The head is the last spine slot whatever the chain's length, so a short
    # spine still ends in a head rather than trailing off mid-torso.
    if len(body.spine) < len(slots["spine"]) and len(body.spine) >= 2:
        names[body.spine[-1]] = slots["spine"][-1]
    if body.tail:
        _assign(names, body.tail, slots["tail"])

    def name_pair(pair, prefix, limit):
        for node, side in zip(pair, ("l", "r")):
            key = f"{prefix}_{side}"
            if key not in slots:
                continue
            chain = _chain_from(node, body.children, body.joints,
                                body.joints[node] - body.joints[body.root],
                                body.stats, max_length=limit)
            _assign(names, chain, slots[key])

    # Pairs arrive nose-first, so the last is the hind pair and the rest are
    # front limbs — which is what tells a bird's wings from its legs even though
    # both hang off the same spine bone.
    pairs = list(body.limb_pairs)
    if not pairs:
        return
    if len(pairs) > 1:
        name_pair(pairs[-1], "hind", len(slots.get("hind_l", [])) + 1)
        front_pairs = pairs[:-1]
    else:
        # Only one pair: on a two-legged creature those are the hind legs.
        front_pairs = [] if plan.get("front_is_wing") else pairs
        if not front_pairs:
            name_pair(pairs[0], "hind", len(slots.get("hind_l", [])) + 1)

    if plan.get("wings") and len(front_pairs) >= 2:
        # A dragon carries front legs AND wings off the same stretch of torso.
        # A leg reaches the ground; a wing stays up and spreads wide, so the
        # lowest-reaching pair is the legs and the other is the wings.
        front_pairs.sort(key=lambda pr: min(
            float(body.stats["min_z"][pr[0]]), float(body.stats["min_z"][pr[1]])))
        name_pair(front_pairs[0], "front", len(slots.get("front_l", [])) + 1)
        name_pair(front_pairs[-1], "wing", len(slots.get("wing_l", [])) + 1)
    elif front_pairs:
        name_pair(front_pairs[0], "front", len(slots.get("front_l", [])) + 1)


def build_species_names(
    joint_names: Optional[List[str]],
    joints: np.ndarray,
    parents: np.ndarray,
    species: str,
) -> Optional[List[str]]:
    """Name a generated skeleton with one species' mesh2motion bone names.

    Returns ``None`` when the skeleton cannot be read as that animal, so the
    caller can fall back rather than emit confidently wrong names.
    """
    slots = SPECIES_SLOTS.get(species)
    plan = SPECIES_PLAN.get(species)
    if slots is None or plan is None:
        return None

    joints = np.asarray(joints, dtype=np.float32)
    parents = np.asarray(parents, dtype=np.int32)
    source_names = _resolve_source_names(joint_names=joint_names, joint_count=int(joints.shape[0]))

    body = _decompose(joints=joints, parents=parents)
    if body is None or not body.spine:
        return None

    names = _build_extra_names(source_names=source_names, template=species)
    kind = plan["limbs"]
    if kind in ("none", "fins"):
        _name_single_chain(body, names, slots)
    elif kind == "many":
        _name_spider(body, names, slots, plan.get("leg_pairs", 4))
    else:
        _name_quadruped(body, names, slots, plan)
    return _make_unique_names(names)
