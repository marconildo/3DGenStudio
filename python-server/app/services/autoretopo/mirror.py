"""Stage 3b - mirror-symmetric output.

The remesh has no idea the model is symmetric, so the two halves come back with
unrelated edge flow: measured on seven AI meshes, ~1% of the vertices had a
mirror partner. Rigging (mirrored weight painting), Auto UV's symmetry seam and
plain readability all want the two sides to match.

Method (after Smart Remesh's `fold_result`): keep one half of the FINISHED
result, reflect it onto the other, weld the seam. Cutting the *source* in half
instead was their first attempt and is worse - the cut is an open border every
later stage treats as a real edge of the model.

  1. find the plane: per axis, the offset near the bbox centre where reflected
     surface samples land closest to the surface;
  2. snap vertices within 0.35 edge of the plane onto it, so the cut follows
     existing edges instead of slicing triangles into slivers;
  3. clip to the positive side, drop faces lying IN the plane (the mirror would
     duplicate them into non-manifold edges), reflect, weld;
  4. guard: measure detail lost / gained against the original before and after.
     A model that only looks symmetric (a turned head, a sword in one hand)
     loses real geometry to the fold - measured +25% / +82% on an anime figure
     whose hair and pose differ left to right - so the fold is reverted when it
     costs more than `max_cost` percent.
"""
from __future__ import annotations
import numpy as np
import trimesh
from scipy.spatial import cKDTree

AXES = {"x": 0, "y": 1, "z": 2}


def find_plane(mesh, axis="auto", n=8000, seed=1):
    """Best mirror plane. Returns (axis_index, offset, error_pct_of_size).

    Error is the 90th-percentile distance from a reflected surface sample to
    the surface, as a percentage of the largest extent. `axis="auto"` tries all
    three and keeps the lowest.
    """
    pts, _ = trimesh.sample.sample_surface(mesh, n, seed=seed)
    ref, _ = trimesh.sample.sample_surface(mesh, max(10 * n, 60000), seed=seed + 1)
    tree = cKDTree(ref)
    size = float(np.max(mesh.extents)) or 1.0
    centre = mesh.bounds.mean(axis=0)

    # A reflection that lands far from the surface is a miss whatever the exact
    # distance, and an uncapped KD query for it is what made the scan slow
    # (5 s of a 5 s plane search on a 340k-face head).
    cap = 0.05 * size
    scan = pts[:2000]       # the scan only has to find the neighbourhood

    def err(ax, c, P=pts):
        q = P.copy()
        q[:, ax] = 2.0 * c - q[:, ax]
        d = tree.query(q, distance_upper_bound=cap)[0]
        return float(np.percentile(np.minimum(d, cap), 90))

    best = None
    for ax in ([AXES[axis]] if axis in AXES else range(3)):
        # A mesh that is flat along this axis is trivially "symmetric" across it.
        if float(mesh.extents[ax]) < 0.05 * size:
            continue
        # coarse scan of +-3% of the size
        coarse = centre[ax] + np.linspace(-0.03, 0.03, 25) * size
        c = min(coarse, key=lambda v: err(ax, v, scan))
        # Then refine below the scan's step, ICP-style: pair each reflected
        # sample with its nearest surface point and move the plane to the
        # middle of the closest half of the pairs. The fold is very sensitive
        # to this - 0.3% of the size off took a column's cost from 10% to 23%.
        for _ in range(6):
            q = pts.copy()
            q[:, ax] = 2.0 * c - q[:, ax]
            d, j = tree.query(q)
            good = d <= np.median(d)
            c_new = float(np.median(0.5 * (pts[good, ax] + ref[j[good], ax])))
            if abs(c_new - c) < 1e-5 * size:
                c = c_new
                break
            c = c_new
        e = err(ax, c)
        if best is None or e < best[2]:
            best = (ax, float(c), e)
    if best is None:
        return None
    return best[0], best[1], 100.0 * best[2] / size


def _clip_half(V, F, ax, c):
    """Keep the side V[:, ax] >= c. Triangles crossing the plane are clipped,
    with one shared vertex per cut edge so the half stays welded."""
    s = V[:, ax] - c
    inside = s >= 0.0
    n_in = inside[F].sum(axis=1)
    keep = F[n_in == 3]
    cross = F[(n_in == 1) | (n_in == 2)]

    Vl = V.tolist()
    sl = s.tolist()
    cut = {}

    def mid(a, b):
        k = (a, b) if a < b else (b, a)
        idx = cut.get(k)
        if idx is None:
            t = sl[a] / (sl[a] - sl[b])
            p = [Vl[a][i] + (Vl[b][i] - Vl[a][i]) * t for i in range(3)]
            p[ax] = c
            idx = cut[k] = len(Vl)
            Vl.append(p)
        return idx

    out = []
    for f in cross.tolist():
        poly = []
        for k in range(3):
            a, b = f[k], f[(k + 1) % 3]
            if sl[a] >= 0.0:
                poly.append(a)
            if (sl[a] >= 0.0) != (sl[b] >= 0.0):
                poly.append(mid(a, b))
        for k in range(1, len(poly) - 1):
            out.append([poly[0], poly[k], poly[k + 1]])
    Fh = np.vstack([keep, np.asarray(out, np.int64).reshape(-1, 3)])
    return np.asarray(Vl, float), Fh


def fold(V, F, ax, c):
    """Replace the negative half of (V, F) with the mirror image of the positive half."""
    V = np.asarray(V, float).copy()
    F = np.asarray(F, np.int64)
    e = np.vstack([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    mean_edge = float(np.linalg.norm(V[e[:, 0]] - V[e[:, 1]], axis=1).mean())
    size = float(np.ptp(V, axis=0).max()) or 1.0

    # Snap only where the surface really crosses the plane (the vertex has a
    # neighbour on the other side). A surface that merely comes NEAR the plane -
    # inner thighs, the inside of a cape - must stay put: snapped, its mirror
    # image lands on the very same points and the two sides weld into edges
    # shared by four faces.
    s = V[:, ax] - c
    crosses = np.zeros(len(V), bool)
    flip = np.sign(s[e[:, 0]]) != np.sign(s[e[:, 1]])
    crosses[e[flip].ravel()] = True
    snap = crosses & (np.abs(s) < 0.35 * mean_edge)
    V0 = V.copy()

    # Every edge left lying in the plane must be the kept half's BORDER (one
    # face). A ridge whose two faces both sit on the kept side, snapped flat
    # onto the plane, would be doubled by the mirror into four faces; such
    # vertices are put back where they were and the half is cut again.
    for _ in range(8):
        V = V0.copy()
        V[snap, ax] = c
        Vh, Fh = _clip_half(V, F, ax, c)
        on_plane = np.abs(Vh[:, ax] - c) < 1e-6 * size
        Vh[on_plane, ax] = c
        # a face lying IN the plane would be duplicated by the mirror too
        Fh = Fh[~on_plane[Fh].all(axis=1)]
        if not len(Fh):
            return None
        he = np.sort(np.vstack([Fh[:, [0, 1]], Fh[:, [1, 2]], Fh[:, [2, 0]]]), axis=1)
        u, cnt = np.unique(he, axis=0, return_counts=True)
        bad = u[(cnt > 1) & on_plane[u].all(axis=1)].ravel()
        bad = bad[bad < len(V0)]            # cut vertices are never snapped ones
        bad = bad[snap[bad]]
        if not len(bad):
            break
        snap[bad] = False

    Vm = Vh.copy()
    Vm[:, ax] = 2.0 * c - Vm[:, ax]
    m = trimesh.Trimesh(np.vstack([Vh, Vm]),
                        np.vstack([Fh, Fh[:, ::-1] + len(Vh)]),   # reflection flips winding
                        process=False)
    m.merge_vertices()          # welds the seam: plane vertices coincide exactly
    m.update_faces(m.nondegenerate_faces())
    m.remove_unreferenced_vertices()
    return np.ascontiguousarray(m.vertices), np.ascontiguousarray(m.faces.astype(np.int64))


class _Fidelity:
    """Mean distance original -> result (detail lost) and result -> original
    (geometry that is not there), as % of the diagonal. One fixed sample of the
    original is reused so before/after differ only by the result."""

    def __init__(self, original, n=40000):
        self.diag = float(np.linalg.norm(original.extents)) or 1.0
        self.a, _ = trimesh.sample.sample_surface(original, n, seed=3)
        self.ta = cKDTree(self.a)
        self.n = n

    def __call__(self, V, F):
        m = trimesh.Trimesh(V, F, process=False)
        b, _ = trimesh.sample.sample_surface(m, self.n, seed=4)
        lost = float(cKDTree(b).query(self.a)[0].mean())
        extra = float(self.ta.query(b)[0].mean())
        return 100.0 * lost / self.diag, 100.0 * extra / self.diag


def apply(V, F, original, axis="auto", max_cost=10.0, seal=None):
    """Mirror (V, F) if the guard allows it. Returns (V, F, info).

    `seal(V, F) -> (V, F)` re-closes the result after the fold (the caller's
    finalize step); the seam weld alone leaves a few meshes open where a thin
    part straddles the plane.
    """
    info = {"requested": axis, "applied": False}
    plane = find_plane(original, axis)
    if plane is None:
        info["reason"] = "no usable mirror axis (the mesh is flat along it)"
        return V, F, info
    ax, c, err = plane
    info.update(axis="xyz"[ax], offset=c, plane_error_pct=round(err, 3))

    folded = fold(V, F, ax, c)
    if folded is None:
        info["reason"] = "nothing on the kept side of the plane"
        return V, F, info
    Vf, Ff = folded
    if seal is not None:
        Vf, Ff = seal(Vf, Ff)

    fid = _Fidelity(original)
    lost0, extra0 = fid(V, F)
    lost1, extra1 = fid(Vf, Ff)
    cost = max(100.0 * (lost1 - lost0) / max(lost0, 1e-12),
               100.0 * (extra1 - extra0) / max(extra0, 1e-12))
    info.update(cost_pct=round(cost, 1), max_cost_pct=float(max_cost),
                faces_before=int(len(F)), faces_after=int(len(Ff)))
    if cost > max_cost:
        info["reason"] = (f"mirroring across {'XYZ'[ax]} would cost {cost:.1f}% detail "
                          f"(limit {max_cost:g}%) - the model is not symmetric enough")
        return V, F, info
    info["applied"] = True
    return Vf, Ff, info
