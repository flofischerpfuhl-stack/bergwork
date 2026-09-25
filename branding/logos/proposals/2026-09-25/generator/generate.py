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


def poly(fill, pts):
    return (fill, [(round(x, 2), round(y, 2)) for x, y in pts])


def poly_str(fill, pts):
    s = " ".join(f"{x:g} {y:g}" for x, y in pts)
    return f'    <polygon fill="{fill}" points="{s}"/>'


def svg(title, gid, polys):
    body = "\n".join(poly_str(*p) for p in polys)
    return f"""<svg
  width="256"
  height="256"
  viewBox="0 0 256 256"
  xmlns="http://www.w3.org/2000/svg"
>
  <title>{title}</title>

  <g
    id="{gid}"
    stroke="none"
    fill-rule="evenodd"
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
# File list
# ---------------------------------------------------------------------------
import builder_alt
import flat
import rim


def pts_of(s):
    n = list(map(float, s.split()))
    return list(zip(n[::2], n[1::2]))


CLOUD = [(m.group(1), pts_of(m.group(2))) for m in re.finditer(
    r'fill="(#[0-9A-Fa-f]{6})" points="([^"]+)"',
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "himmelcad-cloud-master.svg")).read())]


def cloud():
    # master polygons with its translate(18 45) baked in
    return [(col, [(x + 18, y + 45) for x, y in pts]) for col, pts in CLOUD]


AZ_RAMP = [AZ[k] for k in ("w0", "w1", "w2", "w3", "l1", "l2", "l3", "m1", "m2", "m3", "d1", "d2")]
GR_RAMP = [GR[k] for k in ("g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9")]

LOGOS = [
    # (file, title, group id, artwork, light-background treatment)
    ("himmelcad", "Himmel:CAD", "Cloud-Low-Poly", cloud(), "tone"),
    ("himmelcad-builder", "Himmel:CAD Builder – Hard Hat", "Hard-Hat-Low-Poly",
     builder_alt.helmet_traced(AZ, sample=os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference-hard-hat.png")), "tone"),
    ("himmelcad-photolab", "Himmel:CAD PhotoLab – Crystal", "Crystal-Low-Poly", prism_crystal(AZ, None), "tone"),
    ("himmelcad-cap", "Himmel:CAD Cap – Aperture", "Aperture-Low-Poly", aperture(AZ), "tone"),
    ("himmelcad-weltview", "Himmel:CAD WeltView – Globe", "Globe-Low-Poly",
     flat.globe_poly(AZ, lon0=0, lat0=25, eps=10), "tone"),
    ("bergwork", "berg:work – Schlägel und Eisen", "Hammer-Pick-Low-Poly", flat.hammer_and_pick(GR), "rim"),
    ("bergwork-pdf", "berg:work PDF – Stone Tablet", "Tablet-Low-Poly", pdf_slab(GR, GR["red"]), "tone"),
    ("bergwork-image", "berg:work Image – Stone Frame", "Frame-Low-Poly", image_slab(GR, GR["red"]), "tone"),
]

for name, title, gid, art, mode in LOGOS:
    ramp, rim_col = (AZ_RAMP, AZ["m1"]) if name.startswith("himmelcad") else (GR_RAMP, GR["g5"])
    light = rim.rim(art, rim_col) if mode == "rim" else rim.tone(art, ramp)
    write(f"{name}.svg", svg(title, gid, art))
    write(f"{name}-on-light.svg", svg(f"{title} (on light)", gid, light))
