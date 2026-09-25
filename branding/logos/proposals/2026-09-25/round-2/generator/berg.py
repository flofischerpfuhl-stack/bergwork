"""berg:work mark alternatives."""
import math
import random
import numpy as np
from lp3d import Face, render, rot_x, rot_y, GR_RAMP

G = {"g0": "#F4F3F0", "g1": "#E3E2DE", "g2": "#CDCBC6", "g3": "#B2B0AB", "g4": "#96948F",
     "g5": "#7A7874", "g6": "#5F5D5A", "g7": "#474644", "g8": "#31302F", "g9": "#1D1D1C", "red": "#C81E1E"}


def xf(pts, deg, tx, ty):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [(round(tx + x * c - y * s, 1), round(ty + x * s + y * c, 1)) for x, y in pts]


def hammer_and_pick(accent=None):
    """Schlägel und Eisen: the German mining emblem, as two faceted tools."""
    out = []

    def handle(deg, lit, shade):
        return [(G[lit], xf([(-7, 96), (0, 100), (0, -52), (-7, -52)], deg, 120, 146)),
                (G[shade], xf([(0, 100), (7, 96), (7, -52), (0, -52)], deg, 120, 146))]

    # Eisen (pointed iron), head top-right
    d = 45
    out += handle(d, "g5", "g7")
    out += [
        (G["g1"], xf([(-24, -90), (24, -90), (70, -70), (-24, -70)], d, 120, 146)),
        (G["g4"], xf([(-24, -70), (70, -70), (24, -50), (-24, -50)], d, 120, 146)),
        (G["g2"], xf([(-30, -84), (-24, -90), (-24, -50), (-30, -56)], d, 120, 146)),
    ]
    # Schlägel (hammer), head top-left, handle on top
    d = -45
    out += handle(d, "g4", "g6")
    out += [
        (G["g0"], xf([(-40, -94), (40, -94), (46, -86), (-46, -86)], d, 120, 146)),
        (G["g2"], xf([(-46, -86), (46, -86), (-46, -58)], d, 120, 146)),
        (G["g3"], xf([(46, -86), (46, -58), (-46, -58)], d, 120, 146)),
        (G["g5"], xf([(-46, -58), (46, -58), (40, -50), (-40, -50)], d, 120, 146)),
    ]
    if accent:
        out.append((accent, xf([(-7, 100), (7, 96), (7, 82), (-7, 86)], -45, 120, 146)))
    return out


def mine_cart(accent=None):
    """Lore: faceted ore heap in a tapered tub on two wheels and a rail."""
    out = [
        # rail
        (G["g6"], [(20, 214), (236, 214), (236, 222), (20, 222)]),
        (G["g4"], [(20, 214), (236, 214), (232, 210), (24, 210)]),
    ]
    # ore heap (behind the rim)
    A, B, C, D, E, F = (48, 112), (78, 80), (110, 66), (146, 54), (184, 76), (208, 112)
    M1, M2 = (112, 100), (160, 96)
    out += [
        (G["g1"], [A, B, M1]), (G["g0"], [B, C, M1]), (G["g2"], [C, D, M1]),
        (accent or G["g3"], [D, M2, M1]), (G["g4"], [D, E, M2]), (G["g5"], [E, F, M2]),
        (G["g3"], [A, M1, (128, 112)]), (G["g5"], [M1, M2, (128, 112)]), (G["g6"], [M2, F, (128, 112)]),
    ]
    # tub: rim band, then three panels
    out += [
        (G["g1"], [(34, 106), (222, 106), (218, 120), (38, 120)]),
        (G["g3"], [(38, 120), (92, 120), (100, 186), (62, 186)]),
        (G["g4"], [(92, 120), (164, 120), (156, 186), (100, 186)]),
        (G["g6"], [(164, 120), (218, 120), (194, 186), (156, 186)]),
    ]
    # wheels: octagons with a hub
    for cx in (88, 168):
        ring = [(round(cx + 22 * math.cos(math.radians(22.5 + 45 * i)), 1), round(192 + 22 * math.sin(math.radians(22.5 + 45 * i)), 1)) for i in range(8)]
        out.append((G["g8"], ring))
        out.append((G["g7"], [ring[4], ring[5], ring[6], ring[7], (cx, 192)]))
        hub = [(round(cx + 7 * math.cos(math.radians(22.5 + 45 * i)), 1), round(192 + 7 * math.sin(math.radians(22.5 + 45 * i)), 1)) for i in range(8)]
        out.append((G["g3"], hub))
    return out


def terrain_block(accent=None):
    """Terrain tile cut from the mountain: faceted surface, strata on the cut faces, an adit in front."""
    H = np.array([
        [0.50, 0.90, 1.10, 0.80, 0.45],
        [0.45, 1.00, 1.45, 1.05, 0.50],
        [0.30, 0.70, 0.95, 0.75, 0.35],
        [0.20, 0.35, 0.50, 0.45, 0.25],
        [0.12, 0.18, 0.25, 0.20, 0.12],
    ])
    n = H.shape[0]
    xs = np.linspace(-1, 1, n)
    zs = np.linspace(-1, 1, n)
    P = lambda i, j: np.array([xs[j], H[i, j], zs[i]])
    faces = []
    for i in range(n - 1):
        for j in range(n - 1):
            a, b, c, d = P(i, j), P(i, j + 1), P(i + 1, j + 1), P(i + 1, j)
            if (i + j) % 2:
                faces += [Face([a, d, b], inside=(0, -5, 0)), Face([b, d, c], inside=(0, -5, 0))]
            else:
                faces += [Face([a, d, c], inside=(0, -5, 0)), Face([a, c, b], inside=(0, -5, 0))]
    base, layers = -0.55, [-0.55, -0.36, -0.18]
    shades = [-0.2, -0.08, 0.04]

    def side(edge_pts, outward, extra=0.0):
        fs = []
        for k in range(len(edge_pts) - 1):
            p0, p1 = edge_pts[k], edge_pts[k + 1]
            for L in range(len(layers)):
                y0 = layers[L]
                y1 = layers[L + 1] if L + 1 < len(layers) else None
                if y1 is None:
                    q = [np.array([p0[0], y0, p0[2]]), np.array([p1[0], y0, p1[2]]), p1, p0]
                else:
                    q = [np.array([p0[0], y0, p0[2]]), np.array([p1[0], y0, p1[2]]),
                         np.array([p1[0], y1, p1[2]]), np.array([p0[0], y1, p0[2]])]
                c = np.mean(q, axis=0) - np.array(outward)
                fs.append(Face(q, shade=shades[L] + extra, inside=c))
        return fs

    faces += side([P(n - 1, j) for j in range(n)], (0, 0, 1), -0.12)      # front
    faces += side([P(i, 0) for i in range(n)], (-1, 0, 0))          # left
    faces += side([P(i, n - 1) for i in range(n)], (1, 0, 0), 0.5)       # right
    faces += side([P(0, j) for j in range(n)], (0, 0, -1))          # back
    # adit on the front face
    z = 1.001
    fo = [(-0.26, -0.55), (-0.26, -0.2), (-0.05, -0.04), (0.16, -0.2), (0.16, -0.55)]
    fi = [(-0.17, -0.55), (-0.17, -0.24), (-0.05, -0.14), (0.07, -0.24), (0.07, -0.55)]
    V = lambda p: np.array([p[0], p[1], z])
    for k, sh in zip(range(4), [0.1, 0.25, 0.0, -0.2]):
        faces.append(Face([V(fo[k]), V(fo[k + 1]), V(fi[k + 1]), V(fi[k])], layer=1, shade=sh, inside=(0, 0, 0)))
    faces.append(Face([V(p) for p in fi], layer=2, color=accent or G["g9"], inside=(0, 0, 0)))
    R = rot_x(20) @ rot_y(-24)
    return render(faces, R, GR_RAMP, lo=-0.3, hi=1.25, margin=22)


def rock(seed, n_sub=0, r=1.0):
    """A boulder: icosahedron with radially jittered vertices."""
    t = (1 + 5 ** 0.5) / 2
    V = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
         (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    F = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
         (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    rnd = random.Random(seed)
    V = [np.array(v) / np.linalg.norm(v) * r * rnd.uniform(0.82, 1.1) for v in V]
    V = [v * np.array([1.15, 0.85, 1.0]) for v in V]
    return [Face([V[a], V[b], V[c]], inside=(0, 0, 0)) for a, b, c in F]


def colon_rocks(accent=None):
    """The colon of berg:work as two stacked boulders."""
    R = rot_x(18) @ rot_y(-20)
    top = [Face(f.pts + np.array([0, 1.25, 0]), inside=(0, 1.25, 0)) for f in rock(7, r=0.78)]
    bot = [Face(f.pts + np.array([0, -1.05, 0]), inside=(0, -1.05, 0)) for f in rock(3, r=0.92)]
    if accent:
        for f in top:
            f.color = None
    a = render(top, R, GR_RAMP, lo=-0.4, hi=1.3, box=(-2, 2, -2.1, 2.1))
    b = render(bot, R, GR_RAMP, lo=-0.4, hi=1.3, box=(-2, 2, -2.1, 2.1))
    return a + b
