import math
import numpy as np
from lp3d import Face


def uv_globe(lats=(-90, -54, -18, 18, 54, 90), N=10):
    """Globe: latitude bands x meridians, so the facets draw the graticule."""
    def p(la, lo):
        la, lo = math.radians(la), math.radians(lo)
        return np.array([math.cos(la) * math.sin(lo), math.sin(la), math.cos(la) * math.cos(lo)])
    lons = [360 * i / N for i in range(N)]
    faces = []
    for a, b in zip(lats[:-1], lats[1:]):
        for i in range(N):
            lo0, lo1 = lons[i], lons[(i + 1) % N]
            pts = [p(a, lo0), p(a, lo1), p(b, lo1), p(b, lo0)]
            # collapse pole quads to triangles
            uniq = []
            for q in pts:
                if not any(np.allclose(q, u) for u in uniq):
                    uniq.append(q)
            faces.append(Face(uniq, inside=(0, 0, 0)))
    return faces


def ring(r0=1.28, r1=1.46, N=16, tilt=0):
    """Flat orbit ring (two-sided) around the globe."""
    faces = []
    for i in range(N):
        a0, a1 = 2 * math.pi * i / N, 2 * math.pi * (i + 1) / N
        q = [np.array([r0 * math.cos(a0), 0, r0 * math.sin(a0)]), np.array([r1 * math.cos(a0), 0, r1 * math.sin(a0)]),
             np.array([r1 * math.cos(a1), 0, r1 * math.sin(a1)]), np.array([r0 * math.cos(a1), 0, r0 * math.sin(a1)])]
        faces.append(Face(q))
        faces.append(Face(q[::-1]))
    return faces


def land_globe(lats=(-90, -60, -30, 0, 30, 60, 90), N=12, land=None):
    """Globe whose facets inside `land(lat, lon)` are lifted a few shades (blocky continents)."""
    faces = uv_globe(lats, N)
    lons = [360 * i / N for i in range(N)]
    k = 0
    for a, b in zip(lats[:-1], lats[1:]):
        for i in range(N):
            lo = (lons[i] + 180 / N + 180) % 360 - 180
            if land and land((a + b) / 2, lo):
                faces[k].shade = 0.32
            k += 1
    return faces


def europe_africa(la, lo):
    return (-45 < la < 0 and 0 < lo < 45) or (0 <= la < 35 and -20 < lo < 45) or (30 <= la < 75 and -15 < lo < 75)
