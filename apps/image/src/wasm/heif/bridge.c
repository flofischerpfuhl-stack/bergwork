#include <emscripten/emscripten.h>
#include <libheif/heif.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

static uint8_t* result_data;
static int result_width;
static int result_height;
static size_t result_size;

EMSCRIPTEN_KEEPALIVE void compositor_heif_release(void) {
  free(result_data);
  result_data = NULL;
  result_width = 0;
  result_height = 0;
  result_size = 0;
}

/* libheif applies primary-item irot/imir and decodes an alpha auxiliary image by default. */
EMSCRIPTEN_KEEPALIVE int compositor_heif_decode(const uint8_t* bytes, size_t length) {
  compositor_heif_release();
  struct heif_context* context = heif_context_alloc();
  if (!context) return 1;
  struct heif_image_handle* handle = NULL;
  struct heif_image* image = NULL;
  struct heif_error error = heif_context_read_from_memory_without_copy(context, bytes, length, NULL);
  if (error.code == heif_error_Ok) error = heif_context_get_primary_image_handle(context, &handle);
  if (error.code == heif_error_Ok) {
    error = heif_decode_image(handle, &image, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, NULL);
  }
  if (error.code != heif_error_Ok || !image) {
    heif_image_handle_release(handle);
    heif_context_free(context);
    return 2;
  }

  const int width = heif_image_get_width(image, heif_channel_interleaved);
  const int height = heif_image_get_height(image, heif_channel_interleaved);
  size_t stride = 0;
  const uint8_t* plane = heif_image_get_plane_readonly2(image, heif_channel_interleaved, &stride);
  if (!plane || width <= 0 || height <= 0 || (size_t) width > SIZE_MAX / 4 ||
      (size_t) height > SIZE_MAX / ((size_t) width * 4) || stride < (size_t) width * 4) {
    heif_image_release(image);
    heif_image_handle_release(handle);
    heif_context_free(context);
    return 3;
  }

  result_size = (size_t) width * (size_t) height * 4;
  result_data = (uint8_t*) malloc(result_size);
  if (!result_data) {
    result_size = 0;
    heif_image_release(image);
    heif_image_handle_release(handle);
    heif_context_free(context);
    return 4;
  }
  for (int y = 0; y < height; ++y) {
    memcpy(result_data + (size_t) y * (size_t) width * 4, plane + (size_t) y * stride, (size_t) width * 4);
  }
  result_width = width;
  result_height = height;
  heif_image_release(image);
  heif_image_handle_release(handle);
  heif_context_free(context);
  return 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t compositor_heif_result_data(void) { return (uintptr_t) result_data; }
EMSCRIPTEN_KEEPALIVE size_t compositor_heif_result_size(void) { return result_size; }
EMSCRIPTEN_KEEPALIVE int compositor_heif_result_width(void) { return result_width; }
EMSCRIPTEN_KEEPALIVE int compositor_heif_result_height(void) { return result_height; }

#ifdef __cplusplus
}
#endif
