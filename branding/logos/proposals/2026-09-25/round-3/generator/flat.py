"""Flat low-poly marks: hard hat profile, world globe, Schlägel und Eisen."""
import json
import math
import os
import numpy as np
from matplotlib.path import Path
from scipy.spatial import Delaunay

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------
# Himmel:CAD Builder — hard hat in side profile, visor to the left
# ---------------------------------------------------------------------------
def hard_hat_profile(c, dy=8):
    """Side profile, peak to the left, ridge over the crown."""
    F0, F1, F2, F3, F4 = (60, 160), (62, 126), (80, 92), (110, 70), (148, 62)
    F5, F6, F7, F8 = (186, 70), (212, 96), (224, 130), (226, 160)
    I1, I2, I3 = (106, 128), (162, 112), (196, 136)
    B1, B2 = (122, 160), (182, 160)
    R2, R3, R4, R5, R6 = (70, 86), (104, 58), (148, 48), (192, 57), (222, 90)
    # peak: slopes forward and down, then a short brim to the back
    V0, V1 = (8, 184), (234, 166)
    E0, E1, E2 = (12, 194), (236, 174), (60, 172)
    P = [
        ("l3", [V0, F0, E2]), ("l2", [F0, F8, V1, E2]),
        ("d1", [V0, E2, E0]), ("d2", [E2, V1, E1, (60, 182), E0]),
        ("l2", [F0, F1, I1]), ("w3", [F1, F2, I1]), ("w1", [F2, F3, I1]),
        ("w2", [F3, I2, I1]), ("w0", [F3, F4, I2]), ("w3", [F4, F5, I2]),
        ("l1", [F5, F6, I2]), ("l3", [F6, I3, I2]), ("m1", [F6, F7, I3]), ("m3", [F7, F8, I3]),
        ("m1", [F0, I1, B1]), ("l3", [I1, I2, B1]), ("m2", [I2, B2, B1]),
        ("m1", [I2, I3, B2]), ("d1", [I3, F8, B2]),
        ("m1", [F2, R2, R3, F3]), ("l3", [F3, R3, R4, F4]), ("m2", [F4, R4, R5, F5]), ("m3", [F5, R5, R6, F6]),
    ]
    return [(c[k], [(x, y + dy) for x, y in pts]) for k, pts in P]


def hard_hat_front(c, dy=6):
    """Front view: round dome, raised centre ridge, straight brim bar."""
    A0, A1, A2, A3 = (38, 170), (46, 124), (70, 86), (104, 64)
    B0, B1 = (86, 170), (90, 118)
    K0, K1, K2 = (108, 62), (128, 52), (108, 170)
    mx = lambda p: (256 - p[0], p[1])
    L = [("l2", [A0, A1, B1]), ("m1", [A0, B1, B0]), ("w3", [A1, A2, B1]),
         ("w1", [A2, A3, B1]), ("w2", [A3, K0, B1]), ("l1", [B1, K0, K2]), ("l3", [B0, B1, K2])]
    Rt = [("m2", [A0, A1, B1]), ("d1", [A0, B1, B0]), ("l3", [A1, A2, B1]),
          ("l1", [A2, A3, B1]), ("w3", [A3, K0, B1]), ("l2", [B1, K0, K2]), ("m1", [B0, B1, K2])]
    ridge = [("w0", [K0, K1, (128, 170), K2]), ("w3", [K1, mx(K0), mx(K2), (128, 170)])]
    brim = [("l3", [(14, 170), (242, 170), (230, 182), (26, 182)]),
            ("d1", [(26, 182), (230, 182), (226, 192), (30, 192)])]
    brim = [("m1", [(14, 170), (128, 170), (128, 182), (26, 182)]), ("m2", [(128, 170), (242, 170), (230, 182), (128, 182)]),
            ("d1", [(26, 182), (128, 182), (128, 192), (30, 192)]), ("d2", [(128, 182), (230, 182), (226, 192), (128, 192)])]
    P = L + [(k, [mx(p) for p in pts]) for k, pts in Rt] + ridge + brim
    return [(c[k], [(x, y + dy) for x, y in pts]) for k, pts in P]


# ---------------------------------------------------------------------------
# Himmel:CAD WeltView — low-poly globe with the real continents
# ---------------------------------------------------------------------------
def _land_paths():
    d = json.load(open(os.path.join(HERE, "ne_110m_land.geojson")))
    paths = []
    for f in d["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for p in polys:
            paths.append(Path(np.array(p[0])))
    return paths


def _rdp(pts, eps):
    if len(pts) < 3:
        return pts
    a, b = np.array(pts[0]), np.array(pts[-1])
    ab = b - a
    ln = np.linalg.norm(ab)
    best, idx = 0.0, 0
    for i in range(1, len(pts) - 1):
        p = np.array(pts[i])
        d = abs(ab[0] * (a[1] - p[1]) - ab[1] * (a[0] - p[0])) / ln if ln else np.linalg.norm(p - a)
        if d > best:
            best, idx = d, i
    if best > eps:
        return _rdp(pts[:idx + 1], eps)[:-1] + _rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def _area(p):
    return 0.5 * sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))


def _ear_clip(poly):
    """Triangulate a simple polygon (counter-clockwise in y-down screen = negative area)."""
    pts = list(poly)
    if _area(pts) > 0:
        pts = pts[::-1]
    tris = []

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    guard = 0
    while len(pts) > 3 and guard < 5000:
        guard += 1
        n = len(pts)
        for i in range(n):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % n]
            if cross(a, b, c) >= 0:
                continue
            if any(cross(a, b, p) <= 0 and cross(b, c, p) <= 0 and cross(c, a, p) <= 0
                   for p in pts if p not in (a, b, c)):
                continue
            tris.append([a, b, c])
            del pts[i]
            break
        else:
            break
    if len(pts) == 3:
        tris.append(pts)
    return tris


def globe(c, lon0=12.0, lat0=24.0, R=108, n_rim=16, eps=6.0, min_area=90, grid=26):
    lam0, phi0 = math.radians(lon0), math.radians(lat0)
    cx = cy = 128.0
    L = np.array([-0.55, -0.62, 0.56])
    L /= np.linalg.norm(L)

    def proj(lo, la):
        lam, phi = math.radians(lo), math.radians(la)
        cosc = math.sin(phi0) * math.sin(phi) + math.cos(phi0) * math.cos(phi) * math.cos(lam - lam0)
        x = math.cos(phi) * math.sin(lam - lam0)
        y = math.cos(phi0) * math.sin(phi) - math.sin(phi0) * math.cos(phi) * math.cos(lam - lam0)
        # keep land inside the ocean polygon: pin to its inscribed circle
        ln = math.hypot(x, y) or 1
        rmax = math.cos(math.pi / n_rim)
        if cosc < 0 or ln > rmax:
            x, y = x / ln * rmax, y / ln * rmax
        return (cx + R * x, cy - R * y), cosc

    def tone(m, ramp, lift=0.0):
        nx, ny = (m[0] - cx) / R, (m[1] - cy) / R
        nz = math.sqrt(max(0.0, 1 - nx * nx - ny * ny))
        v = max(0.0, nx * L[0] + ny * L[1] + nz * L[2]) + lift
        return c[ramp[min(len(ramp) - 1, int(max(v, 0) * len(ramp)))]]

    out = []
    # ocean: rim polygon split into a coarse fan around an off-centre point
    rim = [(cx + R * math.cos(2 * math.pi * i / n_rim - math.pi / 2), cy + R * math.sin(2 * math.pi * i / n_rim - math.pi / 2)) for i in range(n_rim)]
    inner = [(cx + 0.52 * R * math.cos(2 * math.pi * (i + 0.5) / 7 - math.pi / 2), cy + 0.52 * R * math.sin(2 * math.pi * (i + 0.5) / 7 - math.pi / 2)) for i in range(7)]
    P = np.array(rim + inner + [(cx - 6, cy - 8)])
    for s in Delaunay(P).simplices:
        q = [tuple(map(float, P[k])) for k in s]
        m = np.mean(q, axis=0)
        out.append((tone(m, ["d2", "d1", "m3", "m2", "m1", "l3"]), [(round(x, 1), round(y, 1)) for x, y in q]))
    # land
    d = json.load(open(os.path.join(HERE, "ne_110m_land.geojson")))
    for f in d["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            ring = poly[0]
            pr = [proj(lo, la) for lo, la in ring]
            if max(cc for _, cc in pr) < 0.05:
                continue
            sp = [p for p, _ in pr]
            sp = _rdp(sp, eps)
            if sp[0] == sp[-1]:
                sp = sp[:-1]
            if len(sp) < 3 or abs(_area(sp)) < min_area:
                continue
            path = Path(np.array(sp + [sp[0]]))
            pts = list(sp)
            # a few interior points keep the facets chunky instead of splintered
            xs, ys = [p[0] for p in sp], [p[1] for p in sp]
            gy = min(ys) + grid / 2
            row = 0
            while gy < max(ys):
                gx = min(xs) + (grid / 2 if row % 2 else grid / 4)
                while gx < max(xs):
                    if path.contains_point((gx, gy)) and min(math.hypot(gx - p[0], gy - p[1]) for p in sp) > grid * 0.45:
                        pts.append((gx, gy))
                    gx += grid
                gy += grid * 0.87
                row += 1
            P2 = np.array(pts)
            if len(P2) < 3:
                continue
            for s3 in Delaunay(P2).simplices:
                t = [(round(float(P2[k][0]), 1), round(float(P2[k][1]), 1)) for k in s3]
                m = np.mean(t, axis=0)
                if not path.contains_point(tuple(m)):
                    continue
                out.append((tone(m, ["l1", "w3", "w2", "w1", "w0"], 0.05), t))
    return out


# ---------------------------------------------------------------------------
# berg:work — Schlägel und Eisen, faceted
# ---------------------------------------------------------------------------
LIGHT2 = np.array([-0.6, -0.8])


def xf(pts, deg, tx, ty):
    co, si = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [(round(tx + x * co - y * si, 1), round(ty + x * si + y * co, 1)) for x, y in pts]


def fan(center, ring, tones, bias=0.0):
    """Split a convex outline into a fan around `center`; each facet takes a tone from its lean to the light."""
    out = []
    cx, cy = center
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        mx, my = (a[0] + b[0] + cx) / 3 - cx, (a[1] + b[1] + cy) / 3 - cy
        ln = math.hypot(mx, my) or 1
        v = 0.5 + 0.5 * (mx * LIGHT2[0] + my * LIGHT2[1]) / ln + bias
        v = min(max(v, 0), 0.999)
        out.append((tones[int(v * len(tones))], [a, b, center]))
    return out


def hammer_and_pick(G, cx=126, cy=140):
    iron = [G[k] for k in ("g6", "g5", "g4", "g3", "g2", "g1", "g0")]
    out = []

    def handle(deg, lit, mid, dark):
        a, b, cc, d, m0, m1 = (-10, 108), (10, 108), (10, -52), (-10, -52), (0, 108), (0, -52)
        return [(G[lit], xf([a, m0, d], deg, cx, cy)), (G[mid], xf([m0, m1, d], deg, cx, cy)),
                (G[mid], xf([m0, b, m1], deg, cx, cy)), (G[dark], xf([b, cc, m1], deg, cx, cy))]

    # Eisen: pointed iron, head top-right
    d = 45
    out += handle(d, "g5", "g6", "g7")
    ring = xf([(-28, -98), (30, -98), (84, -74), (30, -48), (-28, -48)], d, cx, cy)
    out += fan(xf([(0, -76)], d, cx, cy)[0], ring, iron)
    # Schlägel: hammer, head top-left, on top
    d = -45
    out += handle(d, "g4", "g5", "g6")
    ring = xf([(-50, -102), (0, -104), (50, -102), (50, -48), (0, -46), (-50, -48)], d, cx, cy)
    out += fan(xf([(0, -75)], d, cx, cy)[0], ring, iron, bias=0.05)
    return out
