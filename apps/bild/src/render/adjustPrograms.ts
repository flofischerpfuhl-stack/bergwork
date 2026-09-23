/** Live adjustment-layer GLSL programs matching the CPU engines in core/adjust. */
import type { Layer } from '../core/document';
import {
  resolveAdjustment, type GrainSettings, type HueSaturationSettings,
} from '../core/adjustments';
import { curvesTables, levelsTables } from '../core/adjust/levels';
import { hueCube } from '../core/adjust/apply';
import type { AdjustmentProgram } from './gpuCompositor';

function params(values: readonly number[] = []): Float32Array { const out = new Float32Array(32); out.set(values.slice(0, 32)); return out; }
function tableTexture(tables: Float32Array): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = Math.round(Math.min(1, Math.max(0, tables[i]!)) * 255);
    data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, tables[256 + i]!)) * 255);
    data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, tables[512 + i]!)) * 255); data[i * 4 + 3] = 255;
  }
  return { data, width: 256, height: 1 };
}
function hueTexture(settings: HueSaturationSettings): { data: Uint8Array; width: number; height: number } {
  const cube = hueCube(settings), n = 33, data = new Uint8Array(n * n * n * 4);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const source = ((b * n + g) * n + r) * 3, target = (b * n * n + g * n + r) * 4;
    data[target] = Math.round(cube[source]! * 255); data[target + 1] = Math.round(cube[source + 1]! * 255);
    data[target + 2] = Math.round(cube[source + 2]! * 255); data[target + 3] = 255;
  }
  return { data, width: n * n, height: n };
}

const TABLE_GLSL = /* glsl */ `
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  vec3 p = clamp(c, 0.0, 1.0) * 255.0;
  ivec3 lo = ivec3(floor(p));
  ivec3 hi = min(lo + 1, ivec3(255));
  vec3 f = fract(p);
  vec3 a = vec3(texelFetch(uLut, ivec2(lo.r, 0), 0).r,
                texelFetch(uLut, ivec2(lo.g, 0), 0).g,
                texelFetch(uLut, ivec2(lo.b, 0), 0).b);
  vec3 b = vec3(texelFetch(uLut, ivec2(hi.r, 0), 0).r,
                texelFetch(uLut, ivec2(hi.g, 0), 0).g,
                texelFetch(uLut, ivec2(hi.b, 0), 0).b);
  return mix(a, b, f);
}`;
const HUE_GLSL = /* glsl */ `
vec3 cubeFetch(ivec3 p) { return texelFetch(uLut, ivec2(p.x + p.y * 33, p.z), 0).rgb; }
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  vec3 p = clamp(c, 0.0, 1.0) * 32.0;
  ivec3 a = ivec3(floor(p)), b = min(a + 1, ivec3(32)); vec3 f = fract(p);
  vec3 z0 = mix(mix(cubeFetch(ivec3(a.x,a.y,a.z)), cubeFetch(ivec3(b.x,a.y,a.z)), f.x),
                mix(cubeFetch(ivec3(a.x,b.y,a.z)), cubeFetch(ivec3(b.x,b.y,a.z)), f.x), f.y);
  vec3 z1 = mix(mix(cubeFetch(ivec3(a.x,a.y,b.z)), cubeFetch(ivec3(b.x,a.y,b.z)), f.x),
                mix(cubeFetch(ivec3(a.x,b.y,b.z)), cubeFetch(ivec3(b.x,b.y,b.z)), f.x), f.y);
  return mix(z0, z1, f.z);
}`;
const EXPOSURE_GLSL = /* glsl */ `
vec3 decodeSrgb(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), greaterThan(v, vec3(0.04045))); }
vec3 encodeSrgb(vec3 v) { return mix(v * 12.92, 1.055 * pow(v, vec3(1.0/2.4)) - 0.055, greaterThan(v, vec3(0.0031308))); }
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  vec3 linear = pow(max(vec3(0.0), decodeSrgb(clamp(c,0.0,1.0)) * exp2(uParams[0].x) + uParams[0].y), vec3(1.0/uParams[0].z));
  return clamp(encodeSrgb(linear), 0.0, 1.0);
}`;
const GRADIENT_GLSL = /* glsl */ `
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  float level = clamp(dot(c, vec3(0.2126,0.7152,0.0722)), 0.0, 1.0);
  return mix(uParams[0].rgb, uParams[1].rgb, level);
}`;
const GRAIN_GLSL = /* glsl */ `
uint mix32(uint x) { x ^= x>>16; x *= 0x7feb352du; x ^= x>>15; x *= 0x846ca68bu; x ^= x>>16; return x; }
float lattice(ivec2 p, uint seed) {
  uint h=mix32(uint(p.x)*0x9e3779b1u ^ mix32(uint(p.y)*0x85ebca77u ^ seed));
  return float(h&0xffffu)/65535.0 + float(h>>16)/65535.0 - 1.0;
}
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  float size=max(uParams[0].y,0.0001); vec2 q=documentPixel/size; ivec2 cell=ivec2(floor(q));
  vec2 f=fract(q); f=f*f*(3.0-2.0*f); uint seed=uint(uParams[0].w)*65536u+uint(uParams[0].z);
  float top=mix(lattice(cell,seed),lattice(cell+ivec2(1,0),seed),f.x);
  float bottom=mix(lattice(cell+ivec2(0,1),seed),lattice(cell+ivec2(1,1),seed),f.x);
  float smoothed=mix(top,bottom,f.y)*1.6;
  uint fineSeed=mix32(seed^0xa511e9b3u); float fine=lattice(ivec2(floor(documentPixel)),fineSeed);
  float noise=mix(smoothed,fine,clamp(uParams[1].x/100.0,0.0,1.0));
  float level=clamp(dot(c,vec3(0.2126,0.7152,0.0722)),0.0,1.0);
  float delta=noise*min(1.0,uParams[0].x/100.0)*0.35*(0.4+2.4*level*(1.0-level));
  return clamp(c+delta,0.0,1.0);
}`;

function grainParams(s: GrainSettings): Float32Array {
  const seed = s.seed >>> 0; return params([s.amount, s.size, seed & 0xffff, seed >>> 16, s.roughness]);
}

/** Programs per (immutable) adjustment value, so tables and cubes are built once, not every frame. */
const programs = new WeakMap<object, AdjustmentProgram | null>();

/** All six variants required by `GpuCompositor.adjustmentPrograms`. */
export function adjustmentProgram(layer: Layer): AdjustmentProgram | null {
  if (!layer.adjustment) return null;
  let program = programs.get(layer.adjustment);
  if (program === undefined) { program = makeProgram(layer); programs.set(layer.adjustment, program); }
  return program;
}

function once<T>(make: () => T): () => T { let value: T | undefined; return () => (value ??= make()); }

function makeProgram(layer: Layer): AdjustmentProgram | null {
  if (!layer.adjustment) return null;
  const value = resolveAdjustment(layer.adjustment);
  switch (value.kind) {
    case 'Hue/Saturation': return { key: 'hsv-cube-33', glsl: HUE_GLSL, params: () => params(), lut: once(() => hueTexture(value.hsvSettings)) };
    case 'Levels': return { key: 'levels-table', glsl: TABLE_GLSL, params: () => params(), lut: once(() => tableTexture(levelsTables(value.levels))) };
    case 'Curves': return { key: 'curves-table', glsl: TABLE_GLSL, params: () => params(), lut: once(() => tableTexture(curvesTables(value.curves))) };
    case 'Exposure': return { key: 'exposure-linear', glsl: EXPOSURE_GLSL,
      params: () => params([value.exposureSettings.exposure, value.exposureSettings.offset, value.exposureSettings.gamma]) };
    case 'Gradient Map': {
      const s = value.gradientMapSettings, dark = s.reversed ? s.highlights : s.shadows, light = s.reversed ? s.shadows : s.highlights;
      return { key: 'gradient-map', glsl: GRADIENT_GLSL,
        params: () => params([dark.red, dark.green, dark.blue, 0, light.red, light.green, light.blue]) };
    }
    case 'Grain': return { key: 'grain-v1', glsl: GRAIN_GLSL, params: () => grainParams(value.grainSettings) };
  }
}
