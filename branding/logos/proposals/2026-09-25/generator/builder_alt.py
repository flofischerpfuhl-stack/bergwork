"""Himmel:CAD Builder alternatives: hard hats, abstract and asymmetric, few facets."""
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def P(c, spec):
    return [(c[k], pts) for k, pts in spec]


def helmet_abstract(c):
    """A: hard hat as a lopsided faceted dome over a lens-shaped brim that is longer at the front-left."""
    D0, D1, D2, D3, D4, D5, D6 = (56, 164), (60, 116), (92, 70), (140, 50), (188, 70), (212, 116), (208, 164)
    M = (128, 122)
    return P(c, [
        # brim
        ("m1", [(14, 182), (56, 164), (128, 166), (58, 194)]),
        ("m3", [(56, 164), (208, 164), (240, 172), (128, 166)]),
        ("d1", [(58, 194), (128, 166), (240, 172), (220, 184)]),
        # dome
        ("l2", [D0, D1, M]), ("w2", [D1, D2, M]), ("w0", [D2, D3, M]),
        ("l1", [D3, D4, M]), ("l3", [D4, D5, M]), ("m2", [D5, D6, M]),
        ("m1", [D0, M, (130, 164)]), ("m3", [M, D6, (130, 164)]),
    ])


def cloud_helmet(c):
    """B: the Himmel:CAD cloud crown worn as a hard hat — cloud facets on top, a brim underneath."""
    src = open(os.path.join(HERE, "himmelcad-cloud-master.svg")).read()
    polys = [(m.group(1), [tuple(map(float, xy)) for xy in zip(*[iter(m.group(2).split())] * 2)])
             for m in re.finditer(r'fill="(#[0-9A-Fa-f]{6})" points="([^"]+)"', src)]
    # keep the upper facets of the cloud (everything that sits above the cloud's waist line)
    top = [(col, pts) for col, pts in polys if max(y for _, y in pts) <= 125]
    s, tx, ty = 0.9, 16, 44
    out = [(col, [(round(tx + x * s, 1), round(ty + y * s, 1)) for x, y in pts]) for col, pts in top]
    # waist line of the cloud: (15,105) (85,125) (165,125) (235,105)
    w = [(round(tx + x * s, 1), round(ty + y * s, 1)) for x, y in [(15, 105), (85, 125), (165, 125), (235, 105)]]
    out += P(c, [
        ("m1", [(4, w[0][1] + 20), w[0], w[1], (w[1][0] - 8, w[1][1] + 16)]),
        ("m2", [(w[1][0] - 8, w[1][1] + 16), w[1], w[2], (w[2][0] + 4, w[2][1] + 14)]),
        ("m3", [(w[2][0] + 4, w[2][1] + 14), w[2], w[3], (w[3][0] + 6, w[3][1] + 8)]),
        ("d1", [(4, w[0][1] + 20), (w[1][0] - 8, w[1][1] + 16), (w[1][0] - 6, w[1][1] + 26), (10, w[0][1] + 28)]),
        ("d2", [(w[1][0] - 8, w[1][1] + 16), (w[2][0] + 4, w[2][1] + 14), (w[3][0] + 6, w[3][1] + 8),
                (w[3][0] + 2, w[3][1] + 14), (w[2][0] + 2, w[2][1] + 22), (w[1][0] - 6, w[1][1] + 26)]),
    ])
    return out


def helmet_profile(c):
    """C: side profile, peak to the left, one fan of facets from the crown's centre."""
    F0, F1, F2, F3, F4, F5, F6 = (62, 166), (70, 112), (112, 72), (164, 64), (206, 92), (222, 140), (224, 166)
    M = (142, 124)
    V, T = (10, 184), (244, 172)
    return P(c, [
        ("l2", [V, F0, (132, 166)]),
        ("m2", [V, (132, 166), F6, T]),
        ("d1", [V, T, (238, 180), (24, 194)]),
        ("l2", [F0, F1, M]), ("w2", [F1, F2, M]), ("w0", [F2, F3, M]),
        ("l1", [F3, F4, M]), ("l3", [F4, F5, M]), ("m2", [F5, F6, M]), ("m1", [F0, M, F6]),
    ])


def helmet_minimal(c):
    """D: the least that still reads as a hard hat — a dome of three shards fanned from the brim, on a sheared peak."""
    D = [(54, 170), (66, 112), (112, 66), (170, 60), (210, 100), (220, 168)]
    C = (128, 170)
    return P(c, [
        ("m1", [(10, 180), (236, 164), (242, 176), (26, 198)]),
        ("d1", [(26, 198), (242, 176), (230, 186), (44, 206)]),
        ("l1", [D[0], D[1], D[2], C]),
        ("w1", [D[2], D[3], D[4], C]),
        ("m1", [D[4], D[5], C]),
    ])


def helmet_three_quarter(c):
    """E: three-quarter view from the front-left and above: elliptical brim with the peak towards the viewer."""
    import math

    def ell(cx, cy, rx, ry, deg, bulge=0.0):
        t = math.radians(deg)
        f = 1 + bulge * max(0.0, math.cos(t - math.radians(125))) ** 3
        return (round(cx + rx * f * math.cos(t), 1), round(cy + ry * f * math.sin(t), 1))

    angs = [0, 45, 90, 135, 180, 225, 270, 315]
    outer = [ell(128, 168, 112, 34, a, 0.28) for a in angs]
    base = [ell(136, 160, 74, 20, a) for a in angs]
    out = []
    tones = {0: "m3", 45: "m2", 90: "m1", 135: "l3", 180: "l2", 225: "l1", 270: "l2", 315: "m2"}
    for i, a in enumerate(angs):
        j = (i + 1) % 8
        out.append((c[tones[a]], [outer[i], outer[j], base[j], base[i]]))
    # thickness along the front half of the brim
    front = [ell(128, 168, 112, 34, a, 0.28) for a in range(0, 181, 30)]
    out.append((c["d1"], front + [(x, y + 9) for x, y in front[::-1]]))
    # dome: fan from M over the silhouette and the front half of the base
    M = (140, 118)
    sil = [base[4], (68, 116), (100, 76), (146, 54), (190, 72), (214, 112), base[0]]
    sil_t = ["l2", "w2", "w0", "l1", "l3", "m2"]
    for k in range(len(sil) - 1):
        out.append((c[sil_t[k]], [sil[k], sil[k + 1], M]))
    out.append((c["m1"], [base[0], base[1], base[2], M]))
    out.append((c["l1"], [base[2], base[3], base[4], M]))
    # ridge from the crown to the front
    out.append((c["w1"], [(146, 54), (156, 58), (M[0] + 6, M[1] + 2), (M[0] - 4, M[1])]))
    out.append((c["w3"], [(M[0] - 4, M[1]), (M[0] + 6, M[1] + 2), (base[2][0] + 5, base[2][1]), (base[2][0] - 5, base[2][1])]))
    return out


def helmet_inspo(c):
    """F: three-quarter hard hat after the owner's reference — shaded left flank, a light ridge band
    sweeping over the crown to the front, side clips, and a brim whose peak points front-right."""
    # dome silhouette, left base to right base
    D = [(32, 150), (34, 112), (48, 76), (72, 48), (98, 32), (120, 26), (150, 28), (182, 46), (204, 76), (214, 112), (216, 146)]
    # dome base on the brim, left to right
    E = [(32, 150), (70, 170), (110, 184), (144, 186), (192, 178), (216, 146)]
    # brim outer edge, left to right, then back up the right side
    O = [(12, 160), (40, 182), (80, 200), (122, 212), (172, 210), (216, 198), (246, 180), (236, 156)]
    # ridge band edges, crown to brim
    L = [(120, 26), (132, 82), (138, 134), (144, 186)]
    R = [(150, 28), (174, 78), (188, 128), (192, 178)]
    I1, I2, I3, I4, J1 = (62, 100), (94, 62), (98, 126), (70, 148), (202, 114)
    th = 9
    down = lambda pts: [(x, y + th) for x, y in pts]
    return P(c, [
        # brim thickness, then its top surface
        ("d2", O[0:4] + down(O[0:4])[::-1]),
        ("d1", O[3:7] + down(O[3:7])[::-1]),
        ("m3", [(20, 148), O[0], E[0]]),
        ("m3", [O[0], O[1], E[0]]), ("m2", [E[0], O[1], E[1]]),
        ("m2", [O[1], O[2], E[1]]), ("m1", [E[1], O[2], E[2]]),
        ("m1", [O[2], O[3], E[2]]), ("l3", [E[2], O[3], E[3]]),
        ("l2", [O[3], O[4], E[3]]), ("l1", [E[3], O[4], E[4]]),
        ("w3", [O[4], O[5], E[4]]), ("w2", [E[4], O[5], O[6]]),
        ("l1", [E[4], O[6], E[5]]), ("l3", [E[5], O[6], O[7]]),
        # dome, shaded left flank
        ("d1", [D[0], D[1], I4]), ("m3", [D[1], D[2], I1]), ("d2", [D[1], I1, I4]),
        ("l3", [D[2], D[3], I1]), ("m2", [D[3], I2, I1]), ("l2", [D[3], D[4], I2]),
        ("l1", [D[4], D[5], I2]), ("m1", [D[5], L[1], I2]), ("d1", [I2, L[1], I3]),
        ("m3", [I1, I2, I3]), ("d2", [I1, I3, I4]),
        ("d1", [E[0], I4, E[1]]), ("m3", [I4, I3, E[1]]), ("d2", [I3, E[2], E[1]]),
        ("m2", [I3, L[1], L[2]]), ("d1", [I3, L[2], E[2]]), ("m3", [L[2], L[3], E[2]]),
        # ridge band
        ("w0", [L[0], R[0], R[1]]), ("w2", [L[0], R[1], L[1]]),
        ("w1", [L[1], R[1], R[2]]), ("w3", [L[1], R[2], L[2]]),
        ("l1", [L[2], R[2], R[3]]), ("l2", [L[2], R[3], L[3]]),
        # dome, lit right flank
        ("l2", [R[0], D[7], R[1]]), ("l3", [D[7], D[8], R[1]]), ("l1", [D[8], J1, R[1]]),
        ("m1", [D[8], D[9], J1]), ("l2", [R[1], J1, R[2]]), ("m2", [D[9], D[10], J1]),
        ("m1", [J1, D[10], R[2]]), ("l3", [R[2], D[10], R[3]]),
        # side clips where the dome meets the brim
        ("d2", [(62, 152), (82, 156), (80, 176), (64, 172)]), ("l3", [(62, 152), (82, 156), (86, 151), (67, 147)]),
        ("m3", [(82, 156), (86, 151), (84, 171), (80, 176)]),
        ("d1", [(24, 126), (32, 124), (32, 148), (24, 150)]), ("m2", [(24, 126), (32, 124), (36, 121), (28, 123)]),
        ("m2", [(204, 128), (211, 124), (212, 150), (205, 154)]), ("l2", [(204, 128), (211, 124), (214, 121), (207, 125)]),
    ])


# vertices read off the owner's reference image (1402 x 1122 px), mapped into the 256 frame
_REF_BOX = (50, 51, 1350, 1100)


def _ref(p):
    x0, y0, x1, y1 = _REF_BOX
    s = 236 / (x1 - x0)
    return (round(10 + (p[0] - x0) * s, 1), round(128 + (p[1] - (y0 + y1) / 2) * s, 1))


def helmet_traced(c, sample=None):
    """G: the reference hard hat, traced vertex for vertex."""
    V = dict(
        # dome silhouette
        a=(140, 613), b=(140, 507), c=(213, 327), e=(400, 160), f=(580, 51), g=(747, 56), h=(873, 127),
        i=(993, 197), j=(1100, 349), k=(1147, 493), l=(1180, 627), m=(1220, 740),
        # dome interior
        p=(227, 387), q=(573, 287), r=(307, 427), s=(727, 480), t=(540, 540), u=(747, 133), v=(840, 440),
        # raised ridge: left edge h-w-x-z, right edge hr-wr-xr-zr
        w=(953, 347), x=(1013, 507), z=(1080, 847),
        hr=(897, 122), wr=(977, 340), xr=(1037, 503), zr=(1104, 842),
        # dome base on the brim
        bb=(200, 845), n=(400, 905), o=(600, 900), y=(820, 880),
        # brim: outer edge of the top face, then the underside line
        E0=(50, 745), E1=(400, 960), E2=(600, 1065), E3=(800, 1073), E4=(1000, 1050), E5=(1253, 1003),
        E6=(1347, 920), E7=(1320, 847), E8=(1240, 760),
        U0=(58, 812), U1=(400, 1025), U2=(600, 1105), U3=(800, 1106), U4=(1000, 1083), U5=(1253, 1034), U6=(1347, 948),
    )
    T = lambda *names: [_ref(V[n]) for n in names]
    spec = [
        # brim underside, then the top face fanned from the dome base
        ("d2", T("E0", "E1", "E2", "E3", "U3", "U2", "U1", "U0")),
        ("d1", T("E3", "E4", "E5", "E6", "U6", "U5", "U4", "U3")),
        ("m3", T("E0", "bb", "E1")), ("m2", T("bb", "n", "E1")), ("m3", T("n", "E2", "E1")),
        ("m1", T("n", "o", "E2")), ("m2", T("o", "E3", "E2")), ("l3", T("o", "y", "E3")),
        ("l3", T("y", "E4", "E3")), ("l1", T("y", "z", "E4")), ("w2", T("z", "E5", "E4")),
        ("w1", T("z", "E6", "E5")), ("l1", T("z", "E7", "E6")), ("l2", T("z", "m", "E8", "E7")),
        # dome, shaded left and front-left
        ("m2", T("b", "c", "p")), ("l3", T("c", "e", "p")), ("l2", T("p", "e", "q")), ("l3", T("p", "q", "r")),
        ("m2", T("e", "f", "q")), ("d1", T("f", "u", "q")), ("l3", T("f", "g", "u")),
        ("d2", T("q", "u", "s")), ("m1", T("q", "s", "t")), ("d1", T("r", "q", "t")),
        ("m2", T("b", "p", "r")), ("d2", T("a", "b", "r")), ("d2", T("a", "r", "bb")),
        ("d2", T("r", "t", "n")), ("d1", T("r", "n", "bb")), ("d1", T("t", "s", "o")), ("d2", T("t", "o", "n")),
        ("d1", T("s", "y", "o")), ("d2", T("s", "v", "y")), ("d1", T("u", "v", "s")),
        # dome, lit crown and front
        ("w1", T("g", "h", "u")), ("w0", T("u", "h", "w")), ("w2", T("u", "w", "v")),
        ("l1", T("v", "w", "x")), ("m1", T("v", "x", "y")), ("m2", T("x", "z", "y")),
        # dome, right flank behind the ridge
        ("l2", T("hr", "i", "wr")), ("l3", T("i", "j", "wr")), ("m1", T("j", "k", "wr")), ("m2", T("wr", "k", "xr")),
        ("m3", T("k", "l", "xr")), ("m3", T("xr", "l", "zr")), ("d1", T("l", "m", "zr")),
        # raised ridge
        ("w0", T("h", "hr", "wr", "w")), ("w1", T("w", "wr", "xr", "x")), ("l1", T("x", "xr", "zr", "z")),
    ]
    clips = [
        # left clip: top, left face, front face
        ("l3", [(93, 613), (127, 600), (173, 633), (140, 640)]),
        ("m2", [(93, 613), (140, 640), (127, 767), (87, 733)]),
        ("d2", [(140, 640), (173, 633), (173, 773), (127, 767)]),
        # front clip
        ("l3", [(353, 687), (500, 727), (460, 747), (360, 720)]),
        ("d2", [(360, 720), (460, 747), (467, 900), (320, 873)]),
        ("m2", [(460, 747), (500, 727), (513, 880), (467, 900)]),
        # right clip
        ("l3", [(1167, 640), (1193, 613), (1213, 624), (1187, 653)]),
        ("d2", [(1167, 647), (1187, 653), (1193, 773), (1173, 767)]),
        ("m2", [(1187, 653), (1213, 624), (1227, 760), (1193, 773)]),
    ]
    out = [(c[k], pts) for k, pts in spec]
    out += [(c[k], [_ref(p) for p in pts]) for k, pts in clips]
    if sample:
        # the brim underside is a long thin band whose centroid falls on the lit top face, and the clips
        # are small blocks whose centroids graze their neighbours: both keep their drawn tones
        n = len(clips)
        out = out[:2] + _tone_from_reference(c, out, sample)[2:-n] + out[-n:]
    return out


def _tone_from_reference(c, polys, image_path):
    """Give every facet the azure step that matches the reference's brightness at its centroid."""
    from PIL import Image
    im = Image.open(image_path).convert("RGB")
    x0, y0, x1, y1 = _REF_BOX
    s = 236 / (x1 - x0)
    ramp = ["d2", "d1", "m3", "m2", "m1", "l3", "l2", "l1", "w3", "w2", "w1", "w0"]
    lum = []
    for _, pts in polys:
        # centroid back in reference pixels; average a small patch
        mx = sum(p[0] for p in pts) / len(pts)
        my = sum(p[1] for p in pts) / len(pts)
        rx, ry = x0 + (mx - 10) / s, (y0 + y1) / 2 + (my - 128) / s
        vals = []
        for dx in (-6, 0, 6):
            for dy in (-6, 0, 6):
                r, g, b = im.getpixel((int(min(max(rx + dx, 0), im.width - 1)), int(min(max(ry + dy, 0), im.height - 1))))
                vals.append(0.2126 * r + 0.7152 * g + 0.0722 * b)
        lum.append(sorted(vals)[len(vals) // 2])
    lo, hi = min(lum), max(lum)
    out = []
    for (_, pts), L in zip(polys, lum):
        k = int((L - lo) / (hi - lo + 1e-9) * (len(ramp) - 1) + 0.5)
        out.append((c[ramp[k]], pts))
    return out
