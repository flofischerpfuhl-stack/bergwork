"""Light-background treatments for flat polygon logos.

- rim:  a narrow polygon strip, in a mid tone, along the silhouette edges of very light facets
- tone: the very light facets on the silhouette are swapped for a darker tone of the same ramp
"""
import math
import numpy as np
from matplotlib.path import Path


def luminance(hex_):
    r, g, b = (int(hex_[i:i + 2], 16) / 255 for i in (1, 3, 5))
    lin = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def _key(p):
    return (round(p[0], 1), round(p[1], 1))


def silhouette_edges(polys):
    """[(a, b, owner_index, outward_normal)] for every edge on the outer silhouette."""
    verts = {_key(p) for _, pts in polys for p in pts}
    paths = [Path(np.array(pts + [pts[0]])) for _, pts in polys]
    edges = []
    for idx, (_, pts) in enumerate(polys):
        n = len(pts)
        for i in range(n):
            a, b = np.array(pts[i], float), np.array(pts[(i + 1) % n], float)
            d = b - a
            L = np.linalg.norm(d)
            if L < 1e-6:
                continue
            # split at T-junctions so shared edges are recognised
            ts = [0.0, 1.0]
            for v in verts:
                w = np.array(v) - a
                t = np.dot(w, d) / L ** 2
                if 0.001 < t < 0.999 and np.linalg.norm(w - t * d) < 0.15:
                    ts.append(t)
            ts.sort()
            for t0, t1 in zip(ts[:-1], ts[1:]):
                edges.append((tuple(a + t0 * d), tuple(a + t1 * d), idx))
    count = {}
    for a, b, _ in edges:
        k = frozenset((_key(a), _key(b)))
        count[k] = count.get(k, 0) + 1
    out = []
    for a, b, idx in edges:
        if count[frozenset((_key(a), _key(b)))] != 1:
            continue
        a_, b_ = np.array(a), np.array(b)
        d = b_ - a_
        L = np.linalg.norm(d)
        if L < 0.5:
            continue
        nrm = np.array([d[1], -d[0]]) / L
        mid = (a_ + b_) / 2
        if paths[idx].contains_point(tuple(mid + nrm * 0.6)):
            nrm = -nrm
        probe = tuple(mid + nrm * 2.0)
        if any(p.contains_point(probe) for p in paths):
            continue  # an interior boundary, covered by another shape
        # orient every edge the same way round the outline: outward normal = (dy, -dx)
        if np.dot(nrm, [d[1] / L, -d[0] / L]) < 0:
            a_, b_ = b_, a_
        out.append((tuple(a_), tuple(b_), idx, nrm))
    return out


def rim(polys, color, width=5.0, threshold=0.55):
    edges = [e for e in silhouette_edges(polys) if luminance(polys[e[2]][0]) > threshold]
    by_start = {_key(e[0]): e for e in edges}
    by_end = {_key(e[1]) for e in edges}
    used, chains = set(), []
    starts = [e for e in edges if _key(e[0]) not in by_end] + edges
    for e in starts:
        if id(e) in used:
            continue
        chain = []
        cur = e
        while cur is not None and id(cur) not in used:
            used.add(id(cur))
            chain.append(cur)
            cur = by_start.get(_key(cur[1]))
        chains.append(chain)
    strips = []
    for chain in chains:
        pts = [np.array(chain[0][0])] + [np.array(e[1]) for e in chain]
        normals = [np.array(e[3]) for e in chain]
        closed = _key(chain[-1][1]) == _key(chain[0][0]) and len(chain) > 2
        off = []
        for i, p in enumerate(pts):
            ns = []
            if i > 0:
                ns.append(normals[i - 1])
            if i < len(normals):
                ns.append(normals[i])
            if closed and i in (0, len(pts) - 1):
                ns = [normals[-1], normals[0]]
            m = sum(ns)
            m = m / (np.linalg.norm(m) or 1)
            k = width / max(0.35, float(np.dot(m, ns[0])))
            off.append(p + m * k)
        ring = [tuple(np.round(p, 2)) for p in pts] + [tuple(np.round(p, 2)) for p in off[::-1]]
        strips.append((color, ring))
    return strips + polys


def tone(polys, ramp, steps=3, threshold=0.55):
    """ramp: colours ordered light -> dark."""
    owners = {e[2] for e in silhouette_edges(polys)}
    out = []
    for i, (col, pts) in enumerate(polys):
        if i in owners and luminance(col) > threshold and col in ramp:
            col = ramp[min(len(ramp) - 1, ramp.index(col) + steps)]
        out.append((col, pts))
    return out
