/** Live adjustment-layer GLSL programs matching the CPU engines in core/adjust. */
import type { CanvasDocument, Layer } from '../core/document';
import {
  resolveAdjustment, type GrainSettings, type HueSaturationSettings,
} from '../core/adjustments';
import { curveValue, curvesTables, levelRangeValue, levelsTables } from '../core/adjust/levels';
import { applyAdjustment, hueCube } from '../core/adjust/apply';
import { parseCubeLut, type CubeLut } from '../core/adjust/cube';
import type { AdjustmentProgram } from './gpuCompositor';

function params(values: readonly number[] = []): Float32Array { const out = new Float32Array(32); out.set(values.slice(0, 32)); return out; }
function tableTexture(tables: Float32Array): { data: Float32Array; width: number; height: number } {
  const data = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    data[i * 4] = Math.min(1, Math.max(0, tables[i]!));
    data[i * 4 + 1] = Math.min(1, Math.max(0, tables[256 + i]!));
    data[i * 4 + 2] = Math.min(1, Math.max(0, tables[512 + i]!)); data[i * 4 + 3] = 1;
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
const INVERT_GLSL = /* glsl */ `vec3 adjustColor(vec3 c, vec2 documentPixel) { return vec3(1.0) - c; }`;
const THRESHOLD_GLSL = /* glsl */ `vec3 adjustColor(vec3 c, vec2 documentPixel) {
  float lightness=dot(c,vec3(0.299,0.587,0.114))*255.0;
  return vec3(lightness >= uParams[0].x ? 1.0 : 0.0);
}`;
const POSTERIZE_GLSL = /* glsl */ `vec3 adjustColor(vec3 c, vec2 documentPixel) {
  float levels=max(2.0,uParams[0].x),steps=levels-1.0;
  return min(vec3(steps),floor(clamp(c,0.0,1.0)*levels))/steps;
}`;
const PSD_GRAY_GLSL = /* glsl */ `vec3 adjustColor(vec3 c, vec2 documentPixel) {
  int count=int(uParams[0].x),width=int(uParams[0].y);
  int index=int(round(clamp((c.r+c.g+c.b)/3.0,0.0,1.0)*float(count-1)));
  return texelFetch(uLut,ivec2(index%width,index/width),0).rgb;
}`;
const PSD_CMYK_GLSL = /* glsl */ `
vec4 cmykInverseFetch(ivec3 p) { int n=int(uParams[0].x),columns=int(uParams[0].y); return texelFetch(uLut,
  ivec2((p.z%columns)*n+p.x,(p.z/columns)*n+p.y),0); }
vec4 cmykInverse(vec3 c) {
  // The PSD profile transform is an 8-bit LUT. WebKit's normalized texture/target path can deliver byte 255 just below 1;
  // restore the byte grid before the nonlinear RGB→CMYK→RGB round trip so white and saturated bytes stay exact.
  c=floor(clamp(c,0.0,1.0)*255.0+0.5)/255.0;
  int n=int(uParams[0].x); vec3 p=c*float(n-1); ivec3 a=ivec3(floor(p)),z=min(a+1,ivec3(n-1)); vec3 f=fract(p);
  vec4 outColor=vec4(0.0); for(int dz=0;dz<2;dz++)for(int dy=0;dy<2;dy++)for(int dx=0;dx<2;dx++) {
    ivec3 q=ivec3(dx==0?a.x:z.x,dy==0?a.y:z.y,dz==0?a.z:z.z);
    float weight=(dx==0?1.0-f.x:f.x)*(dy==0?1.0-f.y:f.y)*(dz==0?1.0-f.z:f.z); outColor+=cmykInverseFetch(q)*weight;
  } return outColor;
}
vec3 cmykForwardFetch(ivec4 p) { int n=int(uParams[0].z),y0=int(uParams[0].w);
  return texelFetch(uLut,ivec2(p.y*n+p.x,y0+p.w*n+p.z),0).rgb; }
vec3 cmykForward(vec4 inks) {
  int n=int(uParams[0].z); vec4 p=clamp(inks,0.0,1.0)*float(n-1); ivec4 a=ivec4(floor(p)),z=min(a+1,ivec4(n-1)); vec4 f=fract(p);
  vec3 outColor=vec3(0.0); for(int dk=0;dk<2;dk++)for(int dy=0;dy<2;dy++)for(int dm=0;dm<2;dm++)for(int dc=0;dc<2;dc++) {
    ivec4 q=ivec4(dc==0?a.x:z.x,dm==0?a.y:z.y,dy==0?a.z:z.z,dk==0?a.w:z.w);
    float weight=(dc==0?1.0-f.x:f.x)*(dm==0?1.0-f.y:f.y)*(dy==0?1.0-f.z:f.z)*(dk==0?1.0-f.w:f.w);
    outColor+=cmykForwardFetch(q)*weight;
  } return outColor;
}
float cmykTable(int channel,float value) { float p=clamp(value,0.0,1.0)*255.0; int lo=int(floor(p)),hi=min(255,lo+1);
  int row=int(uParams[1].x)+channel; return mix(texelFetch(uLut,ivec2(lo,row),0).r,texelFetch(uLut,ivec2(hi,row),0).r,fract(p)); }
float cmykParameter(int index) { return uParams[index/4][index%4]; }
float cmykLevel(float value,int range) { int offset=6+range*5; float black=cmykParameter(offset),gamma=cmykParameter(offset+1);
  float white=cmykParameter(offset+2),outputBlack=cmykParameter(offset+3),outputWhite=cmykParameter(offset+4);
  float mapped=clamp((value*255.0-black)/(white-black),0.0,1.0);
  return (outputBlack+pow(mapped,1.0/gamma)*(outputWhite-outputBlack))/255.0; }
vec3 adjustColor(vec3 c, vec2 documentPixel) {
  vec4 inks=cmykInverse(c); int operation=int(uParams[1].y);
  if(operation==0) inks=vec4(1.0)-inks;
  else if(operation==1) { float density=dot(inks,vec4(0.252,0.632,0.109,0.371)); inks=vec4(0.0,0.0,0.0,density>1.0-uParams[1].z/255.0?1.0:0.0); }
  else if(operation==2) { float levels=max(2.0,uParams[1].w),steps=levels-1.0; inks=min(vec4(steps),floor(clamp(inks,0.0,1.0)*levels))/steps; }
  else if(operation==3) for(int channel=0;channel<4;channel++) inks[channel]=1.0-cmykLevel(cmykLevel(1.0-inks[channel],channel+1),0);
  else inks=vec4(cmykTable(0,inks.x),cmykTable(1,inks.y),cmykTable(2,inks.z),cmykTable(3,inks.w));
  return cmykForward(inks);
}`;
const LOOKUP_GLSL = /* glsl */ `
vec3 lookupFetch(ivec3 p) { int columns=int(uParams[0].y); return texelFetch(uLut,
  ivec2((p.z%columns)*int(uParams[0].x)+p.x,(p.z/columns)*int(uParams[0].x)+p.y),0).rgb; }
vec3 lookup1d(vec3 c) {
  int n=int(uParams[0].z); if(n<2)return c; vec3 p=clamp(c,0.0,1.0)*float(n-1); ivec3 lo=ivec3(floor(p));
  ivec3 hi=min(lo+1,ivec3(n-1)); vec3 f=fract(p); int y=int(uParams[0].w);
  vec3 a=vec3(texelFetch(uLut,ivec2(lo.r,y),0).r,texelFetch(uLut,ivec2(lo.g,y),0).g,texelFetch(uLut,ivec2(lo.b,y),0).b);
  vec3 b=vec3(texelFetch(uLut,ivec2(hi.r,y),0).r,texelFetch(uLut,ivec2(hi.g,y),0).g,texelFetch(uLut,ivec2(hi.b,y),0).b);
  return mix(a,b,f);
}
vec3 lookup3d(vec3 c) {
  int n=int(uParams[0].x); if(n<2)return c; vec3 p=clamp(c,0.0,1.0)*float(n-1); ivec3 a=ivec3(floor(p)),z=min(a+1,ivec3(n-1)); vec3 f=fract(p);
  if(uParams[3].x<0.5) {
    vec3 p0=mix(mix(lookupFetch(ivec3(a.x,a.y,a.z)),lookupFetch(ivec3(z.x,a.y,a.z)),f.x),mix(lookupFetch(ivec3(a.x,z.y,a.z)),lookupFetch(ivec3(z.x,z.y,a.z)),f.x),f.y);
    vec3 p1=mix(mix(lookupFetch(ivec3(a.x,a.y,z.z)),lookupFetch(ivec3(z.x,a.y,z.z)),f.x),mix(lookupFetch(ivec3(a.x,z.y,z.z)),lookupFetch(ivec3(z.x,z.y,z.z)),f.x),f.y); return mix(p0,p1,f.z);
  }
  vec3 c000=lookupFetch(a),c111=lookupFetch(z);
  if(f.x>=f.y) { if(f.y>=f.z)return c000+f.x*(lookupFetch(ivec3(z.x,a.y,a.z))-c000)+f.y*(lookupFetch(ivec3(z.x,z.y,a.z))-lookupFetch(ivec3(z.x,a.y,a.z)))+f.z*(c111-lookupFetch(ivec3(z.x,z.y,a.z)));
    if(f.x>=f.z)return c000+f.x*(lookupFetch(ivec3(z.x,a.y,a.z))-c000)+f.z*(lookupFetch(ivec3(z.x,a.y,z.z))-lookupFetch(ivec3(z.x,a.y,a.z)))+f.y*(c111-lookupFetch(ivec3(z.x,a.y,z.z)));
    return c000+f.z*(lookupFetch(ivec3(a.x,a.y,z.z))-c000)+f.x*(lookupFetch(ivec3(z.x,a.y,z.z))-lookupFetch(ivec3(a.x,a.y,z.z)))+f.y*(c111-lookupFetch(ivec3(z.x,a.y,z.z))); }
  if(f.x>=f.z)return c000+f.y*(lookupFetch(ivec3(a.x,z.y,a.z))-c000)+f.x*(lookupFetch(ivec3(z.x,z.y,a.z))-lookupFetch(ivec3(a.x,z.y,a.z)))+f.z*(c111-lookupFetch(ivec3(z.x,z.y,a.z)));
  if(f.y>=f.z)return c000+f.y*(lookupFetch(ivec3(a.x,z.y,a.z))-c000)+f.z*(lookupFetch(ivec3(a.x,z.y,z.z))-lookupFetch(ivec3(a.x,z.y,a.z)))+f.x*(c111-lookupFetch(ivec3(a.x,z.y,z.z)));
  return c000+f.z*(lookupFetch(ivec3(a.x,a.y,z.z))-c000)+f.y*(lookupFetch(ivec3(a.x,z.y,z.z))-lookupFetch(ivec3(a.x,a.y,z.z)))+f.x*(c111-lookupFetch(ivec3(a.x,z.y,z.z)));
}
vec3 adjustColor(vec3 c, vec2 documentPixel) { vec3 domain=clamp((c-uParams[1].rgb)/(uParams[2].rgb-uParams[1].rgb),0.0,1.0); return lookup3d(lookup1d(domain)); }
`;
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
const lookupPrograms = new WeakMap<Uint8Array, Map<string, AdjustmentProgram | null>>();
const GENERIC_CUBE_DIMENSION = 65;

/** All six variants required by `GpuCompositor.adjustmentPrograms`. */
export function adjustmentProgram(layer: Layer, document?: CanvasDocument): AdjustmentProgram | null {
  if (!layer.adjustment) return null;
  if (layer.adjustment.kind === 'Colour Lookup') {
    const adjustment = layer.adjustment;
    const resource = document?.resources?.find((value) => value.id === adjustment.parameters.resourceId && value.role === 'lut');
    if (!resource) return null;
    let variants = lookupPrograms.get(resource.bytes); if (!variants) { variants = new Map(); lookupPrograms.set(resource.bytes, variants); }
    const key = adjustment.parameters.interpolation;
    if (!variants.has(key)) variants.set(key, makeProgram(layer, document));
    return variants.get(key) ?? null;
  }
  let program = programs.get(layer.adjustment);
  if (program === undefined) { program = makeProgram(layer, document); programs.set(layer.adjustment, program); }
  return program;
}

function once<T>(make: () => T): () => T { let value: T | undefined; return () => (value ??= make()); }

function genericTexture(layer: Layer, document?: CanvasDocument): { data: Float32Array; width: number; height: number; columns: number } {
  const n = GENERIC_CUBE_DIMENSION, input = new Float32Array(n * n * n * 4);
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const i = ((b * n + g) * n + r) * 4;
    input[i] = r / (n - 1); input[i + 1] = g / (n - 1); input[i + 2] = b / (n - 1); input[i + 3] = 1;
  }
  const adjusted = applyAdjustment(layer.adjustment!, input, n * n, n, 0, 0, document?.resources);
  const columns = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / columns), width = n * columns, height = n * rows;
  const data = new Float32Array(width * height * 4); for (let i = 3; i < data.length; i += 4) data[i] = 1;
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const source = ((b * n + g) * n + r) * 4;
    const target = ((Math.floor(b / columns) * n + g) * width + (b % columns) * n + r) * 4;
    data[target] = adjusted[source]!; data[target + 1] = adjusted[source + 1]!; data[target + 2] = adjusted[source + 2]!;
  }
  return { data, width, height, columns };
}

function grayTexture(layer: Layer, bits: number, document?: CanvasDocument): { data: Float32Array; width: number; height: number } {
  const count = bits === 16 ? 65_536 : 256, width = Math.min(256, count), height = Math.ceil(count / width);
  const input = new Float32Array(count * 4);
  for (let index = 0; index < count; index++) {
    const value = index / (count - 1), at = index * 4;
    input[at] = value; input[at + 1] = value; input[at + 2] = value; input[at + 3] = 1;
  }
  return { data: applyAdjustment(layer.adjustment!, input, count, 1, 0, 0, document?.resources), width, height };
}

interface PsdCmykTransfer { readonly inverseSize: number; readonly inverse: Uint8Array;
  readonly forwardSize: number; readonly forward: Uint8Array }

function cmykTexture(layer: Layer, transfer: PsdCmykTransfer): { data: Float32Array; width: number; height: number } {
  const inverseSize = transfer.inverseSize, inverseColumns = Math.ceil(Math.sqrt(inverseSize));
  const inverseHeight = inverseSize * Math.ceil(inverseSize / inverseColumns);
  const forwardSize = transfer.forwardSize, forwardWidth = forwardSize * forwardSize;
  const width = Math.max(256, inverseSize * inverseColumns, forwardWidth);
  const forwardY = inverseHeight, tableY = forwardY + forwardWidth, height = tableY + 4;
  const data = new Float32Array(width * height * 4); for (let at = 3; at < data.length; at += 4) data[at] = 1;
  for (let b = 0; b < inverseSize; b++) for (let g = 0; g < inverseSize; g++) for (let r = 0; r < inverseSize; r++) {
    const source = ((b * inverseSize + g) * inverseSize + r) * 4;
    const target = ((Math.floor(b / inverseColumns) * inverseSize + g) * width
      + (b % inverseColumns) * inverseSize + r) * 4;
    for (let channel = 0; channel < 4; channel++) data[target + channel] = transfer.inverse[source + channel]! / 255;
  }
  for (let k = 0; k < forwardSize; k++) for (let y = 0; y < forwardSize; y++) {
    for (let m = 0; m < forwardSize; m++) for (let c = 0; c < forwardSize; c++) {
      const source = (((k * forwardSize + y) * forwardSize + m) * forwardSize + c) * 4;
      const target = ((forwardY + k * forwardSize + y) * width + m * forwardSize + c) * 4;
      for (let channel = 0; channel < 3; channel++) data[target + channel] = transfer.forward[source + channel]! / 255;
    }
  }
  const adjustment = layer.adjustment!;
  if (adjustment.kind === 'Levels' || adjustment.kind === 'Curves' || adjustment.kind === 'Brightness/Contrast') {
    let brightness: Float32Array | null = null;
    if (adjustment.kind === 'Brightness/Contrast') {
      const input = new Float32Array(256 * 4);
      for (let index = 0; index < 256; index++) input.set([index / 255, index / 255, index / 255, 1], index * 4);
      brightness = applyAdjustment({ kind: 'Brightness/Contrast', schemaVersion: 1, parameters: adjustment.parameters },
        input, 256, 1, 0, 0);
    }
    for (let channel = 0; channel < 4; channel++) for (let index = 0; index < 256; index++) {
      const ink = index / 255, input = 1 - ink;
      let output: number;
      if (adjustment.kind === 'Levels') {
        const local = adjustment.parameters.ranges[channel + 1];
        output = 1 - levelRangeValue(local ? levelRangeValue(input, local) : input, adjustment.parameters.ranges[0]!);
      } else if (adjustment.kind === 'Curves') {
        const local = adjustment.parameters.channels[channel + 1];
        const value = local ? curveValue(input * 255, adjustment.parameters, channel + 1) : input * 255;
        output = 1 - curveValue(value, adjustment.parameters, 0) / 255;
      } else output = 1 - brightness![(255 - index) * 4]!;
      data[((tableY + channel) * width + index) * 4] = output;
    }
  }
  return { data, width, height };
}

function lookupTexture(lut: CubeLut): { data: Float32Array; width: number; height: number; columns: number; oneDRow: number } {
  const n = lut.size3D, columns = n ? Math.ceil(Math.sqrt(n)) : 1, rows = n ? Math.ceil(n / columns) : 0;
  const cubeHeight = n * rows, width = Math.max(1, n * columns, lut.size1D), height = Math.max(1, cubeHeight + (lut.size1D ? 1 : 0));
  const data = new Float32Array(width * height * 4); for (let i = 3; i < data.length; i += 4) data[i] = 1;
  if (lut.data3D) for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    const src = ((b * n + g) * n + r) * 3, x = (b % columns) * n + r, y = Math.floor(b / columns) * n + g, dst = (y * width + x) * 4;
    data[dst] = lut.data3D[src]!; data[dst + 1] = lut.data3D[src + 1]!; data[dst + 2] = lut.data3D[src + 2]!;
  }
  if (lut.data1D) for (let i = 0; i < lut.size1D; i++) {
    const src = i * 3, dst = (cubeHeight * width + i) * 4;
    data[dst] = lut.data1D[src]!; data[dst + 1] = lut.data1D[src + 1]!; data[dst + 2] = lut.data1D[src + 2]!;
  }
  return { data, width, height, columns, oneDRow: cubeHeight };
}

function makeProgram(layer: Layer, document?: CanvasDocument): AdjustmentProgram | null {
  if (!layer.adjustment) return null;
  if (layer.adjustment.kind === 'Colour Lookup') {
    const adjustment = layer.adjustment;
    const resource = document?.resources?.find((value) => value.id === adjustment.parameters.resourceId && value.role === 'lut');
    if (!resource) return null;
    let lut: CubeLut; try { lut = parseCubeLut(resource.bytes); } catch { return null; }
    const texture = once(() => lookupTexture(lut));
    return { key: `cube-lut:${lut.size1D}:${lut.size3D}`, glsl: LOOKUP_GLSL,
      params: () => { const t = texture(); return params([lut.size3D, t.columns, lut.size1D, t.oneDRow,
        ...lut.domainMin, 0, ...lut.domainMax, 0, adjustment.parameters.interpolation === 'tetrahedral' ? 1 : 0]); }, lut: texture };
  }
  const value = resolveAdjustment(layer.adjustment);
  const psd = layer.adjustment as typeof layer.adjustment
    & { readonly psdColorMode?: number; readonly psdBitsPerChannel?: number; readonly psdCmykTransfer?: PsdCmykTransfer };
  const generic = (): AdjustmentProgram => {
    const texture = once(() => genericTexture(layer, document));
    return { key: `generic-cube-${GENERIC_CUBE_DIMENSION}:${value.kind}`, glsl: LOOKUP_GLSL,
      params: () => { const t = texture(); return params([GENERIC_CUBE_DIMENSION, t.columns, 0, t.height,
        0, 0, 0, 0, 1, 1, 1, 0, 0]); }, lut: texture };
  };
  const gray = (): AdjustmentProgram => {
    const bits = psd.psdBitsPerChannel === 16 ? 16 : 8, texture = once(() => grayTexture(layer, bits, document));
    return { key: `psd-gray-${bits}:${value.kind}`, glsl: PSD_GRAY_GLSL,
      params: () => { const t = texture(); return params([bits === 16 ? 65_536 : 256, t.width]); }, lut: texture };
  };
  const cmyk = (): AdjustmentProgram => {
    const transfer = psd.psdCmykTransfer!, texture = once(() => cmykTexture(layer, transfer));
    const operation = value.kind === 'Invert' ? 0 : value.kind === 'Threshold' ? 1 : value.kind === 'Posterize' ? 2
      : value.kind === 'Levels' ? 3 : 4;
    return { key: `psd-cmyk:${value.kind}`, glsl: PSD_CMYK_GLSL,
      params: () => { const inverseColumns = Math.ceil(Math.sqrt(transfer.inverseSize));
        const forwardY = transfer.inverseSize * Math.ceil(transfer.inverseSize / inverseColumns);
        let extra: number[];
        if (layer.adjustment?.kind === 'Levels') {
          const ranges = layer.adjustment.parameters.ranges;
          extra = Array.from({ length: 5 }, (_, index) => ranges[index]
            ?? { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })
            .flatMap((range) => [range.black, range.gamma, range.white, range.outputBlack, range.outputWhite]);
        } else extra = [layer.adjustment?.kind === 'Threshold' ? layer.adjustment.parameters.level : 0,
          layer.adjustment?.kind === 'Posterize' ? layer.adjustment.parameters.levels : 0];
        return params([transfer.inverseSize, inverseColumns, transfer.forwardSize, forwardY,
          forwardY + transfer.forwardSize ** 2, operation, ...extra]); }, lut: texture };
  };
  switch (value.kind) {
    case 'Hue/Saturation': return { key: 'hsv-cube-33', glsl: HUE_GLSL, params: () => params(), lut: once(() => hueTexture(value.hsvSettings)) };
    case 'Levels': return psd.psdColorMode === 1 ? gray() : psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk()
      : { key: 'levels-table', glsl: TABLE_GLSL, params: () => params(), lut: once(() => tableTexture(levelsTables(value.levels))) };
    case 'Curves': return psd.psdColorMode === 1 ? gray() : psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk()
      : { key: 'curves-table', glsl: TABLE_GLSL, params: () => params(), lut: once(() => tableTexture(curvesTables(value.curves))) };
    case 'Exposure': return { key: 'exposure-linear', glsl: EXPOSURE_GLSL,
      params: () => params([value.exposureSettings.exposure, value.exposureSettings.offset, value.exposureSettings.gamma]) };
    case 'Gradient Map': {
      const s = value.gradientMapSettings, dark = s.reversed ? s.highlights : s.shadows, light = s.reversed ? s.shadows : s.highlights;
      return { key: 'gradient-map', glsl: GRADIENT_GLSL,
        params: () => params([dark.red, dark.green, dark.blue, 0, light.red, light.green, light.blue]) };
    }
    case 'Grain': return { key: 'grain-v1', glsl: GRAIN_GLSL, params: () => grainParams(value.grainSettings) };
    case 'Invert': return psd.psdColorMode === 1 ? gray() : psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk()
      : { key: 'invert', glsl: INVERT_GLSL, params: () => params() };
    case 'Threshold': return psd.psdColorMode === 1 ? gray() : psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk() : { key: 'threshold', glsl: THRESHOLD_GLSL,
      params: () => params([layer.adjustment.kind === 'Threshold' ? layer.adjustment.parameters.level : 128]) };
    case 'Posterize': return psd.psdColorMode === 1 ? gray() : psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk() : { key: 'posterize', glsl: POSTERIZE_GLSL,
      params: () => params([layer.adjustment.kind === 'Posterize' ? layer.adjustment.parameters.levels : 4]) };
    case 'Brightness/Contrast': return psd.psdColorMode === 4 && psd.psdCmykTransfer ? cmyk() : generic();
    case 'Basic': case 'Colour': case 'Photo Filter': case 'Channel Mixer': return generic();
    case 'Colour Lookup': return null;
  }
}
