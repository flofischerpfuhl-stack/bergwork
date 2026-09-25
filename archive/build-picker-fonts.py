#!/usr/bin/env python3
"""Subset the font candidates for auswahl.html to Latin-1 + Cyrillic (variable fonts pinned to their
heaviest weight). Sources: google/fonts (all SIL OFL 1.1), downloaded into .fontlab/."""
import pathlib
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
LAB = ROOT / ".fontlab"
OUT = ROOT / "website/assets/fonts/auswahl"
BASE = "https://github.com/google/fonts/raw/main/ofl/"
FONTS = {
    "stalinist-one": "stalinistone/StalinistOne-Regular.ttf",
    "russo-one": "russoone/RussoOne-Regular.ttf",
    "rubik-mono-one": "rubikmonoone/RubikMonoOne-Regular.ttf",
    "oi": "oi/Oi-Regular.ttf",
    "ruslan-display": "ruslandisplay/RuslanDisplay-Regular.ttf",
    "days-one": "daysone/DaysOne-Regular.ttf",
    "prosto-one": "prostoone/ProstoOne-Regular.ttf",
    "dela-gothic-one": "delagothicone/DelaGothicOne-Regular.ttf",
    "rampart-one": "rampartone/RampartOne-Regular.ttf",
    "train-one": "trainone/TrainOne-Regular.ttf",
    "press-start-2p": "pressstart2p/PressStart2P-Regular.ttf",
    "rubik-dirt": "rubikdirt/RubikDirt-Regular.ttf",
    "rubik-glitch": "rubikglitch/RubikGlitch-Regular.ttf",
    "sofia-sans-xcond": "sofiasansextracondensed/SofiaSansExtraCondensed%5Bwght%5D.ttf",
    "unbounded": "unbounded/Unbounded%5Bwght%5D.ttf",
    "tektur": "tektur/Tektur%5Bwdth,wght%5D.ttf",
    "underdog": "underdog/Underdog-Regular.ttf",
    "yeseva-one": "yesevaone/YesevaOne-Regular.ttf",
    "poiret-one": "poiretone/PoiretOne-Regular.ttf",
    "kelly-slab": "kellyslab/KellySlab-Regular.ttf",
}
UNICODES = "U+0020-00FF,U+0400-045F,U+2010-2027,U+20AC,U+2190-2193"

def tighten_fullwidth_cyrillic(font):
    """CJK faces (Rampart One, Train One) ship Cyrillic at full em width. Re-space those glyphs with
    the side bearings of Latin capitals so faux-Cyrillic words don't fall apart."""
    if "glyf" not in font:
        return
    cmap, glyf, hmtx = font.getBestCmap(), font["glyf"], font["hmtx"]
    latin = [cmap[ord(c)] for c in "HNOE" if ord(c) in cmap]
    cyr = {cmap[c] for c in range(0x410, 0x450) if c in cmap}
    adv = lambda names: sum(hmtx[n][0] for n in names) / max(len(names), 1)
    if not latin or not cyr or adv(cyr) < 1.15 * adv(latin):
        return
    bearings = []
    for name in latin:
        g = glyf[name]
        g.recalcBounds(glyf)
        bearings += [g.xMin, hmtx[name][0] - g.xMax]
    side = round(sum(bearings) / len(bearings))
    for name in cyr:
        g = glyf[name]
        if g.isComposite() or not g.numberOfContours:
            continue
        g.recalcBounds(glyf)
        shift = side - g.xMin
        coords = g.coordinates
        for i in range(len(coords)):
            coords[i] = (coords[i][0] + shift, coords[i][1])
        g.recalcBounds(glyf)
        hmtx[name] = (g.xMax - g.xMin + 2 * side, side)
    print(f"  re-spaced {len(cyr)} full-width Cyrillic glyphs")


LAB.mkdir(exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
for key, path in FONTS.items():
    src = LAB / f"{key}.ttf"
    if not src.exists():
        src.write_bytes(urllib.request.urlopen(BASE + path).read())
    font = TTFont(src)
    if "fvar" in font:
        pins = {a.axisTag: (a.maxValue if a.axisTag == "wght" else a.defaultValue) for a in font["fvar"].axes}
        font = instancer.instantiateVariableFont(font, pins)
    tighten_fullwidth_cyrillic(font)
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_legacy = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    dst = OUT / f"{key}.woff2"
    font.flavor = "woff2"
    font.save(dst)
    print(f"{key:20s} {dst.stat().st_size // 1024:4d} KB")
