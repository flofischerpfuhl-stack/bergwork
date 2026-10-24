"""Minimal AVIF encoder through the system libavif (1.0.x) via ctypes: avif_encode(rgba_uint8 HxWx4, path)."""
import ctypes, numpy as np
lib = ctypes.CDLL('libavif.so.16')
class RGB(ctypes.Structure):
    _fields_ = [('width', ctypes.c_uint32), ('height', ctypes.c_uint32), ('depth', ctypes.c_uint32), ('format', ctypes.c_int),
                ('chromaUpsampling', ctypes.c_int), ('chromaDownsampling', ctypes.c_int), ('avoidLibYUV', ctypes.c_int),
                ('ignoreAlpha', ctypes.c_int), ('alphaPremultiplied', ctypes.c_int), ('isFloat', ctypes.c_int),
                ('maxThreads', ctypes.c_int), ('pixels', ctypes.POINTER(ctypes.c_uint8)), ('rowBytes', ctypes.c_uint32),
                ('_pad', ctypes.c_uint8 * 64)]
class RW(ctypes.Structure):
    _fields_ = [('data', ctypes.POINTER(ctypes.c_uint8)), ('size', ctypes.c_size_t)]
lib.avifImageCreate.restype = ctypes.c_void_p
lib.avifEncoderCreate.restype = ctypes.c_void_p
lib.avifCodecName.restype = ctypes.c_char_p
lib.avifVersion.restype = ctypes.c_char_p

def avif_encode(rgba, path, lossless=False):
    h, w, _ = rgba.shape
    img = lib.avifImageCreate(w, h, 8, 1 if not lossless else 1)  # AVIF_PIXEL_FORMAT_YUV444 = 1
    rgb = RGB()
    lib.avifRGBImageSetDefaults(ctypes.byref(rgb), ctypes.c_void_p(img))
    rgb.format = 1  # AVIF_RGB_FORMAT_RGBA
    assert lib.avifRGBImageAllocatePixels(ctypes.byref(rgb)) == 0
    buf = np.ascontiguousarray(rgba, dtype=np.uint8)
    for y in range(h):
        ctypes.memmove(ctypes.addressof(rgb.pixels.contents) + y * rgb.rowBytes, buf[y].ctypes.data, w * 4)
    r = lib.avifImageRGBToYUV(ctypes.c_void_p(img), ctypes.byref(rgb)); assert r == 0, r
    enc = lib.avifEncoderCreate()
    out = RW()
    r = lib.avifEncoderWrite(ctypes.c_void_p(enc), ctypes.c_void_p(img), ctypes.byref(out)); assert r == 0, r
    data = ctypes.string_at(out.data, out.size)
    open(path, 'wb').write(data)
    lib.avifRWDataFree(ctypes.byref(out)); lib.avifEncoderDestroy(ctypes.c_void_p(enc))
    lib.avifRGBImageFreePixels(ctypes.byref(rgb)); lib.avifImageDestroy(ctypes.c_void_p(img))
    return len(data)

if __name__ == '__main__':
    print(lib.avifVersion(), lib.avifCodecName(0, 2))
    a = np.zeros((32, 48, 4), np.uint8); a[..., 0] = 200; a[..., 3] = 255
    print(avif_encode(a, '/tmp/fw-qa-files/probe.avif'))
