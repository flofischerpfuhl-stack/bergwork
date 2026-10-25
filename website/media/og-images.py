#!/usr/bin/env python3
"""Draws the three 1200 x 630 Open Graph pictures of bergwork.app (JPEG) from the site's own assets.

    python3 website/media/og-images.py

og-bergwork.jpg: the mine picture under the wordmark. og-pdf.jpg and og-image.jpg: the product's claim next to the
last frame of its take (website/src/media/*-poster.jpg). Needs Pillow; fonts come from website/src/assets/fonts.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'src' / 'assets'
MEDIA = ROOT / 'src' / 'media'
OUT = ASSETS / 'img'
CREAM, INK, RED = (243, 240, 230), (10, 10, 10), (200, 30, 30)
W, H = 1200, 630


def display(size):
    return ImageFont.truetype(str(ASSETS / 'fonts' / 'Bergschrift-Regular.ttf'), size)


def mono(size, weight=700):
    font = ImageFont.truetype(str(ASSETS / 'fonts' / 'JetBrainsMono-latin.woff2'), size)
    font.set_variation_by_axes([weight])
    return font


def cover(image, width, height, focus_x=0.5, focus_y=0.5):
    scale = max(width / image.width, height / image.height)
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.LANCZOS)
    left = round((image.width - width) * focus_x)
    top = round((image.height - height) * focus_y)
    return image.crop((left, top, left + width, top + height))


def shadowed(draw, xy, text, font, fill=CREAM, shadow=INK, offset=6):
    draw.text((xy[0] + offset, xy[1] + offset), text, font=font, fill=shadow)
    draw.text(xy, text, font=font, fill=fill)


def site():
    canvas = Image.new('RGB', (W, H), INK)
    canvas.paste(cover(Image.open(ASSETS / 'img' / 'mine-dusk.jpg').convert('RGB'), W, H - 160, 0.6, 0.55), (0, 160))
    draw = ImageDraw.Draw(canvas)
    draw.text((64, 40), 'berg:work', font=display(118), fill=CREAM)
    draw.rectangle((64, 176, 416, 186), fill=RED)
    label = 'PDF + IMAGE EDITING IN YOUR BROWSER'
    sub = 'NOTHING UPLOADED · NO ACCOUNT'
    draw.rectangle((52, 488, 52 + 28 + draw.textlength(label, font=mono(34)), 545), fill=CREAM, outline=INK, width=3)
    draw.text((66, 494), label, font=mono(34), fill=INK)
    draw.rectangle((70, 556, 84 + draw.textlength(sub, font=mono(26)) + 14, 602), fill=RED, outline=INK, width=3)
    draw.text((84, 562), sub, font=mono(26), fill=CREAM)
    canvas.save(OUT / 'og-bergwork.jpg', quality=86, optimize=True, progressive=True)


def product(name, claim, lines, poster, background, out, focus=(0.5, 0.0)):
    canvas = Image.new('RGB', (W, H), background)
    shot = cover(Image.open(poster).convert('RGB'), 520, 630, *focus)
    canvas.paste(shot, (W - 520, 0))
    draw = ImageDraw.Draw(canvas)
    draw.line((W - 522, 0, W - 522, H), fill=INK, width=4)
    fg = INK if background == CREAM else CREAM
    draw.text((56, 48), 'berg:work', font=display(40), fill=fg)
    draw.text((58, 108), name.replace('berg:work ', ''), font=mono(30, 800), fill=RED if background == CREAM else CREAM)
    # The largest display size at which every claim line fits left of the picture.
    size = 84
    while max(draw.textlength(word, font=display(size)) for word in claim) > W - 520 - 110:
        size -= 2
    y = 200
    for word in claim:
        shadowed(draw, (56, y), word, display(size), fill=fg, shadow=RED, offset=4)
        y += round(size * 1.12)
    y += 28
    for line in lines:
        draw.text((58, y), line, font=mono(25, 600), fill=fg)
        y += 38
    canvas.save(OUT / out, quality=86, optimize=True, progressive=True)


site()
product('berg:work PDF', ['MOVE', 'ANYTHING.'], ['Edit what is inside a PDF,', 'in your browser. Nothing uploaded.'],
        MEDIA / 'pdf-move-poster.jpg', CREAM, 'og-pdf.jpg', (0.5, 0.05))
image_poster = MEDIA / 'image-move-poster.jpg'
if image_poster.exists():
    product('berg:work Image', ['LAYERS,', 'IN YOUR', 'BROWSER.'], ['Cut out, compose, adjust.', 'Your photos stay on your computer.'],
            image_poster, INK, 'og-image.jpg', (0.17, 0.5))
print('og images written to', OUT)
