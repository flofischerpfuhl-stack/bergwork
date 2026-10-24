import type { LiveFilter } from '../core/document';
import type { BlendMode } from '../core/document';
import type { FilterKind, FilterSettings } from '../core/filters/settings';
import { COMMON } from './shaders';

export type ViewFilter = (
  | { readonly kind: 'Gaussian Blur'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Motion Blur'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Add Noise'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Lens Correction'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Unsharp Mask'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Smart Sharpen'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'High Pass'; readonly settings: FilterSettings; readonly seed: number }
  | { readonly kind: 'Denoise'; readonly settings: FilterSettings; readonly seed: number }) & {
    readonly opacity: number; readonly blendMode: BlendMode;
  };

export interface GpuFilterPreview {
  readonly kind: FilterKind;
  readonly settings: FilterSettings;
  readonly seed: number;
  readonly selection: import('../core/selection').DocumentSelection | null;
}

export type PreviewLayer = import('../core/document').Layer & { readonly gpuFilterPreview?: GpuFilterPreview };

/** View-space counterparts of upstream `Compositor/Document/Filters.swift` `PixelFilter.run`. */
export function liveViewFilter(filter: LiveFilter, defaults: FilterSettings): ViewFilter | null {
  if (!filter.enabled) return null;
  const seed = 0x6d2b79f5, opacity = filter.opacity ?? 1, blendMode = filter.blendMode ?? 'normal';
  switch (filter.kind) {
    case 'gaussianBlur': return { kind: 'Gaussian Blur', settings: { ...defaults, radius: filter.radius }, seed, opacity, blendMode };
    case 'motionBlur': return { kind: 'Motion Blur', settings: { ...defaults, angle: filter.angle, distance: filter.distance }, seed, opacity, blendMode };
    case 'noise': return { kind: 'Add Noise', settings: { ...defaults, amount: filter.amount,
      gaussian: filter.gaussian, monochromatic: filter.monochromatic }, seed, opacity, blendMode };
    case 'lensCorrection': return { kind: 'Lens Correction', settings: { ...defaults, distortion: filter.distortion }, seed, opacity, blendMode };
    case 'unsharpMask': return { kind: 'Unsharp Mask', settings: { ...defaults, amount: filter.amount,
      radius: filter.radius, threshold: filter.threshold }, seed, opacity, blendMode };
    case 'smartSharpen': return { kind: 'Smart Sharpen', settings: { ...defaults, amount: filter.amount,
      radius: filter.radius, threshold: filter.threshold, reduceNoise: filter.reduceNoise }, seed, opacity, blendMode };
    case 'highPass': return { kind: 'High Pass', settings: { ...defaults, radius: filter.radius }, seed, opacity, blendMode };
    case 'denoise': return { kind: 'Denoise', settings: { ...defaults, luminance: filter.luminance,
      colour: filter.colour, detail: filter.detail ?? 50 }, seed, opacity, blendMode };
    // No view-space program: the compositor renders these through the cached CPU stack (`needsCpuLiveFilters`).
    case 'vignette': case 'bloom': case 'tonalContrast': case 'progressiveBlur': case 'rgbSplit': return null;
  }
}

/** Whether a live stack holds an enabled filter that only the CPU path (`applyLiveFilters`) can render. */
export function needsCpuLiveFilters(filters: readonly LiveFilter[]): boolean {
  return filters.some((filter) => filter.enabled && (filter.kind === 'vignette' || filter.kind === 'bloom'
    || filter.kind === 'tonalContrast' || filter.kind === 'progressiveBlur' || filter.kind === 'rgbSplit'));
}

export function previewViewFilter(preview: GpuFilterPreview): ViewFilter | null {
  switch (preview.kind) {
    case 'Gaussian Blur': case 'Motion Blur': case 'Add Noise': case 'Lens Correction':
    case 'Unsharp Mask': case 'Smart Sharpen': case 'High Pass': case 'Denoise': return { ...preview, opacity: 1, blendMode: 'normal' } as ViewFilter;
    default: return null;
  }
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uSource;
uniform vec2 uSourceSize;
uniform vec2 uDirection;
uniform mat3 uViewToLayer;
uniform mat3 uLayerToView;
uniform vec2 uLayerSize;
uniform vec4 uParams;
uniform int uSeed;
`;

export function gaussianSupport(sigma: number, recursive = false): 4 | 8 | 16 | 32 | 64 | 96 {
  const radius = Math.min(96, recursive ? Math.ceil(Math.max(0.5, sigma) * 8) + 3
    : Math.ceil(Math.max(0.01, sigma) * 3));
  return radius <= 4 ? 4 : radius <= 8 ? 8 : radius <= 16 ? 16 : radius <= 32 ? 32 : radius <= 64 ? 64 : 96;
}

function recursiveCoefficients(sigma: number): { feed: number; one: number; two: number; three: number; padding: number } {
  const q = sigma >= 2.5 ? 0.98711 * sigma - 0.96330 : 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * sigma);
  const q2 = q * q, q3 = q2 * q, divisor = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
  const one = (2.44413 * q + 2.85619 * q2 + 1.26661 * q3) / divisor;
  const two = -(1.4281 * q2 + 1.26661 * q3) / divisor, three = 0.422205 * q3 / divisor;
  return { feed: 1 - one - two - three, one, two, three, padding: Math.ceil(8 * sigma) + 3 };
}

export function usesRecursiveGaussian(width: number, height: number, sigma: number, directions: 1 | 2): boolean {
  const taps = Math.ceil(Math.max(0.01, sigma) * 3) * 2 + 1;
  return width * height > 250_000 && width * height * taps * directions > 32_000_000;
}

export function gaussianWeights(sigma: number, support: number, recursive = false): Float32Array {
  const safe = Math.max(0.01, sigma), radius = Math.min(96, Math.ceil(safe * 3));
  const weights = new Float32Array(support * 2 + 1); let total = 0;
  if (recursive) {
    const coefficients = recursiveCoefficients(Math.max(0.5, safe));
    const length = Math.max(support * 6 + 1, coefficients.padding * 2 + support * 2 + 1), center = Math.floor(length / 2);
    const forward = new Float64Array(length + coefficients.padding), output = new Float64Array(length);
    let previous1 = 0, previous2 = 0, previous3 = 0;
    for (let x = 0; x < forward.length; x++) {
      const value = coefficients.feed * (x === center ? 1 : 0)
        + coefficients.one * previous1 + coefficients.two * previous2 + coefficients.three * previous3;
      forward[x] = value; previous3 = previous2; previous2 = previous1; previous1 = value;
    }
    previous1 = 0; previous2 = 0; previous3 = 0;
    for (let x = forward.length - 1; x >= 0; x--) {
      const value = coefficients.feed * forward[x]! + coefficients.one * previous1
        + coefficients.two * previous2 + coefficients.three * previous3;
      if (x < length) output[x] = value;
      previous3 = previous2; previous2 = previous1; previous1 = value;
    }
    for (let offset = -support; offset <= support; offset++) weights[offset + support] = output[center + offset]!;
    return weights;
  }
  for (let offset = -radius; offset <= radius; offset++) {
    const value = Math.exp(-0.5 * (offset / safe) ** 2); weights[offset + support] = value; total += value;
  }
  for (let index = 0; index < weights.length; index++) weights[index] = weights[index]! / total;
  // Keep the uploaded float kernel normalized after Float64→Float32 conversion; otherwise long flat runs
  // acquire a small negative bias that sharpening can amplify across an 8-bit boundary.
  let floatTotal = 0; for (const weight of weights) floatTotal += weight;
  weights[support] = weights[support]! + (1 - floatTotal);
  return weights;
}

/** Exact finite Gaussian taps through radius 96; larger interactive radii keep bounded GPU work. */
export function gaussianFragment(support: number): string { return `${HEADER}
uniform float uWeights[${support * 2 + 1}];
void main(){vec4 sum=vec4(0.0);vec2 q;
  for(int offset=-${support};offset<=${support};offset++){float weight=uWeights[offset+${support}];if(weight<=0.0)continue;
    q=vPos+uDirection*float(offset);if(all(greaterThanEqual(q,vec2(0.0)))&&all(lessThan(q,uSourceSize)))
      {vec2 centre=abs(fract(q)-vec2(0.5));vec4 sampled=all(lessThan(centre,vec2(0.0001)))
        ?texelFetch(uSource,ivec2(floor(q)),0):texture(uSource,q/uSourceSize);sum+=sampled*weight;}}finalColor=sum;}`; }

export const COMBINE_FRAGMENT = `${HEADER}
uniform sampler2D uSecond;
void main(){ivec2 p=ivec2(vPos);vec4 source=texelFetch(uSource,p,0),blurred=texelFetch(uSecond,p,0);
  vec3 s=source.a>0.0?source.rgb/source.a:vec3(0.0),b=blurred.a>0.0?blurred.rgb/blurred.a:vec3(0.0);
  float levels=max(255.0,uParams.w);
  vec3 sourceValues=floor(clamp(s,0.0,1.0)*levels+0.5);
  // Match the CPU's Float64 convolution -> Float32 plane -> integer rounding at half-value boundaries.
  vec3 blurredValues=floor(clamp(b-vec3(0.05/levels),0.0,1.0)*levels+0.5);
  s=sourceValues/levels;b=blurredValues/levels;vec3 detail=s-b;
  vec3 passesGate=step(vec3(uParams.y/255.0),abs(detail));
  // Unpremultiplication makes an exact threshold hit at a transparent boundary ambiguous by one
  // blurred byte across float32 drivers. Use the midpoint of gated/ungated results only there.
  float edge=step(0.5,uParams.y)*(1.0-step(0.999,blurred.a));
  vec3 exact=vec3(1.0)-step(vec3(0.5/levels),abs(abs(detail)-vec3(uParams.y/255.0)));
  passesGate*=mix(vec3(1.0),vec3(0.5),exact*edge);
  vec3 changed=mix(s,clamp(s+detail*uParams.x/100.0,0.0,1.0),passesGate);
  // Avoid WebKit's upward half-tie on the neutral High Pass offset without moving a full source value.
  if(uParams.z>0.5) changed=clamp(vec3(0.5)+detail-vec3(0.00255/levels),0.0,1.0);
  changed=floor(changed*levels+0.5)/levels;
  finalColor=vec4(changed*source.a,source.a);
}`;

/** Photoshop smart-filter blending options: filtered result over the pre-filter image. */
export const FILTER_BLEND_FRAGMENT = `${COMMON}
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uSource;
uniform sampler2D uSecond;
uniform int uMode;
uniform float uOpacity;
void main(){ivec2 p=ivec2(vPos);vec4 before=texelFetch(uSource,p,0),filtered=texelFetch(uSecond,p,0);
  finalColor=composite(uMode,before,filtered*clamp(uOpacity,0.0,1.0),p,0);}
`;

export const DENOISE_FRAGMENT = `${HEADER}
vec4 sampleAt(vec2 q){return all(greaterThanEqual(q,vec2(0.0)))&&all(lessThan(q,uSourceSize))
  ?texture(uSource,q/uSourceSize):vec4(0.0);}
void main(){vec4 center=sampleAt(vPos);if(center.a<=0.0){finalColor=center;return;}
  vec3 c=center.rgb/center.a;float cy=dot(c,vec3(0.2126,0.7152,0.0722));float radius=uParams.w;
  float spatialSigma=max(1.0,radius*0.65),rangeSigma=0.04+(1.0-uParams.z)*0.24;
  float sw=0.0,sy=0.0,scb=0.0,scr=0.0;
  for(int y=-4;y<=4;y++)for(int x=-4;x<=4;x++){if(abs(float(x))>radius||abs(float(y))>radius)continue;
    vec4 sampled=sampleAt(vPos+uDirection*float(x)+uLayerToView[1].xy*float(y));
    if(sampled.a<=0.0)continue;vec3 s=sampled.rgb/sampled.a;float lum=dot(s,vec3(0.2126,0.7152,0.0722));float d=lum-cy;
    float w=exp(-(float(x*x+y*y))/(2.0*spatialSigma*spatialSigma)-d*d/(2.0*rangeSigma*rangeSigma));
    sw+=w;sy+=lum*w;scb+=(s.b-lum)*w;scr+=(s.r-lum)*w;}
  float smoothY=sy/max(sw,1e-6),smoothCb=scb/max(sw,1e-6),smoothCr=scr/max(sw,1e-6);
  float oldCb=c.b-cy,oldCr=c.r-cy,nextY=mix(cy,smoothY,uParams.x),nextCb=mix(oldCb,smoothCb,uParams.y),nextCr=mix(oldCr,smoothCr,uParams.y);
  vec3 outColor;outColor.r=nextY+nextCr;outColor.b=nextY+nextCb;outColor.g=(nextY-0.2126*outColor.r-0.0722*outColor.b)/0.7152;
  finalColor=vec4(clamp(outColor,0.0,1.0)*center.a,center.a);
}`;

export const NOISE_FRAGMENT = `${HEADER}
uint hash32(uint x){x^=x>>16;x*=0x7feb352du;x^=x>>15;x*=0x846ca68bu;x^=x>>16;return x;}
float unit(uint x){return float(hash32(x)>>8)/16777216.0;}
void main(){ivec2 p=ivec2(vPos);vec4 source=texelFetch(uSource,p,0);if(source.a<=0.0){finalColor=source;return;}
  vec2 lp=(uViewToLayer*vec3(vPos,1.0)).xy;uint index=uint(max(0.0,floor(lp.y)))*uint(uLayerSize.x)+uint(max(0.0,floor(lp.x)));
  uint base=hash32(uint(uSeed)^hash32(index));vec3 straight=source.rgb/source.a;float spread=uParams.x*0.005;
  for(int c=0;c<3;c++){uint key=uParams.z>0.5?base:base+uint(c)*0x9e3779b9u;float n;
    if(uParams.y>0.5)n=sqrt(-2.0*log(max(1e-7,1.0-unit(key))))*cos(6.28318530718*unit(key^0x68e31da4u))*spread*0.6666666667;
    else n=(unit(key)*2.0-1.0)*spread;straight[c]=clamp(straight[c]+n,0.0,1.0);}
  finalColor=vec4(straight*source.a,source.a);
}`;

export const LENS_FRAGMENT = `${HEADER}
vec4 bilinearZero(vec2 q){vec2 base=floor(q-0.5),f=q-0.5-base;vec4 sum=vec4(0.0);
  for(int y=0;y<2;y++)for(int x=0;x<2;x++){vec2 at=base+vec2(float(x),float(y));if(all(greaterThanEqual(at,vec2(0.0)))&&all(lessThan(at,uSourceSize)))
    sum+=texelFetch(uSource,ivec2(at),0)*(x==0?1.0-f.x:f.x)*(y==0?1.0-f.y:f.y);}return sum;}
void main(){vec2 lp=(uViewToLayer*vec3(vPos,1.0)).xy,center=uLayerSize*0.5,d=lp-center;
  float scale=1.0-uParams.x*0.0035*dot(d,d)/max(dot(center,center),1e-6);vec2 sourceLayer=center+d*scale;
  vec2 sourceView=(uLayerToView*vec3(sourceLayer,1.0)).xy;finalColor=bilinearZero(sourceView);}
`;

export const SELECTION_MIX_FRAGMENT = `${HEADER}
uniform sampler2D uSecond;
uniform sampler2D uSelection;
void main(){ivec2 p=ivec2(vPos);vec4 a=texelFetch(uSource,p,0),b=texelFetch(uSecond,p,0);float coverage=texelFetch(uSelection,p,0).r;
  vec4 straightA=vec4(a.a>0.0?a.rgb/a.a:vec3(0.0),a.a),straightB=vec4(b.a>0.0?b.rgb/b.a:vec3(0.0),b.a);
  vec4 mixed=mix(straightA,straightB,coverage);finalColor=vec4(mixed.rgb*mixed.a,mixed.a);}
`;

export const QUANTIZE_FRAGMENT = `${HEADER}
void main(){vec4 source=texelFetch(uSource,ivec2(vPos),0);float maximum=uParams.x;
  float alpha=floor(clamp(source.a,0.0,1.0)*maximum+0.5)/maximum;
  vec3 straight=source.a>0.0?source.rgb/source.a:vec3(0.0);
  straight=floor(clamp(straight,0.0,1.0)*maximum+0.5)/maximum;
  finalColor=vec4(straight*alpha,alpha);}
`;

export function filterHalo(filters: readonly ViewFilter[], targetPerLayerX: number, targetPerLayerY: number): number {
  let layerPixels = 0;
  for (const filter of filters) {
    if (filter.kind === 'Gaussian Blur' || filter.kind === 'Unsharp Mask' || filter.kind === 'High Pass' || filter.kind === 'Smart Sharpen') {
      layerPixels += Math.min(96, Math.ceil(filter.settings.radius * 8) + 3);
    } else if (filter.kind === 'Motion Blur') layerPixels += Math.min(96, Math.ceil(filter.settings.distance / Math.sqrt(12) * 8) + 3);
    else if (filter.kind === 'Denoise') layerPixels += 4;
  }
  return Math.min(256, Math.ceil(layerPixels * Math.max(targetPerLayerX, targetPerLayerY)) + 2);
}
