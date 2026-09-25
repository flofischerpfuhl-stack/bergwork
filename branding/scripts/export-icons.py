#!/usr/bin/env python3
"""Export an app/web icon set from a flat 256x256 logo SVG.

usage: export_icons.py <mark.svg> <out-dir> [--plate #0a0a0a] [--scale 0.78]

Writes:
  icon.svg              1024 card: the mark, bbox-centred, on a rounded plate (favicon, source for `tauri icon`)
  icon-<n>.png          16 32 48 64 128 180 192 256 512 1024 from the card
  icon.ico              16 24 32 48 64 128 256
  apple-touch-icon.png  180, square plate without rounding (iOS rounds itself)
  icon-maskable-512.png full-bleed plate, mark inside the 80 % safe circle
  mark-512.png          the bare mark, transparent
Needs inkscape and ImageMagick (convert).
"""
import argparse
import os
import re
import subprocess
import tempfile


def polygons(svg_text):
    body = re.search(r"<g[^>]*>(.*)</g>", svg_text, re.S).group(1)
    pts = [float(v) for m in re.finditer(r'points="([^"]+)"', body) for v in m.group(1).split()]
    xs, ys = pts[::2], pts[1::2]
    return body, (min(xs), min(ys), max(xs), max(ys))


def card(body, bbox, plate, scale, radius, size=1024):
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    s = size * scale / max(w, h)
    tx, ty = size / 2 - (x0 + w / 2) * s, size / 2 - (y0 + h / 2) * s
    rect = f'<rect width="{size}" height="{size}" rx="{radius}" fill="{plate}"/>' if plate else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">\n'
            f'  {rect}\n  <g transform="translate({tx:.2f} {ty:.2f}) scale({s:.4f})" stroke="none">{body}  </g>\n</svg>\n')


def png(svg_path, out, size):
    subprocess.run(["inkscape", svg_path, "-o", out, "-w", str(size), "-h", str(size)], check=True, capture_output=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mark")
    ap.add_argument("out")
    ap.add_argument("--plate", default="#000000")
    ap.add_argument("--scale", type=float, default=0.78)
    ap.add_argument("--radius", type=int, default=192)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    body, bbox = polygons(open(a.mark).read())
    open(os.path.join(a.out, "icon.svg"), "w").write(card(body, bbox, a.plate, a.scale, a.radius))
    with tempfile.TemporaryDirectory() as tmp:
        sq = os.path.join(tmp, "square.svg")
        open(sq, "w").write(card(body, bbox, a.plate, a.scale, 0))
        mk = os.path.join(tmp, "mask.svg")
        open(mk, "w").write(card(body, bbox, a.plate, 0.62, 0))
        bare = os.path.join(tmp, "bare.svg")
        open(bare, "w").write(card(body, bbox, None, 0.94, 0))
        src = os.path.join(a.out, "icon.svg")
        for n in (16, 32, 48, 64, 128, 180, 192, 256, 512, 1024):
            png(src, os.path.join(a.out, f"icon-{n}.png"), n)
        png(sq, os.path.join(a.out, "apple-touch-icon.png"), 180)
        png(mk, os.path.join(a.out, "icon-maskable-512.png"), 512)
        png(bare, os.path.join(a.out, "mark-512.png"), 512)
        ico_src = []
        for n in (16, 24, 32, 48, 64, 128, 256):
            p = os.path.join(tmp, f"ico-{n}.png")
            png(src, p, n)
            ico_src.append(p)
        subprocess.run(["convert", *ico_src, os.path.join(a.out, "icon.ico")], check=True)


if __name__ == "__main__":
    main()
