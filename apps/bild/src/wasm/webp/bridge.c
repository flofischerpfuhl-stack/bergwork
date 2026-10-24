#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <webp/decode.h>
#include <webp/demux.h>
#include <webp/encode.h>

static uint8_t *result_data;
static size_t result_size;

EMSCRIPTEN_KEEPALIVE void fernwork_webp_release(void) {
    free(result_data);
    result_data = NULL;
    result_size = 0;
}

EMSCRIPTEN_KEEPALIVE int fernwork_webp_decode(const uint8_t *bytes, size_t length,
                                              uint32_t expected_width, uint32_t expected_height) {
    WebPData input = { bytes, length };
    WebPAnimDecoderOptions options;
    WebPAnimDecoder *decoder = NULL;
    WebPAnimInfo info;
    uint8_t *decoded = NULL;
    int timestamp = 0;
    int width = 0, height = 0, ok = 0;
    fernwork_webp_release();
    if (!bytes || !length || !WebPAnimDecoderOptionsInit(&options)) return 1;
    options.color_mode = MODE_RGBA;
    options.use_threads = 0;
    decoder = WebPAnimDecoderNew(&input, &options);
    if (!decoder || !WebPAnimDecoderGetInfo(decoder, &info)) goto done;
    width = (int)info.canvas_width;
    height = (int)info.canvas_height;
    if (width <= 0 || height <= 0 || (uint32_t)width != expected_width ||
        (uint32_t)height != expected_height || (size_t)width > SIZE_MAX / 4 ||
        (size_t)height > SIZE_MAX / ((size_t)width * 4)) goto done;
    result_size = (size_t)width * (size_t)height * 4;
    result_data = (uint8_t *)malloc(result_size);
    if (!result_data || !WebPAnimDecoderGetNext(decoder, &decoded, &timestamp) || !decoded) goto done;
    memcpy(result_data, decoded, result_size); /* first fully composited frame */
    ok = 1;
done:
    if (decoder) WebPAnimDecoderDelete(decoder);
    if (!ok) fernwork_webp_release();
    return ok ? 0 : 2;
}

EMSCRIPTEN_KEEPALIVE int fernwork_webp_encode(const uint8_t *rgba, uint32_t width, uint32_t height,
                                              float quality, int lossless, int alpha_quality) {
    WebPConfig config;
    WebPPicture picture;
    WebPMemoryWriter writer;
    fernwork_webp_release();
    if (!rgba || !width || !height || width > INT32_MAX / 4 || height > INT32_MAX ||
        quality < 0.0f || quality > 100.0f || alpha_quality < 0 || alpha_quality > 100) return 1;
    if (!WebPConfigInit(&config) || !WebPPictureInit(&picture)) return 2;
    config.lossless = lossless ? 1 : 0;
    config.quality = quality;
    config.alpha_quality = alpha_quality;
    config.method = 4;
    if (!WebPValidateConfig(&config)) return 3;
    picture.width = (int)width;
    picture.height = (int)height;
    picture.use_argb = 1;
    if (!WebPPictureImportRGBA(&picture, rgba, (int)(width * 4))) {
        WebPPictureFree(&picture);
        return 4;
    }
    WebPMemoryWriterInit(&writer);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;
    if (!WebPEncode(&config, &picture)) {
        WebPPictureFree(&picture);
        WebPMemoryWriterClear(&writer);
        return 5;
    }
    WebPPictureFree(&picture);
    result_data = (uint8_t *)malloc(writer.size);
    if (!result_data) { WebPMemoryWriterClear(&writer); return 6; }
    memcpy(result_data, writer.mem, writer.size);
    result_size = writer.size;
    WebPMemoryWriterClear(&writer);
    return 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t fernwork_webp_result_data(void) { return (uintptr_t)result_data; }
EMSCRIPTEN_KEEPALIVE size_t fernwork_webp_result_size(void) { return result_size; }
