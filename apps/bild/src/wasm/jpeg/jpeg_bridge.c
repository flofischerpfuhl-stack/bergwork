#include <setjmp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "jpeglib.h"

typedef struct {
    struct jpeg_error_mgr base;
    jmp_buf jump;
} decoder_error;

static void fail_decode(j_common_ptr info) {
    decoder_error* error = (decoder_error*)info->err;
    longjmp(error->jump, 1);
}

/*
 * Decode normalized color samples for the browser importer.  libjpeg converts YCCK to
 * Adobe-style inverted CMYK; bare Adobe CMYK is inverted too, so normalize both to
 * conventional 0=no ink samples before Little CMS sees them.  See libjpeg.txt,
 * "CAUTION: ... Adobe Photoshop writes inverted data in CMYK JPEG files".
 */
int compositor_jpeg_decode(const uint8_t* input, uint32_t input_size,
                           uint8_t* output, uint32_t output_size,
                           uint32_t expected_width, uint32_t expected_height,
                           int components) {
    struct jpeg_decompress_struct info;
    decoder_error error;
    uint64_t required;
    int created = 0;

    if (!input || !input_size || !output || !expected_width || !expected_height ||
        (components != 1 && components != 3 && components != 4)) return 1;
    memset(&info, 0, sizeof(info));
    info.err = jpeg_std_error(&error.base);
    error.base.error_exit = fail_decode;
    if (setjmp(error.jump)) {
        if (created) jpeg_destroy_decompress(&info);
        return 2;
    }

    jpeg_create_decompress(&info);
    created = 1;
    jpeg_mem_src(&info, input, input_size);
    if (jpeg_read_header(&info, TRUE) != JPEG_HEADER_OK ||
        info.image_width != expected_width || info.image_height != expected_height ||
        info.num_components != components) {
        jpeg_destroy_decompress(&info);
        return 3;
    }

    info.out_color_space = components == 1 ? JCS_GRAYSCALE :
                           components == 3 ? JCS_RGB : JCS_CMYK;
    if (!jpeg_start_decompress(&info) || info.output_components != components ||
        info.output_width != expected_width || info.output_height != expected_height) {
        jpeg_destroy_decompress(&info);
        return 3;
    }
    required = (uint64_t)info.output_width * info.output_height * info.output_components;
    if (required != output_size) {
        jpeg_destroy_decompress(&info);
        return 4;
    }

    while (info.output_scanline < info.output_height) {
        JSAMPROW row = output + (size_t)info.output_scanline * info.output_width * components;
        if (jpeg_read_scanlines(&info, &row, 1) != 1) {
            jpeg_destroy_decompress(&info);
            return 5;
        }
    }
    if (!jpeg_finish_decompress(&info)) {
        jpeg_destroy_decompress(&info);
        return 5;
    }

    if (components == 4 && info.saw_Adobe_marker) {
        uint32_t index;
        for (index = 0; index < output_size; index++) output[index] = 255 - output[index];
    }
    jpeg_destroy_decompress(&info);
    return 0;
}
