#!/usr/bin/env python3
"""Low-poly logo proposals for Himmel:CAD and berg:work (2026-09-25)."""
import os, sys

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


def svg(title, gid, polys, tx=0, ty=0):
    body = "\n".join(polys)
    tr = f'\n    transform="translate({tx:g} {ty:g})"' if (tx or ty) else ""
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
# Himmel:CAD Builder — low-poly hard hat
# ---------------------------------------------------------------------------
def helmet(palette):
    c = palette
    # dome, left half (mirrored for the right)
    A0, A1, A2, A3, A4 = (40, 160), (44, 122), (60, 90), (86, 66), (112, 56)
    B0, B1, B2 = (80, 160), (80, 122), (94, 88)
    R0, R1, R2, R3 = (112, 160), (112, 122), (112, 88), (112, 56)
    # rib
    K0, K1, K2, K3 = (112, 56), (128, 48), (144, 56), (128, 58)
    # brim
    E0, E1, E2, E3 = (16, 172), (48, 184), (88, 191), (128, 193)
    D = 8
    F0, F1, F2, F3 = [(x + (2 if x < 128 else 0), y + D) for x, y in (E0, E1, E2, E3)]
    Cb = (128, 160)

    left = [
        # outer column
        (c["m1"], [A0, A1, B1]), (c["m3"], [A0, B1, B0]),
        (c["l1"], [A1, A2, B1]), (c["l2"], [A2, B2, B1]),
        (c["w1"], [A2, A3, B2]),
        # inner column
        (c["l3"], [B0, B1, R1]), (c["m2"], [B0, R1, R0]),
        (c["w3"], [B1, B2, R2]), (c["l1"], [B1, R2, R1]),
        (c["w0"], [B2, A3, A4]), (c["w2"], [B2, A4, R2]),
    ]
    right = [
        (c["d1"], [A0, A1, B1]), (c["d2"], [A0, B1, B0]),
        (c["m2"], [A1, A2, B1]), (c["m3"], [A2, B2, B1]),
        (c["l2"], [A2, A3, B2]),
        (c["m1"], [B0, B1, R1]), (c["m3"], [B0, R1, R0]),
        (c["l1"], [B1, B2, R2]), (c["l3"], [B1, R2, R1]),
        (c["w3"], [B2, A3, A4]), (c["l1"], [B2, A4, R2]),
    ]
    out = []
    # brim edge (thickness) first, sits behind the top surface
    edge_l = [(c["d1"], [E0, E1, F1, F0]), (c["d1"], [E1, E2, F2, F1]), (c["d2"], [E2, E3, F3, F2])]
    edge_r = [(c["d2"], [E0, E1, F1, F0]), (c["d2"], [E1, E2, F2, F1]), (c["d2"], [E2, E3, F3, F2])]
    for col, pts in edge_l:
        out.append(poly(col, pts))
    for col, pts in edge_r:
        out.append(poly(col, [mx(p) for p in pts]))
    # brim top surface
    brim_l = [
        (c["m1"], [E0, A0, E1]), (c["m2"], [A0, B0, E1]),
        (c["m3"], [B0, E2, E1]), (c["m2"], [B0, R0, E2]),
        (c["m3"], [R0, E3, E2]), (c["m1"], [R0, Cb, E3]),
    ]
    brim_r = [
        (c["d1"], [E0, A0, E1]), (c["m3"], [A0, B0, E1]),
        (c["d1"], [B0, E2, E1]), (c["m3"], [B0, R0, E2]),
        (c["d1"], [R0, E3, E2]), (c["m3"], [R0, Cb, E3]),
    ]
    for col, pts in brim_l:
        out.append(poly(col, pts))
    for col, pts in brim_r:
        out.append(poly(col, [mx(p) for p in pts]))
    for col, pts in left:
        out.append(poly(col, pts))
    for col, pts in right:
        out.append(poly(col, [mx(p) for p in pts]))
    # rib: a raised ridge from crown to brim, lit face left / shade face right
    rib = [
        (c["w0"], [K0, K1, K3]), (c["w2"], [K1, K2, K3]),
        (c["w1"], [R3, K3, (128, 88), R2]), (c["w3"], [K3, mx(R3), mx(R2), (128, 88)]),
        (c["w3"], [R2, (128, 88), (128, 122), R1]), (c["l1"], [(128, 88), mx(R2), mx(R1), (128, 122)]),
        (c["l2"], [R1, (128, 122), (128, 162), R0]), (c["l3"], [(128, 122), mx(R1), mx(R0), (128, 162)]),
    ]
    for col, pts in rib:
        out.append(poly(col, pts))
    return out


write("himmelcad-builder-helmet.svg",
      svg("Himmel:CAD Builder – Low-Poly Helmet", "Helmet-Low-Poly", helmet(AZ), 0, 4))


# ---------------------------------------------------------------------------
# Himmel:CAD PhotoLab — prism
# ---------------------------------------------------------------------------
def lerp(a, b, t):
    return (round(a[0] + (b[0] - a[0]) * t, 2), round(a[1] + (b[1] - a[1]) * t, 2))


def prism_refraction(c, fan):
    """A: faceted prism, a white ray enters left and leaves right as a fan."""
    T, L, R = (120, 30), (30, 204), (206, 204)
    C = (124, 150)                        # apex of the facet pyramid
    P = lerp(T, L, 0.54)                  # entry point on the left face
    Q = lerp(T, R, 0.60)                  # exit point on the right face
    out = []
    # incoming ray (behind the prism edge)
    out.append(poly(c["w0"], [(2, 164), (2, 156), P, (P[0] + 1.5, P[1] + 6)]))
    # outgoing fan, behind the prism
    n = len(fan)
    y0, y1 = Q[1] + 14, 236
    for i, col in enumerate(fan):
        a = (254, y0 + (y1 - y0) * i / n)
        b = (254, y0 + (y1 - y0) * (i + 1) / n)
        out.append(poly(col, [Q, (Q[0], Q[1] + 6), a, b] if i == 0 else [Q, a, b]))
    # prism body
    out += [
        poly(c["w1"], [T, L, C]),
        poly(c["l2"], [T, C, R]),
        poly(c["m2"], [L, R, C]),
    ]
    # the ray inside the glass: lit on the bright facet, tinted on the shaded one
    X = lerp(T, C, 0.62)
    Xb = (X[0], X[1] + 6)
    out.append(poly(c["w0"], [P, (P[0] + 1.5, P[1] + 6), Xb, X]))
    out.append(poly(c["w3"], [X, Xb, (Q[0], Q[1] + 6), Q]))
    return out


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


SPECTRUM = ["#F8FDFF", "#FFE45C", "#FF8A3D", "#FF3D6E", "#8F5BFF"]
AZFAN = [AZ["w0"], AZ["w3"], AZ["l2"], AZ["m1"], AZ["d1"]]

write("himmelcad-photolab-a-refraction.svg",
      svg("Himmel:CAD PhotoLab – Prism Refraction", "Prism-Low-Poly", prism_refraction(AZ, AZFAN)))
write("himmelcad-photolab-a-refraction-spectrum.svg",
      svg("Himmel:CAD PhotoLab – Prism Refraction (spectrum)", "Prism-Low-Poly", prism_refraction(AZ, SPECTRUM)))
write("himmelcad-photolab-b-crystal.svg",
      svg("Himmel:CAD PhotoLab – Crystal", "Crystal-Low-Poly", prism_crystal(AZ, AZFAN)))
write("himmelcad-photolab-c-aperture.svg",
      svg("Himmel:CAD PhotoLab – Prism Aperture", "Aperture-Low-Poly", aperture(AZ)))


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


write("bergwork-mark.svg", svg("berg:work – Granite Mark", "Mountain-Low-Poly", mountain(GR)))
write("bergwork-mark-red.svg", svg("berg:work – Granite Mark (red adit)", "Mountain-Low-Poly", mountain(GR, GR["red"])))
write("bergwork-pdf.svg", svg("berg:work PDF – Stone Tablet", "Tablet-Low-Poly", pdf_slab(GR)))
write("bergwork-pdf-red.svg", svg("berg:work PDF – Stone Tablet (red line)", "Tablet-Low-Poly", pdf_slab(GR, GR["red"])))
write("bergwork-image.svg", svg("berg:work Image – Stone Frame", "Frame-Low-Poly", image_slab(GR)))
write("bergwork-image-red.svg", svg("berg:work Image – Stone Frame (red sun)", "Frame-Low-Poly", image_slab(GR, GR["red"])))
