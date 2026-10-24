#!/usr/bin/env python3
"""Generates the QA import corpus (files the developers have never seen) plus sRGB references.

Output: /tmp/fw-qa-files/import/<case files>, <case>.ref.bin (straight RGBA8 in sRGB, row-major) and manifest.json.
Every image has a distinct marker in each corner (TL red, TR green, BL blue, BR white) so orientation errors show.
Run: python3 tests/qa-tools/make_files.py [outdir]
"""
import io, json, os, struct, subprocess, sys, zlib
import numpy as np
from PIL import Image, ImageCms

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/fw-qa-files/import'
os.makedirs(OUT, exist_ok=True)
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(__file__))
from avif_encode import avif_encode  # noqa: E402

W, H = 96, 64
ICC = '/usr/share/color/icc'
cases = []


def base_rgb16():
    """Smooth 16-bit content with corner markers (values 0..65535)."""
    y, x = np.mgrid[0:H, 0:W].astype(np.float64)
    r = x / (W - 1)
    g = y / (H - 1)
    b = 0.5 + 0.5 * np.sin(x / 9.0) * np.cos(y / 7.0)
    img = np.stack([r, g, b], -1)
    m = 12
    img[:m, :m] = [1, 0, 0]
    img[:m, -m:] = [0, 1, 0]
    img[-m:, :m] = [0, 0, 1]
    img[-m:, -m:] = [1, 1, 1]
    return np.round(img * 65535).astype(np.uint16)


RGB16 = base_rgb16()
RGB8 = np.round(RGB16 / 257.0).astype(np.uint8)
yy, xx = np.mgrid[0:H, 0:W]
ALPHA8 = np.clip(np.round(xx / (W - 1) * 255), 0, 255).astype(np.uint8)
ALPHA8[:, :4] = 0            # fully transparent strip
ALPHA8[:, -4:] = 255         # opaque strip
ALPHA16 = (ALPHA8.astype(np.uint32) * 257).astype(np.uint16)


def rgba8(rgb8, a8=None):
    a = np.full(rgb8.shape[:2], 255, np.uint8) if a8 is None else a8
    return np.dstack([rgb8, a])


def add(name, mime, ref, **kw):
    ref = np.ascontiguousarray(ref, dtype=np.uint8)
    ref.tofile(os.path.join(OUT, name + '.ref.bin'))
    cases.append(dict(file=name, mime=mime, width=int(ref.shape[1]), height=int(ref.shape[0]), **kw))


# ---------------------------------------------------------------- PNG writer (any colour type / depth / chunks)
def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def write_png(path, arr, color_type, bit_depth, extra=b'', palette=None, trns=None):
    h, w = arr.shape[:2]
    if bit_depth == 16:
        raw_rows = [b'\x00' + arr[y].astype('>u2').tobytes() for y in range(h)]
    elif bit_depth == 8:
        raw_rows = [b'\x00' + arr[y].astype(np.uint8).tobytes() for y in range(h)]
    else:  # packed 1/2/4-bit gray or palette indices
        per = 8 // bit_depth
        rows = []
        for y in range(h):
            row = arr[y].astype(np.uint8)
            pad = (-len(row)) % per
            row = np.concatenate([row, np.zeros(pad, np.uint8)]).reshape(-1, per)
            packed = np.zeros(row.shape[0], np.uint8)
            for i in range(per):
                packed |= (row[:, i] << (8 - bit_depth * (i + 1))).astype(np.uint8)
            rows.append(b'\x00' + packed.tobytes())
        raw_rows = rows
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, bit_depth, color_type, 0, 0, 0))
    png += extra
    if palette is not None:
        png += chunk(b'PLTE', bytes(np.asarray(palette, np.uint8).ravel()))
    if trns is not None:
        png += chunk(b'tRNS', trns)
    png += chunk(b'IDAT', zlib.compress(b''.join(raw_rows), 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def png_chrm_srgb():
    v = [0.3127, 0.3290, 0.64, 0.33, 0.30, 0.60, 0.15, 0.06]
    return chunk(b'cHRM', struct.pack('>8I', *[round(x * 100000) for x in v])) + chunk(b'gAMA', struct.pack('>I', 45455))


write_png(f'{OUT}/png8_rgb.png', RGB8, 2, 8); add('png8_rgb.png', 'image/png', rgba8(RGB8), max=0.01, bits=8)
write_png(f'{OUT}/png8_rgba.png', rgba8(RGB8, ALPHA8), 6, 8)
add('png8_rgba.png', 'image/png', rgba8(RGB8, ALPHA8), max=0.01, alpha=True, bits=8)
write_png(f'{OUT}/png16_rgb.png', RGB16, 2, 16); add('png16_rgb.png', 'image/png', rgba8(RGB8), max=0.6, bits=16)
write_png(f'{OUT}/png16_rgba.png', np.dstack([RGB16, ALPHA16]), 6, 16)
add('png16_rgba.png', 'image/png', rgba8(RGB8, ALPHA8), max=0.6, alpha=True, bits=16)
G16 = RGB16[..., 1]
G8 = RGB8[..., 1]
write_png(f'{OUT}/png16_gray.png', G16, 0, 16); add('png16_gray.png', 'image/png', rgba8(np.dstack([G8] * 3)), max=0.6, bits=16)
write_png(f'{OUT}/png8_gray.png', G8, 0, 8); add('png8_gray.png', 'image/png', rgba8(np.dstack([G8] * 3)), max=0.01)
write_png(f'{OUT}/png8_grayalpha.png', np.dstack([G8, ALPHA8]), 4, 8)
add('png8_grayalpha.png', 'image/png', rgba8(np.dstack([G8] * 3), ALPHA8), max=0.01, alpha=True)
# 1-bit gray checkerboard
chk = (((xx // 8) + (yy // 8)) % 2).astype(np.uint8)
write_png(f'{OUT}/png1_gray.png', chk, 0, 1); add('png1_gray.png', 'image/png', rgba8(np.dstack([chk * 255] * 3)), max=0.01)
# 4-bit palette with a partially transparent tRNS
pal = np.array([[i * 17, 255 - i * 17, (i * 53) % 256] for i in range(16)], np.uint8)
idx = ((xx // 6) % 16).astype(np.uint8)
alph = np.array([0, 64, 128, 200] + [255] * 12, np.uint8)
write_png(f'{OUT}/png4_palette_trns.png', idx, 3, 4, palette=pal, trns=bytes(alph))
add('png4_palette_trns.png', 'image/png', np.dstack([pal[idx], alph[idx]]), max=0.01, alpha=True)
# 8-bit palette (Pillow quantised)
pimg = Image.fromarray(RGB8).quantize(64)
pimg.save(f'{OUT}/png8_palette.png')
add('png8_palette.png', 'image/png', rgba8(np.asarray(pimg.convert('RGB'))), max=0.01)
# 16-bit RGB PNG tagged like ImageMagick writes it (cHRM = sRGB primaries, gAMA 1/2.2): still sRGB
write_png(f'{OUT}/png16_chrm_srgb.png', RGB16, 2, 16, extra=png_chrm_srgb())
# The PNG spec makes gAMA 1/2.2 a pure power curve (as Chromium decodes it), so the reference goes 2.2 -> linear -> sRGB.
g22 = (RGB16.astype(np.float64) / 65535) ** (1 / 0.45455)
g22 = np.where(g22 <= 0.0031308, g22 * 12.92, 1.055 * g22 ** (1 / 2.4) - 0.055)
add('png16_chrm_srgb.png', 'image/png', rgba8(np.round(g22 * 255).astype(np.uint8)), max=0.6, bits=16)
# 8-bit linear-gamma PNG (gAMA = 1.0): reference = linear -> sRGB transfer
lin = RGB8.astype(np.float64) / 255
srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
write_png(f'{OUT}/png8_gamma1.png', RGB8, 2, 8, extra=chunk(b'gAMA', struct.pack('>I', 100000)))
add('png8_gamma1.png', 'image/png', rgba8(np.round(srgb * 255).astype(np.uint8)), max=2.0)
# Adam7 interlaced PNG through ImageMagick
subprocess.run(['convert', f'{OUT}/png8_rgba.png', '-interlace', 'PNG', f'PNG32:{OUT}/png8_interlaced.png'], check=True)
add('png8_interlaced.png', 'image/png', rgba8(RGB8, ALPHA8), max=0.01, alpha=True)

# ---------------------------------------------------------------- JPEG
src = Image.fromarray(RGB8)
src.save(f'{OUT}/jpeg_baseline.jpg', quality=95)
add('jpeg_baseline.jpg', 'image/jpeg', rgba8(RGB8), max=3.0)
src.save(f'{OUT}/jpeg_progressive.jpg', quality=95, progressive=True)
add('jpeg_progressive.jpg', 'image/jpeg', rgba8(RGB8), max=3.0)
src.convert('L').save(f'{OUT}/jpeg_gray.jpg', quality=95)
add('jpeg_gray.jpg', 'image/jpeg', rgba8(np.dstack([np.asarray(src.convert('L'))] * 3)), max=3.0)


def with_orientation(img_display, orientation, path, icc=None):
    """Stores pixels so that applying EXIF `orientation` shows `img_display`."""
    inverse = {6: Image.Transpose.ROTATE_90, 8: Image.Transpose.ROTATE_270, 3: Image.Transpose.ROTATE_180,
               5: Image.Transpose.TRANSPOSE, 7: Image.Transpose.TRANSVERSE, 2: Image.Transpose.FLIP_LEFT_RIGHT}[orientation]
    stored = img_display.transpose(inverse)
    exif = Image.Exif(); exif[0x0112] = orientation
    kw = dict(quality=95, exif=exif.tobytes())
    if icc: kw['icc_profile'] = icc
    stored.save(path, **kw)
    from PIL import ImageOps
    check = ImageOps.exif_transpose(Image.open(path))
    assert check.size == img_display.size, (path, check.size)


with_orientation(src, 6, f'{OUT}/jpeg_exif6.jpg'); add('jpeg_exif6.jpg', 'image/jpeg', rgba8(RGB8), max=3.0)
with_orientation(src, 8, f'{OUT}/jpeg_exif8.jpg'); add('jpeg_exif8.jpg', 'image/jpeg', rgba8(RGB8), max=3.0)
with_orientation(src, 5, f'{OUT}/jpeg_exif5.jpg'); add('jpeg_exif5.jpg', 'image/jpeg', rgba8(RGB8), max=3.0)

srgb_p = ImageCms.getOpenProfile(f'{ICC}/sRGB.icc')


def to_profile(img, dst_path, mode='RGB'):
    dst = ImageCms.getOpenProfile(dst_path)
    return ImageCms.profileToProfile(img, srgb_p, dst, outputMode=mode, renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC)


# Content well inside the sRGB gamut, converted into a wide-gamut space and tagged: import must bring it back.
wide = f'{ICC}/colord/WideGamutRGB.icc'
wimg = to_profile(src, wide)
wimg.save(f'{OUT}/jpeg_widegamut_icc.jpg', quality=97, icc_profile=open(wide, 'rb').read())
add('jpeg_widegamut_icc.jpg', 'image/jpeg', rgba8(RGB8), max=5.0)
# ICC + EXIF 6: the lcms path applies orientation itself
with_orientation(wimg, 6, f'{OUT}/jpeg_icc_exif6.jpg', icc=open(wide, 'rb').read())
add('jpeg_icc_exif6.jpg', 'image/jpeg', rgba8(RGB8), max=5.0)
with_orientation(wimg, 8, f'{OUT}/jpeg_icc_exif8.jpg', icc=open(wide, 'rb').read())
add('jpeg_icc_exif8.jpg', 'image/jpeg', rgba8(RGB8), max=5.0)
# 8-bit PNG tagged with a wide-gamut ICC profile (as Photoshop writes "Embed Color Profile")
wimg.save(f'{OUT}/png8_iccp_widegamut.png', icc_profile=open(wide, 'rb').read())
add('png8_iccp_widegamut.png', 'image/png', rgba8(RGB8), max=2.0)
# CMYK JPEG (Adobe APP14, inverted like Photoshop) with a FOGRA profile, made by ImageMagick; reference = IM back to sRGB
fogra = f'{ICC}/colord/FOGRA27L_coated.icc'
subprocess.run(['convert', f'{OUT}/png8_rgb.png', '-profile', f'{ICC}/sRGB.icc', '-intent', 'Relative', '-profile', fogra,
                '-quality', '97', f'{OUT}/jpeg_cmyk_fogra.jpg'], check=True)
ref = subprocess.run(['convert', f'{OUT}/jpeg_cmyk_fogra.jpg', '-intent', 'Relative', '-profile', f'{ICC}/sRGB.icc', '-depth', '8',
                      'RGBA:-'], check=True, capture_output=True).stdout
add('jpeg_cmyk_fogra.jpg', 'image/jpeg', np.frombuffer(ref, np.uint8).reshape(H, W, 4), max=6.0,
    note='reference: ImageMagick/lcms relative colorimetric; perceptual vs relative intent may differ a little')

# ---------------------------------------------------------------- TIFF
subprocess.run(['convert', f'{OUT}/png16_rgb.png', '-depth', '16', '-compress', 'lzw', f'{OUT}/tiff16_lzw.tif'], check=True)
add('tiff16_lzw.tif', 'image/tiff', rgba8(RGB8), max=0.6, bits=16)
subprocess.run(['convert', f'{OUT}/png16_rgb.png', '-depth', '16', '-compress', 'zip', '-define', 'tiff:predictor=2',
                '-endian', 'MSB', f'{OUT}/tiff16_zip_pred_be.tif'], check=True)
add('tiff16_zip_pred_be.tif', 'image/tiff', rgba8(RGB8), max=0.6, bits=16)
subprocess.run(['convert', f'{OUT}/png8_rgb.png', '-compress', 'lzw', '-define', 'tiff:predictor=2', f'{OUT}/tiff8_lzw_pred.tif'], check=True)
add('tiff8_lzw_pred.tif', 'image/tiff', rgba8(RGB8), max=0.01)
# Unassociated alpha (ExtraSamples = 2) and associated/premultiplied alpha (ExtraSamples = 1)
subprocess.run(['convert', f'{OUT}/png8_rgba.png', '-define', 'tiff:alpha=unassociated', '-compress', 'lzw', f'{OUT}/tiff8_rgba_unassoc.tif'], check=True)
add('tiff8_rgba_unassoc.tif', 'image/tiff', rgba8(RGB8, ALPHA8), max=0.6, alpha=True)
subprocess.run(['convert', f'{OUT}/png8_rgba.png', '-define', 'tiff:alpha=associated', '-compress', 'lzw', f'{OUT}/tiff8_rgba_assoc.tif'], check=True)
add('tiff8_rgba_assoc.tif', 'image/tiff', rgba8(RGB8, ALPHA8), max=2.0, alpha=True,
    note='associated alpha: colour is compared where alpha >= 64 only (premultiplied rounding)')
# Multipage: page 1 is the reference, page 2 something else entirely
Image.fromarray(np.full((H, W, 3), [10, 200, 30], np.uint8)).save(f'{OUT}/_page2.png')
subprocess.run(['convert', f'{OUT}/png8_rgb.png', f'{OUT}/_page2.png', '-compress', 'lzw', f'{OUT}/tiff_multipage.tif'], check=True)
os.remove(f'{OUT}/_page2.png')
add('tiff_multipage.tif', 'image/tiff', rgba8(RGB8), max=0.01)
subprocess.run(['convert', f'{OUT}/png8_rgb.png', '-define', 'tiff:tile-geometry=32x32', '-compress', 'zip', f'{OUT}/tiff8_tiled.tif'], check=True)
add('tiff8_tiled.tif', 'image/tiff', rgba8(RGB8), max=0.01)
subprocess.run(['convert', f'{OUT}/png16_gray.png', '-depth', '16', '-compress', 'none', f'{OUT}/tiff16_gray.tif'], check=True)
add('tiff16_gray.tif', 'image/tiff', rgba8(np.dstack([G8] * 3)), max=0.6, bits=16)
subprocess.run(['convert', f'{OUT}/png8_rgb.png', '-interlace', 'plane', '-compress', 'lzw', f'{OUT}/tiff8_planar.tif'], check=True)
add('tiff8_planar.tif', 'image/tiff', rgba8(RGB8), max=0.01)

# ---------------------------------------------------------------- WebP
src.save(f'{OUT}/webp_lossy.webp', quality=95)
add('webp_lossy.webp', 'image/webp', rgba8(RGB8), max=3.0)
src.save(f'{OUT}/webp_lossless.webp', lossless=True)
add('webp_lossless.webp', 'image/webp', rgba8(RGB8), max=0.01)
Image.fromarray(rgba8(RGB8, ALPHA8)).save(f'{OUT}/webp_lossless_alpha.webp', lossless=True, exact=True)
add('webp_lossless_alpha.webp', 'image/webp', rgba8(RGB8, ALPHA8), max=0.01, alpha=True)
Image.fromarray(rgba8(RGB8, ALPHA8)).save(f'{OUT}/webp_lossy_alpha.webp', quality=95)
add('webp_lossy_alpha.webp', 'image/webp', rgba8(RGB8, ALPHA8), max=4.0, alpha=True)
frame1 = Image.fromarray(rgba8(RGB8)); frame2 = Image.fromarray(np.full((H, W, 4), [0, 0, 255, 255], np.uint8))
frame1.save(f'{OUT}/webp_animated.webp', save_all=True, append_images=[frame2], duration=100, loop=0, lossless=True)
add('webp_animated.webp', 'image/webp', rgba8(RGB8), max=0.01, note='first frame expected')

# ---------------------------------------------------------------- GIF
gp = Image.fromarray(RGB8).quantize(255)
gp.save(f'{OUT}/gif_static.gif')
add('gif_static.gif', 'image/gif', rgba8(np.asarray(gp.convert('RGB'))), max=0.01)
tr = gp.copy(); a = np.asarray(tr).copy(); a[:, :10] = 255; tr = Image.fromarray(a, 'P'); tr.putpalette(gp.getpalette())
tr.save(f'{OUT}/gif_transparent.gif', transparency=255)
ref = np.asarray(tr.convert('RGBA')).copy(); ref[:, :10] = [0, 0, 0, 0]
add('gif_transparent.gif', 'image/gif', ref, max=0.01, alpha=True)
f2 = Image.fromarray(np.full((H, W, 3), [0, 0, 255], np.uint8)).quantize(4)
gp.save(f'{OUT}/gif_animated.gif', save_all=True, append_images=[f2], duration=100, loop=0)
add('gif_animated.gif', 'image/gif', rgba8(np.asarray(gp.convert('RGB'))), max=0.01, note='first frame expected')
gp.save(f'{OUT}/gif_interlaced.gif', interlace=True)
add('gif_interlaced.gif', 'image/gif', rgba8(np.asarray(gp.convert('RGB'))), max=0.01)

# ---------------------------------------------------------------- AVIF (libavif + aom, 4:4:4)
avif_encode(rgba8(RGB8), f'{OUT}/avif_rgb.avif')
add('avif_rgb.avif', 'image/avif', rgba8(RGB8), max=4.0)
avif_encode(rgba8(RGB8, ALPHA8), f'{OUT}/avif_alpha.avif')
add('avif_alpha.avif', 'image/avif', rgba8(RGB8, ALPHA8), max=4.0, alpha=True)

# ---------------------------------------------------------------- precision probes (not colour cases: listed in precision.json)
GW = 2048
ramp16 = np.round(np.linspace(0, 65535, GW)).astype(np.uint16)
grad16 = np.repeat(np.stack([ramp16, 65535 - ramp16, ramp16], -1)[None], 4, 0)
write_png(f'{OUT}/prec_png16_plain.png', grad16, 2, 16)
srgb_icc = open(f'{ICC}/sRGB.icc', 'rb').read()
iccp = chunk(b'iCCP', b'sRGB IEC61966-2.1\x00\x00' + zlib.compress(srgb_icc))
write_png(f'{OUT}/prec_png16_iccp_srgb.png', grad16, 2, 16, extra=iccp)
write_png(f'{OUT}/prec_png16_chrm.png', grad16, 2, 16, extra=png_chrm_srgb())
subprocess.run(['convert', f'{OUT}/prec_png16_plain.png', '-depth', '16', '-type', 'TrueColor', '-profile', f'{ICC}/sRGB.icc', '-compress', 'lzw',
                f'{OUT}/prec_tiff16_icc.tif'], check=True)
subprocess.run(['convert', f'{OUT}/prec_png16_plain.png', '-depth', '16', '-compress', 'lzw', f'{OUT}/prec_tiff16_plain.tif'], check=True)
# Lossless WebP whose colour must survive at low alpha (canvas premultiplication would quantise it)
la = np.zeros((16, 256, 4), np.uint8)
la[..., 0] = np.arange(256)[None]; la[..., 1] = 255 - np.arange(256)[None]; la[..., 2] = 77
la[..., 3] = (np.arange(16)[:, None] * 4 + 1)  # alpha 1..61
Image.fromarray(la).save(f'{OUT}/prec_webp_lossless_lowalpha.webp', lossless=True, exact=True)
la.tofile(f'{OUT}/prec_webp_lossless_lowalpha.webp.ref.bin')
Image.fromarray(la).save(f'{OUT}/prec_png_lowalpha.png')

json.dump(cases, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print(f'{len(cases)} cases in {OUT}')
