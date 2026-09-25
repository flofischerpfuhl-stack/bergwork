#!/usr/bin/env python3
"""Low-poly logo proposals for Himmel:CAD and berg:work (2026-09-25)."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
os.makedirs(OUT, exist_ok=True)

# Azure Tech palette, taken 1:1 from himmelcad-builder-primary.svg
AZ = {
    "w0": "#F8FDFF", "w1": "#E7F7FF", "w2": "#D8F3FF", "w3": "#BDE8FF",
    "l1": "#92D5FF", "l2": "#55B8FF", "l3": "#3EACF5",
    "m1": "#1597F2", "m2": "#0084E8", "m3": "#0076D8",
    "d1": "#0056A8", "d2": "#003F7A",
}
# berg:work granite: neutral greys with a hair of warmth (sits next to the site's cream #f3f0e6)
GR = {
    "g0": "#F4F3F0", "g1": "#E3E2DE", "g2": "#CDCBC6", "g3": "#B2B0AB",
    "g4": "#96948F", "g5": "#7A7874", "g6": "#5F5D5A", "g7": "#474644",
    "g8": "#31302F", "g9": "#1D1D1C",
    "red": "#C81E1E",
}


def mx(p):
    return (256 - p[0], p[1])


def poly(fill, pts):
    s = " ".join(f"{x:g} {y:g}" for x, y in pts)
    return f'    <polygon fill="{fill}" points="{s}"/>'


def svg(title, gid, polys, tx=0, ty=0, outline=None, ow=9):
    polys = [p if isinstance(p, str) else poly(*p) for p in polys]
    body = "\n".join(polys)
    tr = f'\n    transform="translate({tx:g} {ty:g})"' if (tx or ty) else ""
    if outline:
        # the same shapes, stroked, behind the artwork: a dark rim that follows the silhouette
        rim = "\n".join(re.sub(r' fill="[^"]*"', "", p) for p in polys)
        body_rim = f"""  <g
    id="Outline"
    fill="{outline}"
    stroke="{outline}"
    stroke-width="{ow:g}"
    stroke-linejoin="round"{tr}
  >
{rim}
  </g>

"""
    else:
        body_rim = ""
    return f"""<svg
  width="256"
  height="256"
  viewBox="0 0 256 256"
  xmlns="http://www.w3.org/2000/svg"
>
  <title>{title}</title>

{body_rim}  <g
    id="{gid}"
    stroke="none"
    fill-rule="evenodd"{tr}
  >
{body}
  </g>
</svg>
"""


def write(name, content):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(content)


# ---------------------------------------------------------------------------
# Himmel:CAD PhotoLab — prism
# ---------------------------------------------------------------------------
def lerp(a, b, t):
    return (round(a[0] + (b[0] - a[0]) * t, 2), round(a[1] + (b[1] - a[1]) * t, 2))


def prism(c):
    """A: faceted prism; the light only shows as a band running through the glass."""
    T, L, R = (128, 30), (34, 206), (222, 206)
    C = (132, 152)                        # apex of the facet pyramid
    P = lerp(T, L, 0.54)                  # entry point on the left face
    Q = lerp(T, R, 0.62)                  # exit point on the right face
    X = lerp(T, C, 0.60)
    k = 7
    return [
        poly(c["w1"], [T, L, C]),
        poly(c["l2"], [T, C, R]),
        poly(c["m2"], [L, R, C]),
        poly(c["w0"], [P, (P[0] + 2, P[1] + k), (X[0], X[1] + k), X]),
        poly(c["w3"], [X, (X[0], X[1] + k), (Q[0] - 2, Q[1] + k), Q]),
    ]


def prism_crystal(c, fan):
    """B: the current PhotoLab idea, re-drawn as clean geometry: a cut crystal with a light band."""
    T = (128, 22)
    L, FL, FR, R = (50, 160), (104, 176), (170, 172), (208, 154)
    B = (126, 232)
    out = [
        poly(c["l1"], [T, L, FL]),
        poly(c["l3"], [T, FL, FR]),
        poly(c["m2"], [T, FR, R]),
        poly(c["w3"], [L, B, FL]),
        poly(c["m1"], [FL, B, FR]),
        poly(c["d1"], [FR, B, R]),
    ]
    # light band crossing the upper facets
    y = lambda p, q, t: lerp(p, q, t)
    a0, a1 = y(T, L, 0.70), y(T, L, 0.76)
    b0, b1 = y(T, FL, 0.66), y(T, FL, 0.72)
    c0, c1 = y(T, FR, 0.64), y(T, FR, 0.72)
    d0, d1 = y(T, R, 0.63), y(T, R, 0.73)
    out += [
        poly(c["w0"], [a0, b0, b1, a1]),
        poly(c["w2"], [b0, c0, c1, b1]),
        poly(c["w3"], [c0, d0, d1, c1]),
    ]
    return out


def aperture(c):
    """C: prism-faceted aperture — six blades around a bright hexagonal opening."""
    import math

    def pt(r, deg):
        return (128 + r * math.cos(math.radians(deg)), 128 + r * math.sin(math.radians(deg)))

    O = [pt(110, -90 + 60 * i) for i in range(6)]
    I = [pt(36, -90 + 60 * i + 12) for i in range(6)]

    def hit(p, d):
        # ray p + t*d against the outer hexagon; returns (point, edge index)
        best = None
        for k in range(6):
            a, b = O[k], O[(k + 1) % 6]
            ex, ey = b[0] - a[0], b[1] - a[1]
            den = d[0] * ey - d[1] * ex
            if abs(den) < 1e-9:
                continue
            t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den
            u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den
            if t > 0 and -1e-9 <= u <= 1 + 1e-9 and (best is None or t < best[0]):
                best = (t, k)
        t, k = best
        return (p[0] + t * d[0], p[1] + t * d[1]), k

    # line k runs along inner edge I[k] -> I[k+1]; extend it backwards past I[k] to the rim
    H = []
    for k in range(6):
        a, b = I[k], I[(k + 1) % 6]
        H.append(hit(a, (a[0] - b[0], a[1] - b[1])))
    r = lambda p: (round(p[0], 2), round(p[1], 2))
    # light from the top-left
    tones = [("l1", "w3"), ("l2", "l3"), ("m1", "m2"), ("d1", "d2"), ("m3", "d1"), ("w3", "l1")]
    out = []
    for k in range(6):
        (h0, e0), (h1, e1) = H[k], H[(k + 1) % 6]
        rim = []
        e = e0
        while e != e1:
            e = (e + 1) % 6
            rim.append(O[e])
        inner = I[(k + 1) % 6]
        blade = [h0] + rim + [h1, inner]
        a, b = tones[k]
        # split each blade along inner -> first rim corner for the low-poly grain
        if rim:
            out.append(poly(c[a], [r(p) for p in [h0] + rim[:1] + [inner]]))
            out.append(poly(c[b], [r(p) for p in rim[:1] + rim[1:] + [h1, inner]]))
        else:
            out.append(poly(c[a], [r(p) for p in blade]))
    out.append(poly(c["w0"], [r(p) for p in I]))
    return out


# ---------------------------------------------------------------------------
# berg:work — granite
# ---------------------------------------------------------------------------
def mountain(c, accent=None):
    """Brand mark: faceted peak with a mine adit at its foot."""
    L0, L1, L2, S, T = (16, 206), (50, 146), (78, 108), (96, 124), (136, 40)
    R1, R2, R3, R0 = (168, 90), (186, 106), (214, 150), (240, 206)
    M1, M2, M3, M4, M5, M6 = (120, 106), (150, 122), (104, 162), (170, 160), (64, 176), (206, 178)
    out = [
        # snow / upper faces
        poly(c["g0"], [T, M1, S]),
        poly(c["g1"], [T, M2, M1]),
        poly(c["g3"], [T, R1, M2]),
        poly(c["g4"], [R1, R2, M2]),
        # left sub-peak
        poly(c["g1"], [L2, S, M5]),
        poly(c["g2"], [L1, L2, M5]),
        poly(c["g3"], [L0, L1, M5]),
        # middle band
        poly(c["g2"], [S, M1, M3]),
        poly(c["g3"], [M1, M2, M3]),
        poly(c["g5"], [M2, M4, M3]),
        poly(c["g5"], [M2, R2, M4]),
        poly(c["g6"], [R2, R3, M4]),
        poly(c["g2"], [S, M3, M5]),
        # foot
        poly(c["g4"], [L0, M5, (84, 206)]),
        poly(c["g3"], [M5, M3, (84, 206)]),
        poly(c["g5"], [M3, (128, 206), (84, 206)]),
        poly(c["g6"], [M3, M4, (128, 206)]),
        poly(c["g7"], [M4, (184, 206), (128, 206)]),
        poly(c["g7"], [M4, M6, (184, 206)]),
        poly(c["g7"], [M4, R3, M6]),
        poly(c["g8"], [R3, R0, M6]),
        poly(c["g8"], [M6, R0, (184, 206)]),
    ]
    # adit: timber frame + dark opening
    fo = [(106, 206), (106, 170), (128, 156), (150, 170), (150, 206)]
    fi = [(115, 206), (115, 175), (128, 167), (141, 175), (141, 206)]
    out += [
        poly(c["g2"], [fo[0], fo[1], fi[1], fi[0]]),
        poly(c["g1"], [fo[1], fo[2], fi[2], fi[1]]),
        poly(c["g3"], [fo[2], fo[3], fi[3], fi[2]]),
        poly(c["g4"], [fo[3], fo[4], fi[4], fi[3]]),
        poly(accent or c["g9"], fi),
    ]
    return out


def slab(c, x0, y0, x1, y1, dog=0, depth=(10, 8)):
    """Stone slab: front face triangulated, plus right and bottom thickness faces."""
    dx, dy = depth
    TL, BR, BL = (x0, y0), (x1, y1), (x0, y1)
    TRa, TRb = (x1 - dog, y0), (x1, y0 + dog)
    out = [
        poly(c["g6"], [TRb, (x1 + dx, y0 + dog + dy), (x1 + dx, y1 + dy), BR]),
        poly(c["g7"], [BL, BR, (x1 + dx, y1 + dy), (x0 + dx, y1 + dy)]),
    ]
    w, h = x1 - x0, y1 - y0
    P = lambda u, v: (round(x0 + w * u, 1), round(y0 + h * v, 1))
    m, n = P(0.42, 0.40), P(0.56, 0.62)
    out += [
        poly(c["g1"], [TL, TRa, TRb, m]),
        poly(c["g2"], [TL, m, BL]),
        poly(c["g3"], [m, n, BL]),
        poly(c["g3"], [TRb, BR, n, m]),
        poly(c["g4"], [BL, n, BR]),
    ]
    if dog:
        out.append(poly(c["g0"], [TRa, (x1 - dog, y0 + dog), TRb]))
    return out


def pdf_slab(c, accent=None):
    out = slab(c, 58, 30, 190, 214, dog=38)
    # chiselled lines: shaded upper wall + lit lower lip
    for i, (xa, xb) in enumerate([(80, 168), (80, 168), (80, 168), (80, 136)]):
        y = 96 + i * 26
        col = accent if (accent and i == 0) else c["g7"]
        out.append(poly(col, [(xa, y), (xb, y), (xb - 3, y + 7), (xa + 3, y + 7)]))
        out.append(poly(c["g0"], [(xa + 3, y + 7), (xb - 3, y + 7), (xb - 6, y + 10), (xa + 6, y + 10)]))
    return out


def image_slab(c, accent=None):
    x0, y0, x1, y1 = 30, 50, 216, 198
    out = slab(c, x0, y0, x1, y1)
    # sunken window
    wx0, wy0, wx1, wy1 = 50, 70, 196, 178
    b = 8
    out += [
        poly(c["g7"], [(wx0, wy0), (wx1, wy0), (wx1 - b, wy0 + b), (wx0 + b, wy0 + b)]),   # top wall, shaded
        poly(c["g6"], [(wx0, wy0), (wx0 + b, wy0 + b), (wx0 + b, wy1 - b), (wx0, wy1)]),   # left wall
        poly(c["g1"], [(wx0, wy1), (wx0 + b, wy1 - b), (wx1 - b, wy1 - b), (wx1, wy1)]),   # bottom lip, lit
        poly(c["g2"], [(wx1, wy0), (wx1, wy1), (wx1 - b, wy1 - b), (wx1 - b, wy0 + b)]),   # right wall
        poly(c["g8"], [(wx0 + b, wy0 + b), (wx1 - b, wy0 + b), (wx1 - b, wy1 - b), (wx0 + b, wy1 - b)]),
    ]
    fb = wy1 - b
    # peaks inside the window
    P1, P2 = (104, 88), (156, 116)
    out += [
        poly(c["g0"], [P1, (96, 132), (wx0 + b, fb)]),
        poly(c["g2"], [P1, (126, 124), (96, 132)]),
        poly(c["g4"], [P1, (136, 108), (126, 124)]),
        poly(c["g3"], [(96, 132), (126, 124), (118, fb), (wx0 + b, fb)]),
        poly(c["g5"], [(126, 124), (136, 108), (P2[0] - 8, 124), (118, fb)]),
        poly(c["g2"], [P2, (150, 146), (118, fb)]),
        poly(c["g5"], [P2, (wx1 - b, 150), (150, 146)]),
        poly(c["g6"], [(150, 146), (wx1 - b, 150), (wx1 - b, fb), (118, fb)]),
    ]
    import math
    sx, sy, r = 164, 94, 11
    sun = [(round(sx + r * math.cos(math.radians(22.5 + 45 * i)), 2), round(sy + r * math.sin(math.radians(22.5 + 45 * i)), 2)) for i in range(8)]
    out.append(poly(accent or c["g0"], sun))
    return out



# ---------------------------------------------------------------------------
# 3D-rendered marks and the file list
# ---------------------------------------------------------------------------
from lp3d import render, rot_x, rot_y, rot_z, AZ_RAMP
from helmet3d import hard_hat
from globe3d import uv_globe
import berg

def pts_of(s):
    n = list(map(float, s.split()))
    return list(zip(n[::2], n[1::2]))


CLOUD = [(m.group(1), pts_of(m.group(2))) for m in re.finditer(
    r'fill="(#[0-9A-Fa-f]{6})" points="([^"]+)"',
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "himmelcad-cloud-master.svg")).read())]

def cloud():
    # master polygons, translate(18 45) baked in so the outline variant can share them
    out = []
    for col, pts in CLOUD:
        out.append((col, [(x + 18, y + 45) for x, y in pts]))
    return out


AZ_RIM, GR_RIM = AZ["d2"], GR["g8"]
LOGOS = [
    # (file, title, group id, artwork, rim colour)
    ("himmelcad", "Himmel:CAD", "Cloud-Low-Poly", cloud(), AZ_RIM),
    ("himmelcad-builder", "Himmel:CAD Builder – Hard Hat", "Hard-Hat-Low-Poly",
     render(hard_hat(N=8, lats=(0, 40, 70), ry=1.05), rot_x(22) @ rot_y(-30), AZ_RAMP, lo=-0.4, hi=1.45), AZ_RIM),
    ("himmelcad-photolab-a-prism", "Himmel:CAD PhotoLab – Prism", "Prism-Low-Poly", prism(AZ), AZ_RIM),
    ("himmelcad-photolab-b-crystal", "Himmel:CAD PhotoLab – Crystal", "Crystal-Low-Poly", prism_crystal(AZ, None), AZ_RIM),
    ("himmelcad-cap", "Himmel:CAD Cap – Aperture", "Aperture-Low-Poly", aperture(AZ), AZ_RIM),
    ("himmelcad-weltview", "Himmel:CAD WeltView – Globe", "Globe-Low-Poly",
     render(uv_globe(lats=(-90, -60, -30, 0, 30, 60, 90), N=12), rot_x(18) @ rot_z(-14) @ rot_y(-12), AZ_RAMP, lo=-0.35, hi=1.35), AZ_RIM),
    ("bergwork-mark-mountain", "berg:work – Mountain", "Mountain-Low-Poly", mountain(GR), GR_RIM),
    ("bergwork-mark-hammer-pick", "berg:work – Schlägel und Eisen", "Hammer-Pick-Low-Poly", berg.hammer_and_pick(), GR_RIM),
    ("bergwork-mark-cart", "berg:work – Mine Cart", "Cart-Low-Poly", berg.mine_cart(), GR_RIM),
    ("bergwork-mark-cart-red", "berg:work – Mine Cart (red ore)", "Cart-Low-Poly", berg.mine_cart(GR["red"]), GR_RIM),
    ("bergwork-mark-terrain", "berg:work – Terrain Block", "Terrain-Low-Poly", berg.terrain_block(), GR_RIM),
    ("bergwork-mark-terrain-red", "berg:work – Terrain Block (red adit)", "Terrain-Low-Poly", berg.terrain_block(GR["red"]), GR_RIM),
    ("bergwork-pdf", "berg:work PDF – Stone Tablet", "Tablet-Low-Poly", pdf_slab(GR), GR_RIM),
    ("bergwork-image-red", "berg:work Image – Stone Frame", "Frame-Low-Poly", image_slab(GR, GR["red"]), GR_RIM),
]

for name, title, gid, art, rim in LOGOS:
    write(f"{name}.svg", svg(title, gid, art))
    write(f"{name}-on-light.svg", svg(f"{title} (on light)", gid, art, outline=rim))
