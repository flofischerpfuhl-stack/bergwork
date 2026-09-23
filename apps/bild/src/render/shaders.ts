/**
 * GLSL ES 3.0 passes of the GPU compositor. Every pass draws one full-target quad; `vPos` is the
 * fragment centre in target pixels (origin top-left). Colour targets hold premultiplied sRGB.
 *
 * Semantics follow Compositor's CoreGraphics/CoreImage pipeline (LayerRenderer.swift,
 * LiveMaskRenderer.swift, SeparableBlend.swift): PDF blend formulas in 8-bit sRGB, except Color
 * Dodge and Color Burn, which upstream renders through CoreImage in its linear working space.
 */

export const VERTEX = /* glsl */ `#version 300 es
in vec2 aPosition;
in vec2 aUV;
out vec2 vPos;
out vec2 vUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vPos = (uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy;
  vUV = aUV;
}
`;

/** Blend-mode indices, in LayerBlendMode.allCases order. */
export const BLEND_INDEX: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, difference: 6, colorDodge: 7,
  colorBurn: 8, hue: 9, saturation: 10, color: 11, luminosity: 12,
};

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : b + (2.0 * s - 1.0) - b * (2.0 * s - 1.0); }

vec3 blendColor(int mode, vec3 b, vec3 s) {
  if (mode == 1) return b * s;
  if (mode == 2) return b + s - b * s;
  if (mode == 3) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (mode == 4) return min(b, s);
  if (mode == 5) return max(b, s);
  if (mode == 6) return abs(b - s);
  if (mode == 7) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (mode == 8) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (mode == 9) return setLum(setSat(s, sat(b)), lum(b));
  if (mode == 10) return setLum(setSat(b, sat(s)), lum(b));
  if (mode == 11) return setLum(s, lum(b));
  if (mode == 12) return setLum(b, lum(s));
  return s;
}

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

/** Source-over style compositing of premultiplied src onto premultiplied dst with a PDF blend mode. */
vec4 composite(int mode, vec4 dst, vec4 src) {
  float ab = dst.a, as_ = src.a;
  if (as_ <= 0.0) return dst;
  vec3 cb = ab > 0.0 ? dst.rgb / ab : vec3(0.0);
  vec3 cs = src.rgb / as_;
  float ao = as_ + ab - as_ * ab;
  if (mode == 0) return vec4(src.rgb + dst.rgb * (1.0 - as_), ao);
  if (mode == 7 || mode == 8) {
    // CoreImage blends in linear light (SeparableBlend.swift).
    vec3 lb = toLinear(cb), ls = toLinear(cs);
    vec3 co = ls * as_ * (1.0 - ab) + lb * ab * (1.0 - as_) + as_ * ab * blendColor(mode, lb, ls);
    vec3 straight = ao > 0.0 ? co / ao : vec3(0.0);
    return vec4(toSRGB(straight) * ao, ao);
  }
  vec3 co = src.rgb * (1.0 - ab) + dst.rgb * (1.0 - as_) + as_ * ab * blendColor(mode, cb, cs);
  return vec4(co, ao);
}

vec4 fetchClamped(sampler2D t, ivec2 p, ivec2 size) {
  return texelFetch(t, clamp(p, ivec2(0), size - 1), 0);
}
/** Bilinear filtering on texel centres with clamp-to-edge, computed exactly. */
vec4 bilinear(sampler2D t, vec2 p, ivec2 size) {
  vec2 q = p - 0.5;
  vec2 f = q - floor(q);
  ivec2 i = ivec2(floor(q));
  vec4 a = fetchClamped(t, i, size);
  vec4 b = fetchClamped(t, i + ivec2(1, 0), size);
  vec4 c = fetchClamped(t, i + ivec2(0, 1), size);
  vec4 d = fetchClamped(t, i + ivec2(1, 1), size);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
/** sampling: 0 nearest, 1 exact bilinear, 2 hardware trilinear (minified). */
vec4 sampleGrid(sampler2D t, vec2 p, ivec2 size, int sampling) {
  if (sampling == 0) return fetchClamped(t, ivec2(floor(p)), size);
  if (sampling == 1) return bilinear(t, p, size);
  return texture(t, p / vec2(size));
}
/** Coverage of the unit-grid rectangle [0,size] around p, antialiased over edgeScale target px per grid px. */
float edgeCoverage(vec2 p, vec2 size, vec2 edgeScale) {
  vec2 d = min(p, size - p) * edgeScale;
  vec2 c = clamp(0.5 + d, 0.0, 1.0);
  return c.x * c.y;
}
`;

/** Draws one transformed layer (optionally through its mask and a view-space clip) onto the backdrop. */
export const LAYER_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBackdrop;
uniform sampler2D uLayer;
uniform sampler2D uMask;
uniform sampler2D uClip;
uniform vec2 uTarget;
uniform mat3 uViewToDoc;
uniform mat3 uDocToLayer;
uniform vec2 uLayerSize;
uniform vec2 uLayerEdge;
uniform int uSampling;
uniform float uOpacity;
uniform int uMode;
uniform int uHasMask;
uniform mat3 uDocToMask;
uniform vec2 uMaskSize;
uniform vec2 uMaskEdge;
uniform int uMaskPlaced;
uniform float uMaskBackground;
uniform int uMaskSampling;
uniform int uHasClip;
uniform int uSnap;
uniform int uReplace;

void main() {
  vec4 dst = texelFetch(uBackdrop, ivec2(vPos), 0);
  vec2 doc = (uViewToDoc * vec3(vPos, 1.0)).xy;
  if (uSnap == 1) doc = floor(doc) + 0.5;
  vec2 lp = (uDocToLayer * vec3(doc, 1.0)).xy;
  float cover = edgeCoverage(lp, uLayerSize, uLayerEdge);
  if (cover <= 0.0) { finalColor = dst; return; }
  vec4 src = sampleGrid(uLayer, lp, ivec2(uLayerSize), uSampling) * (cover * uOpacity);
  if (uHasMask == 1) {
    vec2 mp = (uDocToMask * vec3(doc, 1.0)).xy;
    float m = sampleGrid(uMask, mp, ivec2(uMaskSize), uMaskSampling).r;
    if (uMaskPlaced == 1) {
      float inside = edgeCoverage(mp, uMaskSize, uMaskEdge);
      m = mix(uMaskBackground, m, inside);
    }
    src *= m;
  }
  if (uHasClip == 1) src *= texelFetch(uClip, ivec2(vPos), 0).r;
  finalColor = uReplace == 1 ? src : composite(uMode, dst, src);
}
`;

/**
 * Multiplies a coverage target by a transformed mask (folder masks: outside the rect → 0) or by
 * the alpha of a view-space layer render (live masks), or initialises it to 1.
 */
export const COVERAGE_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uPrevious;
uniform sampler2D uSource;
uniform int uKind; // 0 = transformed mask, 1 = alpha of a view-space render, 2 = one, 3 = another coverage target
uniform int uHasPrevious;
uniform mat3 uViewToDoc;
uniform mat3 uDocToMask;
uniform vec2 uMaskSize;
uniform vec2 uMaskEdge;
uniform int uSnap;

void main() {
  float previous = uHasPrevious == 1 ? texelFetch(uPrevious, ivec2(vPos), 0).r : 1.0;
  float value = 1.0;
  if (uKind == 0) {
    vec2 doc = (uViewToDoc * vec3(vPos, 1.0)).xy;
    if (uSnap == 1) doc = floor(doc) + 0.5;
    vec2 mp = (uDocToMask * vec3(doc, 1.0)).xy;
    value = bilinear(uSource, mp, ivec2(uMaskSize)).r * edgeCoverage(mp, uMaskSize, uMaskEdge);
  } else if (uKind == 1) {
    value = texelFetch(uSource, ivec2(vPos), 0).a;
  } else if (uKind == 3) {
    value = texelFetch(uSource, ivec2(vPos), 0).r;
  }
  float c = previous * value;
  finalColor = vec4(c, c, c, 1.0);
}
`;

/** layer_unpremultiply_opaque: colour unpremultiplied, alpha 1 (clipping-stack surface). */
export const OPAQUE_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uSource;
void main() {
  vec4 c = texelFetch(uSource, ivec2(vPos), 0);
  finalColor = vec4(c.a > 0.0 ? min(c.rgb / c.a, vec3(1.0)) : vec3(0.0), 1.0);
}
`;

/** layer_restore_alpha on the stack surface, then the stack composited with the base's blend mode. */
export const STACK_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBackdrop;
uniform sampler2D uSurface;
uniform sampler2D uBase;
uniform sampler2D uClip;
uniform int uHasClip;
uniform int uMode;
void main() {
  ivec2 p = ivec2(vPos);
  vec4 dst = texelFetch(uBackdrop, p, 0);
  float a = texelFetch(uBase, p, 0).a;
  vec4 src = vec4(texelFetch(uSurface, p, 0).rgb * a, a);
  if (uHasClip == 1) src *= texelFetch(uClip, p, 0).r;
  finalColor = composite(uMode, dst, src);
}
`;

/**
 * Adjustment layer (LiveMaskRenderer.adjust): adjusted colour, optional blend at full coverage with
 * the original alpha restored, opacity lerp in linear light (CIBlendWithMask), then a copy through
 * the clip: result = mix(original, adjusted, clip).
 * ADJUST_FUNCTION is spliced in per adjustment kind.
 */
export function adjustFragment(adjustFunction: string): string {
  return /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBackdrop;
uniform sampler2D uClip;
uniform sampler2D uLut;
uniform int uHasClip;
uniform int uMode;
uniform float uOpacity;
uniform mat3 uViewToDoc;
uniform vec4 uParams[8];
${adjustFunction}
void main() {
  ivec2 p = ivec2(vPos);
  vec4 original = texelFetch(uBackdrop, p, 0);
  if (original.a <= 0.0) { finalColor = original; return; }
  vec3 straight = original.rgb / original.a;
  vec2 doc = (uViewToDoc * vec3(vPos, 1.0)).xy;
  vec3 adjusted = clamp(adjustColor(straight, doc), 0.0, 1.0);
  if (uMode != 0) adjusted = clamp(blendColor(uMode, straight, adjusted), 0.0, 1.0);
  vec4 result = vec4(adjusted * original.a, original.a);
  if (uOpacity < 1.0) {
    vec3 lo = toLinear(straight), la = toLinear(adjusted);
    result = vec4(toSRGB(mix(lo, la, uOpacity)) * original.a, original.a);
  }
  float clip = uHasClip == 1 ? texelFetch(uClip, p, 0).r : 1.0;
  finalColor = mix(original, result, clip);
}
`;
}

/** Identity adjustment, used until an adjustment kind has a GPU implementation. */
export const IDENTITY_ADJUST = /* glsl */ `vec3 adjustColor(vec3 c, vec2 doc) { return c; }`;

/** Straight-alpha RGBA8 for readback (export). */
export const UNPREMULTIPLY_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uSource;
void main() {
  vec4 c = texelFetch(uSource, ivec2(vPos), 0);
  finalColor = c.a > 0.0 ? vec4(min(c.rgb / c.a, vec3(1.0)), c.a) : vec4(0.0);
}
`;

/**
 * Screen presentation (EditorCanvas.draw): workspace grey, the canvas rectangle with a soft shadow,
 * a 10-point checkerboard under the composite, a hairline border and the pixel grid from 800%.
 */
export const PRESENT_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uComposite;
uniform vec4 uCanvasRect;   // device px: x, y, width, height
uniform float uPointScale;  // device px per point
uniform int uGrid;
uniform float uPixelSize;   // device px per document px
uniform int uHasComposite;
void main() {
  vec3 workspace = vec3(0.105);
  vec2 p = vPos;
  vec2 rel = p - uCanvasRect.xy;
  bool inside = rel.x >= 0.0 && rel.y >= 0.0 && rel.x < uCanvasRect.z && rel.y < uCanvasRect.w;
  if (!inside) {
    // Shadow: offset 3 pt down, blur 14 pt, 35% black.
    vec2 q = p - vec2(0.0, 3.0 * uPointScale);
    vec2 d = max(max(uCanvasRect.xy - q, q - (uCanvasRect.xy + uCanvasRect.zw)), vec2(0.0));
    float dist = length(d) / uPointScale;
    float shadow = uHasComposite == 1 ? 0.35 * exp(-dist * dist / (2.0 * 7.0 * 7.0)) : 0.0;
    finalColor = vec4(workspace * (1.0 - shadow), 1.0);
    return;
  }
  vec2 cell = floor(rel / (10.0 * uPointScale));
  float checker = mod(cell.x + cell.y, 2.0) < 0.5 ? 0.35 : 0.30;
  vec4 c = uHasComposite == 1 ? texelFetch(uComposite, ivec2(p), 0) : vec4(0.0);
  vec3 color = c.rgb + vec3(checker) * (1.0 - c.a);
  if (uGrid == 1) {
    vec2 g = rel / uPixelSize;
    vec2 f = (g - floor(g)) * uPixelSize;
    if (f.x < 1.0 || f.y < 1.0) color = mix(color, vec3(0.55), 0.45);
  }
  // Hairline border, 13% white.
  if (rel.x < 1.0 || rel.y < 1.0 || rel.x >= uCanvasRect.z - 1.0 || rel.y >= uCanvasRect.w - 1.0) color = mix(color, vec3(1.0), 0.13);
  finalColor = vec4(color, 1.0);
}
`;
