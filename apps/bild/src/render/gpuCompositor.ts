/**
 * GPU compositor on PixiJS 8 / WebGL2.
 *
 * Every frame composites the visible document region directly in view space (one full-target
 * pass per layer), so cost scales with the viewport, not the document. Export uses the very same
 * passes with a 1:1 document-tile view and reads the result back. Semantics mirror upstream
 * EditorCanvas/LiveMaskRenderer: pass-through folders, folder masks clipping their descendants,
 * clipping stacks composited on an opaque surface, live masks from other layers' alpha, and
 * adjustment layers applied to everything below.
 */

// Pixi's counterintuitively named module installs static synchronisers; it does not relax CSP.
import 'pixi.js/unsafe-eval';
import {
  Mesh, MeshGeometry, RenderTexture, Shader, State, Texture, TextureSource, WebGLRenderer,
} from 'pixi.js';
import { adjustmentProgram } from './adjustPrograms';
import { ancestorIds, maskTransform as storedMaskTransform, type BlendMode, type CanvasDocument, type Layer } from '../core/document';
import { apply, concat, invert, pixelToDocument, type Affine, type LayerTransform, type Point, type Rect } from '../core/geometry';
import { Raster, TILE } from '../core/raster';
import { blendSeed } from '../core/blend';
import { floatToRgba16, makePixelArray, type PixelArray } from '../core/pixel/format';
import type { BrushSegment, GpuBrushPreview } from '../core/brush';
import { prepareDab, tipAtlas, type BrushDab, type BrushTipImage, type PreparedDab } from '../core/brush/tip';
import { documentWithLayerEffects } from '../core/effects';
import { inverseHomographyMatrix } from '../core/distort';
import { tessellateMesh } from '../core/meshWarp';
import {
  adjustFragment, BLEND_INDEX, BRUSH_COVERAGE_FRAGMENT, BRUSH_DAB_FRAGMENT, BRUSH_MASK_FRAGMENT, BRUSH_MAX_FRAGMENT, BRUSH_PAINT_FRAGMENT, BRUSH_SELECTION_FRAGMENT, COVERAGE_FRAGMENT,
  GROUP_FRAGMENT, IDENTITY_ADJUST, LAYER_FRAGMENT, MASK_FRAGMENT, OPAQUE_FRAGMENT, PRESENT_FRAGMENT, STACK_FRAGMENT,
  UNPREMULTIPLY_FRAGMENT, VERTEX, WARP_MESH_FRAGMENT, FILTERED_LAYER_FRAGMENT,
} from './shaders';
import type { CmykLut } from '../core/color/cmyk';
import { EffectLiveFilterHookAdapter } from './liveFilterPasses';
import { defaultFilterSettings } from '../core/filters/settings';
import { applyLiveFilters } from '../core/filters/live';
import {
  COMBINE_FRAGMENT, DENOISE_FRAGMENT, LENS_FRAGMENT, NOISE_FRAGMENT, QUANTIZE_FRAGMENT, SELECTION_MIX_FRAGMENT,
  filterHalo, gaussianFragment, gaussianSupport, gaussianWeights, liveViewFilter, previewViewFilter,
  usesRecursiveGaussian, type PreviewLayer, type ViewFilter,
} from './gpuFilterPasses';

export { DEFAULT_HOOKS, type CompositeHooks } from './hooks';
import { DEFAULT_HOOKS, type CompositeHooks } from './hooks';

const residentViews = new WeakMap<Raster, { signature: string; raster: Raster }>();
const zeroTiles = new Map<string, PixelArray>();
const occupiedChunkCache = new WeakMap<Raster, Map<number, ReadonlySet<string>>>();

function occupiedChunks(raster: Raster, chunkSize: number): ReadonlySet<string> {
  let sizes = occupiedChunkCache.get(raster);
  const cached = sizes?.get(chunkSize);
  if (cached) return cached;
  const occupied = new Set<string>();
  for (let index = 0; index < raster.tiles.length; index++) {
    if (!raster.tiles[index]) continue;
    const col = index % raster.cols, row = Math.floor(index / raster.cols);
    occupied.add(chunkKey(Math.floor(col * TILE / chunkSize), Math.floor(row * TILE / chunkSize)));
  }
  if (!sizes) { sizes = new Map(); occupiedChunkCache.set(raster, sizes); }
  sizes.set(chunkSize, occupied);
  return occupied;
}

/** A sparse full-resolution view containing every resolved tile and no swapped tile. */
function residentView(source: Raster): Raster {
  let signature = '';
  const length = source.cols * source.rows;
  for (let index = 0; index < length; index++) {
    const state = source.tileResidency(index);
    signature += state === 'swapped' ? 's' : state === 'resident' ? 'r' : 'z';
  }
  const cached = residentViews.get(source);
  if (cached?.signature === signature) return cached.raster;
  const tiles: (PixelArray | null)[] = new Array(length);
  for (let index = 0; index < length; index++) {
    const state = source.tileResidency(index);
    if (state === 'resident') tiles[index] = source.tiles[index] ?? null;
    else if (state === 'zero') {
      const col = index % source.cols, row = Math.floor(index / source.cols);
      const length = source.tileWidth(col) * source.tileHeight(row) * source.channels;
      const key = `${source.format}:${length}`;
      let zero = zeroTiles.get(key);
      if (!zero) { zero = makePixelArray(source.format, length); zeroTiles.set(key, zero); }
      tiles[index] = zero;
    } else tiles[index] = null;
  }
  const raster = new Raster(source.width, source.height, source.channels, tiles, { format: source.format });
  residentViews.set(source, { signature, raster });
  return raster;
}

/** Maps target pixels to document pixels. */
export interface ViewSpec {
  readonly width: number;
  readonly height: number;
  readonly viewToDoc: Affine;
  /** Target pixels per document pixel (for edge antialiasing and mip selection). */
  readonly scale: number;
  /** Show whole document pixels hard-edged (zoom ≥ 200%, EditorCanvas.crispZoom). */
  readonly snap: boolean;
  /** Retain this interactive viewport result so an unchanged redraw can skip all composition passes. */
  readonly cache?: boolean;
}

export interface GpuPerformanceCounters {
  readonly effectRegenerations: number;
  readonly textureUploads: number;
  readonly targetAllocations: number;
  readonly drawPasses: number;
  readonly drawnPixels: number;
  readonly compositeRequests: number;
  readonly fullComposites: number;
  readonly unchangedFrameHits: number;
  readonly viewFilterLayers: number;
  readonly viewFilterPasses: number;
  readonly cpuLiveFilterFallbacks: number;
}

/** GLSL for one adjustment kind plus how to fill its uniforms. Provided by the adjustment module. */
export interface AdjustmentProgram {
  readonly key: string;
  readonly glsl: string;
  params(layer: Layer): Float32Array; // up to 8 vec4
  lut?(layer: Layer): { data: Uint8Array | Float32Array; width: number; height: number } | null;
}
export type AdjustmentProgramProvider = (layer: Layer, document?: CanvasDocument) => AdjustmentProgram | null;

type Uniforms = Record<string, { value: unknown; type: string; size?: number }>;

interface Pass {
  shader: Shader;
  uniforms: { uniforms: Record<string, unknown>; update(): void };
}

interface CustomPassSpec { readonly uniforms: Uniforms; readonly textures: readonly string[] }

interface Slot {
  raster: Raster;
  chunks: Map<string, TextureChunk>;
  lastUsed: number;
  /** RGBA chunks are premultiplied half floats rather than 8-bit (16-bit rasters, or `preciseTextures`). */
  wide: boolean;
}

/**
 * Modes that divide by the blend or backdrop colour (Colour Burn/Dodge, Vivid Light, Divide). They amplify the
 * error of an 8-bit premultiplied texture un-premultiplied at low alpha, so documents using them upload RGBA8
 * layers as premultiplied half floats, which keeps the GPU within rounding of the straight-alpha CPU compositor.
 */
const PRECISION_SENSITIVE_MODES: ReadonlySet<string> = new Set(['colorBurn', 'colorDodge', 'vividLight', 'divide']);

interface TextureChunk {
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly source: TextureSource;
  readonly bytes: number;
  lastUsed: number;
}

interface BrushChunk {
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  permanent: RenderTexture;
  alternate: RenderTexture;
  readonly scratch: RenderTexture;
  readonly tail: RenderTexture;
  readonly painted: RenderTexture;
  selection: RenderTexture | null;
  bounds: Rect | null;
}

type BrushTargets = Pick<BrushChunk, 'permanent' | 'alternate' | 'scratch' | 'tail' | 'painted'>;

interface BrushGpuState {
  readonly preview: GpuBrushPreview;
  readonly chunks: Map<string, BrushChunk>;
  applied: number;
  revision: number;
  tailKeys: Set<string>;
  tail: readonly BrushSegment[];
  dirty: Rect | null;
  /** Dab brushes: settled dabs already drawn and the tail dabs currently in the tail targets. */
  appliedDabs?: number;
  tailDabs?: readonly PreparedDab[];
}

interface BrushCompositeCache {
  readonly document: CanvasDocument;
  readonly preview: GpuBrushPreview;
  readonly view: ViewSpec;
  readonly target: RenderTexture;
}

interface CompositeVisualState {
  readonly documentValues: readonly unknown[];
  readonly layerValues: readonly unknown[];
}

interface ViewportCompositeCache {
  readonly state: CompositeVisualState;
  readonly view: ViewSpec;
  readonly target: RenderTexture;
  readonly skippedAdjustments: number;
}

// A 64 px margin leaves one neighbour texel at the deepest supported sharp halving (level 6).
// TiledLayerRenderer.support grows its piece margin for the same reason.
const CHUNK_APRON = 64;
const TARGET_CHUNK_SIZE = 4096;
const BRUSH_CHUNK_SIZE = TILE;
const BRUSH_APRON = CHUNK_APRON;

const IDENTITY9 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const UNORM16_TO_HALF = makeUnorm16ToHalf();
const COPY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vPos;
out vec4 finalColor;
uniform sampler2D uSource;
void main() { finalColor = texelFetch(uSource, ivec2(vPos), 0); }
`;

function mat3(m: Affine): Float32Array {
  // Column-major mat3 for GLSL.
  return new Float32Array([m.a, m.b, 0, m.c, m.d, 0, m.tx, m.ty, 1]);
}

export class GpuCompositor {
  readonly renderer: WebGLRenderer;
  readonly gl: WebGL2RenderingContext;
  readonly maxTextureSize: number;
  readonly floatTargets: boolean;
  private readonly mesh: Mesh<MeshGeometry, Shader>;
  private chunkSize: number;
  private readonly passes = new Map<string, Pass>();
  private readonly slots = new Map<string, Slot>();
  private readonly pool: RenderTexture[] = [];
  private readonly inUse = new Set<RenderTexture>();
  private frame = 0;
  private readonly white: TextureSource;
  private lutSources = new Map<string, TextureSource>();
  private readonly proofSources = new Map<Uint8Array, TextureSource>();
  private readonly proofWarnings = new WeakMap<CmykLut, Uint8Array>();
  private brushState: BrushGpuState | null = null;
  private brushCompositeCache: BrushCompositeCache | null = null;
  private viewportCompositeCache: ViewportCompositeCache | null = null;
  private renderClip: Rect | null = null;
  private readonly brushTargetPool: BrushTargets[] = [];
  /** Sampled brush tip atlases (all mip levels in one R8 texture), most recent last. */
  private readonly tipSources = new Map<string, TextureSource>();
  /** The LUT samples last uploaded per layer, so an unchanged adjustment is not re-uploaded every frame. */
  private lutUploaded = new Map<string, Uint8Array | Float32Array>();
  private activeDocument: CanvasDocument | undefined;
  private readonly effectFilteredHooks = new EffectLiveFilterHookAdapter(DEFAULT_HOOKS);
  private readonly performanceCounterValue = {
    effectRegenerations: 0, textureUploads: 0, targetAllocations: 0, drawPasses: 0, drawnPixels: 0,
    compositeRequests: 0, fullComposites: 0, unchangedFrameHits: 0,
    viewFilterLayers: 0, viewFilterPasses: 0, cpuLiveFilterFallbacks: 0,
  };
  /** Set per composite: RGBA8 layers get half-float textures (see PRECISION_SENSITIVE_MODES). */
  private preciseTextures = false;
  private textureByteBudget = 384 * 1024 * 1024;
  private requestHydration: ((raster: Raster, rect: Rect) => void) | null = null;
  adjustmentPrograms: AdjustmentProgramProvider = adjustmentProgram;
  /** Adjustment layers drawn without a GPU implementation in the last composite. */
  skippedAdjustments = 0;

  private constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.gl = renderer.gl as WebGL2RenderingContext;
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    this.chunkSize = Math.max(TILE, Math.min(TARGET_CHUNK_SIZE,
      Math.floor((this.maxTextureSize - CHUNK_APRON * 2) / TILE) * TILE));
    // Pixi never sets this; 1-channel masks with odd widths need it.
    this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 1);
    this.gl.pixelStorei(this.gl.PACK_ALIGNMENT, 1);
    this.floatTargets = !!this.gl.getExtension('EXT_color_buffer_float');
    const geometry = new MeshGeometry({
      positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const state = State.for2d();
    state.blend = false;
    this.mesh = new Mesh({ geometry, shader: this.pass('present').shader as never }) as unknown as Mesh<MeshGeometry, Shader>;
    this.mesh.state = state;
    this.white = new TextureSource({ width: 1, height: 1, format: 'rgba8unorm' });
    this.uploadWhole(this.white, new Uint8Array([255, 255, 255, 255]), 1, 1, 4);
  }

  /** Creates a WebGL2 renderer on `canvas`. Throws when WebGL2 is unavailable. */
  static async create(canvas: HTMLCanvasElement | OffscreenCanvas, width = 1, height = 1): Promise<GpuCompositor> {
    const renderer = new WebGLRenderer();
    await renderer.init({
      canvas: canvas as HTMLCanvasElement, width, height, antialias: false, backgroundAlpha: 1, background: 0x1b1b1b,
      premultipliedAlpha: true, preserveDrawingBuffer: false, resolution: 1, autoDensity: false,
      preferWebGLVersion: 2, clearBeforeRender: false, hello: false,
    });
    if (renderer.context.webGLVersion !== 2) {
      renderer.destroy();
      throw new Error('WebGL 2 is required to render the canvas.');
    }
    const compositor = new GpuCompositor(renderer);
    await compositor.prepareBrushPipeline();
    compositor.prepareFilterPipeline();
    return compositor;
  }

  destroy(): void {
    for (const slot of this.slots.values()) for (const chunk of slot.chunks.values()) this.destroySource(chunk.source);
    this.slots.clear();
    this.destroyBrushCompositeCache();
    this.destroyViewportCompositeCache();
    for (const rt of this.pool) this.destroyTarget(rt);
    for (const rt of this.inUse) this.destroyTarget(rt);
    for (const lut of this.lutSources.values()) lut.destroy();
    for (const source of this.proofSources.values()) source.destroy();
    for (const tip of this.tipSources.values()) tip.destroy();
    this.tipSources.clear();
    this.destroyBrushState();
    for (const targets of this.brushTargetPool) for (const target of Object.values(targets)) target.destroy(true);
    this.brushTargetPool.length = 0;
    this.mesh.destroy();
    for (const pass of this.passes.values()) pass.shader.destroy();
    this.passes.clear();
    this.white.destroy();
    this.renderer.destroy();
  }

  /** Number of sparse raster/mask chunk textures currently resident. */
  get textureChunkCount(): number {
    let count = 0;
    for (const slot of this.slots.values()) count += slot.chunks.size;
    return count;
  }

  /** Interior side length selected for this device (aprons are additional). */
  get textureChunkSize(): number { return this.chunkSize; }

  /** Estimated bytes of all resident chunk mip levels (render targets and LUTs excluded). */
  get textureBytes(): number {
    let bytes = 0;
    for (const slot of this.slots.values()) for (const chunk of slot.chunks.values()) bytes += chunk.bytes;
    return bytes;
  }

  /** Cumulative diagnostics used by performance regression tests. */
  get performanceCounters(): GpuPerformanceCounters { return { ...this.performanceCounterValue }; }

  /** Tile RAM and GPU textures have independent caps; hosts may lower this for constrained devices. */
  configureResidency(options: { textureByteBudget?: number; textureChunkSize?: number;
    requestHydration?: (raster: Raster, rect: Rect) => void }): void {
    if (options.textureByteBudget !== undefined) {
      if (!Number.isSafeInteger(options.textureByteBudget) || options.textureByteBudget < 0) throw new RangeError('Invalid GPU texture budget');
      this.textureByteBudget = options.textureByteBudget;
    }
    if (options.textureChunkSize !== undefined) {
      const size = options.textureChunkSize;
      const maximum = Math.floor((this.maxTextureSize - CHUNK_APRON * 2) / TILE) * TILE;
      if (!Number.isSafeInteger(size) || size < TILE || size > maximum || size % TILE) {
        throw new RangeError('Invalid GPU texture chunk size');
      }
      if (size !== this.chunkSize) {
        for (const slot of this.slots.values()) for (const chunk of slot.chunks.values()) this.destroySource(chunk.source);
        this.slots.clear();
        this.chunkSize = size;
      }
    }
    this.requestHydration = options.requestHydration ?? null;
    this.collectTextures(true);
  }

  resize(width: number, height: number): void {
    if (this.renderer.width !== width || this.renderer.height !== height) this.renderer.resize(width, height);
  }

  // MARK: Passes

  private pass(name: string, fragment?: string, custom?: CustomPassSpec): Pass {
    const existing = this.passes.get(name);
    if (existing) return existing;
    const sources: Record<string, [string, Uniforms, string[]]> = {
      layer: [LAYER_FRAGMENT, {
        uTarget: { value: new Float32Array(2), type: 'vec2<f32>' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToLayer: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToWarp: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uHasWarp: { value: 0, type: 'i32' },
        uLayerSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uLayerEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uTextureSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uApron: { value: CHUNK_APRON, type: 'f32' },
        uSampling: { value: 1, type: 'i32' },
        uMipLevel: { value: 0, type: 'i32' },
        uRestrictChunk: { value: 1, type: 'i32' },
        uRestrictBounds: { value: 0, type: 'i32' },
        uDrawOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uDrawSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uHasCrop: { value: 0, type: 'i32' },
        uCropRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCropFeather: { value: 0, type: 'f32' },
        uOpacity: { value: 1, type: 'f32' },
        uFillOpacity: { value: 1, type: 'f32' },
        uMode: { value: 0, type: 'i32' },
        uDissolveSeed: { value: 0, type: 'i32' },
        uHasMask: { value: 0, type: 'i32' },
        uDocToMask: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uMaskSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskPlaced: { value: 0, type: 'i32' },
        uMaskBackground: { value: 1, type: 'f32' },
        uMaskSampling: { value: 1, type: 'i32' },
        uHasClip: { value: 0, type: 'i32' },
        uSnap: { value: 0, type: 'i32' },
        uReplace: { value: 0, type: 'i32' },
      }, ['uBackdrop', 'uLayer', 'uMask', 'uClip']],
      filteredLayer: [FILTERED_LAYER_FRAGMENT, {
        uFilterOffset: { value: new Float32Array(2), type: 'vec2<f32>' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToLayer: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToWarp: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uHasWarp: { value: 0, type: 'i32' }, uLayerSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uHasCrop: { value: 0, type: 'i32' }, uCropRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCropFeather: { value: 0, type: 'f32' }, uOpacity: { value: 1, type: 'f32' },
        uFillOpacity: { value: 1, type: 'f32' }, uMode: { value: 0, type: 'i32' },
        uDissolveSeed: { value: 0, type: 'i32' }, uHasMask: { value: 0, type: 'i32' },
        uHasClip: { value: 0, type: 'i32' }, uSnap: { value: 0, type: 'i32' },
      }, ['uBackdrop', 'uLayer', 'uMask', 'uClip']],
      warpMesh: [WARP_MESH_FRAGMENT, {
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uLayerSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uLayerEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uTextureSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uApron: { value: CHUNK_APRON, type: 'f32' },
        uSampling: { value: 1, type: 'i32' }, uMipLevel: { value: 0, type: 'i32' },
        uHasCrop: { value: 0, type: 'i32' }, uCropRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uCropFeather: { value: 0, type: 'f32' },
        uOpacity: { value: 1, type: 'f32' }, uFillOpacity: { value: 1, type: 'f32' },
        uMode: { value: 0, type: 'i32' }, uDissolveSeed: { value: 0, type: 'i32' },
        uHasMask: { value: 0, type: 'i32' }, uHasClip: { value: 0, type: 'i32' },
        uSnap: { value: 0, type: 'i32' }, uReplace: { value: 0, type: 'i32' },
      }, ['uBackdrop', 'uLayer', 'uMask', 'uClip']],
      mask: [MASK_FRAGMENT, {
        uHasPrevious: { value: 0, type: 'i32' },
        uDrawChunk: { value: 0, type: 'i32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToMask: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uMaskSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uTextureSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uApron: { value: CHUNK_APRON, type: 'f32' },
        uBackground: { value: 0, type: 'f32' },
        uSampling: { value: 1, type: 'i32' },
        uMipLevel: { value: 0, type: 'i32' },
        uSnap: { value: 0, type: 'i32' },
      }, ['uPrevious', 'uMask']],
      coverage: [COVERAGE_FRAGMENT, {
        uKind: { value: 0, type: 'i32' },
        uHasPrevious: { value: 0, type: 'i32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToMask: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uMaskSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSnap: { value: 0, type: 'i32' },
      }, ['uPrevious', 'uSource']],
      brushCoverage: [BRUSH_COVERAGE_FRAGMENT, {
        uPixelToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uGridOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uCanvas: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSegment: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPressure: { value: 1, type: 'f32' }, uRadius: { value: 1, type: 'f32' },
        uHardness: { value: 1, type: 'f32' }, uAntialias: { value: 1, type: 'f32' },
        uSpacing: { value: 1, type: 'f32' },
      }, []],
      brushPaint: [BRUSH_PAINT_FRAGMENT, {
        uGridOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uGridSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSourceRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uSourceSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uBaseOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uBaseTextureSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uBaseApron: { value: 0, type: 'f32' }, uHasBase: { value: 0, type: 'i32' },
        uMask: { value: 0, type: 'i32' }, uHard: { value: 0, type: 'i32' },
        uErase: { value: 0, type: 'i32' }, uBrushMode: { value: 0, type: 'i32' },
        uRange: { value: 1, type: 'i32' }, uExposure: { value: 0.5, type: 'f32' },
        uSpongeDirection: { value: 1, type: 'i32' }, uFlow: { value: 0.5, type: 'f32' }, uVibrance: { value: 0, type: 'i32' },
        uColor: { value: new Float32Array(3), type: 'vec3<f32>' }, uOpacity: { value: 1, type: 'f32' },
        uHasSelection: { value: 0, type: 'i32' },
      }, ['uBase', 'uPermanent', 'uTail', 'uSelection']],
      brushMax: [BRUSH_MAX_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uFirst', 'uSecond']],
      brushSelection: [BRUSH_SELECTION_FRAGMENT, {
        uGridToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uGridOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSelectionOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSelectionSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uApron: { value: CHUNK_APRON, type: 'f32' },
      }, ['uSelection']],
      brushDab: [BRUSH_DAB_FRAGMENT, {
        uPixelToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uGridOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uCanvas: { value: new Float32Array(2), type: 'vec2<f32>' },
        uDab: { value: new Float32Array(4), type: 'vec4<f32>' },
        uShape: { value: new Float32Array(3), type: 'vec3<f32>' },
        uHardness: { value: 1, type: 'f32' }, uAntialias: { value: 1, type: 'f32' },
        uSampled: { value: 0, type: 'i32' },
        uLevel: { value: new Float32Array(4), type: 'vec4<f32>' },
        uScale: { value: new Float32Array(2), type: 'vec2<f32>' },
      }, ['uTip']],
      brushMask: [BRUSH_MASK_FRAGMENT, {
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToMask: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uMaskSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uChunkSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uTextureSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uApron: { value: BRUSH_APRON, type: 'f32' }, uSampling: { value: 1, type: 'i32' },
        uMipLevel: { value: 0, type: 'i32' }, uSnap: { value: 0, type: 'i32' },
      }, ['uBackdrop', 'uPainted']],
      copy: [COPY_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uSource']],
      opaque: [OPAQUE_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uSource']],
      stack: [STACK_FRAGMENT, {
        uHasClip: { value: 0, type: 'i32' },
        uMode: { value: 0, type: 'i32' },
        uDissolveSeed: { value: 0, type: 'i32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
      }, ['uBackdrop', 'uSurface', 'uBase', 'uClip']],
      group: [GROUP_FRAGMENT, {
        uMode: { value: 0, type: 'i32' }, uDissolveSeed: { value: 0, type: 'i32' },
        uOpacity: { value: 1, type: 'f32' }, uFillOpacity: { value: 1, type: 'f32' },
        uKnockout: { value: 0, type: 'i32' }, uHasClip: { value: 0, type: 'i32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
      }, ['uBackdrop', 'uSurface', 'uKnockoutBase', 'uClip']],
      unpremultiply: [UNPREMULTIPLY_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uSource']],
      present: [PRESENT_FRAGMENT, {
        uCanvasRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 1, type: 'f32' },
        uGrid: { value: 0, type: 'i32' },
        uPixelSize: { value: 1, type: 'f32' },
        uHasComposite: { value: 0, type: 'i32' },
        uCompositeOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uCompositeSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uProof: { value: 0, type: 'i32' }, uGamutWarning: { value: 0, type: 'i32' }, uProofSize: { value: 2, type: 'i32' },
      }, ['uComposite', 'uProofLut']],
    };
    let spec = sources[name];
    if (!spec && fragment && custom) spec = [fragment, custom.uniforms, [...custom.textures]];
    if (!spec && fragment) {
      spec = [fragment, {
        uHasClip: { value: 0, type: 'i32' },
        uMode: { value: 0, type: 'i32' },
        uOpacity: { value: 1, type: 'f32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uParams: { value: new Float32Array(32), type: 'vec4<f32>', size: 8 },
      }, ['uBackdrop', 'uClip', 'uLut']];
    }
    if (!spec) throw new Error(`Unknown pass ${name}`);
    const [frag, uniforms, textures] = spec;
    const resources: Record<string, unknown> = { passUniforms: uniforms };
    for (const texture of textures) resources[texture] = Texture.WHITE.source;
    const shader = Shader.from({ gl: { vertex: VERTEX, fragment: frag, name: `compositor-${name}` }, resources });
    const pass: Pass = { shader, uniforms: shader.resources.passUniforms as Pass['uniforms'] };
    this.passes.set(name, pass);
    return pass;
  }

  private run(pass: Pass, target: RenderTexture | null, width: number, height: number, textures: Record<string, TextureSource>,
    uniforms: Record<string, unknown>, rect?: Rect): void {
    const drawRect = this.renderClip
      ? intersect(rect ?? { x: 0, y: 0, width, height }, this.renderClip)
      : rect;
    if (this.renderClip && !drawRect) return;
    for (const [key, value] of Object.entries(uniforms)) {
      const current = pass.uniforms.uniforms[key];
      if (current instanceof Float32Array && value instanceof Float32Array) current.set(value);
      else pass.uniforms.uniforms[key] = value;
    }
    pass.uniforms.update();
    for (const [key, source] of Object.entries(textures)) (pass.shader.resources as Record<string, unknown>)[key] = source;
    this.mesh.shader = pass.shader;
    this.mesh.position.set(drawRect?.x ?? 0, drawRect?.y ?? 0);
    this.mesh.scale.set(drawRect?.width ?? width, drawRect?.height ?? height);
    this.performanceCounterValue.drawPasses++;
    this.performanceCounterValue.drawnPixels += Math.ceil((drawRect?.width ?? width) * (drawRect?.height ?? height));
    this.renderer.render({ container: this.mesh, target: target ?? undefined, clear: false });
  }

  private meshGeometry(warp: Extract<NonNullable<Layer['warp']>, { kind: 'mesh' }>, view: ViewSpec): MeshGeometry {
    const data = tessellateMesh(warp);
    const documentToView = invert(view.viewToDoc), positions = data.positions.slice();
    for (let index = 0; index < positions.length; index += 2) {
      const x = positions[index]!, y = positions[index + 1]!;
      positions[index] = documentToView.a * x + documentToView.c * y + documentToView.tx;
      positions[index + 1] = documentToView.b * x + documentToView.d * y + documentToView.ty;
    }
    return new MeshGeometry({ positions, uvs: data.uvs, indices: data.indices });
  }

  private runWarpMesh(warp: Extract<NonNullable<Layer['warp']>, { kind: 'mesh' }>, view: ViewSpec,
    pass: Pass, target: RenderTexture, textures: Record<string, TextureSource>, uniforms: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(uniforms)) {
      const current = pass.uniforms.uniforms[key];
      if (current instanceof Float32Array && value instanceof Float32Array) current.set(value);
      else pass.uniforms.uniforms[key] = value;
    }
    pass.uniforms.update();
    for (const [key, source] of Object.entries(textures)) (pass.shader.resources as Record<string, unknown>)[key] = source;
    const geometry = this.meshGeometry(warp, view);
    const mesh = new Mesh({ geometry, shader: pass.shader as never, state: State.for2d() }) as unknown as Mesh<MeshGeometry, Shader>;
    mesh.state.blend = false;
    this.renderer.render({ container: mesh, target, clear: false });
    mesh.destroy({ children: false, texture: false, textureSource: false });
  }

  // MARK: Render targets

  private acquire(width: number, height: number, fullFloat = false): RenderTexture {
    const format = this.floatTargets ? fullFloat ? 'rgba32float' : 'rgba16float' : 'rgba8unorm';
    const index = this.pool.findIndex((rt) => rt.width === width && rt.height === height && rt.source.format === format);
    let rt: RenderTexture;
    if (index >= 0) rt = this.pool.splice(index, 1)[0]!;
    else {
      rt = RenderTexture.create({
        width, height, format, antialias: false, resolution: 1,
      });
      this.performanceCounterValue.targetAllocations++;
    }
    this.inUse.add(rt);
    return rt;
  }
  private release(rt: RenderTexture | null | undefined): void {
    if (!rt || !this.inUse.has(rt)) return;
    this.inUse.delete(rt);
    this.pool.push(rt);
    while (this.pool.length > 12) this.destroyTarget(this.pool.shift()!);
  }
  private destroyTarget(target: RenderTexture): void {
    this.detachSource(target.source);
    target.destroy(true);
  }
  private destroySource(source: TextureSource): void {
    this.detachSource(source);
    source.destroy();
  }
  private detachSource(source: TextureSource): void {
    for (const pass of this.passes.values()) {
      const resources = pass.shader.resources as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(resources)) {
        const resource = resources[key];
        if (resource === source) resources[key] = this.white;
      }
    }
  }
  private clear(rt: RenderTexture, opaqueWhite = false): void {
    this.renderer.renderTarget.bind({ target: rt, clear: true,
      clearColor: opaqueWhite ? [1, 1, 1, 1] : [0, 0, 0, 0] });
  }

  // MARK: Textures

  private uploadWhole(source: TextureSource, data: Uint8Array, width: number, height: number, channels: 1 | 4): void {
    const gl = this.gl;
    this.renderer.texture.bindSource(source, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, channels === 4);
    this.performanceCounterValue.textureUploads++;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, channels === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data);
    this.restoreUnpack();
  }

  private restoreUnpack(): void {
    const system = this.renderer.texture as unknown as { _premultiplyAlpha: boolean };
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, system._premultiplyAlpha);
  }

  private uploadRasterData(x: number, y: number, width: number, height: number, format: number,
    data: PixelArray, wide = false): void {
    const gl = this.gl;
    this.performanceCounterValue.textureUploads++;
    if (wide && data instanceof Uint8Array) {
      // RGBA8 into a half-float chunk: widen to 16 bit, then premultiply at that precision like a 16-bit raster.
      const wider = new Uint16Array(data.length);
      for (let i = 0; i < data.length; i++) wider[i] = data[i]! * 257;
      data = wider;
    }
    if (data instanceof Uint16Array) {
      // `data` is always a fresh region buffer. Reusing it for binary16 avoids a second, twice-as-large
      // float allocation for a 4096px texture chunk. WebGL only defines UNPACK_PREMULTIPLY_ALPHA for 8-bit
      // types (WebKit rejects HALF_FLOAT with it as an invalid format/type combination), so RGBA is
      // premultiplied here and the flag is off for this upload.
      const premultiply = format === gl.RGBA && gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) === true;
      if (premultiply) {
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]!;
          if (alpha !== 65535) {
            data[i] = Math.round(data[i]! * alpha / 65535); data[i + 1] = Math.round(data[i + 1]! * alpha / 65535);
            data[i + 2] = Math.round(data[i + 2]! * alpha / 65535);
          }
        }
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
      for (let i = 0; i < data.length; i++) data[i] = UNORM16_TO_HALF[data[i]!]!;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, gl.HALF_FLOAT, data);
      if (premultiply) gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, gl.UNSIGNED_BYTE, data);
  }

  /**
   * Sparse chunk textures for a raster, uploading only changed tiles and neighbouring aprons.
   * Mirrors TiledLayerRenderer.piece: disjoint interiors sample a surrounding margin so they meet.
   */
  private texture(slotKey: string, raster: Raster, visible?: Rect): Slot {
    const gl = this.gl;
    const existing = this.slots.get(slotKey);
    // Once widened a slot stays wide until it is recreated, so previewing modes does not re-upload back and forth.
    // Generated style passes benefit from premultiplication at half-float precision on Firefox/WebKit,
    // but widening the source layer itself when a style is added changes its translucent RGBA8 bytes.
    const effectPass = slotKey.includes(':effect:');
    const wantsWide = raster.format === 'rgba16'
      || (raster.channels === 4 && (this.preciseTextures || (this.floatTargets && effectPass)));
    const occupied = occupiedChunks(raster, this.chunkSize);
    const desired = new Set<string>();
    if (!visible) for (const key of occupied) desired.add(key);
    else {
      const left = Math.max(0, Math.floor(visible.x / this.chunkSize));
      const top = Math.max(0, Math.floor(visible.y / this.chunkSize));
      const right = Math.min(Math.ceil(raster.width / this.chunkSize) - 1,
        Math.floor((visible.x + visible.width - 1) / this.chunkSize));
      const bottom = Math.min(Math.ceil(raster.height / this.chunkSize) - 1,
        Math.floor((visible.y + visible.height - 1) / this.chunkSize));
      for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) {
        const key = chunkKey(col, row); if (occupied.has(key)) desired.add(key);
      }
    }
    if (existing && existing.raster === raster && (existing.wide || !wantsWide)
      && [...desired].every((key) => existing.chunks.has(key))) {
      for (const key of desired) existing.chunks.get(key)!.lastUsed = this.frame;
      existing.lastUsed = this.frame; return existing;
    }
    const compatible = existing && existing.raster.width === raster.width && existing.raster.height === raster.height
      && existing.raster.channels === raster.channels && existing.raster.format === raster.format && (existing.wide || !wantsWide);
    let slot: Slot;
    if (compatible) {
      slot = existing!;
    } else {
      if (existing) for (const chunk of existing.chunks.values()) this.destroySource(chunk.source);
      slot = { raster, chunks: new Map(), lastUsed: this.frame, wide: wantsWide };
      this.slots.set(slotKey, slot);
    }
    const wide = slot.wide;
    const previous = compatible ? existing!.raster : null;
    for (const [key, chunk] of slot.chunks) {
      if (!occupied.has(key)) { this.destroySource(chunk.source); slot.chunks.delete(key); }
    }

    const changed: number[] = [];
    for (let index = 0; index < raster.tiles.length; index++) {
      if (!previous || previous.tiles[index] !== raster.tiles[index]) changed.push(index);
    }
    const created = new Set<string>();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, raster.channels === 4);
    for (const key of desired) {
      if (slot.chunks.has(key)) continue;
      const [col, row] = parseChunkKey(key);
      const x = col * this.chunkSize, y = row * this.chunkSize;
      const width = Math.min(this.chunkSize, raster.width - x), height = Math.min(this.chunkSize, raster.height - y);
      const textureWidth = width + CHUNK_APRON * 2, textureHeight = height + CHUNK_APRON * 2;
      const mips = Math.floor(Math.log2(Math.max(textureWidth, textureHeight))) + 1;
      const source = new TextureSource({
        width: textureWidth, height: textureHeight,
        format: wide ? 'rgba16float' : raster.channels === 4 ? 'rgba8unorm' : 'r8unorm', mipLevelCount: mips,
        autoGenerateMipmaps: false, scaleMode: 'linear', mipmapFilter: 'linear', addressMode: 'clamp-to-edge', maxAnisotropy: 1,
      });
      const chunk: TextureChunk = { col, row, x, y, width, height, source,
        bytes: mipBytes(textureWidth, textureHeight, raster.channels, wide ? 2 : 1), lastUsed: this.frame };
      slot.chunks.set(key, chunk);
      this.renderer.texture.bindSource(source, 0);
      this.uploadRasterData(0, 0, textureWidth, textureHeight, raster.channels === 4 ? gl.RGBA : gl.RED,
        readClamped(raster, x - CHUNK_APRON, y - CHUNK_APRON, textureWidth, textureHeight), wide);
      gl.generateMipmap(gl.TEXTURE_2D);
      created.add(key);
    }
    for (const key of desired) slot.chunks.get(key)!.lastUsed = this.frame;

    const affected = new Set<string>();
    for (const index of changed) {
      const tileCol = index % raster.cols, tileRow = Math.floor(index / raster.cols);
      const x = tileCol * TILE, y = tileRow * TILE;
      const right = x + raster.tileWidth(tileCol), bottom = y + raster.tileHeight(tileRow);
      const c0 = Math.max(0, Math.floor((x - CHUNK_APRON) / this.chunkSize));
      const r0 = Math.max(0, Math.floor((y - CHUNK_APRON) / this.chunkSize));
      const c1 = Math.floor((right + CHUNK_APRON - 1) / this.chunkSize);
      const r1 = Math.floor((bottom + CHUNK_APRON - 1) / this.chunkSize);
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
        const key = chunkKey(col, row);
        if (slot.chunks.has(key) && !created.has(key)) affected.add(key);
      }
    }
    const format = raster.channels === 4 ? gl.RGBA : gl.RED;
    const bulk = changed.length > Math.max(32, affected.size * 12);
    for (const key of affected) {
      const chunk = slot.chunks.get(key)!;
      this.renderer.texture.bindSource(chunk.source, 0);
      if (bulk) {
        const tw = chunk.width + CHUNK_APRON * 2, th = chunk.height + CHUNK_APRON * 2;
        this.uploadRasterData(0, 0, tw, th, format,
          readClamped(raster, chunk.x - CHUNK_APRON, chunk.y - CHUNK_APRON, tw, th), wide);
      } else {
        for (const index of changed) {
          const tileCol = index % raster.cols, tileRow = Math.floor(index / raster.cols);
          const tx = tileCol * TILE, ty = tileRow * TILE;
          const x0 = Math.max(tx, chunk.x), y0 = Math.max(ty, chunk.y);
          const x1 = Math.min(tx + raster.tileWidth(tileCol), chunk.x + chunk.width);
          const y1 = Math.min(ty + raster.tileHeight(tileRow), chunk.y + chunk.height);
          if (x1 <= x0 || y1 <= y0) continue;
          this.uploadRasterData(x0 - chunk.x + CHUNK_APRON, y0 - chunk.y + CHUNK_APRON, x1 - x0, y1 - y0,
            format, raster.readRegionNative(x0, y0, x1 - x0, y1 - y0), wide);
        }
        this.uploadAprons(chunk, raster, format, wide);
      }
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.restoreUnpack();
    slot.raster = raster;
    slot.lastUsed = this.frame;
    return slot;
  }

  private uploadAprons(chunk: TextureChunk, raster: Raster, format: number, wide: boolean): void {
    const gl = this.gl, tw = chunk.width + CHUNK_APRON * 2, th = chunk.height + CHUNK_APRON * 2;
    this.uploadRasterData(0, 0, tw, CHUNK_APRON, format,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y - CHUNK_APRON, tw, CHUNK_APRON), wide);
    this.uploadRasterData(0, th - CHUNK_APRON, tw, CHUNK_APRON, format,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y + chunk.height, tw, CHUNK_APRON), wide);
    this.uploadRasterData(0, CHUNK_APRON, CHUNK_APRON, chunk.height, format,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y, CHUNK_APRON, chunk.height), wide);
    this.uploadRasterData(tw - CHUNK_APRON, CHUNK_APRON, CHUNK_APRON, chunk.height, format,
      readClamped(raster, chunk.x + chunk.width, chunk.y, CHUNK_APRON, chunk.height), wide);
  }

  /** Drops textures of layers not drawn for a while. */
  private collectTextures(enforceBudget = false): void {
    for (const [key, slot] of this.slots) {
      if (this.frame - slot.lastUsed > 120) {
        for (const chunk of slot.chunks.values()) this.destroySource(chunk.source);
        this.slots.delete(key);
      }
    }
    if (!enforceBudget && this.textureBytes <= this.textureByteBudget) return;
    // The active frame is the minimum viable working set. Evicting one of its slots here only
    // guarantees that the next unchanged frame uploads it again (a9fe5e2 regression).
    const cold = [...this.slots.entries()].flatMap(([key, slot]) => [...slot.chunks.entries()]
      .filter(([, chunk]) => chunk.lastUsed < this.frame)
      .map(([chunkKeyValue, chunk]) => ({ key, slot, chunkKeyValue, chunk })))
      .sort((a, b) => a.chunk.lastUsed - b.chunk.lastUsed);
    for (const { key, slot, chunkKeyValue, chunk } of cold) {
      if (this.textureBytes <= this.textureByteBudget) break;
      this.destroySource(chunk.source);
      slot.chunks.delete(chunkKeyValue);
      if (!slot.chunks.size) this.slots.delete(key);
    }
  }

  // MARK: Active brush coverage

  /** Compile/link at compositor startup and retain one cleared native-grid tile for the first sample. */
  private async prepareBrushPipeline(): Promise<void> {
    const programs = ['brushCoverage', 'brushPaint', 'brushMax', 'brushMask', 'brushDab', 'brushSelection'].map((name) =>
      this.renderer.shader._getProgramData(this.pass(name).shader.glProgram).program);
    const parallel = this.gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    if (parallel) {
      while (programs.some((program) => !this.gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    const targets = this.createBrushTargets(BRUSH_CHUNK_SIZE + BRUSH_APRON * 2,
      BRUSH_CHUNK_SIZE + BRUSH_APRON * 2);
    for (const target of Object.values(targets)) this.clear(target);
    this.brushTargetPool.push(targets);
  }

  /** Link and execute every filter variant before a user's first slider movement. */
  private prepareFilterPipeline(): void {
    const first = RenderTexture.create({ width: 1, height: 1, format: this.floatTargets ? 'rgba32float' : 'rgba8unorm',
      antialias: false, resolution: 1 });
    const second = RenderTexture.create({ width: 1, height: 1, format: this.floatTargets ? 'rgba32float' : 'rgba8unorm',
      antialias: false, resolution: 1 });
    this.clear(first); this.clear(second);
    let source = first, target = second;
    const counters = { drawPasses: this.performanceCounterValue.drawPasses,
      drawnPixels: this.performanceCounterValue.drawnPixels, viewFilterPasses: this.performanceCounterValue.viewFilterPasses };
    const run = (pass: Pass, textures: Record<string, TextureSource> = {}, uniforms: Record<string, unknown> = {}) => {
      this.runFilter(pass, target, source, textures, uniforms);
      [source, target] = [target, source];
    };
    for (const support of [4, 8, 16, 32, 64, 96] as const) {
      const weights = new Float32Array(support * 2 + 1); weights[support] = 1;
      const extra = { uWeights: { value: new Float32Array(support * 2 + 1), type: 'f32' as const,
        size: support * 2 + 1 } };
      run(this.filterPass(`filter:gaussian:${support}`, gaussianFragment(support), ['uSource'], extra), {}, { uWeights: weights });
      run(this.filterPass(`filter:motion:${support}`, gaussianFragment(support), ['uSource'], extra), {}, { uWeights: weights });
    }
    run(this.filterPass('filter:noise', NOISE_FRAGMENT, ['uSource']));
    run(this.filterPass('filter:lens', LENS_FRAGMENT, ['uSource']));
    run(this.filterPass('filter:denoise', DENOISE_FRAGMENT, ['uSource']));
    run(this.filterPass('filter:combine', COMBINE_FRAGMENT, ['uSource', 'uSecond']), { uSecond: source.source });
    run(this.filterPass('filter:quantize', QUANTIZE_FRAGMENT, ['uSource']), {},
      { uParams: new Float32Array([255, 0, 0, 0]) });
    run(this.filterPass('filter:selection', SELECTION_MIX_FRAGMENT, ['uSource', 'uSecond', 'uSelection']),
      { uSecond: source.source, uSelection: source.source });
    this.gl.finish();
    this.performanceCounterValue.drawPasses = counters.drawPasses;
    this.performanceCounterValue.drawnPixels = counters.drawnPixels;
    this.performanceCounterValue.viewFilterPasses = counters.viewFilterPasses;
    this.destroyTarget(first); this.destroyTarget(second);
  }

  private createBrushTargets(width: number, height: number): BrushTargets {
    const format = this.floatTargets ? 'rgba16float' : 'rgba8unorm';
    const coverage = () => RenderTexture.create({ width, height, format, antialias: false, resolution: 1 });
    return {
      permanent: coverage(), alternate: coverage(), scratch: coverage(), tail: coverage(),
      painted: RenderTexture.create({ width, height, format,
        mipLevelCount: Math.floor(Math.log2(Math.max(width, height))) + 1,
        autoGenerateMipmaps: false, antialias: false, resolution: 1 }),
    };
  }

  private destroyBrushState(): void {
    if (!this.brushState) return;
    const sources = new Set<TextureSource>();
    for (const chunk of this.brushState.chunks.values()) {
      for (const target of [chunk.permanent, chunk.alternate, chunk.scratch, chunk.tail, chunk.painted, chunk.selection]) {
        if (!target) continue;
        sources.add(target.source);
      }
    }
    for (const pass of this.passes.values()) {
      const resources = pass.shader.resources as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(resources)) {
        if (sources.has(resources[key] as TextureSource)) resources[key] = this.white;
      }
    }
    for (const chunk of this.brushState.chunks.values()) {
      const targets = { permanent: chunk.permanent, alternate: chunk.alternate, scratch: chunk.scratch,
        tail: chunk.tail, painted: chunk.painted };
      chunk.selection?.destroy(true);
      if (this.brushTargetPool.length < 2 && chunk.permanent.width === BRUSH_CHUNK_SIZE + BRUSH_APRON * 2
        && chunk.permanent.height === BRUSH_CHUNK_SIZE + BRUSH_APRON * 2) this.brushTargetPool.push(targets);
      else for (const target of Object.values(targets)) target.destroy(true);
    }
    this.brushState = null;
  }

  private destroyBrushCompositeCache(): void {
    const cache = this.brushCompositeCache;
    if (!cache) return;
    for (const pass of this.passes.values()) {
      const resources = pass.shader.resources as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(resources)) {
        const resource = resources[key];
        if (resource === cache.target.source) resources[key] = this.white;
      }
    }
    this.brushCompositeCache = null;
    this.release(cache.target);
  }

  private destroyViewportCompositeCache(): void {
    const cache = this.viewportCompositeCache;
    if (!cache) return;
    this.viewportCompositeCache = null;
    this.release(cache.target);
  }

  private brushChunk(state: BrushGpuState, key: string): BrushChunk {
    const existing = state.chunks.get(key);
    if (existing) return existing;
    const [col, row] = parseChunkKey(key);
    const x = col * BRUSH_CHUNK_SIZE, y = row * BRUSH_CHUNK_SIZE;
    const width = Math.min(BRUSH_CHUNK_SIZE, state.preview.width - x);
    const height = Math.min(BRUSH_CHUNK_SIZE, state.preview.height - y);
    const textureWidth = width + BRUSH_APRON * 2, textureHeight = height + BRUSH_APRON * 2;
    const pooled = textureWidth === BRUSH_CHUNK_SIZE + BRUSH_APRON * 2
      && textureHeight === BRUSH_CHUNK_SIZE + BRUSH_APRON * 2 ? this.brushTargetPool.pop() : undefined;
    const { permanent, alternate, scratch, tail, painted } = pooled ?? this.createBrushTargets(textureWidth, textureHeight);
    const chunk: BrushChunk = { col, row, x, y, width, height, permanent, alternate, scratch, tail, painted,
      selection: null, bounds: null };
    state.chunks.set(key, chunk);
    this.clear(permanent); this.clear(alternate); this.clear(scratch); this.clear(tail); this.clear(painted);
    if (state.preview.selection) chunk.selection = this.brushSelectionMask(state.preview, chunk);
    return chunk;
  }

  /** Builds selection coverage once per touched brush chunk, not once per pointer sample/dab. */
  private brushSelectionMask(preview: GpuBrushPreview, chunk: BrushChunk): RenderTexture {
    const selection = preview.selection!;
    const target = RenderTexture.create({ width: chunk.painted.width, height: chunk.painted.height,
      format: 'r8unorm', antialias: false, resolution: 1 });
    this.clear(target);
    const slot = this.texture(`selection:${selection.mask.id}`, selection.mask);
    for (const source of slot.chunks.values()) {
      this.run(this.pass('brushSelection'), target, target.width, target.height, { uSelection: source.source }, {
        uGridToDoc: mat3(preview.mapping),
        uGridOrigin: new Float32Array([chunk.x - BRUSH_APRON, chunk.y - BRUSH_APRON]),
        uSelectionOrigin: new Float32Array([selection.x, selection.y]),
        uSelectionSize: new Float32Array([selection.mask.width, selection.mask.height]),
        uChunkOrigin: new Float32Array([source.x, source.y]),
        uChunkSize: new Float32Array([source.width, source.height]), uApron: CHUNK_APRON,
      });
    }
    return target;
  }

  private brushKeys(preview: GpuBrushPreview, segment: BrushSegment): string[] {
    const reach = preview.settings.diameter / 2 + 2;
    const doc = {
      x: Math.min(segment.x0, segment.x1) - reach, y: Math.min(segment.y0, segment.y1) - reach,
      width: Math.abs(segment.x1 - segment.x0) + reach * 2,
      height: Math.abs(segment.y1 - segment.y0) + reach * 2,
    };
    const pixels = affineBounds(invert(preview.mapping), doc);
    const left = Math.max(0, Math.floor(pixels.x)), top = Math.max(0, Math.floor(pixels.y));
    const right = Math.min(preview.width, Math.ceil(pixels.x + pixels.width));
    const bottom = Math.min(preview.height, Math.ceil(pixels.y + pixels.height));
    if (right <= left || bottom <= top) return [];
    const result: string[] = [];
    for (let row = Math.floor(top / BRUSH_CHUNK_SIZE); row <= Math.floor((bottom - 1) / BRUSH_CHUNK_SIZE); row++) {
      for (let col = Math.floor(left / BRUSH_CHUNK_SIZE); col <= Math.floor((right - 1) / BRUSH_CHUNK_SIZE); col++) {
        result.push(chunkKey(col, row));
      }
    }
    return result;
  }

  private brushSegmentRect(preview: GpuBrushPreview, chunk: BrushChunk, segment: BrushSegment): Rect | null {
    const reach = preview.settings.diameter / 2 + 2;
    const pixels = affineBounds(invert(preview.mapping), {
      x: Math.min(segment.x0, segment.x1) - reach, y: Math.min(segment.y0, segment.y1) - reach,
      width: Math.abs(segment.x1 - segment.x0) + reach * 2,
      height: Math.abs(segment.y1 - segment.y0) + reach * 2,
    });
    const originX = chunk.x - BRUSH_APRON, originY = chunk.y - BRUSH_APRON;
    const x = Math.max(0, Math.floor(pixels.x - originX));
    const y = Math.max(0, Math.floor(pixels.y - originY));
    const right = Math.min(chunk.permanent.width, Math.ceil(pixels.x + pixels.width - originX));
    const bottom = Math.min(chunk.permanent.height, Math.ceil(pixels.y + pixels.height - originY));
    return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
  }

  private renderBrushSegment(target: RenderTexture, preview: GpuBrushPreview, chunk: BrushChunk,
    segment: BrushSegment, accumulate = true): void {
    const rect = this.brushSegmentRect(preview, chunk, segment);
    if (!rect || segment.pressure <= 0) return;
    const interior = intersect({ x: rect.x - BRUSH_APRON + chunk.x, y: rect.y - BRUSH_APRON + chunk.y,
      width: rect.width, height: rect.height }, { x: chunk.x, y: chunk.y, width: chunk.width, height: chunk.height });
    if (interior) chunk.bounds = unionRect(chunk.bounds, interior);
    const m = preview.mapping;
    this.mesh.state.blendMode = accumulate ? 'normal' : 'none';
    this.run(this.pass('brushCoverage'), target, target.width, target.height, {}, {
      uPixelToDoc: mat3(m), uGridOrigin: new Float32Array([chunk.x - BRUSH_APRON, chunk.y - BRUSH_APRON]),
      uCanvas: new Float32Array([preview.canvas.width, preview.canvas.height]),
      uSegment: new Float32Array([segment.x0, segment.y0, segment.x1, segment.y1]),
      uPressure: segment.pressure, uRadius: preview.settings.diameter / 2, uHardness: preview.settings.hardness,
      uAntialias: Math.max(0.001, Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d))),
      uSpacing: Math.max(0.25, preview.settings.diameter * 0.025),
    }, rect);
    this.mesh.state.blendMode = 'normal';
    this.mesh.state.blend = false;
  }

  private accumulateHardSegment(preview: GpuBrushPreview, chunk: BrushChunk, segment: BrushSegment): void {
    this.clear(chunk.scratch);
    this.renderBrushSegment(chunk.scratch, preview, chunk, segment, false);
    this.mesh.state.blend = false;
    this.run(this.pass('brushMax'), chunk.alternate, chunk.alternate.width, chunk.alternate.height, {
      uFirst: chunk.permanent.source, uSecond: chunk.scratch.source,
    }, {});
    [chunk.permanent, chunk.alternate] = [chunk.alternate, chunk.permanent];
  }

  private prepareBrush(preview: GpuBrushPreview): BrushGpuState {
    if (this.brushState?.preview !== preview) {
      this.destroyBrushState();
      this.brushState = { preview, chunks: new Map(), applied: 0, revision: -1, tailKeys: new Set(), tail: [], dirty: null };
    }
    const state = this.brushState;
    if (state.revision === preview.revision) return state;
    if (preview.dabs) return this.prepareDabBrush(preview, state);
    const changed = new Set<string>();
    let dirty: Rect | null = null;
    while (state.applied < preview.settled.length) {
      const segment = preview.settled[state.applied++]!;
      dirty = unionMaybe(dirty, this.brushSegmentPixelRect(preview, segment));
      for (const key of this.brushKeys(preview, segment)) {
        const chunk = this.brushChunk(state, key);
        if (preview.settings.hardness >= 1) this.accumulateHardSegment(preview, chunk, segment);
        else this.renderBrushSegment(chunk.permanent, preview, chunk, segment);
        changed.add(key);
      }
    }
    const nextTail = new Set<string>();
    for (const segment of state.tail) dirty = unionMaybe(dirty, this.brushSegmentPixelRect(preview, segment));
    for (const segment of preview.tail) dirty = unionMaybe(dirty, this.brushSegmentPixelRect(preview, segment));
    for (const segment of preview.tail) for (const key of this.brushKeys(preview, segment)) nextTail.add(key);
    for (const key of new Set([...state.tailKeys, ...nextTail])) {
      const chunk = this.brushChunk(state, key);
      this.clear(chunk.tail);
      changed.add(key);
    }
    for (const segment of preview.tail) for (const key of this.brushKeys(preview, segment)) {
      this.renderBrushSegment(this.brushChunk(state, key).tail, preview, this.brushChunk(state, key), segment,
        preview.settings.hardness < 1);
    }
    state.tailKeys = nextTail;
    state.tail = [...preview.tail];
    for (const key of changed) this.paintBrushChunk(preview, this.brushChunk(state, key));
    state.revision = preview.revision;
    state.dirty = dirty;
    return state;
  }

  // MARK: Dab brushes (core/brush/tip.ts)

  /** Draws new settled dabs into the permanent targets and replaces the tail targets' dabs; same dabs as the CPU. */
  private prepareDabBrush(preview: GpuBrushPreview, state: BrushGpuState): BrushGpuState {
    const dabs = preview.dabs!, m = preview.mapping;
    const antialias = Math.max(0.001, Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)));
    const tip = preview.settings.tip;
    const tipSource = tip?.kind === 'sampled' ? this.tipSource(tip.image) : this.white;
    const changed = new Set<string>();
    let dirty: Rect | null = null;
    const draw = (target: 'permanent' | 'tail', dab: PreparedDab) => {
      dirty = unionMaybe(dirty, this.dabPixelRect(preview, dab));
      for (const key of this.dabKeys(preview, dab)) {
        const chunk = this.brushChunk(state, key);
        this.renderDab(chunk[target], preview, chunk, dab, tipSource, antialias);
        changed.add(key);
      }
    };
    let applied = state.appliedDabs ?? 0;
    while (applied < dabs.length) draw('permanent', prepareDab(dabs[applied++]!, tip, antialias));
    state.appliedDabs = applied;
    const tailKeys = new Set<string>();
    for (const dab of state.tailDabs ?? []) {
      dirty = unionMaybe(dirty, this.dabPixelRect(preview, dab));
      for (const key of this.dabKeys(preview, dab)) tailKeys.add(key);
    }
    const nextTail = (preview.tailDabs ?? []).map((dab: BrushDab) => prepareDab(dab, tip, antialias));
    for (const dab of nextTail) for (const key of this.dabKeys(preview, dab)) tailKeys.add(key);
    for (const key of tailKeys) { this.clear(this.brushChunk(state, key).tail); changed.add(key); }
    for (const dab of nextTail) draw('tail', dab);
    state.tailDabs = nextTail;
    state.tailKeys = tailKeys;
    for (const key of changed) this.paintBrushChunk(preview, this.brushChunk(state, key));
    state.revision = preview.revision;
    state.dirty = dirty;
    return state;
  }

  private dabPixelRect(preview: GpuBrushPreview, dab: PreparedDab): Rect | null {
    const pixels = affineBounds(invert(preview.mapping), { x: dab.x - dab.reach, y: dab.y - dab.reach, width: dab.reach * 2, height: dab.reach * 2 });
    return intersect({ x: Math.floor(pixels.x), y: Math.floor(pixels.y),
      width: Math.ceil(pixels.x + pixels.width) - Math.floor(pixels.x), height: Math.ceil(pixels.y + pixels.height) - Math.floor(pixels.y) },
    { x: 0, y: 0, width: preview.width, height: preview.height });
  }

  private dabKeys(preview: GpuBrushPreview, dab: PreparedDab): string[] {
    const rect = this.dabPixelRect(preview, dab);
    if (!rect) return [];
    const result: string[] = [];
    for (let row = Math.floor(rect.y / BRUSH_CHUNK_SIZE); row <= Math.floor((rect.y + rect.height - 1) / BRUSH_CHUNK_SIZE); row++) {
      for (let col = Math.floor(rect.x / BRUSH_CHUNK_SIZE); col <= Math.floor((rect.x + rect.width - 1) / BRUSH_CHUNK_SIZE); col++) result.push(chunkKey(col, row));
    }
    return result;
  }

  private renderDab(target: RenderTexture, preview: GpuBrushPreview, chunk: BrushChunk, dab: PreparedDab, tip: TextureSource, antialias: number): void {
    const pixels = this.dabPixelRect(preview, dab);
    if (!pixels) return;
    const originX = chunk.x - BRUSH_APRON, originY = chunk.y - BRUSH_APRON;
    const x = Math.max(0, pixels.x - originX), y = Math.max(0, pixels.y - originY);
    const right = Math.min(target.width, pixels.x + pixels.width - originX), bottom = Math.min(target.height, pixels.y + pixels.height - originY);
    if (right <= x || bottom <= y) return;
    const interior = intersect({ x: x + originX, y: y + originY, width: right - x, height: bottom - y },
      { x: chunk.x, y: chunk.y, width: chunk.width, height: chunk.height });
    if (interior) chunk.bounds = unionRect(chunk.bounds, interior);
    const level = dab.level;
    this.mesh.state.blendMode = 'normal';
    this.run(this.pass('brushDab'), target, target.width, target.height, { uTip: tip }, {
      uPixelToDoc: mat3(preview.mapping), uGridOrigin: new Float32Array([originX, originY]),
      uCanvas: new Float32Array([preview.canvas.width, preview.canvas.height]),
      uDab: new Float32Array([dab.x, dab.y, dab.cos, dab.sin]), uShape: new Float32Array([dab.radius, dab.minor, dab.alpha]),
      uHardness: preview.settings.hardness, uAntialias: antialias, uSampled: level ? 1 : 0,
      uLevel: new Float32Array(level ? [level.atlasX, level.atlasY, level.width, level.height] : [0, 0, 1, 1]),
      uScale: new Float32Array([dab.scaleX, dab.scaleY]),
    }, { x, y, width: right - x, height: bottom - y });
    this.mesh.state.blend = false;
  }

  /** The tip's R8 atlas; the most recent four tips stay resident. */
  private tipSource(image: BrushTipImage): TextureSource {
    const existing = this.tipSources.get(image.id);
    if (existing) { this.tipSources.delete(image.id); this.tipSources.set(image.id, existing); return existing; }
    const atlas = tipAtlas(image);
    const source = new TextureSource({ width: atlas.width, height: atlas.height, format: 'r8unorm', scaleMode: 'nearest', addressMode: 'clamp-to-edge' });
    this.uploadWhole(source, atlas.data, atlas.width, atlas.height, 1);
    this.tipSources.set(image.id, source);
    if (this.tipSources.size > 4) {
      const [oldest, old] = this.tipSources.entries().next().value!;
      this.tipSources.delete(oldest);
      for (const pass of this.passes.values()) {
        const resources = pass.shader.resources as Record<string, unknown>;
        for (const key of Object.getOwnPropertyNames(resources)) {
          if (resources[key] === old) resources[key] = this.white;
        }
      }
      old.destroy();
    }
    return source;
  }

  private brushSegmentPixelRect(preview: GpuBrushPreview, segment: BrushSegment): Rect | null {
    const reach = preview.settings.diameter / 2 + 2;
    const pixels = affineBounds(invert(preview.mapping), {
      x: Math.min(segment.x0, segment.x1) - reach, y: Math.min(segment.y0, segment.y1) - reach,
      width: Math.abs(segment.x1 - segment.x0) + reach * 2,
      height: Math.abs(segment.y1 - segment.y0) + reach * 2,
    });
    return intersect({ x: Math.floor(pixels.x), y: Math.floor(pixels.y),
      width: Math.ceil(pixels.x + pixels.width) - Math.floor(pixels.x),
      height: Math.ceil(pixels.y + pixels.height) - Math.floor(pixels.y) },
    { x: 0, y: 0, width: preview.width, height: preview.height });
  }

  private paintBrushChunk(preview: GpuBrushPreview, chunk: BrushChunk): void {
    const source = preview.source;
    let baseSource = this.transparentSource();
    let baseOriginX = 0, baseOriginY = 0, baseApron = 0, baseWidth = 1, baseHeight = 1, hasBase = 0;
    if (source) {
      const prefix = preview.target === 'mask' ? 'mask' : 'px';
      const slot = this.texture(`${prefix}:${preview.layerId}${source.hasSwappedTiles ? ':brush-resident' : ''}`,
        source.hasSwappedTiles ? residentView(source) : source);
      const centerX = chunk.x + chunk.width / 2, centerY = chunk.y + chunk.height / 2;
      const sx = Math.min(source.width - 1, Math.max(0,
        Math.floor((centerX - preview.sourceRect.x) * source.width / preview.sourceRect.width)));
      const sy = Math.min(source.height - 1, Math.max(0,
        Math.floor((centerY - preview.sourceRect.y) * source.height / preview.sourceRect.height)));
      const base = slot.chunks.get(chunkKey(Math.floor(sx / this.chunkSize), Math.floor(sy / this.chunkSize)));
      if (base) {
        baseSource = base.source; baseOriginX = base.x; baseOriginY = base.y; baseApron = CHUNK_APRON;
        baseWidth = base.width + CHUNK_APRON * 2; baseHeight = base.height + CHUNK_APRON * 2; hasBase = 1;
      }
    }
    this.mesh.state.blend = false;
    this.run(this.pass('brushPaint'), chunk.painted, chunk.painted.width, chunk.painted.height, {
      uBase: baseSource, uPermanent: chunk.permanent.source, uTail: chunk.tail.source,
      uSelection: chunk.selection?.source ?? this.white,
    }, {
      uGridOrigin: new Float32Array([chunk.x - BRUSH_APRON, chunk.y - BRUSH_APRON]),
      uGridSize: new Float32Array([preview.width, preview.height]),
      uSourceRect: new Float32Array([preview.sourceRect.x, preview.sourceRect.y,
        preview.sourceRect.width, preview.sourceRect.height]),
      uSourceSize: new Float32Array([source?.width ?? 1, source?.height ?? 1]),
      uBaseOrigin: new Float32Array([baseOriginX, baseOriginY]),
      uBaseTextureSize: new Float32Array([baseWidth, baseHeight]), uBaseApron: baseApron, uHasBase: hasBase,
      uMask: preview.target === 'mask' ? 1 : 0, uHard: preview.settings.hardness >= 1 && !preview.dabs ? 1 : 0,
      uErase: preview.settings.mode === 'erase' ? 1 : 0,
      uBrushMode: preview.settings.mode === 'dodge' ? 1 : preview.settings.mode === 'burn' ? 2 : preview.settings.mode === 'sponge' ? 3 : 0,
      uRange: preview.settings.range === 'shadows' ? 0 : preview.settings.range === 'highlights' ? 2 : 1,
      uExposure: preview.settings.exposure ?? 0.5, uSpongeDirection: preview.settings.spongeMode === 'desaturate' ? -1 : 1,
      uFlow: preview.settings.flow ?? 0.5, uVibrance: preview.settings.vibrance ? 1 : 0,
      uColor: new Float32Array([preview.settings.red, preview.settings.green, preview.settings.blue]),
      uOpacity: preview.settings.opacity, uHasSelection: chunk.selection ? 1 : 0,
    });
    this.renderer.texture.bindSource(chunk.painted.source, 0);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
  }

  // MARK: Compositing

  private compositeVisualState(document: CanvasDocument, hooks: CompositeHooks): CompositeVisualState {
    const documentValues: unknown[] = [document.width, document.height, document.layers, document.resources,
      document.globalLightAngle, (document as CanvasDocument & { readonly psdOpaqueCanvas?: boolean }).psdOpaqueCanvas];
    const layerValues: unknown[] = [];
    const addTransform = (transform: LayerTransform | null) => {
      if (!transform) { layerValues.push(null); return; }
      layerValues.push(transform.origin.x, transform.origin.y, transform.size.width, transform.size.height,
        transform.rotation, transform.flipX, transform.flipY, transform.sampling);
    };
    for (const layer of document.layers) {
      const raster = hooks.raster(layer), mask = hooks.maskRaster(layer);
      // A4 residency changes storage in place. Include its resolved resident view so hydration can
      // replace navigation LOD pixels even though the immutable Raster identity did not change.
      layerValues.push(raster, raster?.reducedCopy, raster?.hasSwappedTiles ? residentView(raster) : raster,
        mask, mask?.reducedCopy, mask?.hasSwappedTiles ? residentView(mask) : mask, hooks.blendMode(layer));
      addTransform(hooks.transform(layer));
      addTransform(hooks.maskPlacement(layer));
    }
    const brush = hooks.brush ?? null;
    layerValues.push(brush, brush?.revision ?? -1);
    return { documentValues, layerValues };
  }

  /**
   * Composites `document` into a new render texture of the view's size. The caller releases it
   * with `releaseTarget`.
   */
  composite(document: CanvasDocument, view: ViewSpec, hooks: CompositeHooks = DEFAULT_HOOKS): RenderTexture {
    // Live filters change a layer's content; effects are then computed from the filtered alpha (Photoshop order).
    this.performanceCounterValue.compositeRequests++;
    this.activeDocument = document;
    const activeBrush = hooks.brush ?? null;
    const cacheable = view.cache === true && !activeBrush;
    const visualState = cacheable ? this.compositeVisualState(document, hooks) : null;
    const viewportCache = this.viewportCompositeCache;
    if (visualState && viewportCache && sameView(viewportCache.view, view)
      && sameVisualState(viewportCache.state, visualState)) {
      this.performanceCounterValue.unchangedFrameHits++;
      this.skippedAdjustments = viewportCache.skippedAdjustments;
      return viewportCache.target;
    }
    const needsCpuEffectSource = document.layers.some((layer) => layer.filters.some((filter) => filter.enabled)
      && layer.effects.some((effect) => effect.enabled));
    if (needsCpuEffectSource) this.performanceCounterValue.cpuLiveFilterFallbacks++;
    document = documentWithLayerEffects(document,
      needsCpuEffectSource ? this.effectFilteredHooks.use(hooks) : hooks, this.performanceCounterValue);
    this.frame++;
    this.performanceCounterValue.fullComposites++;
    this.skippedAdjustments = 0;
    // Float targets only: an 8-bit accumulation target would lose the precision again.
    // Keep a layer's texture encoding stable when a style is toggled; changing every RGBA8 upload
    // from browser-premultiplied bytes to half floats re-rounded unrelated translucent pixels.
    this.preciseTextures = this.floatTargets && document.layers.some((layer) =>
      PRECISION_SENSITIVE_MODES.has(hooks.blendMode(layer))
      || !!(layer as PreviewLayer).gpuFilterPreview
      || layer.filters.some((filter) => filter.enabled));
    const { width, height } = view;
    let brushState: BrushGpuState | null = null;
    let cache = this.brushCompositeCache;
    if (activeBrush) {
      // A6 WebKitGTK measurements showed that re-running every full-viewport layer pass, rather
      // than MetalBrushCoverage-equivalent stamp generation, dominated feedback. Blend/adjustment
      // passes are point-local, so retain the completed frame and recompute only old/new tail damage.
      brushState = this.prepareBrush(activeBrush);
      if (!cache || cache.document !== document || cache.preview !== activeBrush || !sameView(cache.view, view)) {
        this.destroyBrushCompositeCache();
        cache = null;
      } else if (!brushState.dirty) {
        return cache.target;
      } else {
        const gridToDoc = pixelToDocument(activeBrush.transform, activeBrush.width, activeBrush.height);
        this.renderClip = this.gridRect(brushState.dirty.x, brushState.dirty.y, brushState.dirty.width,
          brushState.dirty.height, gridToDoc, view);
        if (!this.renderClip) {
          brushState.dirty = null;
          return cache.target;
        }
      }
    } else {
      this.destroyBrushCompositeCache();
    }
    const byId = new Map(document.layers.map((l) => [l.id, l]));
    if (!activeBrush) this.destroyBrushState();
    const children = new Map<string | null, Layer[]>();
    for (const layer of document.layers) {
      const siblings = children.get(layer.parentId);
      if (siblings) siblings.push(layer); else children.set(layer.parentId, [layer]);
    }
    const isolated = (layer: Layer): boolean => layer.kind === 'group'
      && ((layer as Layer & { readonly psdIsolated?: boolean }).psdIsolated === true
        || layer.opacity !== 1 || layer.fillOpacity !== 1 || layer.blendMode !== 'normal' || !!layer.maskSourceId);
    const shallowBoundaryIds = new Set<string>();
    for (const layer of document.layers) {
      if ((layer as Layer & { readonly psdKnockout?: 'shallow' | 'deep' | false }).psdKnockout !== 'shallow') continue;
      for (const id of ancestorIds(document.layers, layer.id)) {
        const ancestor = byId.get(id); if (ancestor && !isolated(ancestor)) shallowBoundaryIds.add(id);
      }
    }
    const sequence = (parent: string | null): Layer[] => {
      const output: Layer[] = [];
      for (const layer of children.get(parent) ?? []) {
        if (!layer.visible) continue;
        if (layer.kind === 'group') {
          if (isolated(layer)) output.push(layer); else output.push(...sequence(layer.id));
        } else if (hooks.raster(layer) || activeBrush?.layerId === layer.id || layer.adjustment) output.push(layer);
      }
      return output;
    };
    const folderClips = new Map<string, RenderTexture | null>();
    const liveCoverage = new Map<string, RenderTexture | null>();
    const temporaries: RenderTexture[] = [];

    const folderClip = (id: string): RenderTexture | null => {
      const folders = ancestorIds(document.layers, id).map((f) => byId.get(f)!)
        .filter((f) => f?.mask?.enabled || f?.vectorMask?.enabled);
      if (!folders.length) return null;
      const key = folders.map((f) => f.id).join('/');
      if (folderClips.has(key)) return folderClips.get(key)!;
      let clip: RenderTexture | null = null;
      for (const folder of folders) {
        const raster = hooks.maskRaster(folder);
        if (!raster) continue;
        clip = this.multiplyMask(clip, raster, `mask:${folder.id}`,
          hooks.maskPlacement(folder) ?? hooks.transform(folder), view, temporaries);
      }
      folderClips.set(key, clip);
      return clip;
    };

    /** Alpha of a layer drawn alone (LiveMaskRenderer.coverage); null when it has no pixels. */
    const coverageOf = (id: string, depth: number): RenderTexture | null => {
      if (liveCoverage.has(id)) return liveCoverage.get(id)!;
      liveCoverage.set(id, null); // cycle guard
      const layer = byId.get(id);
      if (!layer || depth >= 256 || !hooks.raster(layer)) return null;
      let clip: RenderTexture | null = null;
      if (layer.maskSourceId) {
        clip = coverageOf(layer.maskSourceId, depth + 1);
        if (!clip) return null;
      }
      const alone = this.acquire(width, height);
      temporaries.push(alone);
      this.clear(alone);
      const drawn = this.drawLayer(alone, layer, view, hooks, clip, 'normal');
      temporaries.push(drawn);
      const coverage = this.coverageFromAlpha(drawn, view, temporaries);
      liveCoverage.set(id, coverage);
      return coverage;
    };

    const renderSequence = (layers: readonly Layer[], root = false, scopeParent: string | null = null): RenderTexture => {
      let surface = this.acquire(width, height); this.clear(surface, root
        && (document as CanvasDocument & { readonly psdOpaqueCanvas?: boolean }).psdOpaqueCanvas === true);
      let knockoutBase: RenderTexture | null = null;
      const passThroughBases = new Map<string, RenderTexture>();
      const stacks = new Map<string, Layer[]>(), stacked = new Set<string>();
      layers.forEach((base, index) => {
        if (base.kind === 'group' || base.maskSourceId || base.adjustment) return;
        const clipped: Layer[] = [];
        for (const child of layers.slice(index + 1)) {
          if (child.kind === 'group' || child.maskSourceId !== base.id || child.parentId !== base.parentId) break;
          clipped.push(child);
        }
        if (clipped.length) { stacks.set(base.id, clipped); for (const child of clipped) stacked.add(child.id); }
      });
      for (const layer of layers) {
        if (stacked.has(layer.id)) continue;
        const passThroughAncestors: Layer[] = [];
        let parent = layer.parentId;
        while (parent && parent !== scopeParent) {
          const ancestor = byId.get(parent);
          if (!ancestor) break;
          if (!isolated(ancestor)) passThroughAncestors.push(ancestor);
          parent = ancestor.parentId;
        }
        for (const ancestor of passThroughAncestors) if (shallowBoundaryIds.has(ancestor.id)
          && !passThroughBases.has(ancestor.id)) {
          const base = this.acquire(width, height);
          this.run(this.pass('copy'), base, width, height, { uSource: surface.source }, {});
          passThroughBases.set(ancestor.id, base);
        }
        if (layer.kind === 'group') {
          const groupSurface = renderSequence(sequence(layer.id), false, layer.id);
          const groupClip = layer.maskSourceId ? coverageOf(layer.maskSourceId, 1) : null;
          if (layer.maskSourceId && !groupClip) { this.release(groupSurface); continue; }
          const knockout = (layer as Layer & { readonly psdKnockout?: 'shallow' | 'deep' | false }).psdKnockout;
          const shallowBase = passThroughAncestors.map((ancestor) => passThroughBases.get(ancestor.id))
            .find((candidate): candidate is RenderTexture => !!candidate);
          const base = knockout === 'deep' ? knockoutBase
            : knockout === 'shallow' && root ? shallowBase ?? surface : null;
          const next = this.drawGroupSurface(surface, groupSurface, base, groupClip,
            layer, view, hooks.blendMode(layer));
          this.release(surface); this.release(groupSurface); surface = next; continue;
        }
        const clip = folderClip(layer.id);
        if (layer.adjustment) {
          if (layer.maskSourceId) continue;
          const next = this.adjust(surface, layer, view, hooks, this.adjustmentClip(layer, clip, view, hooks, temporaries));
          this.release(surface); surface = next; continue;
        }
        const clipped = stacks.get(layer.id);
        if (clipped) {
          const next = this.drawStack(surface, layer, clipped, view, hooks, clip, temporaries);
          this.release(surface); surface = next; continue;
        }
        let combined = clip;
        if (layer.maskSourceId) {
          const live = coverageOf(layer.maskSourceId, 1);
          if (!live) continue;
          combined = clip ? this.multiplyTargets(clip, live, view, temporaries) : live;
        }
        const next = this.drawLayer(surface, layer, view, hooks, combined, hooks.blendMode(layer));
        this.release(surface); surface = next;
        if (root && !knockoutBase && layer.locks.transparency) {
          knockoutBase = this.acquire(width, height);
          this.run(this.pass('copy'), knockoutBase, width, height, { uSource: surface.source }, {});
        }
      }
      for (const base of passThroughBases.values()) this.release(base);
      if (knockoutBase) this.release(knockoutBase);
      return surface;
    };
    let acc = renderSequence(sequence(null), true);
    for (const t of temporaries) this.release(t);
    if (activeBrush && brushState) {
      if (cache) {
        this.run(this.pass('copy'), cache.target, width, height, { uSource: acc.source }, {});
        this.release(acc);
        acc = cache.target;
      } else {
        this.brushCompositeCache = { document, preview: activeBrush, view: cloneView(view), target: acc };
      }
      brushState.dirty = null;
    }
    this.renderClip = null;
    if (this.frame % 60 === 0 || this.textureBytes > this.textureByteBudget) this.collectTextures(true);
    if (visualState) {
      const previous = this.viewportCompositeCache;
      this.viewportCompositeCache = {
        state: visualState, view: cloneView(view), target: acc, skippedAdjustments: this.skippedAdjustments,
      };
      if (previous && previous.target !== acc) this.release(previous.target);
    }
    return acc;
  }

  releaseTarget(rt: RenderTexture): void {
    if (rt !== this.brushCompositeCache?.target && rt !== this.viewportCompositeCache?.target) this.release(rt);
  }

  private layerUniforms(raster: Pick<Raster, 'width' | 'height'>, transform: LayerTransform, view: ViewSpec,
    warp: Layer['warp'] = null) {
    const docToGrid = invert(pixelToDocument(transform, raster.width, raster.height));
    // Target px per grid px along each local axis, for edge AA and mip choice.
    const gx = Math.hypot(transform.size.width / raster.width, 0) * (view.snap ? 1 : view.scale);
    const gy = Math.hypot(transform.size.height / raster.height, 0) * (view.snap ? 1 : view.scale);
    const mipLevel = sharpMipLevel(gx);
    const nearest = transform.sampling === 'Nearest';
    return {
      uDocToLayer: mat3(docToGrid),
      uDocToWarp: warp?.kind === 'quad' ? inverseHomographyMatrix(warp.corners) : IDENTITY9,
      uHasWarp: warp?.kind === 'quad' ? 1 : 0,
      uLayerSize: new Float32Array([raster.width, raster.height]),
      uLayerEdge: new Float32Array([gx, gy]),
      uSampling: nearest ? 0 : (mipLevel > 0 ? 2 : 1),
      uMipLevel: mipLevel,
    };
  }

  private cropUniforms(layer: Layer, source: Pick<Raster, 'width' | 'height'>,
    drawn: Pick<Raster, 'width' | 'height'>): { uHasCrop: number; uCropRect: Float32Array; uCropFeather: number } {
    const crop = layer.crop;
    if (!crop) return { uHasCrop: 0, uCropRect: new Float32Array(4), uCropFeather: 0 };
    const sx = drawn.width / source.width, sy = drawn.height / source.height;
    return { uHasCrop: 1, uCropRect: new Float32Array([
      crop.rect.x * sx, crop.rect.y * sy, crop.rect.width * sx, crop.rect.height * sy,
    ]), uCropFeather: crop.feather * Math.min(sx, sy) };
  }

  private residentLod(raster: Raster, transform: LayerTransform, view: ViewSpec): Raster {
    if (!raster.hasSwappedTiles) return raster;
    const pixelsPerSourcePixel = transform.size.width / Math.max(1, raster.width) * view.scale;
    if (pixelsPerSourcePixel > 1 / 8 && this.requestHydration) {
      const docToGrid = invert(pixelToDocument(transform, raster.width, raster.height));
      const corners = [
        apply(docToGrid, apply(view.viewToDoc, { x: 0, y: 0 })),
        apply(docToGrid, apply(view.viewToDoc, { x: view.width, y: 0 })),
        apply(docToGrid, apply(view.viewToDoc, { x: view.width, y: view.height })),
        apply(docToGrid, apply(view.viewToDoc, { x: 0, y: view.height })),
      ];
      const left = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))) - 2);
      const top = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))) - 2);
      const right = Math.min(raster.width, Math.ceil(Math.max(...corners.map((point) => point.x))) + 2);
      const bottom = Math.min(raster.height, Math.ceil(Math.max(...corners.map((point) => point.y))) + 2);
      if (right > left && bottom > top) this.requestHydration(raster,
        { x: left, y: top, width: right - left, height: bottom - top });
    }
    return raster.reducedCopy ?? raster.tileOverlay?.source.reducedCopy ?? raster;
  }

  /** Target-pixel bounds of a grid rectangle, expanded for edge antialiasing. */
  private gridRect(x: number, y: number, width: number, height: number, gridToDoc: Affine, view: ViewSpec): Rect | null {
    const docToTarget = invert(view.viewToDoc);
    const points = [
      apply(docToTarget, apply(gridToDoc, { x, y })),
      apply(docToTarget, apply(gridToDoc, { x: x + width, y })),
      apply(docToTarget, apply(gridToDoc, { x: x + width, y: y + height })),
      apply(docToTarget, apply(gridToDoc, { x, y: y + height })),
    ];
    const left = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))) - 1);
    const top = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))) - 1);
    const right = Math.min(view.width, Math.ceil(Math.max(...points.map((p) => p.x))) + 1);
    const bottom = Math.min(view.height, Math.ceil(Math.max(...points.map((p) => p.y))) + 1);
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }

  /** Source-grid bounds that can contribute to this view; chunks outside stay cold until panned into view. */
  private visibleGridBounds(raster: Pick<Raster, 'width' | 'height'>, transform: LayerTransform, view: ViewSpec): Rect {
    const docToGrid = invert(pixelToDocument(transform, raster.width, raster.height));
    const points = [
      apply(docToGrid, apply(view.viewToDoc, { x: 0, y: 0 })),
      apply(docToGrid, apply(view.viewToDoc, { x: view.width, y: 0 })),
      apply(docToGrid, apply(view.viewToDoc, { x: view.width, y: view.height })),
      apply(docToGrid, apply(view.viewToDoc, { x: 0, y: view.height })),
    ];
    const left = Math.max(0, Math.floor(Math.min(...points.map((point) => point.x))) - 2);
    const top = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))) - 2);
    const right = Math.min(raster.width, Math.ceil(Math.max(...points.map((point) => point.x))) + 2);
    const bottom = Math.min(raster.height, Math.ceil(Math.max(...points.map((point) => point.y))) + 2);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  private filterPass(name: string, fragment: string, textures: readonly string[], extra: Uniforms = {}): Pass {
    return this.pass(name, fragment, { uniforms: {
      uSourceSize: { value: new Float32Array(2), type: 'vec2<f32>' },
      uDirection: { value: new Float32Array(2), type: 'vec2<f32>' },
      uViewToLayer: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
      uLayerToView: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
      uLayerSize: { value: new Float32Array(2), type: 'vec2<f32>' },
      uParams: { value: new Float32Array(4), type: 'vec4<f32>' },
      uSeed: { value: 0, type: 'i32' },
      ...extra,
    }, textures });
  }

  private runFilter(pass: Pass, target: RenderTexture, source: RenderTexture, textures: Record<string, TextureSource>,
    uniforms: Record<string, unknown>): void {
    this.performanceCounterValue.viewFilterPasses++;
    this.run(pass, target, target.width, target.height, { uSource: source.source, ...textures }, {
      uSourceSize: new Float32Array([source.width, source.height]), uDirection: new Float32Array(2),
      uViewToLayer: IDENTITY9, uLayerToView: IDENTITY9, uLayerSize: new Float32Array(2),
      uParams: new Float32Array(4), uSeed: 0, ...uniforms,
    });
  }

  private gaussianTarget(source: RenderTexture, sigma: number, xDirection: Point, yDirection: Point,
    recursive = false): RenderTexture {
    const xScale = Math.max(1e-6, Math.hypot(xDirection.x, xDirection.y));
    const yScale = Math.max(1e-6, Math.hypot(yDirection.x, yDirection.y));
    const xSigma = Math.max(0.01, sigma * xScale), ySigma = Math.max(0.01, sigma * yScale);
    const xSupport = gaussianSupport(xSigma, recursive), ySupport = gaussianSupport(ySigma, recursive);
    const xPass = this.filterPass(`filter:gaussian:${xSupport}`, gaussianFragment(xSupport), ['uSource'],
      { uWeights: { value: new Float32Array(xSupport * 2 + 1), type: 'f32', size: xSupport * 2 + 1 } });
    const yPass = this.filterPass(`filter:gaussian:${ySupport}`, gaussianFragment(ySupport), ['uSource'],
      { uWeights: { value: new Float32Array(ySupport * 2 + 1), type: 'f32', size: ySupport * 2 + 1 } });
    const horizontal = this.acquire(source.width, source.height, true);
    const vertical = this.acquire(source.width, source.height, true);
    this.runFilter(xPass, horizontal, source, {}, { uDirection: new Float32Array([xDirection.x / xScale, xDirection.y / xScale]),
      uWeights: gaussianWeights(xSigma, xSupport, recursive) });
    this.runFilter(yPass, vertical, horizontal, {}, { uDirection: new Float32Array([yDirection.x / yScale, yDirection.y / yScale]),
      uWeights: gaussianWeights(ySigma, ySupport, recursive) });
    this.release(horizontal);
    return vertical;
  }

  private oneFilter(source: RenderTexture, filter: ViewFilter, layerToView: Affine, viewToLayer: Affine,
    xDirection: Point, yDirection: Point, layerSize: { width: number; height: number }, maximum: number): RenderTexture {
    const common = { uViewToLayer: mat3(viewToLayer), uLayerToView: mat3(layerToView),
      uLayerSize: new Float32Array([layerSize.width, layerSize.height]), uDirection: new Float32Array([xDirection.x, xDirection.y]) };
    if (filter.kind === 'Gaussian Blur') return this.gaussianTarget(source, filter.settings.radius, xDirection, yDirection,
      usesRecursiveGaussian(layerSize.width, layerSize.height, filter.settings.radius, 2));
    if (filter.kind === 'Motion Blur') {
      const radians = filter.settings.angle * Math.PI / 180;
      const direction = { x: xDirection.x * Math.cos(radians) - yDirection.x * Math.sin(radians),
        y: xDirection.y * Math.cos(radians) - yDirection.y * Math.sin(radians) };
      const scale = Math.max(1e-6, Math.hypot(direction.x, direction.y));
      const sigma = Math.max(0.01, filter.settings.distance / Math.sqrt(12) * scale);
      const sourceSigma = Math.max(0.01, filter.settings.distance / Math.sqrt(12));
      const axisAligned = Math.abs(filter.settings.angle) < 1e-9 || Math.abs(Math.abs(filter.settings.angle) - 90) < 1e-9;
      const recursive = axisAligned && usesRecursiveGaussian(layerSize.width, layerSize.height, sourceSigma, 1);
      const out = this.acquire(source.width, source.height, true), support = gaussianSupport(sigma, recursive);
      this.runFilter(this.filterPass(`filter:motion:${support}`, gaussianFragment(support), ['uSource'],
        { uWeights: { value: new Float32Array(support * 2 + 1), type: 'f32', size: support * 2 + 1 } }), out, source, {},
      { ...common, uDirection: new Float32Array([direction.x / scale, direction.y / scale]),
        uWeights: gaussianWeights(sigma, support, recursive) });
      return out;
    }
    if (filter.kind === 'Add Noise') {
      const out = this.acquire(source.width, source.height, true);
      this.runFilter(this.filterPass('filter:noise', NOISE_FRAGMENT, ['uSource']), out, source, {}, {
        ...common, uParams: new Float32Array([filter.settings.amount, filter.settings.gaussian ? 1 : 0,
          filter.settings.monochromatic ? 1 : 0, 0]), uSeed: filter.seed | 0,
      });
      return out;
    }
    if (filter.kind === 'Lens Correction') {
      const out = this.acquire(source.width, source.height, true);
      this.runFilter(this.filterPass('filter:lens', LENS_FRAGMENT, ['uSource']), out, source, {}, {
        ...common, uParams: new Float32Array([filter.settings.distortion, 0, 0, 0]),
      });
      return out;
    }
    const denoiseTarget = (input: RenderTexture, luminance: number, colour: number, detail: number): RenderTexture => {
      const ls = Math.min(1, Math.max(0, luminance / 100)), cs = Math.min(1, Math.max(0, colour / 100));
      const radius = Math.max(2, Math.round(2 + 2 * Math.max(ls, cs))), out = this.acquire(input.width, input.height, true);
      this.runFilter(this.filterPass('filter:denoise', DENOISE_FRAGMENT, ['uSource']), out, input, {}, {
        ...common, uParams: new Float32Array([ls, cs, Math.min(1, Math.max(0, detail / 100)), radius]),
      });
      return out;
    };
    if (filter.kind === 'Denoise') return denoiseTarget(source, filter.settings.luminance,
      filter.settings.colour, filter.settings.detail);
    let sharpenSource = source, prepared: RenderTexture | null = null;
    if (filter.kind === 'Smart Sharpen' && filter.settings.reduceNoise > 0) {
      const denoised = denoiseTarget(source, filter.settings.reduceNoise * 0.35, filter.settings.reduceNoise, 50);
      prepared = this.quantizeFilterTarget(denoised, maximum); this.release(denoised);
      sharpenSource = prepared;
    }
    const blurred = this.gaussianTarget(sharpenSource, filter.settings.radius, xDirection, yDirection,
      usesRecursiveGaussian(layerSize.width, layerSize.height, filter.settings.radius, 2));
    const out = this.acquire(source.width, source.height, true);
    this.runFilter(this.filterPass('filter:combine', COMBINE_FRAGMENT, ['uSource', 'uSecond']), out, sharpenSource,
      { uSecond: blurred.source }, { ...common, uParams: new Float32Array([
        filter.kind === 'High Pass' ? 0 : filter.settings.amount,
        filter.kind === 'High Pass' ? 0 : filter.settings.threshold,
        filter.kind === 'High Pass' ? 1 : 0, maximum,
      ]) });
    this.release(blurred); if (prepared) this.release(prepared);
    return out;
  }

  private quantizeFilterTarget(source: RenderTexture, maximum: number): RenderTexture {
    // Preserve the byte-quantized straight colour through premultiplication; half float can move a later stacked
    // filter two byte values away even though each individual pass is within one.
    const out = this.acquire(source.width, source.height, true);
    this.runFilter(this.filterPass('filter:quantize', QUANTIZE_FRAGMENT, ['uSource']), out, source, {},
      { uParams: new Float32Array([maximum, 0, 0, 0]) });
    return out;
  }

  private drawFilteredLayer(backdrop: RenderTexture, layer: Layer, raster: Raster, filters: readonly ViewFilter[],
    previewSelection: import('../core/selection').DocumentSelection | null, view: ViewSpec, hooks: CompositeHooks,
    clip: RenderTexture | null, mode: BlendMode): RenderTexture {
    const transform = hooks.transform(layer), gridToDoc = pixelToDocument(transform, raster.width, raster.height);
    const docToView = invert(view.viewToDoc);
    const map = (point: Point) => apply(docToView, apply(gridToDoc, point));
    const origin = map({ x: 0, y: 0 }), x = map({ x: 1, y: 0 }), y = map({ x: 0, y: 1 });
    const xDirection = { x: x.x - origin.x, y: x.y - origin.y }, yDirection = { x: y.x - origin.x, y: y.y - origin.y };
    const halo = filterHalo(filters, Math.hypot(xDirection.x, xDirection.y), Math.hypot(yDirection.x, yDirection.y));
    const expandedView: ViewSpec = { ...view, width: view.width + halo * 2, height: view.height + halo * 2, cache: false,
      viewToDoc: { ...view.viewToDoc,
        tx: view.viewToDoc.tx - view.viewToDoc.a * halo - view.viewToDoc.c * halo,
        ty: view.viewToDoc.ty - view.viewToDoc.b * halo - view.viewToDoc.d * halo } };
    if (expandedView.width > this.maxTextureSize || expandedView.height > this.maxTextureSize) {
      throw new RangeError('Filtered view exceeds the GPU texture limit');
    }
    const empty = this.acquire(expandedView.width, expandedView.height); this.clear(empty);
    const { gpuFilterPreview: _preview, ...plainLayer } = layer as PreviewLayer;
    const rawLayer = { ...plainLayer, filters: [], effects: [], mask: null, vectorMask: null, crop: null,
      opacity: 1, fillOpacity: 1, blendMode: 'normal' as const } as Layer;
    let current = this.drawLayer(empty, rawLayer, expandedView, hooks, null, 'normal', true, true);
    this.release(empty);

    const expandedDocToView = invert(expandedView.viewToDoc), expandedMap = (point: Point) =>
      apply(expandedDocToView, apply(gridToDoc, point));
    const eo = expandedMap({ x: 0, y: 0 }), ex = expandedMap({ x: 1, y: 0 }), ey = expandedMap({ x: 0, y: 1 });
    const layerToView: Affine = { a: ex.x - eo.x, b: ex.y - eo.y, c: ey.x - eo.x, d: ey.y - eo.y, tx: eo.x, ty: eo.y };
    const viewToLayer = invert(layerToView);
    const expandedX = { x: layerToView.a, y: layerToView.b }, expandedY = { x: layerToView.c, y: layerToView.d };
    let selectionTarget: RenderTexture | null = null;
    if (previewSelection) {
      const placement: LayerTransform = { origin: { x: previewSelection.x, y: previewSelection.y },
        size: { width: previewSelection.mask.width, height: previewSelection.mask.height }, rotation: 0,
        flipX: false, flipY: false, sampling: 'High quality' };
      selectionTarget = this.renderMask(null, previewSelection.mask, `filter-selection:${layer.id}`,
        placement, expandedView, 0);
    }
    filters.forEach((filter, index) => {
      const before = current;
      let after = this.oneFilter(before, filter, layerToView, viewToLayer, expandedX, expandedY,
        { width: raster.width, height: raster.height }, raster.maximum);
      const quantized = this.quantizeFilterTarget(after, raster.maximum);
      this.release(after); after = quantized;
      if (index === 0 && selectionTarget) {
        const mixed = this.acquire(after.width, after.height, true);
        this.runFilter(this.filterPass('filter:selection', SELECTION_MIX_FRAGMENT,
          ['uSource', 'uSecond', 'uSelection']), mixed, before,
        { uSecond: after.source, uSelection: selectionTarget.source }, {});
        this.release(after);
        after = this.quantizeFilterTarget(mixed, raster.maximum);
        this.release(mixed);
      }
      this.release(before); current = after;
    });
    this.release(selectionTarget);

    let maskTarget: RenderTexture | null = null;
    const maskEnabled = layer.mask?.enabled || layer.vectorMask?.enabled;
    const maskRaster = maskEnabled ? hooks.maskRaster(layer) : null;
    if (maskEnabled && maskRaster) {
      const placement = hooks.maskPlacement(layer), maskPlace = placement ?? transform;
      const drawnMask = this.residentLod(maskRaster, maskPlace, view);
      maskTarget = this.renderMask(null, maskRaster, `mask:${layer.id}`, maskPlace, view,
        placement ? maskBackground(drawnMask) : 0);
    }
    const brush = hooks.brush?.layerId === layer.id ? hooks.brush : null;
    if (brush?.target === 'mask' && maskTarget) {
      const painted = this.overlayBrushMask(maskTarget, brush, this.prepareBrush(brush), view);
      this.release(maskTarget); maskTarget = painted;
    }
    const out = this.acquire(view.width, view.height), u = this.layerUniforms(raster, transform, view, layer.warp);
    this.run(this.pass('filteredLayer'), out, view.width, view.height, {
      uBackdrop: backdrop.source, uLayer: current.source, uMask: maskTarget?.source ?? this.white,
      uClip: clip?.source ?? this.white,
    }, {
      uFilterOffset: new Float32Array([halo, halo]), uViewToDoc: mat3(view.viewToDoc),
      uDocToLayer: u.uDocToLayer, uDocToWarp: u.uDocToWarp, uHasWarp: u.uHasWarp,
      uLayerSize: u.uLayerSize, ...this.cropUniforms(layer, raster, raster),
      uOpacity: layer.opacity, uFillOpacity: layer.fillOpacity, uMode: BLEND_INDEX[mode] ?? 0,
      uDissolveSeed: mode === 'dissolve' ? blendSeed(layer.id) : 0,
      uHasMask: maskTarget ? 1 : 0, uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0,
    });
    this.release(maskTarget); this.release(current);
    this.performanceCounterValue.viewFilterLayers++;
    return out;
  }

  /** One layer pass onto `backdrop` → a new target. */
  private drawLayer(backdrop: RenderTexture, layer: Layer, view: ViewSpec, hooks: CompositeHooks, clip: RenderTexture | null,
    mode: BlendMode, replace = false, fullFloatTarget = false): RenderTexture {
    const raster = hooks.raster(layer);
    const preview = (layer as PreviewLayer).gpuFilterPreview;
    const defaults = defaultFilterSettings();
    const filters = [preview ? previewViewFilter(preview) : null,
      ...layer.filters.map((filter) => liveViewFilter(filter, defaults))]
      .filter((filter): filter is ViewFilter => !!filter);
    const transform = hooks.transform(layer);
    const targetPerSource = Math.max(transform.size.width / Math.max(1, raster?.width ?? 1),
      transform.size.height / Math.max(1, raster?.height ?? 1)) * view.scale;
    // A highly magnified icon should not be blurred on a much larger upsampled grid. The bounded native-grid
    // path is exact and stays cheap; production-size layers remain view-space and never enter the CPU here.
    if (raster && !preview && filters.length && raster.width * raster.height <= 16_384 && targetPerSource > 1) {
      this.performanceCounterValue.cpuLiveFilterFallbacks++;
      const filtered = applyLiveFilters(raster, layer.filters);
      const plain = { ...layer, filters: [] };
      const filteredHooks: CompositeHooks = {
        transform: (item) => hooks.transform(item), maskPlacement: (item) => hooks.maskPlacement(item),
        blendMode: (item) => hooks.blendMode(item), maskRaster: (item) => hooks.maskRaster(item),
        raster: (item) => item.id === layer.id ? filtered : hooks.raster(item), brush: hooks.brush,
      };
      return this.drawLayer(backdrop, plain, view, filteredHooks, clip, mode, replace, fullFloatTarget);
    }
    if (raster && filters.length) return this.drawFilteredLayer(backdrop, layer, raster, filters,
      preview?.selection ?? null, view, hooks, clip, mode);
    const brush = hooks.brush?.layerId === layer.id ? hooks.brush : null;
    const brushState = brush ? this.prepareBrush(brush) : null;
    const pixelBrush = brush?.target === 'pixels' ? brush : null;
    let out = this.acquire(view.width, view.height, fullFloatTarget);
    if (replace) this.copy(backdrop, out, view);
    let maskTarget: RenderTexture | null = null;
    const maskEnabled = layer.mask?.enabled || layer.vectorMask?.enabled;
    const maskRaster = maskEnabled ? hooks.maskRaster(layer) : null;
    if (maskEnabled && maskRaster) {
      const placement = hooks.maskPlacement(layer);
      const maskPlace = placement ?? hooks.transform(layer);
      const drawnMask = this.residentLod(maskRaster, maskPlace, view);
      maskTarget = this.renderMask(null, maskRaster, `mask:${layer.id}`, maskPlace, view,
        placement ? maskBackground(drawnMask) : 0);
    }
    if (brush?.target === 'mask' && brushState && maskTarget) {
      const paintedMask = this.overlayBrushMask(maskTarget, brush, brushState, view);
      this.release(maskTarget);
      maskTarget = paintedMask;
    }

    if (!raster) this.copy(backdrop, out, view);
    else {
      const transform = hooks.transform(layer);
      const drawnRaster = this.residentLod(raster, transform, view);
      const visible = layer.warp ? undefined : this.visibleGridBounds(drawnRaster, transform, view);
      const slot = this.texture(`px:${layer.id}${drawnRaster === raster ? '' : ':lod'}`, drawnRaster, visible);
      const u = this.layerUniforms(drawnRaster, transform, view, layer.warp);
      const only = slot.chunks.size === 1 ? slot.chunks.values().next().value as TextureChunk : null;
      const restricted = !only || only.x !== 0 || only.y !== 0
        || only.width !== drawnRaster.width || only.height !== drawnRaster.height;
      if (!replace && (!slot.chunks.size || restricted)) this.copy(backdrop, out, view);
      const gridToDoc = pixelToDocument(transform, drawnRaster.width, drawnRaster.height);
      for (const chunk of slot.chunks.values()) {
        const rect = layer.warp ? { x: 0, y: 0, width: view.width, height: view.height } : restricted
          ? this.gridRect(chunk.x, chunk.y, chunk.width, chunk.height, gridToDoc, view)
          : { x: 0, y: 0, width: view.width, height: view.height };
        if (!rect) continue;
        const textures = {
          uBackdrop: backdrop.source, uLayer: chunk.source, uMask: maskTarget?.source ?? this.white,
          uClip: clip?.source ?? this.white,
        };
        const uniforms = {
          uTarget: new Float32Array([view.width, view.height]), uViewToDoc: mat3(view.viewToDoc),
          uDocToLayer: u.uDocToLayer, uDocToWarp: u.uDocToWarp, uHasWarp: u.uHasWarp,
          uLayerSize: u.uLayerSize, uLayerEdge: u.uLayerEdge, uSampling: layer.warp?.kind === 'mesh' && u.uSampling !== 0 ? 3 : u.uSampling,
          uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
          uTextureSize: new Float32Array([chunk.width + CHUNK_APRON * 2, chunk.height + CHUNK_APRON * 2]), uApron: CHUNK_APRON,
          uMipLevel: u.uMipLevel, uRestrictChunk: restricted ? 1 : 0,
          uRestrictBounds: 0,
          ...this.cropUniforms(layer, raster, drawnRaster),
          uOpacity: layer.opacity, uFillOpacity: layer.fillOpacity, uMode: BLEND_INDEX[mode] ?? 0,
          uDissolveSeed: mode === 'dissolve' ? blendSeed(layer.id) : 0,
          uHasMask: maskTarget ? 1 : 0,
          uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0, uReplace: replace ? 1 : 0,
        };
        if (layer.warp?.kind === 'mesh') this.runWarpMesh(layer.warp, view, this.pass('warpMesh'), out, textures, uniforms);
        else this.run(this.pass('layer'), out, view.width, view.height, textures, uniforms, rect);
      }
      if (drawnRaster !== raster) {
        // Product-plan A4: retain the navigation result only under unresolved tiles; every
        // resolved chunk is recomposited against the original backdrop at full resolution.
        const sharp = residentView(raster);
        const sharpVisible = layer.warp ? undefined : this.visibleGridBounds(sharp, transform, view);
        const sharpSlot = this.texture(`px:${layer.id}:resident`, sharp, sharpVisible);
        const sharpOut = this.acquire(view.width, view.height);
        this.copy(out, sharpOut, view);
        const sharpUniforms = this.layerUniforms(sharp, transform, view, layer.warp);
        const sharpGridToDoc = pixelToDocument(transform, sharp.width, sharp.height);
        for (const chunk of sharpSlot.chunks.values()) {
          const rect = layer.warp ? { x: 0, y: 0, width: view.width, height: view.height }
            : this.gridRect(chunk.x, chunk.y, chunk.width, chunk.height, sharpGridToDoc, view);
          if (!rect) continue;
          const textures = {
            uBackdrop: backdrop.source, uLayer: chunk.source, uMask: maskTarget?.source ?? this.white,
            uClip: clip?.source ?? this.white,
          };
          const uniforms = {
            uTarget: new Float32Array([view.width, view.height]), uViewToDoc: mat3(view.viewToDoc),
            uDocToLayer: sharpUniforms.uDocToLayer, uDocToWarp: sharpUniforms.uDocToWarp,
            uHasWarp: sharpUniforms.uHasWarp, uLayerSize: sharpUniforms.uLayerSize,
            uLayerEdge: sharpUniforms.uLayerEdge, uSampling: layer.warp?.kind === 'mesh' && sharpUniforms.uSampling !== 0 ? 3 : sharpUniforms.uSampling,
            uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
            uTextureSize: new Float32Array([chunk.width + CHUNK_APRON * 2, chunk.height + CHUNK_APRON * 2]), uApron: CHUNK_APRON,
            uMipLevel: sharpUniforms.uMipLevel, uRestrictChunk: 1, uRestrictBounds: 0,
            ...this.cropUniforms(layer, raster, sharp),
            uOpacity: layer.opacity, uFillOpacity: layer.fillOpacity, uMode: BLEND_INDEX[mode] ?? 0,
            uDissolveSeed: mode === 'dissolve' ? blendSeed(layer.id) : 0,
            uHasMask: maskTarget ? 1 : 0, uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0,
            uReplace: replace ? 1 : 0,
          };
          if (layer.warp?.kind === 'mesh') this.runWarpMesh(layer.warp, view, this.pass('warpMesh'), sharpOut, textures, uniforms);
          else this.run(this.pass('layer'), sharpOut, view.width, view.height, textures, uniforms, rect);
        }
        this.release(out);
        out = sharpOut;
      }
    }

    if (pixelBrush && brushState) {
      const u = this.layerUniforms({ width: pixelBrush.width, height: pixelBrush.height },
        pixelBrush.transform, view);
      const gridToDoc = pixelToDocument(pixelBrush.transform, pixelBrush.width, pixelBrush.height);
      for (const chunk of brushState.chunks.values()) {
        const bounds = expandedBrushBounds(chunk);
        if (!bounds) continue;
        const rect = this.gridRect(bounds.x, bounds.y, bounds.width, bounds.height, gridToDoc, view);
        if (!rect) continue;
        this.run(this.pass('layer'), out, view.width, view.height, {
          uBackdrop: backdrop.source, uLayer: chunk.painted.source, uMask: maskTarget?.source ?? this.white,
          uClip: clip?.source ?? this.white,
        }, {
          uTarget: new Float32Array([view.width, view.height]), uViewToDoc: mat3(view.viewToDoc),
          uDocToLayer: u.uDocToLayer, uDocToWarp: IDENTITY9, uHasWarp: 0,
          uLayerSize: u.uLayerSize, uLayerEdge: u.uLayerEdge, uSampling: u.uSampling,
          uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
          uTextureSize: new Float32Array([chunk.painted.width, chunk.painted.height]), uApron: BRUSH_APRON,
          uMipLevel: u.uMipLevel, uRestrictChunk: 1,
          uRestrictBounds: 1, uDrawOrigin: new Float32Array([bounds.x, bounds.y]),
          uDrawSize: new Float32Array([bounds.width, bounds.height]),
          ...this.cropUniforms(layer, raster ?? pixelBrush, pixelBrush),
          uOpacity: layer.opacity, uFillOpacity: layer.fillOpacity, uMode: BLEND_INDEX[mode] ?? 0,
          uDissolveSeed: mode === 'dissolve' ? blendSeed(layer.id) : 0,
          uHasMask: maskTarget ? 1 : 0,
          uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0, uReplace: replace ? 1 : 0,
        }, rect);
      }
    }
    this.release(maskTarget);
    return out;
  }

  private overlayBrushMask(base: RenderTexture, preview: GpuBrushPreview, state: BrushGpuState,
    view: ViewSpec): RenderTexture {
    let out = this.acquire(view.width, view.height);
    this.run(this.pass('coverage'), out, view.width, view.height, { uPrevious: this.white, uSource: base.source }, {
      uKind: 3, uHasPrevious: 0, uViewToDoc: mat3(view.viewToDoc), uDocToMask: mat3(invert(preview.mapping)),
      uMaskSize: new Float32Array([preview.width, preview.height]), uMaskEdge: new Float32Array([1, 1]),
      uSnap: view.snap ? 1 : 0,
    });
    const gx = preview.transform.size.width / preview.width * (view.snap ? 1 : view.scale);
    const gy = preview.transform.size.height / preview.height * (view.snap ? 1 : view.scale);
    const mipLevel = sharpMipLevel(gx);
    const gridToDoc = pixelToDocument(preview.transform, preview.width, preview.height);
    for (const chunk of state.chunks.values()) {
      const bounds = expandedBrushBounds(chunk);
      if (!bounds) continue;
      const rect = this.gridRect(bounds.x, bounds.y, bounds.width, bounds.height, gridToDoc, view);
      if (!rect) continue;
      this.run(this.pass('brushMask'), out, view.width, view.height, {
        uBackdrop: base.source, uPainted: chunk.painted.source,
      }, {
        uViewToDoc: mat3(view.viewToDoc), uDocToMask: mat3(invert(preview.mapping)),
        uMaskSize: new Float32Array([preview.width, preview.height]), uMaskEdge: new Float32Array([gx, gy]),
        uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
        uTextureSize: new Float32Array([chunk.painted.width, chunk.painted.height]), uApron: BRUSH_APRON,
        uSampling: mipLevel > 0 ? 2 : 1, uMipLevel: mipLevel, uSnap: view.snap ? 1 : 0,
      }, rect);
    }
    return out;
  }

  private copy(from: RenderTexture, to: RenderTexture, view: ViewSpec): void {
    this.run(this.pass('stack'), to, view.width, view.height, {
      uBackdrop: from.source, uSurface: this.white, uBase: this.transparentSource(), uClip: this.white,
    }, { uHasClip: 0, uMode: 0, uDissolveSeed: 0, uViewToDoc: mat3(view.viewToDoc) });
  }

  private transparent: TextureSource | null = null;
  private transparentSource(): TextureSource {
    if (!this.transparent) {
      this.transparent = new TextureSource({ width: 1, height: 1, format: 'rgba8unorm' });
      this.uploadWhole(this.transparent, new Uint8Array(4), 1, 1, 4);
    }
    return this.transparent;
  }

  /** previous × transformed mask (outside the mask rect → 0), as FolderMaskClip does. */
  private multiplyMask(previous: RenderTexture | null, raster: Raster, slotKey: string, placement: LayerTransform, view: ViewSpec,
    temporaries: RenderTexture[]): RenderTexture {
    const out = this.renderMask(previous, raster, slotKey, placement, view, 0);
    temporaries.push(out);
    return out;
  }

  /** Builds a mask in view space, replacing disjoint chunk interiors over a zero-inside base. */
  private renderMask(previous: RenderTexture | null, raster: Raster, slotKey: string, placement: LayerTransform, view: ViewSpec,
    background: number): RenderTexture {
    const original = raster;
    raster = this.residentLod(raster, placement, view);
    if (raster !== original) slotKey += ':lod';
    const slot = this.texture(slotKey, raster, this.visibleGridBounds(raster, placement, view));
    const docToGrid = invert(pixelToDocument(placement, raster.width, raster.height));
    const gx = placement.size.width / raster.width * (view.snap ? 1 : view.scale);
    const gy = placement.size.height / raster.height * (view.snap ? 1 : view.scale);
    const mipLevel = sharpMipLevel(gx);
    const out = this.acquire(view.width, view.height);
    const common = {
      uHasPrevious: previous ? 1 : 0, uViewToDoc: mat3(view.viewToDoc), uDocToMask: mat3(docToGrid),
      uMaskSize: new Float32Array([raster.width, raster.height]), uMaskEdge: new Float32Array([gx, gy]),
      uBackground: background, uSampling: mipLevel > 0 ? 2 : 1, uMipLevel: mipLevel, uSnap: view.snap ? 1 : 0,
    };
    this.run(this.pass('mask'), out, view.width, view.height, {
      uPrevious: previous?.source ?? this.white, uMask: this.white,
    }, {
      ...common, uDrawChunk: 0,
    });
    const gridToDoc = pixelToDocument(placement, raster.width, raster.height);
    for (const chunk of slot.chunks.values()) {
      const rect = this.gridRect(chunk.x, chunk.y, chunk.width, chunk.height, gridToDoc, view);
      if (!rect) continue;
      this.run(this.pass('mask'), out, view.width, view.height, {
        uPrevious: previous?.source ?? this.white, uMask: chunk.source,
      }, {
        ...common, uDrawChunk: 1, uChunkOrigin: new Float32Array([chunk.x, chunk.y]),
        uChunkSize: new Float32Array([chunk.width, chunk.height]),
        uTextureSize: new Float32Array([chunk.width + CHUNK_APRON * 2, chunk.height + CHUNK_APRON * 2]), uApron: CHUNK_APRON,
      }, rect);
    }
    if (raster !== original) {
      const sharp = residentView(original);
      const sharpSlot = this.texture(`${slotKey}:resident`, sharp, this.visibleGridBounds(sharp, placement, view));
      const sharpDocToGrid = invert(pixelToDocument(placement, sharp.width, sharp.height));
      const sharpGx = placement.size.width / sharp.width * (view.snap ? 1 : view.scale);
      const sharpGy = placement.size.height / sharp.height * (view.snap ? 1 : view.scale);
      const sharpMip = sharpMipLevel(sharpGx);
      const sharpCommon = {
        uHasPrevious: previous ? 1 : 0, uViewToDoc: mat3(view.viewToDoc), uDocToMask: mat3(sharpDocToGrid),
        uMaskSize: new Float32Array([sharp.width, sharp.height]), uMaskEdge: new Float32Array([sharpGx, sharpGy]),
        uBackground: background, uSampling: sharpMip > 0 ? 2 : 1, uMipLevel: sharpMip, uSnap: view.snap ? 1 : 0,
      };
      const sharpGridToDoc = pixelToDocument(placement, sharp.width, sharp.height);
      for (const chunk of sharpSlot.chunks.values()) {
        const rect = this.gridRect(chunk.x, chunk.y, chunk.width, chunk.height, sharpGridToDoc, view);
        if (!rect) continue;
        this.run(this.pass('mask'), out, view.width, view.height, {
          uPrevious: previous?.source ?? this.white, uMask: chunk.source,
        }, {
          ...sharpCommon, uDrawChunk: 1, uChunkOrigin: new Float32Array([chunk.x, chunk.y]),
          uChunkSize: new Float32Array([chunk.width, chunk.height]),
          uTextureSize: new Float32Array([chunk.width + CHUNK_APRON * 2, chunk.height + CHUNK_APRON * 2]), uApron: CHUNK_APRON,
        }, rect);
      }
    }
    return out;
  }

  private coverageFromAlpha(source: RenderTexture, view: ViewSpec, temporaries: RenderTexture[]): RenderTexture {
    const out = this.acquire(view.width, view.height);
    temporaries.push(out);
    this.run(this.pass('coverage'), out, view.width, view.height, { uPrevious: this.white, uSource: source.source },
      { uKind: 1, uHasPrevious: 0 });
    return out;
  }

  private multiplyTargets(a: RenderTexture, b: RenderTexture, view: ViewSpec, temporaries: RenderTexture[]): RenderTexture {
    const out = this.acquire(view.width, view.height);
    temporaries.push(out);
    this.run(this.pass('coverage'), out, view.width, view.height, { uPrevious: a.source, uSource: b.source },
      { uKind: 3, uHasPrevious: 1 });
    return out;
  }

  /** The clip for an adjustment layer: its own enabled mask (outside → 0) times its folders' masks. */
  private adjustmentClip(layer: Layer, folderClip: RenderTexture | null, view: ViewSpec, hooks: CompositeHooks,
    temporaries: RenderTexture[]): RenderTexture | null {
    const raster = layer.mask?.enabled || layer.vectorMask?.enabled ? hooks.maskRaster(layer) : null;
    if (!raster) return folderClip;
    const background = ((layer as Layer & { readonly psdMaskDefault?: number }).psdMaskDefault ?? 0) / 255;
    const placement = (layer as Layer & { readonly psdMaskDefault?: number }).psdMaskDefault === undefined
      ? hooks.transform(layer) : hooks.maskPlacement(layer) ?? hooks.transform(layer);
    const clip = this.renderMask(folderClip, raster, `mask:${layer.id}`, placement, view, background);
    temporaries.push(clip); return clip;
  }

  private adjust(backdrop: RenderTexture, layer: Layer, view: ViewSpec, hooks: CompositeHooks, clip: RenderTexture | null): RenderTexture {
    const program = this.adjustmentPrograms(layer, this.activeDocument);
    if (!program) this.skippedAdjustments++;
    const key = program ? `adjust:${program.key}` : 'adjust:identity';
    const pass = this.pass(key, adjustFragment(program?.glsl ?? IDENTITY_ADJUST));
    const out = this.acquire(view.width, view.height);
    let lut: TextureSource = this.white;
    const lutData = program?.lut?.(layer);
    if (lutData) {
      const useFloat = this.floatTargets && lutData.data instanceof Float32Array;
      const uploadData = useFloat || lutData.data instanceof Uint8Array ? lutData.data : byteLut(lutData.data);
      const lutKey = `${layer.id}:${useFloat ? 'float' : 'byte'}`;
      let source = this.lutSources.get(lutKey);
      if (!source || source.width !== lutData.width || source.height !== lutData.height) {
        source?.destroy();
        this.lutUploaded.delete(lutKey);
        source = new TextureSource({ width: lutData.width, height: lutData.height,
          format: useFloat ? 'rgba16float' : 'rgba8unorm',
          scaleMode: 'linear', addressMode: 'clamp-to-edge' });
        this.lutSources.set(lutKey, source);
      }
      if (this.lutUploaded.get(lutKey) !== uploadData) {
        this.renderer.texture.bindSource(source, 0);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, lutData.width, lutData.height, this.gl.RGBA,
          useFloat ? this.gl.FLOAT : this.gl.UNSIGNED_BYTE, uploadData);
        this.restoreUnpack();
        this.lutUploaded.set(lutKey, uploadData);
      }
      lut = source;
    }
    this.run(pass, out, view.width, view.height, { uBackdrop: backdrop.source, uClip: clip?.source ?? this.white, uLut: lut }, {
      uHasClip: clip ? 1 : 0, uMode: BLEND_INDEX[hooks.blendMode(layer)] ?? 0,
      uOpacity: layer.opacity * layer.fillOpacity,
      uViewToDoc: mat3(view.viewToDoc), uParams: program?.params(layer) ?? new Float32Array(32),
    });
    return out;
  }

  private drawStack(backdrop: RenderTexture, base: Layer, children: Layer[], view: ViewSpec, hooks: CompositeHooks,
    clip: RenderTexture | null, temporaries: RenderTexture[]): RenderTexture {
    const empty = this.acquire(view.width, view.height);
    temporaries.push(empty);
    this.clear(empty);
    const baseAlone = this.drawLayer(empty, base, view, hooks, null, 'normal');
    temporaries.push(baseAlone);
    let surface = this.acquire(view.width, view.height);
    this.run(this.pass('opaque'), surface, view.width, view.height, { uSource: baseAlone.source }, {});
    for (const child of children) {
      const next = child.adjustment
        ? this.adjust(surface, child, view, hooks, this.adjustmentClip(child, null, view, hooks, temporaries))
        : this.drawLayer(surface, child, view, hooks, null, hooks.blendMode(child));
      this.release(surface);
      surface = next;
    }
    const out = this.acquire(view.width, view.height);
    const mode = hooks.blendMode(base);
    this.run(this.pass('stack'), out, view.width, view.height, {
      uBackdrop: backdrop.source, uSurface: surface.source, uBase: baseAlone.source, uClip: clip?.source ?? this.white,
    }, { uHasClip: clip ? 1 : 0, uMode: BLEND_INDEX[mode] ?? 0,
      uDissolveSeed: mode === 'dissolve' ? blendSeed(base.id) : 0, uViewToDoc: mat3(view.viewToDoc) });
    this.release(surface);
    return out;
  }

  private drawGroupSurface(backdrop: RenderTexture, surface: RenderTexture, knockoutBase: RenderTexture | null,
    clip: RenderTexture | null, group: Layer, view: ViewSpec, mode: BlendMode): RenderTexture {
    const out = this.acquire(view.width, view.height);
    this.run(this.pass('group'), out, view.width, view.height, {
      uBackdrop: backdrop.source, uSurface: surface.source,
      uKnockoutBase: knockoutBase?.source ?? this.transparentSource(),
      uClip: clip?.source ?? this.white,
    }, { uMode: BLEND_INDEX[mode] ?? 0, uDissolveSeed: mode === 'dissolve' ? blendSeed(group.id) : 0,
      uOpacity: group.opacity, uFillOpacity: group.fillOpacity,
      uKnockout: (group as Layer & { readonly psdKnockout?: 'shallow' | 'deep' | false }).psdKnockout ? 1 : 0,
      uHasClip: clip ? 1 : 0,
      uViewToDoc: mat3(view.viewToDoc) });
    return out;
  }

  // MARK: Presentation and readback

  /** Draws the workspace, canvas rectangle, checkerboard and composite to the screen canvas. */
  present(composite: RenderTexture | null, width: number, height: number, canvasRect: { x: number; y: number; width: number; height: number },
    pointScale: number, grid: boolean, pixelSize: number, compositeOrigin: { x: number; y: number } = { x: 0, y: 0 },
    proof?: { readonly lut: CmykLut; readonly gamutWarning: boolean }): void {
    this.resize(width, height);
    let proofSource = this.white;
    if (proof) {
      let proofPixels = proof.lut.proof;
      if (proof.gamutWarning) {
        let warning = this.proofWarnings.get(proof.lut);
        if (!warning) {
          warning = proof.lut.proof.slice();
          for (let at = 0; at < warning.length; at += 4) if (warning[at + 3]! > 38) {
            warning[at] = 209; warning[at + 1] = 0; warning[at + 2] = 209;
          }
          this.proofWarnings.set(proof.lut, warning);
        }
        proofPixels = warning;
      }
      let uploaded = this.proofSources.get(proofPixels);
      if (!uploaded) {
        uploaded = new TextureSource({ width: proof.lut.size * proof.lut.size, height: proof.lut.size, format: 'rgba8unorm' });
        this.renderer.texture.bindSource(uploaded, 0);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, proof.lut.size * proof.lut.size, proof.lut.size,
          this.gl.RGBA, this.gl.UNSIGNED_BYTE, proofPixels);
        this.restoreUnpack(); this.proofSources.set(proofPixels, uploaded);
      }
      proofSource = uploaded;
    }
    this.run(this.pass('present'), null, width, height, { uComposite: composite?.source ?? this.white, uProofLut: proofSource }, {
      uCanvasRect: new Float32Array([canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height]),
      uPointScale: pointScale, uGrid: grid ? 1 : 0, uPixelSize: pixelSize, uHasComposite: composite ? 1 : 0,
      uCompositeOrigin: new Float32Array([compositeOrigin.x, compositeOrigin.y]),
      uCompositeSize: new Float32Array([composite?.width ?? 0, composite?.height ?? 0]),
      uProof: proof ? 1 : 0, uGamutWarning: 0, uProofSize: proof?.lut.size ?? 2,
    });
  }

  /** Straight-alpha RGBA8 pixels of a document region, composited exactly like the canvas. */
  readRegion(document: CanvasDocument, x: number, y: number, width: number, height: number, hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
    return this.readView(document, width, height, { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }, 1, hooks);
  }

  /**
   * Straight-alpha RGBA8 pixels of a `width` × `height` target whose pixels map to the document
   * through `viewToDoc` (e.g. a layer's own pixel grid for LiveMaskBaker), rendered in tiles.
   */
  readView(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    const step = Math.min(2048, this.maxTextureSize);
    for (let ty = 0; ty < height; ty += step) {
      for (let tx = 0; tx < width; tx += step) {
        const w = Math.min(step, width - tx), h = Math.min(step, height - ty);
        const view: ViewSpec = { width: w, height: h, scale, snap: false,
          viewToDoc: concat({ a: 1, b: 0, c: 0, d: 1, tx, ty }, viewToDoc) };
        const rt = this.composite(document, view, hooks);
        const straight = RenderTexture.create({ width: w, height: h, format: 'rgba8unorm', antialias: false, resolution: 1 });
        this.run(this.pass('unpremultiply'), straight, w, h, { uSource: rt.source }, {});
        this.releaseTarget(rt);
        const pixels = this.readPixels(straight, w, h);
        this.destroyTarget(straight);
        for (let row = 0; row < h; row++) {
          out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((ty + row) * width + tx) * 4);
        }
      }
    }
    return out;
  }

  /** Straight-alpha float readback from the rgba16float pipeline. */
  readRegionFloat(document: CanvasDocument, x: number, y: number, width: number, height: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
    return this.readViewFloat(document, width, height, { a: 1, b: 0, c: 0, d: 1, tx: x, ty: y }, 1, hooks);
  }

  readRegion16(document: CanvasDocument, x: number, y: number, width: number, height: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Uint16Array {
    return floatToRgba16(this.readRegionFloat(document, x, y, width, height, hooks));
  }

  readViewFloat(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number,
    hooks: CompositeHooks = DEFAULT_HOOKS): Float32Array {
    if (!this.floatTargets) throw new Error('Float readback requires EXT_color_buffer_float.');
    const out = new Float32Array(width * height * 4);
    const step = Math.min(2048, this.maxTextureSize);
    for (let ty = 0; ty < height; ty += step) for (let tx = 0; tx < width; tx += step) {
      const w = Math.min(step, width - tx), h = Math.min(step, height - ty);
      const view: ViewSpec = { width: w, height: h, scale, snap: false,
        viewToDoc: concat({ a: 1, b: 0, c: 0, d: 1, tx, ty }, viewToDoc) };
      const rt = this.composite(document, view, hooks);
      const straight = RenderTexture.create({ width: w, height: h, format: 'rgba16float', antialias: false, resolution: 1 });
      this.run(this.pass('unpremultiply'), straight, w, h, { uSource: rt.source }, {});
      this.releaseTarget(rt);
      const pixels = this.readFloatPixels(straight, w, h);
      this.destroyTarget(straight);
      for (let row = 0; row < h; row++) {
        out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((ty + row) * width + tx) * 4);
      }
    }
    return out;
  }

  /** Reads an RGBA8 render texture top row first. */
  readPixels(rt: RenderTexture, width: number, height: number): Uint8Array {
    const gl = this.gl;
    this.renderer.renderTarget.bind({ target: rt, clear: false });
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (this.renderTargetFlipped()) {
      const row = width * 4, flipped = new Uint8Array(pixels.length);
      for (let y = 0; y < height; y++) flipped.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
      return flipped;
    }
    return pixels;
  }

  private readFloatPixels(rt: RenderTexture, width: number, height: number): Float32Array {
    const gl = this.gl;
    this.renderer.renderTarget.bind({ target: rt, clear: false });
    const pixels = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
    if (!this.renderTargetFlipped()) return pixels;
    const row = width * 4, flipped = new Float32Array(pixels.length);
    for (let y = 0; y < height; y++) flipped.set(pixels.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
    return flipped;
  }

  /** Whether Pixi stores render textures bottom-up in GL memory (probed once). */
  private flippedProbe: boolean | null = null;
  private renderTargetFlipped(): boolean {
    if (this.flippedProbe !== null) return this.flippedProbe;
    // Draw a 1×2 target whose top row is opaque and bottom transparent, then see which GL row holds it.
    const rt = RenderTexture.create({ width: 1, height: 2, format: 'rgba8unorm', antialias: false, resolution: 1 });
    const source = new TextureSource({ width: 1, height: 2, format: 'rgba8unorm' });
    this.uploadWhole(source, new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]), 1, 2, 4);
    this.run(this.pass('stack'), rt, 1, 2, {
      uBackdrop: source, uSurface: this.white, uBase: this.transparentSource(), uClip: this.white,
    }, { uHasClip: 0, uMode: 0 });
    const gl = this.gl;
    this.renderer.renderTarget.bind({ target: rt, clear: false });
    const pixels = new Uint8Array(8);
    gl.readPixels(0, 0, 1, 2, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.destroyTarget(rt);
    this.destroySource(source);
    this.flippedProbe = pixels[3] === 0;
    return this.flippedProbe;
  }
}

/** LayerMask.background: white when most of the mask's edge is light, else black. */
const backgroundCache = new WeakMap<Raster, number>();
export function maskBackground(raster: Raster): number {
  const cached = backgroundCache.get(raster);
  if (cached !== undefined) return cached;
  let total = 0, count = 0;
  const { width, height } = raster;
  const add = (x: number, y: number) => { total += raster.pixel(x, y)[0]!; count++; };
  for (let x = 0; x < width; x++) { add(x, 0); if (height > 1) add(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { add(0, y); if (width > 1) add(width - 1, y); }
  const value = total * 2 >= count * 255 ? 1 : 0;
  backgroundCache.set(raster, value);
  return value;
}

function chunkKey(col: number, row: number): string { return `${col}:${row}`; }

function parseChunkKey(key: string): [number, number] {
  const separator = key.indexOf(':');
  return [Number(key.slice(0, separator)), Number(key.slice(separator + 1))];
}

/** Contiguous pixels with coordinates beyond the raster repeated from its outermost texels. */
function readClamped(raster: Raster, x: number, y: number, width: number, height: number): PixelArray {
  const ch = raster.channels;
  const sx0 = Math.max(0, x), sy0 = Math.max(0, y);
  const sx1 = Math.min(raster.width, x + width), sy1 = Math.min(raster.height, y + height);
  const sourceWidth = sx1 - sx0, sourceHeight = sy1 - sy0;
  const source = raster.readRegionNative(sx0, sy0, sourceWidth, sourceHeight);
  const out = makePixelArray(raster.format, width * height * ch);
  const left = sx0 - x;
  for (let dy = 0; dy < height; dy++) {
    const sy = Math.max(0, Math.min(sourceHeight - 1, y + dy - sy0));
    const src = sy * sourceWidth * ch;
    const dst = dy * width * ch;
    out.set(source.subarray(src, src + sourceWidth * ch), dst + left * ch);
    for (let dx = 0; dx < left; dx++) out.set(source.subarray(src, src + ch), dst + dx * ch);
    const last = src + (sourceWidth - 1) * ch;
    for (let dx = left + sourceWidth; dx < width; dx++) out.set(source.subarray(last, last + ch), dst + dx * ch);
  }
  return out;
}

function mipBytes(width: number, height: number, channels: 1 | 4, bytesPerSample = 1): number {
  let bytes = 0;
  while (true) {
    bytes += width * height * channels * bytesPerSample;
    if (width === 1 && height === 1) return bytes;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  }
}

/** DownsampleCache.level: no halving at half-size or above, at most six below it. */
function sharpMipLevel(targetPixelsPerGridPixel: number): number {
  return Number.isFinite(targetPixelsPerGridPixel) && targetPixelsPerGridPixel > 0 && targetPixelsPerGridPixel < 0.5
    ? Math.min(6, Math.floor(Math.log2(1 / targetPixelsPerGridPixel))) : 0;
}

function affineBounds(transform: Affine, rect: Rect): Rect {
  const points = [
    apply(transform, { x: rect.x, y: rect.y }), apply(transform, { x: rect.x + rect.width, y: rect.y }),
    apply(transform, { x: rect.x, y: rect.y + rect.height }),
    apply(transform, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function unionMaybe(a: Rect | null, b: Rect | null): Rect | null {
  return b ? unionRect(a, b) : a;
}

function sameView(a: ViewSpec, b: ViewSpec): boolean {
  return a.width === b.width && a.height === b.height && a.scale === b.scale && a.snap === b.snap
    && a.viewToDoc.a === b.viewToDoc.a && a.viewToDoc.b === b.viewToDoc.b
    && a.viewToDoc.c === b.viewToDoc.c && a.viewToDoc.d === b.viewToDoc.d
    && a.viewToDoc.tx === b.viewToDoc.tx && a.viewToDoc.ty === b.viewToDoc.ty;
}

function sameVisualState(a: CompositeVisualState, b: CompositeVisualState): boolean {
  return sameValues(a.documentValues, b.documentValues) && sameValues(a.layerValues, b.layerValues);
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (!Object.is(a[index], b[index])) return false;
  return true;
}

function cloneView(view: ViewSpec): ViewSpec {
  return { ...view, viewToDoc: { ...view.viewToDoc } };
}

function makeUnorm16ToHalf(): Uint16Array {
  const table = new Uint16Array(65536);
  for (let sample = 1; sample < 65536; sample++) {
    const value = sample / 65535;
    if (value < 2 ** -14) table[sample] = Math.round(value * 2 ** 24);
    else {
      let exponent = Math.floor(Math.log2(value));
      let mantissa = Math.round((value / 2 ** exponent - 1) * 1024);
      if (mantissa === 1024) { exponent++; mantissa = 0; }
      table[sample] = ((exponent + 15) << 10) | mantissa;
    }
  }
  return table;
}

function byteLut(data: Float32Array): Uint8Array {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = Math.round(Math.min(1, Math.max(0, data[i]!)) * 255);
  return bytes;
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function expandedBrushBounds(chunk: BrushChunk): Rect | null {
  return chunk.bounds;
}

export { storedMaskTransform };
