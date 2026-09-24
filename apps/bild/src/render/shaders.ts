/**
 * GLSL ES 3.0 passes of the GPU compositor. Every pass draws one full-target quad; `vPos` is the
 * fragment centre in target pixels (origin top-left). Colour targets hold premultiplied sRGB.
 *
 * Semantics follow Compositor's CoreGraphics/CoreImage pipeline (LayerRenderer.swift,
 * LiveMaskRenderer.swift, SeparableBlend.swift): PDF/Photoshop formulas on sRGB values. Formula
 * sources and endpoint decisions are documented beside the CPU reference in core/blend.ts.
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

/** Blend-mode indices in Photoshop menu-group order, shared by every compositor pass. */
export const BLEND_INDEX: Record<string, number> = {
  normal: 0, dissolve: 1,
  darken: 2, multiply: 3, colorBurn: 4, linearBurn: 5, darkerColor: 6,
  lighten: 7, screen: 8, colorDodge: 9, linearDodge: 10, lighterColor: 11,
  overlay: 12, softLight: 13, hardLight: 14, vividLight: 15, linearLight: 16, pinLight: 17, hardMix: 18,
  difference: 19, exclusion: 20, subtract: 21, divide: 22,
  hue: 23, saturation: 24, color: 25, luminosity: 26,
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
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float vividLight(float b, float s) {
  if (s <= 0.5) {
    float scaled = 2.0 * s;
    return scaled <= 0.0 ? 0.0 : (b >= 1.0 ? 1.0 : 1.0 - min(1.0, (1.0 - b) / scaled));
  }
  float scaled = 2.0 * s - 1.0;
  return scaled >= 1.0 ? 1.0 : (b <= 0.0 ? 0.0 : min(1.0, b / (1.0 - scaled)));
}
float hardMix(float b, float s) {
  float sum = b + s;
  return sum < 1.0 ? 0.0 : (sum > 1.0 ? 1.0 : (s < 0.5 ? 1.0 : 0.0));
}
float divideBlend(float b, float s) { return b <= 0.0 ? 0.0 : (s <= 0.0 ? 1.0 : min(1.0, b / s)); }

vec3 blendColor(int mode, vec3 b, vec3 s) {
  if (mode == 2) return min(b, s);
  if (mode == 3) return b * s;
  if (mode == 4) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (mode == 5) return max(vec3(0.0), b + s - 1.0);
  if (mode == 6) return lum(s) < lum(b) ? s : b;
  if (mode == 7) return max(b, s);
  if (mode == 8) return b + s - b * s;
  if (mode == 9) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (mode == 10) return min(vec3(1.0), b + s);
  if (mode == 11) return lum(s) > lum(b) ? s : b;
  if (mode == 12) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (mode == 13) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (mode == 14) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (mode == 15) return vec3(vividLight(b.r, s.r), vividLight(b.g, s.g), vividLight(b.b, s.b));
  if (mode == 16) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (mode == 17) return mix(min(b, 2.0 * s), max(b, 2.0 * s - 1.0), step(vec3(0.5), s));
  if (mode == 18) {
    return vec3(hardMix(b.r, s.r), hardMix(b.g, s.g), hardMix(b.b, s.b));
  }
  if (mode == 19) return abs(b - s);
  if (mode == 20) return b + s - 2.0 * b * s;
  if (mode == 21) return max(vec3(0.0), b - s);
  if (mode == 22) return vec3(divideBlend(b.r, s.r), divideBlend(b.g, s.g), divideBlend(b.b, s.b));
  if (mode == 23) return setLum(setSat(s, sat(b)), lum(b));
  if (mode == 24) return setLum(setSat(b, sat(s)), lum(b));
  if (mode == 25) return setLum(s, lum(b));
  if (mode == 26) return setLum(b, lum(s));
  return s;
}

vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
vec3 toSRGB(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

/** Source-over style compositing of premultiplied src onto premultiplied dst with a PDF blend mode. */
uint dissolveNoise(ivec2 p, int seed) {
  uint hash = uint(p.x) * 0x1f123bb5u ^ uint(p.y) * 0x5f356495u ^ uint(seed);
  hash ^= hash >> 16;
  hash *= 0x7feb352du;
  hash ^= hash >> 15;
  hash *= 0x846ca68bu;
  hash ^= hash >> 16;
  return hash % 255u;
}

vec4 composite(int mode, vec4 dst, vec4 src, ivec2 documentPixel, int seed) {
  float ab = dst.a, as_ = src.a;
  if (as_ <= 0.0) return dst;
  if (mode == 1) {
    uint alpha8 = uint(floor(clamp(as_, 0.0, 1.0) * 255.0 + 0.5));
    if (alpha8 <= dissolveNoise(documentPixel, seed)) return dst;
    src = vec4(src.rgb / as_, 1.0);
    as_ = 1.0;
    mode = 0;
  }
  vec3 cb = ab > 0.0 ? dst.rgb / ab : vec3(0.0);
  vec3 cs = src.rgb / as_;
  float ao = as_ + ab - as_ * ab;
  if (mode == 0) return vec4(src.rgb + dst.rgb * (1.0 - as_), ao);
  // Colour Dodge/Burn go through Core Image upstream only to fix CoreGraphics' alpha handling
  // (SeparableBlend.swift); LayerAppearanceTests pins the result to the sRGB formula (burn 0.4/0.8 = 0.25).
  vec3 co = src.rgb * (1.0 - ab) + dst.rgb * (1.0 - as_) + as_ * ab * blendColor(mode, cb, cs);
  return vec4(co, ao);
}

bool specialFillMode(int mode) {
  return mode == 4 || mode == 5 || mode == 9 || mode == 10 || mode == 15 || mode == 16 || mode == 18 || mode == 19;
}
float halfUp(float numerator, float denominator) { return floor(numerator / denominator + 0.5); }
float linearLightFill(float s, float d, float fill) {
  if (fill <= 0.0) return d;
  return clamp(d + halfUp((2.0 * s - 255.0) * fill, 255.0) - 1.0, 0.0, 255.0);
}
float vividFill(float s, float d, float fill) {
  if (fill <= 0.0) return d;
  if (s >= 128.0) {
    float doubled = halfUp((s - 128.0) * 255.0, 127.0);
    float divisor = 255.0 - halfUp(doubled * fill, 255.0);
    return divisor <= 0.0 ? 255.0 : min(255.0, halfUp(d * 255.0, divisor));
  }
  float doubled = 255.0 - halfUp((255.0 - halfUp(s * 255.0, 128.0)) * fill, 255.0);
  float numerator = d + doubled - 255.0;
  if (numerator <= 0.0 || doubled <= 0.0) return 0.0;
  return min(255.0, floor((2.0 * numerator * 255.0 + doubled - 1.0) / (2.0 * doubled)));
}
float hardMixFill(float s, float d, float fill) {
  float faded = fill - (fill >= 128.0 ? 1.0 : 0.0);
  if (faded <= 0.0) return d;
  float anchor = halfUp((255.0 - s) * faded, 255.0);
  return clamp(halfUp((d - anchor) * 255.0, 255.0 - faded), 0.0, 255.0);
}
vec4 compositeFill(int mode, vec4 dst, vec4 sampled, float coverage, float opacity, float fill,
  ivec2 documentPixel, int seed) {
  if (!specialFillMode(mode) || fill >= 1.0) {
    return composite(mode, dst, sampled * (coverage * opacity * fill), documentPixel, seed);
  }
  if (sampled.a <= 0.0 || coverage <= 0.0 || opacity <= 0.0 || fill <= 0.0) return dst;
  float ab = dst.a;
  vec3 source = floor(clamp(sampled.rgb / sampled.a, 0.0, 1.0) * 255.0 + 0.5);
  vec3 destination = ab > 0.0 ? floor(clamp(dst.rgb / ab, 0.0, 1.0) * 255.0 + 0.5) : vec3(0.0);
  float fb = floor(clamp(fill, 0.0, 1.0) * 255.0 + 0.5);
  vec3 blended;
  if (mode == 15) blended = vec3(vividFill(source.r, destination.r, fb), vividFill(source.g, destination.g, fb), vividFill(source.b, destination.b, fb));
  else if (mode == 16) blended = vec3(linearLightFill(source.r, destination.r, fb), linearLightFill(source.g, destination.g, fb), linearLightFill(source.b, destination.b, fb));
  else if (mode == 18) blended = vec3(hardMixFill(source.r, destination.r, fb), hardMixFill(source.g, destination.g, fb), hardMixFill(source.b, destination.b, fb));
  else {
    bool whiteNeutral = mode == 4 || mode == 5;
    vec3 adjustedFloat = mix(whiteNeutral ? vec3(255.0) : vec3(0.0), source, fill);
    vec3 adjusted = floor(clamp(adjustedFloat, 0.0, 255.0) + 0.5);
    blended = blendColor(mode, destination / 255.0, adjusted / 255.0) * 255.0;
    if (mode == 4) {
      vec3 quotient = floor((255.0 - destination) * 256.0 / max(adjustedFloat, vec3(1e-30)));
      blended = clamp(255.0 - mix(quotient, vec3(256.0), lessThanEqual(adjustedFloat, vec3(0.0))), 0.0, 255.0);
    } else if (mode == 9) {
      vec3 divisor = 256.0 - adjustedFloat;
      vec3 value = floor(destination * 256.0 / max(divisor, vec3(1e-30)) + 0.5);
      blended = clamp(mix(value, vec3(255.0), lessThanEqual(divisor, vec3(0.0))), 0.0, 255.0);
    }
  }
  vec3 straightSource = source / 255.0, straightDestination = destination / 255.0;
  blended /= 255.0;
  float sourceCoverage = sampled.a * coverage;
  float effective = sourceCoverage * fill * opacity;
  float overlap = sourceCoverage * opacity;
  float outputAlpha = effective + ab * (1.0 - effective);
  vec3 outputColor = straightSource * effective * (1.0 - ab) + blended * overlap * ab
    + straightDestination * ab * (1.0 - overlap);
  return vec4(outputColor, outputAlpha);
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
/** sampling: 0 nearest, 1 exact bilinear, 2 one sharp mip level followed by hardware bilinear. */
vec4 sampleGrid(sampler2D t, vec2 p, ivec2 size, int sampling, int mipLevel) {
  if (sampling == 0) return fetchClamped(t, ivec2(floor(p)), size);
  if (sampling == 1) return bilinear(t, p, size);
  return textureLod(t, p / vec2(size), float(mipLevel));
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
uniform vec2 uChunkOrigin;
uniform vec2 uChunkSize;
uniform vec2 uTextureSize;
uniform float uApron;
uniform int uSampling;
uniform int uMipLevel;
uniform int uRestrictChunk;
uniform int uRestrictBounds;
uniform vec2 uDrawOrigin;
uniform vec2 uDrawSize;
uniform float uOpacity;
uniform float uFillOpacity;
uniform int uMode;
uniform int uDissolveSeed;
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
  if (uRestrictBounds == 1 && (lp.x < uDrawOrigin.x || lp.y < uDrawOrigin.y
    || lp.x >= uDrawOrigin.x + uDrawSize.x || lp.y >= uDrawOrigin.y + uDrawSize.y)) discard;
  float cover = edgeCoverage(lp, uLayerSize, uLayerEdge);
  vec2 chunkMax = uChunkOrigin + uChunkSize;
  if (cover <= 0.0 || lp.x < uChunkOrigin.x || lp.y < uChunkOrigin.y || lp.x >= chunkMax.x || lp.y >= chunkMax.y) {
    if (uRestrictChunk == 1) discard;
    finalColor = dst;
    return;
  }
  vec2 chunkPixel = lp - uChunkOrigin + vec2(uApron);
  vec4 sampled = sampleGrid(uLayer, chunkPixel, ivec2(uTextureSize), uSampling, uMipLevel);
  float coverage = cover;
  if (uHasMask == 1) {
    coverage *= texelFetch(uMask, ivec2(vPos), 0).r;
  }
  if (uHasClip == 1) coverage *= texelFetch(uClip, ivec2(vPos), 0).r;
  vec4 src = sampled * (coverage * uOpacity * uFillOpacity);
  finalColor = uReplace == 1 ? src
    : compositeFill(uMode, dst, sampled, coverage, uOpacity, uFillOpacity, ivec2(floor(doc)), uDissolveSeed);
}
`;

/** MetalBrushCoverage.continuousBrush for one settled or provisional spline chord. */
export const BRUSH_COVERAGE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vPos;
out vec4 finalColor;
uniform mat3 uPixelToDoc;
uniform vec2 uGridOrigin;
uniform vec2 uCanvas;
uniform vec4 uSegment;
uniform float uPressure;
uniform float uRadius;
uniform float uHardness;
uniform float uAntialias;
uniform float uSpacing;

float falloff(float t) {
  const float edge = 0.08208499862; // exp(-2.5)
  return max(0.0, (exp(-2.5 * t * t) - edge) / (1.0 - edge));
}
float tipCoverage(float distanceSquared) {
  float distance = sqrt(distanceSquared);
  if (uHardness >= 1.0) return clamp((uRadius - distance) / uAntialias + 0.5, 0.0, 1.0);
  float t = clamp((distance / uRadius - uHardness) / (1.0 - uHardness), 0.0, 1.0);
  return falloff(t);
}
float tipDensity(float distanceSquared) {
  return -log(max(1.0 - tipCoverage(distanceSquared), 0.001));
}
float segmentDistanceSquared(vec2 p) {
  vec2 v = uSegment.zw - uSegment.xy;
  float t = clamp(dot(p - uSegment.xy, v) / max(dot(v, v), 1e-12), 0.0, 1.0);
  vec2 d = p - (uSegment.xy + t * v);
  return dot(d, d);
}
float segmentDensity(vec2 p) {
  vec2 v = uSegment.zw - uSegment.xy;
  float len = length(v);
  if (len < 1e-6) { vec2 d = p - uSegment.xy; return tipDensity(dot(d, d)) * uPressure; }
  vec2 direction = v / len;
  float projection = dot(p - uSegment.xy, direction);
  vec2 perpendicular = p - uSegment.xy - projection * direction;
  float perpendicularSquared = dot(perpendicular, perpendicular);
  float radiusSquared = uRadius * uRadius;
  if (perpendicularSquared >= radiusSquared) return 0.0;
  float reach = sqrt(radiusSquared - perpendicularSquared);
  float lo = max(0.0, projection - reach), hi = min(len, projection + reach);
  if (hi <= lo) return 0.0;
  float midpoint = (lo + hi) * 0.5, halfLength = (hi - lo) * 0.5;
  const vec4 nodes = vec4(0.1834346425, 0.5255324099, 0.7966664774, 0.9602898565);
  const vec4 weights = vec4(0.3626837834, 0.3137066459, 0.2223810345, 0.1012285363);
  float integral = 0.0;
  for (int i = 0; i < 4; ++i) {
    float a = midpoint - halfLength * nodes[i] - projection;
    float b = midpoint + halfLength * nodes[i] - projection;
    integral += weights[i] * (tipDensity(perpendicularSquared + a * a)
      + tipDensity(perpendicularSquared + b * b));
  }
  return integral * halfLength / uSpacing * uPressure;
}
void main() {
  vec2 grid = uGridOrigin + vPos;
  vec2 p = (uPixelToDoc * vec3(grid, 1.0)).xy;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, uCanvas))) { finalColor = vec4(0.0); return; }
  float coverage = uHardness >= 1.0
    ? tipCoverage(segmentDistanceSquared(p)) * uPressure
    : 1.0 - exp(-min(segmentDensity(p), 20.0));
  finalColor = vec4(coverage);
}
`;

/** Original native-grid pixels composed once through permanent + tail coverage. */
export const BRUSH_PAINT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBase;
uniform sampler2D uPermanent;
uniform sampler2D uTail;
uniform vec2 uGridOrigin;
uniform vec2 uGridSize;
uniform vec4 uSourceRect;
uniform vec2 uSourceSize;
uniform vec2 uBaseOrigin;
uniform vec2 uBaseTextureSize;
uniform float uBaseApron;
uniform int uHasBase;
uniform int uMask;
uniform int uHard;
uniform int uErase;
uniform int uBrushMode;
uniform int uRange;
uniform float uExposure;
uniform int uSpongeDirection;
uniform float uFlow;
uniform int uVibrance;
uniform vec3 uColor;
uniform float uOpacity;

vec4 basePixel(vec2 grid) {
  if (uHasBase == 0) return uMask == 1 ? vec4(1.0) : vec4(0.0);
  vec2 source = floor((grid - uSourceRect.xy) * uSourceSize / uSourceRect.zw);
  if (any(lessThan(source, vec2(0.0))) || any(greaterThanEqual(source, uSourceSize))) {
    return uMask == 1 ? vec4(1.0) : vec4(0.0);
  }
  ivec2 p = clamp(ivec2(source - uBaseOrigin + vec2(uBaseApron)), ivec2(0), ivec2(uBaseTextureSize) - 1);
  return texelFetch(uBase, p, 0);
}
void main() {
  vec2 grid = floor(clamp(uGridOrigin + vPos, vec2(0.0), uGridSize - 1.0));
  ivec2 p = ivec2(vPos);
  float permanent = texelFetch(uPermanent, p, 0).r;
  float tail = texelFetch(uTail, p, 0).r;
  float coverage = (uHard == 1 ? max(permanent, tail) : 1.0 - (1.0 - permanent) * (1.0 - tail)) * uOpacity;
  vec4 base = basePixel(grid);
  vec3 straightBase = base.a > 0.0 ? clamp(base.rgb / base.a, 0.0, 1.0) : vec3(0.0);
  vec3 paint = floor(uColor * 255.0 + 0.5) / 255.0;
  if (uMask == 1) {
    float value = floor(mix(base.r, paint.r, coverage) * 255.0 + 0.5) / 255.0;
    finalColor = vec4(value, value, value, 1.0);
  } else if (uErase == 1) {
    float alpha = floor(base.a * (1.0 - coverage) * 255.0 + 0.5) / 255.0;
    finalColor = vec4(straightBase * alpha, alpha);
  } else if (uBrushMode != 0 && base.a > 0.0) {
    float luma=dot(straightBase,vec3(0.2126,0.7152,0.0722));
    float rangeWeight=uRange==0 ? (1.0-luma)*(1.0-luma) : (uRange==2 ? luma*luma : max(0.0,1.0-abs(luma*2.0-1.0)));
    vec3 adjusted;
    if (uBrushMode==1) { float s=clamp(coverage*uExposure*rangeWeight,0.0,1.0); adjusted=1.0-(1.0-straightBase)*(1.0-s); }
    else if (uBrushMode==2) { float s=clamp(coverage*uExposure*rangeWeight,0.0,1.0); adjusted=straightBase*(1.0-s); }
    else { float chroma=max(max(straightBase.r,straightBase.g),straightBase.b)-min(min(straightBase.r,straightBase.g),straightBase.b);
      float s=clamp(coverage*uFlow,0.0,1.0); if(uVibrance==1 && uSpongeDirection==1)s*=1.0-chroma;
      adjusted=clamp(vec3(luma)+(straightBase-vec3(luma))*(1.0+float(uSpongeDirection)*s),0.0,1.0); }
    adjusted=floor(adjusted*255.0+0.5)/255.0;
    finalColor=vec4(adjusted*base.a,base.a);
  } else {
    float alpha = coverage + base.a * (1.0 - coverage);
    vec3 premultiplied = paint * coverage + base.rgb * (1.0 - coverage);
    vec3 straight = alpha > 0.0 ? floor(premultiplied / alpha * 255.0 + 0.5) / 255.0 : vec3(0.0);
    alpha = floor(alpha * 255.0 + 0.5) / 255.0;
    finalColor = vec4(straight * alpha, alpha);
  }
}
`;

export const BRUSH_MAX_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uFirst;
uniform sampler2D uSecond;
void main() {
  ivec2 p = ivec2(vPos);
  finalColor = max(texelFetch(uFirst, p, 0), texelFetch(uSecond, p, 0));
}
`;

/** Replaces one touched mask-tile interior over the already-rendered stored mask. */
export const BRUSH_MASK_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBackdrop;
uniform sampler2D uPainted;
uniform mat3 uViewToDoc;
uniform mat3 uDocToMask;
uniform vec2 uMaskSize;
uniform vec2 uMaskEdge;
uniform vec2 uChunkOrigin;
uniform vec2 uChunkSize;
uniform vec2 uTextureSize;
uniform float uApron;
uniform int uSampling;
uniform int uMipLevel;
uniform int uSnap;
void main() {
  vec2 doc = (uViewToDoc * vec3(vPos, 1.0)).xy;
  if (uSnap == 1) doc = floor(doc) + 0.5;
  vec2 mp = (uDocToMask * vec3(doc, 1.0)).xy;
  vec2 chunkMax = uChunkOrigin + uChunkSize;
  if (mp.x < uChunkOrigin.x || mp.y < uChunkOrigin.y || mp.x >= chunkMax.x || mp.y >= chunkMax.y) discard;
  vec2 texturePixel = mp - uChunkOrigin + vec2(uApron);
  float value = sampleGrid(uPainted, texturePixel, ivec2(uTextureSize), uSampling, uMipLevel).r;
  value = mix(0.0, value, edgeCoverage(mp, uMaskSize, uMaskEdge));
  finalColor = vec4(value, value, value, 1.0);
}
`;

/**
 * Builds view-space mask coverage from sparse chunks. The base pass supplies the placed-mask
 * background outside the mask and zero inside; chunk passes replace their disjoint interiors.
 */
export const MASK_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uPrevious;
uniform sampler2D uMask;
uniform int uHasPrevious;
uniform int uDrawChunk;
uniform mat3 uViewToDoc;
uniform mat3 uDocToMask;
uniform vec2 uMaskSize;
uniform vec2 uMaskEdge;
uniform vec2 uChunkOrigin;
uniform vec2 uChunkSize;
uniform vec2 uTextureSize;
uniform float uApron;
uniform float uBackground;
uniform int uSampling;
uniform int uMipLevel;
uniform int uSnap;

void main() {
  float previous = uHasPrevious == 1 ? texelFetch(uPrevious, ivec2(vPos), 0).r : 1.0;
  vec2 doc = (uViewToDoc * vec3(vPos, 1.0)).xy;
  if (uSnap == 1) doc = floor(doc) + 0.5;
  vec2 mp = (uDocToMask * vec3(doc, 1.0)).xy;
  float inside = edgeCoverage(mp, uMaskSize, uMaskEdge);
  float value = uBackground * (1.0 - inside);
  if (uDrawChunk == 1) {
    vec2 chunkMax = uChunkOrigin + uChunkSize;
    if (mp.x < uChunkOrigin.x || mp.y < uChunkOrigin.y || mp.x >= chunkMax.x || mp.y >= chunkMax.y) discard;
    vec2 chunkPixel = mp - uChunkOrigin + vec2(uApron);
    float sampled = sampleGrid(uMask, chunkPixel, ivec2(uTextureSize), uSampling, uMipLevel).r;
    value = mix(uBackground, sampled, inside);
  }
  float c = previous * value;
  finalColor = vec4(c, c, c, 1.0);
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
uniform int uDissolveSeed;
uniform mat3 uViewToDoc;
void main() {
  ivec2 p = ivec2(vPos);
  vec4 dst = texelFetch(uBackdrop, p, 0);
  float a = texelFetch(uBase, p, 0).a;
  vec4 src = vec4(texelFetch(uSurface, p, 0).rgb * a, a);
  if (uHasClip == 1) src *= texelFetch(uClip, p, 0).r;
  ivec2 documentPixel = ivec2(floor((uViewToDoc * vec3(vPos, 1.0)).xy));
  finalColor = composite(uMode, dst, src, documentPixel, uDissolveSeed);
}
`;

/** An isolated PSD group surface composited once with the group's opacity and blend mode. */
export const GROUP_FRAGMENT = /* glsl */ `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uBackdrop;
uniform sampler2D uSurface;
uniform sampler2D uKnockoutBase;
uniform sampler2D uClip;
uniform int uMode;
uniform int uDissolveSeed;
uniform float uOpacity;
uniform float uFillOpacity;
uniform int uKnockout;
uniform int uHasClip;
uniform mat3 uViewToDoc;
void main() {
  ivec2 p = ivec2(vPos);
  vec4 dst = texelFetch(uBackdrop, p, 0);
  vec4 group = texelFetch(uSurface, p, 0);
  if (uHasClip == 1) group *= texelFetch(uClip, p, 0).r;
  if (uKnockout == 1) dst = mix(dst, texelFetch(uKnockoutBase, p, 0), group.a);
  vec4 src = group * (uOpacity * uFillOpacity);
  ivec2 documentPixel = ivec2(floor((uViewToDoc * vec3(vPos, 1.0)).xy));
  finalColor = composite(uMode, dst, src, documentPixel, uDissolveSeed);
}
`;

/**
 * Adjustment layer (LiveMaskRenderer.adjust): adjusted colour, optional blend at full coverage with
 * the original alpha restored, opacity lerp (CIBlendWithMask), then a copy through
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
  if (uOpacity < 1.0) result = vec4(mix(straight, adjusted, uOpacity) * original.a, original.a);
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
uniform vec2 uCompositeOrigin;
uniform vec2 uCompositeSize;
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
  vec2 cp = p - uCompositeOrigin;
  vec4 c = uHasComposite == 1 && cp.x >= 0.0 && cp.y >= 0.0 && cp.x < uCompositeSize.x && cp.y < uCompositeSize.y
    ? texelFetch(uComposite, ivec2(cp), 0) : vec4(0.0);
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
