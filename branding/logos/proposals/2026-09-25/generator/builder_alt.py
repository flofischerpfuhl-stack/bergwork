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
