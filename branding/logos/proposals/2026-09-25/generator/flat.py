"""Flat low-poly marks: hard hat, world globe, Schlägel und Eisen."""
import json
import math
import os
import numpy as np
from matplotlib.path import Path
from scipy.spatial import Delaunay

HERE = os.path.dirname(os.path.abspath(__file__))


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


# ---------------------------------------------------------------------------
# Himmel:CAD Builder and WeltView, reduced facets
# ---------------------------------------------------------------------------
def hard_hat_min(c, dy=4):
    """Front view in 12 facets: four per dome half, a two-tone ridge, a two-tone brim."""
    A0, A1, K0, K1, K2 = (42, 170), (50, 110), (104, 62), (128, 58), (108, 170)
    B1 = (80, 128)
    mx = lambda p: (256 - p[0], p[1])
    left = [("l2", [A0, A1, B1]), ("w2", [A1, K0, B1]), ("l1", [B1, K0, K2]), ("m1", [A0, B1, K2])]
    right = [("m1", [A0, A1, B1]), ("l2", [A1, K0, B1]), ("l3", [B1, K0, K2]), ("m3", [A0, B1, K2])]
    ridge = [("w0", [K0, K1, (128, 170), K2]), ("w3", [K1, mx(K0), mx(K2), (128, 170)])]
    brim = [("m2", [(12, 170), (244, 170), (232, 184), (24, 184)]),
            ("d2", [(24, 184), (232, 184), (226, 194), (30, 194)])]
    P = left + [(k, [mx(p) for p in pts]) for k, pts in right] + ridge + brim
    return [(c[k], [(x, y + dy) for x, y in pts]) for k, pts in P]


def globe_poly(c, lon0=-10.0, lat0=30.0, R=108, n_rim=12, eps=11.0, min_area=260, grid=40):
    LV = np.array([-0.55, -0.62, 0.56])
    LV = LV / np.linalg.norm(LV)
    """Coarse ocean fan + continents as simplified polygons, each fanned into a few facets."""
    lam0, phi0 = math.radians(lon0), math.radians(lat0)
    cx = cy = 128.0
    rmax = math.cos(math.pi / n_rim)

    def proj(lo, la):
        lam, phi = math.radians(lo), math.radians(la)
        cosc = math.sin(phi0) * math.sin(phi) + math.cos(phi0) * math.cos(phi) * math.cos(lam - lam0)
        x = math.cos(phi) * math.sin(lam - lam0)
        y = math.cos(phi0) * math.sin(phi) - math.sin(phi0) * math.cos(phi) * math.cos(lam - lam0)
        ln = math.hypot(x, y) or 1
        if cosc < 0 or ln > rmax:
            x, y = x / ln * rmax, y / ln * rmax
        return (cx + R * x, cy - R * y), cosc

    rim_ang = [2 * math.pi * i / n_rim - math.pi / 2 for i in range(n_rim)]

    def at(ang):
        return (cx + R * rmax * math.cos(ang), cy + R * rmax * math.sin(ang))

    def clip(ring):
        """Clip a lon/lat ring to the visible hemisphere; hidden stretches follow the rim."""
        vals = [(lo, la, proj(lo, la)[1]) for lo, la in ring]
        out_pts, exit_ang = [], None
        n = len(vals)
        start = next((i for i, v in enumerate(vals) if v[2] >= 0), None)
        if start is None:
            return []
        for k in range(n):
            lo0, la0, c0 = vals[(start + k) % n]
            lo1, la1, c1 = vals[(start + k + 1) % n]
            if c0 >= 0:
                out_pts.append(proj(lo0, la0)[0])
            if (c0 >= 0) != (c1 >= 0):
                t = c0 / (c0 - c1)
                p = proj(lo0 + (lo1 - lo0) * t, la0 + (la1 - la0) * t)[0]
                ang = math.atan2(p[1] - cy, p[0] - cx)
                if c0 >= 0:
                    exit_ang = ang
                    out_pts.append(at(ang))
                else:
                    # walk the rim the short way from exit to entry
                    if exit_ang is not None:
                        dlt = (ang - exit_ang + math.pi) % (2 * math.pi) - math.pi
                        steps = [ra for ra in rim_ang if 0 < ((ra - exit_ang) % (2 * math.pi) if dlt > 0 else (exit_ang - ra) % (2 * math.pi)) < abs(dlt)]
                        steps.sort(key=lambda ra: ((ra - exit_ang) % (2 * math.pi)) if dlt > 0 else ((exit_ang - ra) % (2 * math.pi)))
                        out_pts += [at(ra) for ra in steps]
                    out_pts.append(at(ang))
        return out_pts

    out = []
    rim = [(cx + R * math.cos(ra), cy + R * math.sin(ra)) for ra in rim_ang]
    out += fan((cx - 10, cy - 12), [(round(x, 1), round(y, 1)) for x, y in rim], [c[k] for k in ("d2", "d1", "m3", "m2", "m1")])
    d = json.load(open(os.path.join(HERE, "ne_110m_land.geojson")))
    land_tones = [c[k] for k in ("l1", "w3", "w2", "w1", "w0")]
    for f in d["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            cl = clip(poly[0])
            if len(cl) < 3:
                continue
            sp = _rdp(cl + [cl[0]], eps)
            if sp[0] == sp[-1]:
                sp = sp[:-1]
            sp = [(round(x, 1), round(y, 1)) for x, y in sp]
            if len(sp) < 3 or abs(_area(sp)) < min_area:
                continue
            path = Path(np.array(sp + [sp[0]]))
            # a sparse hex grid of interior points keeps the land facets chunky
            pts = list(sp)
            xs, ys = [p[0] for p in sp], [p[1] for p in sp]
            gy, row = min(ys) + grid / 2, 0
            while gy < max(ys):
                gx = min(xs) + (grid / 2 if row % 2 else grid / 4)
                while gx < max(xs):
                    if path.contains_point((gx, gy)) and min(math.hypot(gx - p[0], gy - p[1]) for p in sp) > grid * 0.5:
                        pts.append((round(gx, 1), round(gy, 1)))
                    gx += grid
                gy += grid * 0.87
                row += 1
            P2 = np.array(pts)
            for s3 in Delaunay(P2).simplices:
                t = [(float(P2[k][0]), float(P2[k][1])) for k in s3]
                tm = np.mean(t, axis=0)
                if not path.contains_point(tuple(tm)):
                    continue
                nx, ny = (tm[0] - cx) / R, (tm[1] - cy) / R
                nz = math.sqrt(max(0.0, 1 - nx * nx - ny * ny))
                v = max(0.0, nx * LV[0] + ny * LV[1] + nz * LV[2]) + 0.05
                out.append((land_tones[min(len(land_tones) - 1, int(v * len(land_tones)))], t))
    return out
