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

import { adjustmentProgram } from './adjustPrograms';
import {
  Mesh, MeshGeometry, RenderTexture, Shader, State, Texture, TextureSource, WebGLRenderer,
} from 'pixi.js';
import {
  ancestorIds, maskTransform as storedMaskTransform, renderLayers, type BlendMode, type CanvasDocument, type Layer,
} from '../core/document';
import { apply, concat, invert, pixelToDocument, type Affine, type LayerTransform, type Rect } from '../core/geometry';
import { TILE, type Raster } from '../core/raster';
import type { BrushSegment, GpuBrushPreview } from '../core/brush';
import {
  adjustFragment, BLEND_INDEX, BRUSH_COVERAGE_FRAGMENT, BRUSH_MASK_FRAGMENT, BRUSH_MAX_FRAGMENT, BRUSH_PAINT_FRAGMENT, COVERAGE_FRAGMENT,
  IDENTITY_ADJUST, LAYER_FRAGMENT, MASK_FRAGMENT, OPAQUE_FRAGMENT, PRESENT_FRAGMENT, STACK_FRAGMENT,
  UNPREMULTIPLY_FRAGMENT, VERTEX,
} from './shaders';

export interface CompositeHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  blendMode(layer: Layer): BlendMode;
  /** Pixels to draw instead of the stored raster (brush stroke in progress, previews). */
  raster(layer: Layer): Raster | null;
  maskRaster(layer: Layer): Raster | null;
  /** Geometry-only ordinary Brush/Eraser preview; clone and selection strokes use `raster`. */
  readonly brush?: GpuBrushPreview | null;
}

export const DEFAULT_HOOKS: CompositeHooks = {
  transform: (l) => l.transform,
  maskPlacement: (l) => l.mask?.placement ?? null,
  blendMode: (l) => l.blendMode,
  raster: (l) => l.raster,
  maskRaster: (l) => l.mask?.raster ?? null,
};

/** Maps target pixels to document pixels. */
export interface ViewSpec {
  readonly width: number;
  readonly height: number;
  readonly viewToDoc: Affine;
  /** Target pixels per document pixel (for edge antialiasing and mip selection). */
  readonly scale: number;
  /** Show whole document pixels hard-edged (zoom ≥ 200%, EditorCanvas.crispZoom). */
  readonly snap: boolean;
}

/** GLSL for one adjustment kind plus how to fill its uniforms. Provided by the adjustment module. */
export interface AdjustmentProgram {
  readonly key: string;
  readonly glsl: string;
  params(layer: Layer): Float32Array; // up to 8 vec4
  lut?(layer: Layer): { data: Uint8Array; width: number; height: number } | null;
}
export type AdjustmentProgramProvider = (layer: Layer) => AdjustmentProgram | null;

type Uniforms = Record<string, { value: unknown; type: string; size?: number }>;

interface Pass {
  shader: Shader;
  uniforms: { uniforms: Record<string, unknown>; update(): void };
}

interface Slot {
  raster: Raster;
  chunks: Map<string, TextureChunk>;
  lastUsed: number;
}

interface TextureChunk {
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly source: TextureSource;
  readonly bytes: number;
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
  bounds: Rect | null;
}

interface BrushGpuState {
  readonly preview: GpuBrushPreview;
  readonly chunks: Map<string, BrushChunk>;
  applied: number;
  revision: number;
  tailKeys: Set<string>;
}

// A 64 px margin leaves one neighbour texel at the deepest supported sharp halving (level 6).
// TiledLayerRenderer.support grows its piece margin for the same reason.
const CHUNK_APRON = 64;
const TARGET_CHUNK_SIZE = 4096;
const BRUSH_CHUNK_SIZE = TILE;
const BRUSH_APRON = CHUNK_APRON;

const IDENTITY9 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

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
  private readonly chunkSize: number;
  private readonly passes = new Map<string, Pass>();
  private readonly slots = new Map<string, Slot>();
  private readonly pool: RenderTexture[] = [];
  private readonly inUse = new Set<RenderTexture>();
  private frame = 0;
  private readonly white: TextureSource;
  private lutSources = new Map<string, TextureSource>();
  private brushState: BrushGpuState | null = null;
  /** The LUT bytes last uploaded per layer, so an unchanged adjustment is not re-uploaded every frame. */
  private lutUploaded = new Map<string, Uint8Array>();
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
    return new GpuCompositor(renderer);
  }

  destroy(): void {
    for (const slot of this.slots.values()) for (const chunk of slot.chunks.values()) chunk.source.destroy();
    this.slots.clear();
    for (const rt of this.pool) rt.destroy(true);
    for (const rt of this.inUse) rt.destroy(true);
    for (const lut of this.lutSources.values()) lut.destroy();
    this.destroyBrushState();
    this.mesh.destroy();
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

  resize(width: number, height: number): void {
    if (this.renderer.width !== width || this.renderer.height !== height) this.renderer.resize(width, height);
  }

  // MARK: Passes

  private pass(name: string, fragment?: string): Pass {
    const existing = this.passes.get(name);
    if (existing) return existing;
    const sources: Record<string, [string, Uniforms, string[]]> = {
      layer: [LAYER_FRAGMENT, {
        uTarget: { value: new Float32Array(2), type: 'vec2<f32>' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToLayer: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
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
        uOpacity: { value: 1, type: 'f32' },
        uMode: { value: 0, type: 'i32' },
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
        uErase: { value: 0, type: 'i32' }, uColor: { value: new Float32Array(3), type: 'vec3<f32>' },
        uOpacity: { value: 1, type: 'f32' },
      }, ['uBase', 'uPermanent', 'uTail']],
      brushMax: [BRUSH_MAX_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uFirst', 'uSecond']],
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
      opaque: [OPAQUE_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uSource']],
      stack: [STACK_FRAGMENT, {
        uHasClip: { value: 0, type: 'i32' },
        uMode: { value: 0, type: 'i32' },
      }, ['uBackdrop', 'uSurface', 'uBase', 'uClip']],
      unpremultiply: [UNPREMULTIPLY_FRAGMENT, { uUnused: { value: 0, type: 'f32' } }, ['uSource']],
      present: [PRESENT_FRAGMENT, {
        uCanvasRect: { value: new Float32Array(4), type: 'vec4<f32>' },
        uPointScale: { value: 1, type: 'f32' },
        uGrid: { value: 0, type: 'i32' },
        uPixelSize: { value: 1, type: 'f32' },
        uHasComposite: { value: 0, type: 'i32' },
        uCompositeOrigin: { value: new Float32Array(2), type: 'vec2<f32>' },
        uCompositeSize: { value: new Float32Array(2), type: 'vec2<f32>' },
      }, ['uComposite']],
    };
    let spec = sources[name];
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
    for (const [key, value] of Object.entries(uniforms)) {
      const current = pass.uniforms.uniforms[key];
      if (current instanceof Float32Array && value instanceof Float32Array) current.set(value);
      else pass.uniforms.uniforms[key] = value;
    }
    pass.uniforms.update();
    for (const [key, source] of Object.entries(textures)) (pass.shader.resources as Record<string, unknown>)[key] = source;
    this.mesh.shader = pass.shader;
    this.mesh.position.set(rect?.x ?? 0, rect?.y ?? 0);
    this.mesh.scale.set(rect?.width ?? width, rect?.height ?? height);
    this.renderer.render({ container: this.mesh, target: target ?? undefined, clear: false });
  }

  // MARK: Render targets

  private acquire(width: number, height: number): RenderTexture {
    const index = this.pool.findIndex((rt) => rt.width === width && rt.height === height);
    const rt = index >= 0 ? this.pool.splice(index, 1)[0]! : RenderTexture.create({
      width, height, format: this.floatTargets ? 'rgba16float' : 'rgba8unorm', antialias: false, resolution: 1,
    });
    this.inUse.add(rt);
    return rt;
  }
  private release(rt: RenderTexture | null | undefined): void {
    if (!rt || !this.inUse.has(rt)) return;
    this.inUse.delete(rt);
    this.pool.push(rt);
    while (this.pool.length > 12) this.pool.shift()!.destroy(true);
  }
  private clear(rt: RenderTexture): void {
    this.renderer.renderTarget.bind({ target: rt, clear: true, clearColor: [0, 0, 0, 0] });
  }

  // MARK: Textures

  private uploadWhole(source: TextureSource, data: Uint8Array, width: number, height: number, channels: 1 | 4): void {
    const gl = this.gl;
    this.renderer.texture.bindSource(source, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, channels === 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, channels === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, data);
    this.restoreUnpack();
  }

  private restoreUnpack(): void {
    const system = this.renderer.texture as unknown as { _premultiplyAlpha: boolean };
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, system._premultiplyAlpha);
  }

  /**
   * Sparse chunk textures for a raster, uploading only changed tiles and neighbouring aprons.
   * Mirrors TiledLayerRenderer.piece: disjoint interiors sample a surrounding margin so they meet.
   */
  private texture(slotKey: string, raster: Raster): Slot {
    const gl = this.gl;
    const existing = this.slots.get(slotKey);
    if (existing && existing.raster === raster) { existing.lastUsed = this.frame; return existing; }
    const compatible = existing && existing.raster.width === raster.width && existing.raster.height === raster.height
      && existing.raster.channels === raster.channels;
    let slot: Slot;
    if (compatible) {
      slot = existing!;
    } else {
      if (existing) for (const chunk of existing.chunks.values()) chunk.source.destroy();
      slot = { raster, chunks: new Map(), lastUsed: this.frame };
      this.slots.set(slotKey, slot);
    }
    const previous = compatible ? existing!.raster : null;
    const desired = new Set<string>();
    for (let row = 0; row < raster.rows; row++) for (let col = 0; col < raster.cols; col++) {
      if (raster.tiles[row * raster.cols + col]) desired.add(chunkKey(Math.floor(col * TILE / this.chunkSize), Math.floor(row * TILE / this.chunkSize)));
    }
    for (const [key, chunk] of slot.chunks) {
      if (!desired.has(key)) { chunk.source.destroy(); slot.chunks.delete(key); }
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
        width: textureWidth, height: textureHeight, format: raster.channels === 4 ? 'rgba8unorm' : 'r8unorm', mipLevelCount: mips,
        autoGenerateMipmaps: false, scaleMode: 'linear', mipmapFilter: 'linear', addressMode: 'clamp-to-edge', maxAnisotropy: 1,
      });
      const chunk: TextureChunk = { col, row, x, y, width, height, source,
        bytes: mipBytes(textureWidth, textureHeight, raster.channels) };
      slot.chunks.set(key, chunk);
      this.renderer.texture.bindSource(source, 0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, textureWidth, textureHeight,
        raster.channels === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE,
        readClamped(raster, x - CHUNK_APRON, y - CHUNK_APRON, textureWidth, textureHeight));
      gl.generateMipmap(gl.TEXTURE_2D);
      created.add(key);
    }

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
        if (desired.has(key) && !created.has(key)) affected.add(key);
      }
    }
    const format = raster.channels === 4 ? gl.RGBA : gl.RED;
    const bulk = changed.length > Math.max(32, affected.size * 12);
    for (const key of affected) {
      const chunk = slot.chunks.get(key)!;
      this.renderer.texture.bindSource(chunk.source, 0);
      if (bulk) {
        const tw = chunk.width + CHUNK_APRON * 2, th = chunk.height + CHUNK_APRON * 2;
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, format, gl.UNSIGNED_BYTE,
          readClamped(raster, chunk.x - CHUNK_APRON, chunk.y - CHUNK_APRON, tw, th));
      } else {
        for (const index of changed) {
          const tileCol = index % raster.cols, tileRow = Math.floor(index / raster.cols);
          const tx = tileCol * TILE, ty = tileRow * TILE;
          const x0 = Math.max(tx, chunk.x), y0 = Math.max(ty, chunk.y);
          const x1 = Math.min(tx + raster.tileWidth(tileCol), chunk.x + chunk.width);
          const y1 = Math.min(ty + raster.tileHeight(tileRow), chunk.y + chunk.height);
          if (x1 <= x0 || y1 <= y0) continue;
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x0 - chunk.x + CHUNK_APRON, y0 - chunk.y + CHUNK_APRON, x1 - x0, y1 - y0,
            format, gl.UNSIGNED_BYTE, raster.readRegion(x0, y0, x1 - x0, y1 - y0));
        }
        this.uploadAprons(chunk, raster, format);
      }
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    this.restoreUnpack();
    slot.raster = raster;
    slot.lastUsed = this.frame;
    return slot;
  }

  private uploadAprons(chunk: TextureChunk, raster: Raster, format: number): void {
    const gl = this.gl, tw = chunk.width + CHUNK_APRON * 2, th = chunk.height + CHUNK_APRON * 2;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, CHUNK_APRON, format, gl.UNSIGNED_BYTE,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y - CHUNK_APRON, tw, CHUNK_APRON));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, th - CHUNK_APRON, tw, CHUNK_APRON, format, gl.UNSIGNED_BYTE,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y + chunk.height, tw, CHUNK_APRON));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, CHUNK_APRON, CHUNK_APRON, chunk.height, format, gl.UNSIGNED_BYTE,
      readClamped(raster, chunk.x - CHUNK_APRON, chunk.y, CHUNK_APRON, chunk.height));
    gl.texSubImage2D(gl.TEXTURE_2D, 0, tw - CHUNK_APRON, CHUNK_APRON, CHUNK_APRON, chunk.height, format, gl.UNSIGNED_BYTE,
      readClamped(raster, chunk.x + chunk.width, chunk.y, CHUNK_APRON, chunk.height));
  }

  /** Drops textures of layers not drawn for a while. */
  private collectTextures(): void {
    for (const [key, slot] of this.slots) {
      if (this.frame - slot.lastUsed > 120) {
        for (const chunk of slot.chunks.values()) chunk.source.destroy();
        this.slots.delete(key);
      }
    }
  }

  // MARK: Active brush coverage

  private destroyBrushState(): void {
    if (!this.brushState) return;
    const sources = new Set<TextureSource>();
    for (const chunk of this.brushState.chunks.values()) {
      for (const target of [chunk.permanent, chunk.alternate, chunk.scratch, chunk.tail, chunk.painted]) {
        sources.add(target.source);
      }
    }
    for (const pass of this.passes.values()) {
      const resources = pass.shader.resources as Record<string, unknown>;
      for (const [key, resource] of Object.entries(resources)) if (sources.has(resource as TextureSource)) resources[key] = this.white;
    }
    for (const chunk of this.brushState.chunks.values()) {
      chunk.permanent.destroy(true);
      chunk.alternate.destroy(true);
      chunk.scratch.destroy(true);
      chunk.tail.destroy(true);
      chunk.painted.destroy(true);
    }
    this.brushState = null;
  }

  private brushChunk(state: BrushGpuState, key: string): BrushChunk {
    const existing = state.chunks.get(key);
    if (existing) return existing;
    const [col, row] = parseChunkKey(key);
    const x = col * BRUSH_CHUNK_SIZE, y = row * BRUSH_CHUNK_SIZE;
    const width = Math.min(BRUSH_CHUNK_SIZE, state.preview.width - x);
    const height = Math.min(BRUSH_CHUNK_SIZE, state.preview.height - y);
    const textureWidth = width + BRUSH_APRON * 2, textureHeight = height + BRUSH_APRON * 2;
    const format = this.floatTargets ? 'rgba16float' : 'rgba8unorm';
    const permanent = RenderTexture.create({ width: textureWidth, height: textureHeight, format, antialias: false, resolution: 1 });
    const alternate = RenderTexture.create({ width: textureWidth, height: textureHeight, format, antialias: false, resolution: 1 });
    const scratch = RenderTexture.create({ width: textureWidth, height: textureHeight, format, antialias: false, resolution: 1 });
    const tail = RenderTexture.create({ width: textureWidth, height: textureHeight, format, antialias: false, resolution: 1 });
    const painted = RenderTexture.create({ width: textureWidth, height: textureHeight,
      format: this.floatTargets ? 'rgba16float' : 'rgba8unorm',
      mipLevelCount: Math.floor(Math.log2(Math.max(textureWidth, textureHeight))) + 1,
      autoGenerateMipmaps: false, antialias: false, resolution: 1 });
    const chunk = { col, row, x, y, width, height, permanent, alternate, scratch, tail, painted, bounds: null };
    state.chunks.set(key, chunk);
    this.clear(permanent); this.clear(alternate); this.clear(scratch); this.clear(tail); this.clear(painted);
    return chunk;
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
      this.brushState = { preview, chunks: new Map(), applied: 0, revision: -1, tailKeys: new Set() };
    }
    const state = this.brushState;
    if (state.revision === preview.revision) return state;
    const changed = new Set<string>();
    while (state.applied < preview.settled.length) {
      const segment = preview.settled[state.applied++]!;
      for (const key of this.brushKeys(preview, segment)) {
        const chunk = this.brushChunk(state, key);
        if (preview.settings.hardness >= 1) this.accumulateHardSegment(preview, chunk, segment);
        else this.renderBrushSegment(chunk.permanent, preview, chunk, segment);
        changed.add(key);
      }
    }
    const nextTail = new Set<string>();
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
    for (const key of changed) this.paintBrushChunk(preview, this.brushChunk(state, key));
    state.revision = preview.revision;
    return state;
  }

  private paintBrushChunk(preview: GpuBrushPreview, chunk: BrushChunk): void {
    const source = preview.source;
    let baseSource = this.transparentSource();
    let baseOriginX = 0, baseOriginY = 0, baseApron = 0, baseWidth = 1, baseHeight = 1, hasBase = 0;
    if (source) {
      const slot = this.texture(`${preview.target === 'mask' ? 'mask' : 'px'}:${preview.layerId}`, source);
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
    }, {
      uGridOrigin: new Float32Array([chunk.x - BRUSH_APRON, chunk.y - BRUSH_APRON]),
      uGridSize: new Float32Array([preview.width, preview.height]),
      uSourceRect: new Float32Array([preview.sourceRect.x, preview.sourceRect.y,
        preview.sourceRect.width, preview.sourceRect.height]),
      uSourceSize: new Float32Array([source?.width ?? 1, source?.height ?? 1]),
      uBaseOrigin: new Float32Array([baseOriginX, baseOriginY]),
      uBaseTextureSize: new Float32Array([baseWidth, baseHeight]), uBaseApron: baseApron, uHasBase: hasBase,
      uMask: preview.target === 'mask' ? 1 : 0, uHard: preview.settings.hardness >= 1 ? 1 : 0,
      uErase: preview.settings.mode === 'erase' ? 1 : 0,
      uColor: new Float32Array([preview.settings.red, preview.settings.green, preview.settings.blue]),
      uOpacity: preview.settings.opacity,
    });
    this.renderer.texture.bindSource(chunk.painted.source, 0);
    this.gl.generateMipmap(this.gl.TEXTURE_2D);
  }

  // MARK: Compositing

  /**
   * Composites `document` into a new render texture of the view's size. The caller releases it
   * with `releaseTarget`.
   */
  composite(document: CanvasDocument, view: ViewSpec, hooks: CompositeHooks = DEFAULT_HOOKS): RenderTexture {
    this.frame++;
    this.skippedAdjustments = 0;
    const { width, height } = view;
    let acc = this.acquire(width, height);
    this.clear(acc);
    const byId = new Map(document.layers.map((l) => [l.id, l]));
    const activeBrush = hooks.brush ?? null;
    if (!activeBrush) this.destroyBrushState();
    const ids = renderLayers(document.layers).filter((l) => hooks.raster(l) || activeBrush?.layerId === l.id || l.adjustment)
      .map((l) => l.id);
    const stacks = new Map<string, string[]>();
    const stacked = new Set<string>();
    ids.forEach((base, index) => {
      const layer = byId.get(base)!;
      if (layer.maskSourceId || layer.adjustment) return;
      const children: string[] = [];
      for (const child of ids.slice(index + 1)) {
        const c = byId.get(child)!;
        if (c.maskSourceId !== base || c.parentId !== layer.parentId) break;
        children.push(child);
      }
      if (children.length) { stacks.set(base, children); for (const c of children) stacked.add(c); }
    });
    const folderClips = new Map<string, RenderTexture | null>();
    const liveCoverage = new Map<string, RenderTexture | null>();
    const temporaries: RenderTexture[] = [];

    const folderClip = (id: string): RenderTexture | null => {
      const folders = ancestorIds(document.layers, id).map((f) => byId.get(f)!).filter((f) => f?.mask?.enabled);
      if (!folders.length) return null;
      const key = folders.map((f) => f.id).join('/');
      if (folderClips.has(key)) return folderClips.get(key)!;
      let clip: RenderTexture | null = null;
      for (const folder of folders) {
        const raster = hooks.maskRaster(folder);
        if (!raster) continue;
        clip = this.multiplyMask(clip, raster, `mask:${folder.id}`, hooks.transform(folder), view, temporaries);
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

    for (const id of ids) {
      if (stacked.has(id)) continue;
      const layer = byId.get(id)!;
      const clip = folderClip(id);
      if (layer.adjustment) {
        if (layer.maskSourceId) continue;
        const next = this.adjust(acc, layer, view, hooks, this.adjustmentClip(layer, clip, view, hooks, temporaries));
        this.release(acc);
        acc = next;
        continue;
      }
      const children = stacks.get(id);
      if (children) {
        const next = this.drawStack(acc, layer, children.map((c) => byId.get(c)!), view, hooks, clip, temporaries);
        this.release(acc);
        acc = next;
        continue;
      }
      let combined = clip;
      if (layer.maskSourceId) {
        const live = coverageOf(layer.maskSourceId, 1);
        if (!live) continue;
        combined = clip ? this.multiplyTargets(clip, live, view, temporaries) : live;
      }
      const next = this.drawLayer(acc, layer, view, hooks, combined, hooks.blendMode(layer));
      this.release(acc);
      acc = next;
    }
    for (const t of temporaries) this.release(t);
    if (this.frame % 60 === 0) this.collectTextures();
    return acc;
  }

  releaseTarget(rt: RenderTexture): void { this.release(rt); }

  private layerUniforms(raster: Pick<Raster, 'width' | 'height'>, transform: LayerTransform, view: ViewSpec) {
    const docToGrid = invert(pixelToDocument(transform, raster.width, raster.height));
    // Target px per grid px along each local axis, for edge AA and mip choice.
    const gx = Math.hypot(transform.size.width / raster.width, 0) * (view.snap ? 1 : view.scale);
    const gy = Math.hypot(transform.size.height / raster.height, 0) * (view.snap ? 1 : view.scale);
    const mipLevel = sharpMipLevel(gx);
    const nearest = transform.sampling === 'Nearest';
    return {
      uDocToLayer: mat3(docToGrid),
      uLayerSize: new Float32Array([raster.width, raster.height]),
      uLayerEdge: new Float32Array([gx, gy]),
      uSampling: nearest ? 0 : (mipLevel > 0 ? 2 : 1),
      uMipLevel: mipLevel,
    };
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

  /** One layer pass onto `backdrop` → a new target. */
  private drawLayer(backdrop: RenderTexture, layer: Layer, view: ViewSpec, hooks: CompositeHooks, clip: RenderTexture | null,
    mode: BlendMode, replace = false): RenderTexture {
    const raster = hooks.raster(layer);
    const brush = hooks.brush?.layerId === layer.id ? hooks.brush : null;
    const brushState = brush ? this.prepareBrush(brush) : null;
    const pixelBrush = brush?.target === 'pixels' ? brush : null;
    const out = this.acquire(view.width, view.height);
    let maskTarget: RenderTexture | null = null;
    const maskRaster = layer.mask?.enabled ? hooks.maskRaster(layer) : null;
    if (layer.mask && maskRaster) {
      const placement = hooks.maskPlacement(layer);
      const maskPlace = placement ?? hooks.transform(layer);
      maskTarget = this.renderMask(null, maskRaster, `mask:${layer.id}`, maskPlace, view,
        placement ? maskBackground(maskRaster) : 0);
    }
    if (brush?.target === 'mask' && brushState && maskTarget) {
      const paintedMask = this.overlayBrushMask(maskTarget, brush, brushState, view);
      this.release(maskTarget);
      maskTarget = paintedMask;
    }

    if (!raster) this.copy(backdrop, out, view);
    else {
      const transform = hooks.transform(layer);
      const slot = this.texture(`px:${layer.id}`, raster);
      const u = this.layerUniforms(raster, transform, view);
      const restricted = slot.chunks.size > 1;
      if (!slot.chunks.size || restricted) this.copy(backdrop, out, view);
      const gridToDoc = pixelToDocument(transform, raster.width, raster.height);
      for (const chunk of slot.chunks.values()) {
        const rect = restricted
          ? this.gridRect(chunk.x, chunk.y, chunk.width, chunk.height, gridToDoc, view)
          : { x: 0, y: 0, width: view.width, height: view.height };
        if (!rect) continue;
        this.run(this.pass('layer'), out, view.width, view.height, {
          uBackdrop: backdrop.source, uLayer: chunk.source, uMask: maskTarget?.source ?? this.white,
          uClip: clip?.source ?? this.white,
        }, {
          uTarget: new Float32Array([view.width, view.height]), uViewToDoc: mat3(view.viewToDoc),
          uDocToLayer: u.uDocToLayer, uLayerSize: u.uLayerSize, uLayerEdge: u.uLayerEdge, uSampling: u.uSampling,
          uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
          uTextureSize: new Float32Array([chunk.width + CHUNK_APRON * 2, chunk.height + CHUNK_APRON * 2]), uApron: CHUNK_APRON,
          uMipLevel: u.uMipLevel, uRestrictChunk: restricted ? 1 : 0,
          uRestrictBounds: 0,
          uOpacity: layer.opacity, uMode: BLEND_INDEX[mode] ?? 0, uHasMask: maskTarget ? 1 : 0,
          uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0, uReplace: replace ? 1 : 0,
        }, rect);
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
          uDocToLayer: u.uDocToLayer, uLayerSize: u.uLayerSize, uLayerEdge: u.uLayerEdge, uSampling: u.uSampling,
          uChunkOrigin: new Float32Array([chunk.x, chunk.y]), uChunkSize: new Float32Array([chunk.width, chunk.height]),
          uTextureSize: new Float32Array([chunk.painted.width, chunk.painted.height]), uApron: BRUSH_APRON,
          uMipLevel: u.uMipLevel, uRestrictChunk: 1,
          uRestrictBounds: 1, uDrawOrigin: new Float32Array([bounds.x, bounds.y]),
          uDrawSize: new Float32Array([bounds.width, bounds.height]),
          uOpacity: layer.opacity, uMode: BLEND_INDEX[mode] ?? 0, uHasMask: maskTarget ? 1 : 0,
          uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0, uReplace: replace ? 1 : 0,
        }, rect);
      }
    }
    this.release(maskTarget);
    return out;
  }

  private overlayBrushMask(base: RenderTexture, preview: GpuBrushPreview, state: BrushGpuState,
    view: ViewSpec): RenderTexture {
    const out = this.acquire(view.width, view.height);
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
    }, { uHasClip: 0, uMode: 0 });
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
    const slot = this.texture(slotKey, raster);
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
    const raster = layer.mask?.enabled ? hooks.maskRaster(layer) : null;
    if (!raster) return folderClip;
    return this.multiplyMask(folderClip, raster, `mask:${layer.id}`, hooks.transform(layer), view, temporaries);
  }

  private adjust(backdrop: RenderTexture, layer: Layer, view: ViewSpec, hooks: CompositeHooks, clip: RenderTexture | null): RenderTexture {
    const program = this.adjustmentPrograms(layer);
    if (!program) this.skippedAdjustments++;
    const key = program ? `adjust:${program.key}` : 'adjust:identity';
    const pass = this.pass(key, adjustFragment(program?.glsl ?? IDENTITY_ADJUST));
    const out = this.acquire(view.width, view.height);
    let lut: TextureSource = this.white;
    const lutData = program?.lut?.(layer);
    if (lutData) {
      const lutKey = `${layer.id}`;
      let source = this.lutSources.get(lutKey);
      if (!source || source.width !== lutData.width || source.height !== lutData.height) {
        source?.destroy();
        this.lutUploaded.delete(lutKey);
        source = new TextureSource({ width: lutData.width, height: lutData.height, format: 'rgba8unorm',
          scaleMode: 'linear', addressMode: 'clamp-to-edge' });
        this.lutSources.set(lutKey, source);
      }
      if (this.lutUploaded.get(lutKey) !== lutData.data) {
        this.renderer.texture.bindSource(source, 0);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, lutData.width, lutData.height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, lutData.data);
        this.restoreUnpack();
        this.lutUploaded.set(lutKey, lutData.data);
      }
      lut = source;
    }
    this.run(pass, out, view.width, view.height, { uBackdrop: backdrop.source, uClip: clip?.source ?? this.white, uLut: lut }, {
      uHasClip: clip ? 1 : 0, uMode: BLEND_INDEX[hooks.blendMode(layer)] ?? 0, uOpacity: layer.opacity,
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
    this.run(this.pass('stack'), out, view.width, view.height, {
      uBackdrop: backdrop.source, uSurface: surface.source, uBase: baseAlone.source, uClip: clip?.source ?? this.white,
    }, { uHasClip: clip ? 1 : 0, uMode: BLEND_INDEX[hooks.blendMode(base)] ?? 0 });
    this.release(surface);
    return out;
  }

  // MARK: Presentation and readback

  /** Draws the workspace, canvas rectangle, checkerboard and composite to the screen canvas. */
  present(composite: RenderTexture | null, width: number, height: number, canvasRect: { x: number; y: number; width: number; height: number },
    pointScale: number, grid: boolean, pixelSize: number, compositeOrigin: { x: number; y: number } = { x: 0, y: 0 }): void {
    this.resize(width, height);
    this.run(this.pass('present'), null, width, height, { uComposite: composite?.source ?? this.white }, {
      uCanvasRect: new Float32Array([canvasRect.x, canvasRect.y, canvasRect.width, canvasRect.height]),
      uPointScale: pointScale, uGrid: grid ? 1 : 0, uPixelSize: pixelSize, uHasComposite: composite ? 1 : 0,
      uCompositeOrigin: new Float32Array([compositeOrigin.x, compositeOrigin.y]),
      uCompositeSize: new Float32Array([composite?.width ?? 0, composite?.height ?? 0]),
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
        this.release(rt);
        const pixels = this.readPixels(straight, w, h);
        straight.destroy(true);
        for (let row = 0; row < h; row++) {
          out.set(pixels.subarray(row * w * 4, (row + 1) * w * 4), ((ty + row) * width + tx) * 4);
        }
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
    rt.destroy(true);
    source.destroy();
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
function readClamped(raster: Raster, x: number, y: number, width: number, height: number): Uint8Array {
  const ch = raster.channels;
  const sx0 = Math.max(0, x), sy0 = Math.max(0, y);
  const sx1 = Math.min(raster.width, x + width), sy1 = Math.min(raster.height, y + height);
  const sourceWidth = sx1 - sx0, sourceHeight = sy1 - sy0;
  const source = raster.readRegion(sx0, sy0, sourceWidth, sourceHeight);
  const out = new Uint8Array(width * height * ch);
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

function mipBytes(width: number, height: number, channels: 1 | 4): number {
  let bytes = 0;
  while (true) {
    bytes += width * height * channels;
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
