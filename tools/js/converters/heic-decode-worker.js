// Decodes one HEIC/HEIF photo off the main thread and posts its primary image back as RGBA.
// libheif (LGPL-3.0) stays the separate, replaceable file below; see LICENSES/THIRD_PARTY.md.
importScripts('/tools/vendor/libheif-js-1.23.5/libheif-bundle.js');

const ICC_RED_COLORANT_TAG = 0x7258595a; // 'rXYZ'
const DISPLAY_P3_RED_X = 0.5151;

// True when the image carries an ICC profile with Display P3 primaries, as iPhone photos do.
function hasDisplayP3Profile(lib, handle) {
  const pointer = handle.$$.ptr;
  const size = lib._heif_image_handle_get_raw_color_profile_size(pointer);
  if (!size) return false;
  const error = lib._malloc(16);
  const buffer = lib._malloc(size);
  lib._heif_image_handle_get_raw_color_profile(error, pointer, buffer);
  const icc = new DataView(lib.HEAPU8.slice(buffer, buffer + size).buffer);
  lib._free(buffer);
  lib._free(error);
  const tagCount = icc.getUint32(128);
  for (let index = 0; index < tagCount; index += 1) {
    const entry = 132 + index * 12;
    if (icc.getUint32(entry) !== ICC_RED_COLORANT_TAG) continue;
    const redX = icc.getInt32(icc.getUint32(entry + 4) + 8) / 65536;
    return Math.abs(redX - DISPLAY_P3_RED_X) < 0.01;
  }
  return false;
}

// Display P3 and sRGB share their transfer curve, so this is decode, primaries matrix, encode. Done here rather than
// with a display-p3 ImageData because Safari draws those without converting them.
function convertDisplayP3ToSrgb(rgba) {
  const toLinear = Float32Array.from({ length: 256 }, (_, value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const steps = 4095;
  const toEncoded = Uint8ClampedArray.from({ length: steps + 1 }, (_, value) => {
    const channel = value / steps;
    return 255 * (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);
  });
  const encode = (channel) => toEncoded[Math.round(Math.min(1, Math.max(0, channel)) * steps)];
  for (let index = 0; index < rgba.length; index += 4) {
    const red = toLinear[rgba[index]];
    const green = toLinear[rgba[index + 1]];
    const blue = toLinear[rgba[index + 2]];
    rgba[index] = encode(1.2249402 * red - 0.2249402 * green);
    rgba[index + 1] = encode(-0.042057 * red + 1.042057 * green);
    rgba[index + 2] = encode(-0.0196376 * red - 0.078636 * green + 1.0982736 * blue);
  }
}

self.postMessage({ ready: true });

self.onmessage = async ({ data: { bytes } }) => {
  try {
    const lib = await libheif();
    const context = lib.heif_context_alloc();
    const readError = lib.heif_context_read_from_memory(context, bytes);
    if (readError.code !== lib.heif_error_code.heif_error_Ok) throw new Error(readError.message);
    const handle = lib.heif_js_context_get_primary_image_handle(context);
    if (!handle || handle.code) throw new Error(handle?.message || 'No image in this file');
    const image = new lib.HeifImage(handle);
    const width = image.get_width();
    const height = image.get_height();
    const rgba = new Uint8ClampedArray(width * height * 4);
    const decoded = await new Promise((resolve) => image.display({ data: rgba, width, height }, resolve));
    if (!decoded) throw new Error('The image data could not be decoded');
    try {
      if (hasDisplayP3Profile(lib, handle)) convertDisplayP3ToSrgb(rgba);
    } catch {} // An unreadable profile must not cost the user the photo.
    self.postMessage({ rgba, width, height }, [rgba.buffer]);
  } catch (error) {
    self.postMessage({ error: error?.message || String(error) });
  }
};
