#include <stdint.h>
#include "lcms2.h"

enum { MODEL_GRAY = 1, MODEL_RGB = 3, MODEL_CMYK = 4 };

static cmsUInt32Number input_format(int model, int bits) {
    if (model == MODEL_GRAY) return bits == 16 ? TYPE_GRAY_16 : TYPE_GRAY_8;
    if (model == MODEL_RGB) return bits == 16 ? TYPE_RGB_16 : TYPE_RGB_8;
    if (model == MODEL_CMYK) return bits == 16 ? TYPE_CMYK_16 : TYPE_CMYK_8;
    return 0;
}

static cmsColorSpaceSignature expected_space(int model) {
    if (model == MODEL_GRAY) return cmsSigGrayData;
    if (model == MODEL_RGB) return cmsSigRgbData;
    if (model == MODEL_CMYK) return cmsSigCmykData;
    return (cmsColorSpaceSignature) 0;
}

cmsHTRANSFORM lcms_create_transform(const uint8_t* profile_data, uint32_t profile_size,
                                    int model, int bits) {
    cmsHPROFILE source = NULL, destination = NULL;
    cmsHTRANSFORM transform = NULL;
    cmsUInt32Number format = input_format(model, bits);
    if (!profile_data || !profile_size || !format || (bits != 8 && bits != 16)) return NULL;
    source = cmsOpenProfileFromMem(profile_data, profile_size);
    if (!source || cmsGetColorSpace(source) != expected_space(model)) goto done;
    destination = cmsCreate_sRGBProfile();
    if (!destination) goto done;
    transform = cmsCreateTransform(source, format, destination, TYPE_RGB_8,
                                   INTENT_PERCEPTUAL, 0);
done:
    if (destination) cmsCloseProfile(destination);
    if (source) cmsCloseProfile(source);
    return transform;
}

void lcms_do_transform(cmsHTRANSFORM transform, const void* input, uint8_t* output, uint32_t pixels) {
    if (transform && input && output && pixels) cmsDoTransform(transform, input, output, pixels);
}

void lcms_delete_transform(cmsHTRANSFORM transform) {
    if (transform) cmsDeleteTransform(transform);
}

static cmsToneCurve* make_curve(double gamma, int srgb_curve) {
    if (srgb_curve) {
        const double params[5] = { 2.4, 1.0 / 1.055, 0.055 / 1.055,
                                   1.0 / 12.92, 0.04045 };
        return cmsBuildParametricToneCurve(NULL, 4, params);
    }
    if (gamma <= 0.0) return NULL;
    return cmsBuildGamma(NULL, gamma);
}

static uint32_t save_profile(cmsHPROFILE profile, uint8_t* output, uint32_t capacity) {
    cmsUInt32Number required = 0;
    if (!profile || !cmsSaveProfileToMem(profile, NULL, &required)) return 0;
    if (output && capacity >= required && !cmsSaveProfileToMem(profile, output, &required)) return 0;
    return required;
}

uint32_t lcms_create_rgb_profile(uint8_t* output, uint32_t capacity,
                                 double wx, double wy, double rx, double ry,
                                 double gx, double gy, double bx, double by,
                                 double gamma, int srgb_curve) {
    cmsCIExyY white = { wx, wy, 1.0 };
    cmsCIExyYTRIPLE primaries = {
        { rx, ry, 1.0 }, { gx, gy, 1.0 }, { bx, by, 1.0 }
    };
    cmsToneCurve* curve = make_curve(gamma, srgb_curve);
    cmsToneCurve* curves[3] = { curve, curve, curve };
    cmsHPROFILE profile;
    uint32_t size;
    if (!curve || wx <= 0.0 || wy <= 0.0) { if (curve) cmsFreeToneCurve(curve); return 0; }
    profile = cmsCreateRGBProfile(&white, &primaries, curves);
    size = save_profile(profile, output, capacity);
    if (profile) cmsCloseProfile(profile);
    cmsFreeToneCurve(curve);
    return size;
}

uint32_t lcms_create_gray_profile(uint8_t* output, uint32_t capacity,
                                  double wx, double wy, double gamma) {
    cmsCIExyY white = { wx, wy, 1.0 };
    cmsToneCurve* curve = make_curve(gamma, 0);
    cmsHPROFILE profile;
    uint32_t size;
    if (!curve || wx <= 0.0 || wy <= 0.0) { if (curve) cmsFreeToneCurve(curve); return 0; }
    profile = cmsCreateGrayProfile(&white, curve);
    size = save_profile(profile, output, capacity);
    if (profile) cmsCloseProfile(profile);
    cmsFreeToneCurve(curve);
    return size;
}

typedef struct { cmsHTRANSFORM rgb_to_lab; cmsHTRANSFORM lab_to_rgb; } cmyk_sampler_data;

static int sample_cmyk_to_lab(const cmsUInt16Number input[], cmsUInt16Number output[], void* cargo) {
    cmyk_sampler_data* data = (cmyk_sampler_data*) cargo;
    cmsUInt16Number rgb[3];
    const uint32_t inverse_k = 65535u - input[3];
    rgb[0] = (cmsUInt16Number) (((65535u - input[0]) * inverse_k + 32767u) / 65535u);
    rgb[1] = (cmsUInt16Number) (((65535u - input[1]) * inverse_k + 32767u) / 65535u);
    rgb[2] = (cmsUInt16Number) (((65535u - input[2]) * inverse_k + 32767u) / 65535u);
    cmsDoTransform(data->rgb_to_lab, rgb, output, 1);
    return 1;
}

static int sample_lab_to_cmyk(const cmsUInt16Number input[], cmsUInt16Number output[], void* cargo) {
    cmyk_sampler_data* data = (cmyk_sampler_data*) cargo;
    cmsUInt16Number rgb[3];
    cmsDoTransform(data->lab_to_rgb, input, rgb, 1);
    output[0] = 65535u - rgb[0];
    output[1] = 65535u - rgb[1];
    output[2] = 65535u - rgb[2];
    output[3] = 0;
    return 1;
}

static cmsStage* identity_curves(uint32_t channels) {
    cmsToneCurve* curves[4] = { NULL, NULL, NULL, NULL };
    cmsStage* stage;
    uint32_t i;
    for (i = 0; i < channels; i++) {
        curves[i] = cmsBuildGamma(NULL, 1.0);
        if (!curves[i]) break;
    }
    stage = i == channels ? cmsStageAllocToneCurves(NULL, channels, curves) : NULL;
    for (i = 0; i < channels; i++) if (curves[i]) cmsFreeToneCurve(curves[i]);
    return stage;
}

// A compact deterministic CMYK output profile for real-profile codec fixtures. Imports never
// substitute this for a missing profile.
uint32_t lcms_create_cmyk_profile(uint8_t* output, uint32_t capacity) {
    cmsHPROFILE profile = NULL, srgb = NULL, lab = NULL;
    cmsPipeline* pipeline = NULL;
    cmsStage* clut = NULL;
    cmsPipeline* reverse = NULL;
    cmsStage* reverse_clut = NULL;
    cmsStage* pre = NULL, *post = NULL, *reverse_pre = NULL, *reverse_post = NULL;
    cmyk_sampler_data data = { NULL, NULL };
    uint32_t size = 0;
    uint32_t failure = 1;
    profile = cmsCreateProfilePlaceholder(NULL);
    srgb = cmsCreate_sRGBProfile();
    lab = cmsCreateLab4Profile(NULL);
    if (!profile || !srgb || !lab) goto done;
    failure = 2;
    data.rgb_to_lab = cmsCreateTransform(srgb, TYPE_RGB_16, lab, TYPE_Lab_16, INTENT_PERCEPTUAL, 0);
    data.lab_to_rgb = cmsCreateTransform(lab, TYPE_Lab_16, srgb, TYPE_RGB_16, INTENT_PERCEPTUAL, 0);
    pipeline = cmsPipelineAlloc(NULL, 4, 3);
    clut = cmsStageAllocCLut16bit(NULL, 9, 4, 3, NULL);
    reverse = cmsPipelineAlloc(NULL, 3, 4);
    reverse_clut = cmsStageAllocCLut16bit(NULL, 9, 3, 4, NULL);
    pre = identity_curves(4); post = identity_curves(3);
    reverse_pre = identity_curves(3); reverse_post = identity_curves(4);
    if (!data.rgb_to_lab || !data.lab_to_rgb || !pipeline || !clut || !reverse || !reverse_clut ||
        !pre || !post || !reverse_pre || !reverse_post) goto done;
    failure = 3;
    if (!cmsStageSampleCLut16bit(clut, sample_cmyk_to_lab, &data, 0) ||
        !cmsStageSampleCLut16bit(reverse_clut, sample_lab_to_cmyk, &data, 0)) goto done;
    failure = 4;
    if (!cmsPipelineInsertStage(pipeline, cmsAT_END, pre)) goto done; pre = NULL;
    if (!cmsPipelineInsertStage(pipeline, cmsAT_END, clut)) goto done; clut = NULL;
    if (!cmsPipelineInsertStage(pipeline, cmsAT_END, post)) goto done; post = NULL;
    if (!cmsPipelineInsertStage(reverse, cmsAT_END, reverse_pre)) goto done; reverse_pre = NULL;
    if (!cmsPipelineInsertStage(reverse, cmsAT_END, reverse_clut)) goto done; reverse_clut = NULL;
    if (!cmsPipelineInsertStage(reverse, cmsAT_END, reverse_post)) goto done; reverse_post = NULL;
    cmsSetProfileVersion(profile, 4.3);
    cmsSetDeviceClass(profile, cmsSigOutputClass);
    cmsSetColorSpace(profile, cmsSigCmykData);
    cmsSetPCS(profile, cmsSigLabData);
    cmsSetHeaderRenderingIntent(profile, INTENT_PERCEPTUAL);
    failure = 5;
    if (!cmsWriteTag(profile, cmsSigMediaWhitePointTag, cmsD50_XYZ()) ||
        !cmsWriteTag(profile, cmsSigAToB0Tag, pipeline) ||
        !cmsWriteTag(profile, cmsSigBToA0Tag, reverse) ||
        !cmsLinkTag(profile, cmsSigAToB1Tag, cmsSigAToB0Tag) ||
        !cmsLinkTag(profile, cmsSigAToB2Tag, cmsSigAToB0Tag) ||
        !cmsLinkTag(profile, cmsSigBToA1Tag, cmsSigBToA0Tag) ||
        !cmsLinkTag(profile, cmsSigBToA2Tag, cmsSigBToA0Tag)) goto done;
    failure = 6;
    size = save_profile(profile, output, capacity);
done:
    if (clut) cmsStageFree(clut);
    if (reverse_clut) cmsStageFree(reverse_clut);
    if (pre) cmsStageFree(pre);
    if (post) cmsStageFree(post);
    if (reverse_pre) cmsStageFree(reverse_pre);
    if (reverse_post) cmsStageFree(reverse_post);
    if (pipeline) cmsPipelineFree(pipeline);
    if (reverse) cmsPipelineFree(reverse);
    if (data.rgb_to_lab) cmsDeleteTransform(data.rgb_to_lab);
    if (data.lab_to_rgb) cmsDeleteTransform(data.lab_to_rgb);
    if (lab) cmsCloseProfile(lab);
    if (srgb) cmsCloseProfile(srgb);
    if (profile) cmsCloseProfile(profile);
    return size ? size : failure;
}
