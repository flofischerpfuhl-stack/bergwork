#!/usr/bin/env python3
"""Build website/assets/fonts/Bergschrift-Regular.ttf from Stalinist One (SIL OFL 1.1).

Latin R/r, W/w, N/n are remapped to the Cyrillic glyphs Я/я, Ш/ш, И/и, so markup keeps plain Latin
text ("berg:work") while the rendering reads faux-Cyrillic. The Reserved Font Name "Stalinist"
forces a rename, hence "Bergschrift".
"""
import io
import pathlib
import urllib.request

from fontTools.ttLib import TTFont

SOURCE = "https://github.com/google/fonts/raw/main/ofl/stalinistone/StalinistOne-Regular.ttf"
OUT = pathlib.Path(__file__).resolve().parent.parent / "website/assets/fonts/Bergschrift-Regular.ttf"
SWAP = {"R": "Я", "r": "я", "W": "Ш", "w": "ш", "N": "И", "n": "и"}

font = TTFont(io.BytesIO(urllib.request.urlopen(SOURCE).read()))
for table in font["cmap"].tables:
    if table.isUnicode():
        for latin, cyrillic in SWAP.items():
            if ord(cyrillic) in table.cmap:
                table.cmap[ord(latin)] = table.cmap[ord(cyrillic)]

for record in font["name"].names:
    if record.nameID in (1, 16):
        record.string = "Bergschrift"
    elif record.nameID == 4:
        record.string = "Bergschrift Regular"
    elif record.nameID == 6:
        record.string = "Bergschrift-Regular"
    elif record.nameID == 3:
        record.string = "Bergschrift-Regular; derived from Stalinist One (OFL-1.1)"
    elif record.nameID == 5:
        record.string = f"{record.toUnicode()}; berg:work modification 2026-09-25"
    elif record.nameID == 10:
        record.string = (
            "Modified version of Stalinist One: Latin R, W, N (and lowercase) map to the Cyrillic "
            "glyphs Я, Ш, И. Renamed per the Reserved Font Name clause of the SIL OFL 1.1."
        )

font.save(OUT)
print(f"wrote {OUT}")
