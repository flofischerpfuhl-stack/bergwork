"""Tiny flat-shaded low-poly renderer: mesh -> orthographic projection -> palette polygons."""
import math
import numpy as np

AZ_RAMP = ["#003F7A", "#0056A8", "#0076D8", "#0084E8", "#1597F2", "#3EACF5",
           "#55B8FF", "#92D5FF", "#BDE8FF", "#D8F3FF", "#E7F7FF", "#F8FDFF"]
GR_RAMP = ["#1D1D1C", "#31302F", "#474644", "#5F5D5A", "#7A7874", "#96948F",
           "#B2B0AB", "#CDCBC6", "#E3E2DE", "#F4F3F0"]

LIGHT = np.array([-0.55, 0.75, 0.45])
LIGHT = LIGHT / np.linalg.norm(LIGHT)


def rot_y(a):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_x(a):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_z(a):
    c, s = math.cos(math.radians(a)), math.sin(math.radians(a))
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


class Face:
    def __init__(self, pts, layer=0, color=None, shade=0.0, inside=None):
        self.pts = np.array(pts, dtype=float)
        if inside is not None:
            # orient the winding so the normal points away from `inside`
            if np.dot(normal(self.pts), self.pts.mean(axis=0) - np.array(inside, dtype=float)) < 0:
                self.pts = self.pts[::-1]
        self.layer = layer      # higher layers are always painted later
        self.color = color      # fixed colour overrides the lighting
        self.shade = shade      # added to the lighting value (-1..1)


def normal(p):
    n = np.zeros(3)
    for i in range(len(p)):
        a, b = p[i], p[(i + 1) % len(p)]
        n += np.cross(a, b)
    ln = np.linalg.norm(n)
    return n / ln if ln else n


def render(faces, R, ramp, size=256, margin=18, lo=0.0, hi=1.0, box=None, cull=True):
    """Return (list of (hex, [(x, y)...])) painted back to front, fitted into the frame."""
    items = []
    for f in faces:
        p = f.pts @ R.T
        n = normal(p)
        if cull and n[2] <= 1e-6:
            continue
        if f.color:
            col = f.color
        else:
            lam = float(np.dot(n, LIGHT))
            v = (lam - lo) / (hi - lo) + f.shade
            v = min(max(v, 0.0), 0.999)
            col = ramp[int(v * len(ramp))]
        items.append((f.layer, p[:, 2].mean(), col, p))
    items.sort(key=lambda t: (t[0], t[1]))
    allp = np.vstack([t[3] for t in items])
    if box is None:
        x0, x1 = allp[:, 0].min(), allp[:, 0].max()
        y0, y1 = allp[:, 1].min(), allp[:, 1].max()
    else:
        x0, x1, y0, y1 = box
    s = (size - 2 * margin) / max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    out = []
    for _, _, col, p in items:
        pts = [(round(size / 2 + (x - cx) * s, 1), round(size / 2 - (y - cy) * s, 1)) for x, y, _ in p]
        out.append((col, pts))
    return out
