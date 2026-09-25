import math
import numpy as np
from lp3d import Face


def hard_hat(N=10, lats=(0, 34, 64), rx=1.0, ry=0.92, rz=1.12, rib=True):
    """Hard hat: faceted dome, raised centre rib, narrow brim with a long front peak (front = +z)."""
    faces = []

    def dome(lat, lon, lift=0.0):
        la, lo = math.radians(lat), math.radians(lon)
        return np.array([(rx + lift) * math.cos(la) * math.sin(lo),
                         (ry + lift) * math.sin(la),
                         (rz + lift) * math.cos(la) * math.cos(lo)])

    lons = [360 * i / N for i in range(N)]
    rings = [[dome(la, lo) for lo in lons] for la in lats]
    for r in range(len(lats) - 1):
        for i in range(N):
            j = (i + 1) % N
            faces.append(Face([rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]]))
    top = np.array([0, ry * 1.0, 0])
    for i in range(N):
        j = (i + 1) % N
        faces.append(Face([rings[-1][i], rings[-1][j], top]))

    # brim: inner = dome base, outer pushed out, much further at the front
    def outer(lo, drop=0.0):
        c = math.cos(math.radians(lo))
        d = 0.10 + 0.55 * max(0.0, c) ** 3
        b = dome(0, lo)
        dirv = np.array([b[0], 0, b[2]])
        dirv /= np.linalg.norm(dirv)
        p = b + dirv * d
        p[1] = -0.10 * max(0.0, c) ** 2 - drop
        return p

    th = 0.07
    for i in range(N):
        j = (i + 1) % N
        a, b = lons[i], lons[j]
        faces.append(Face([rings[0][j], rings[0][i], outer(a), outer(b)], shade=-0.08))
        faces.append(Face([outer(a), outer(a, th), outer(b, th), outer(b)], shade=-0.25))

    if rib:
        # raised rib along the front-back meridian
        w, h, K = 0.19, 0.09, 8
        ts = [-78 + 156 * k / K for k in range(K + 1)]

        def rp(t, x, lift):
            tt = math.radians(t)
            y = (ry + lift) * math.cos(tt)
            z = (rz + lift) * math.sin(tt)
            # keep the rib on the dome surface for this x offset
            sc = math.sqrt(max(0.0, 1 - (x / rx) ** 2))
            return np.array([x, y * sc, z * sc])

        for k in range(K):
            t0, t1 = ts[k], ts[k + 1]
            c = rp((t0 + t1) / 2, 0, h / 2)
            faces.append(Face([rp(t0, -w, h), rp(t0, w, h), rp(t1, w, h), rp(t1, -w, h)], layer=1, shade=0.06, inside=c))
            faces.append(Face([rp(t0, -w, 0), rp(t0, -w, h), rp(t1, -w, h), rp(t1, -w, 0)], layer=1, inside=c))
            faces.append(Face([rp(t0, w, h), rp(t0, w, 0), rp(t1, w, 0), rp(t1, w, h)], layer=1, inside=c))
        # rib ends
        for t, t2 in ((ts[0], ts[1]), (ts[-1], ts[-2])):
            faces.append(Face([rp(t, -w, 0), rp(t, w, 0), rp(t, w, h), rp(t, -w, h)], layer=1, inside=rp(t2, 0, h / 2)))
    return faces
