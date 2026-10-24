#include <avif/avif.h>
#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *result_data;
static size_t result_size;
static uint8_t *result_icc;
static size_t result_icc_size;
static uint32_t result_width;
static uint32_t result_height;
static uint8_t result_orientation;

EMSCRIPTEN_KEEPALIVE void fernwork_avif_release(void) {
    free(result_data); free(result_icc);
    result_data = NULL; result_icc = NULL;
    result_size = result_icc_size = 0;
    result_width = result_height = 0;
    result_orientation = 1;
}

/* ISO/IEC 23008-12 irot/imir to EXIF orientation, matching libavif src/exif.c. */
static uint8_t image_orientation(const avifImage *image) {
    const int rotate = (image->transformFlags & AVIF_TRANSFORM_IROT) ? image->irot.angle : 0;
    const int mirror = (image->transformFlags & AVIF_TRANSFORM_IMIR) ? image->imir.axis + 1 : 0;
    if (rotate == 0) return mirror == 1 ? 4 : mirror == 2 ? 2 : 1;
    if (rotate == 1) return mirror == 1 ? 5 : mirror == 2 ? 7 : 8;
    if (rotate == 2) return mirror == 1 ? 2 : mirror == 2 ? 4 : 3;
    return mirror == 1 ? 7 : mirror == 2 ? 5 : 6;
}

EMSCRIPTEN_KEEPALIVE int fernwork_avif_decode(const uint8_t *bytes, size_t length) {
    avifDecoder *decoder = NULL;
    avifRGBImage rgb;
    avifCropRect crop;
    avifResult status;
    uint8_t *converted = NULL;
    fernwork_avif_release();
    if (!bytes || !length) return 1;
    decoder = avifDecoderCreate();
    if (!decoder) return 2;
    decoder->maxThreads = 1;
    decoder->imageContentToDecode = AVIF_IMAGE_CONTENT_COLOR_AND_ALPHA;
    status = avifDecoderSetIOMemory(decoder, bytes, length);
    if (status == AVIF_RESULT_OK) status = avifDecoderParse(decoder);
    if (status == AVIF_RESULT_OK) status = avifDecoderNextImage(decoder); /* first frame only */
    if (status != AVIF_RESULT_OK || !decoder->image || !decoder->image->width || !decoder->image->height ||
        (size_t)decoder->image->width > SIZE_MAX / 4 ||
        (size_t)decoder->image->height > SIZE_MAX / ((size_t)decoder->image->width * 4)) {
        avifDecoderDestroy(decoder); return 3;
    }
    crop.x = 0; crop.y = 0; crop.width = decoder->image->width; crop.height = decoder->image->height;
    if ((decoder->image->transformFlags & AVIF_TRANSFORM_CLAP) &&
        !avifCropRectFromCleanApertureBox(&crop, &decoder->image->clap, decoder->image->width,
                                         decoder->image->height, &decoder->diag)) {
        avifDecoderDestroy(decoder); return 4;
    }
    result_width = crop.width;
    result_height = crop.height;
    result_size = (size_t)result_width * result_height * 4;
    result_data = (uint8_t *)malloc(result_size);
    if (!result_data) { avifDecoderDestroy(decoder); fernwork_avif_release(); return 5; }
    avifRGBImageSetDefaults(&rgb, decoder->image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 8;
    if (crop.x || crop.y || crop.width != decoder->image->width || crop.height != decoder->image->height) {
        converted = (uint8_t *)malloc((size_t)decoder->image->width * decoder->image->height * 4);
        if (!converted) { avifDecoderDestroy(decoder); fernwork_avif_release(); return 6; }
    }
    rgb.pixels = converted ? converted : result_data;
    rgb.rowBytes = decoder->image->width * 4;
    status = avifImageYUVToRGB(decoder->image, &rgb);
    if (status != AVIF_RESULT_OK) { free(converted); avifDecoderDestroy(decoder); fernwork_avif_release(); return 7; }
    if (converted) {
        for (uint32_t y = 0; y < crop.height; ++y) {
            memcpy(result_data + (size_t)y * crop.width * 4,
                   converted + ((size_t)(crop.y + y) * decoder->image->width + crop.x) * 4,
                   (size_t)crop.width * 4);
        }
        free(converted);
    }
    result_orientation = image_orientation(decoder->image);
    if (decoder->image->icc.size) {
        result_icc = (uint8_t *)malloc(decoder->image->icc.size);
        if (!result_icc) { avifDecoderDestroy(decoder); fernwork_avif_release(); return 8; }
        memcpy(result_icc, decoder->image->icc.data, decoder->image->icc.size);
        result_icc_size = decoder->image->icc.size;
    }
    avifDecoderDestroy(decoder);
    return 0;
}

EMSCRIPTEN_KEEPALIVE int fernwork_avif_encode(const uint8_t *rgba, uint32_t width, uint32_t height,
                                              int quality, int alpha_quality, int speed,
                                              const uint8_t *icc, size_t icc_size) {
    avifImage *image = NULL;
    avifEncoder *encoder = NULL;
    avifRGBImage rgb;
    avifRWData output = AVIF_DATA_EMPTY;
    avifResult status;
    fernwork_avif_release();
    if (!rgba || !width || !height || quality < 0 || quality > 100 || alpha_quality < 0 ||
        alpha_quality > 100 || speed < 0 || speed > 10) return 1;
    image = avifImageCreate(width, height, 8, AVIF_PIXEL_FORMAT_YUV444);
    encoder = avifEncoderCreate();
    if (!image || !encoder) { avifImageDestroy(image); avifEncoderDestroy(encoder); return 2; }
    image->colorPrimaries = AVIF_COLOR_PRIMARIES_BT709;
    image->transferCharacteristics = AVIF_TRANSFER_CHARACTERISTICS_SRGB;
    image->matrixCoefficients = AVIF_MATRIX_COEFFICIENTS_BT601;
    if (icc_size && (!icc || avifImageSetProfileICC(image, icc, icc_size) != AVIF_RESULT_OK)) {
        avifEncoderDestroy(encoder); avifImageDestroy(image); return 3;
    }
    avifRGBImageSetDefaults(&rgb, image);
    rgb.format = AVIF_RGB_FORMAT_RGBA;
    rgb.depth = 8;
    rgb.pixels = (uint8_t *)rgba;
    rgb.rowBytes = width * 4;
    status = avifImageRGBToYUV(image, &rgb);
    encoder->quality = quality;
    encoder->qualityAlpha = alpha_quality;
    encoder->speed = speed;
    if (status == AVIF_RESULT_OK) status = avifEncoderWrite(encoder, image, &output);
    if (status != AVIF_RESULT_OK || !output.data || !output.size) {
        avifRWDataFree(&output); avifEncoderDestroy(encoder); avifImageDestroy(image); return 4;
    }
    result_data = (uint8_t *)malloc(output.size);
    if (!result_data) { avifRWDataFree(&output); avifEncoderDestroy(encoder); avifImageDestroy(image); return 5; }
    memcpy(result_data, output.data, output.size);
    result_size = output.size;
    avifRWDataFree(&output);
    avifEncoderDestroy(encoder);
    avifImageDestroy(image);
    return 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t fernwork_avif_result_data(void) { return (uintptr_t)result_data; }
EMSCRIPTEN_KEEPALIVE size_t fernwork_avif_result_size(void) { return result_size; }
EMSCRIPTEN_KEEPALIVE uintptr_t fernwork_avif_result_icc(void) { return (uintptr_t)result_icc; }
EMSCRIPTEN_KEEPALIVE size_t fernwork_avif_result_icc_size(void) { return result_icc_size; }
EMSCRIPTEN_KEEPALIVE uint32_t fernwork_avif_result_width(void) { return result_width; }
EMSCRIPTEN_KEEPALIVE uint32_t fernwork_avif_result_height(void) { return result_height; }
EMSCRIPTEN_KEEPALIVE uint8_t fernwork_avif_result_orientation(void) { return result_orientation; }
