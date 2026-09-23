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
import { concat, invert, pixelToDocument, type Affine, type LayerTransform } from '../core/geometry';
import { TILE, type Raster } from '../core/raster';
import {
  adjustFragment, BLEND_INDEX, COVERAGE_FRAGMENT, IDENTITY_ADJUST, LAYER_FRAGMENT, OPAQUE_FRAGMENT, PRESENT_FRAGMENT,
  STACK_FRAGMENT, UNPREMULTIPLY_FRAGMENT, VERTEX,
} from './shaders';

export interface CompositeHooks {
  transform(layer: Layer): LayerTransform;
  maskPlacement(layer: Layer): LayerTransform | null;
  blendMode(layer: Layer): BlendMode;
  /** Pixels to draw instead of the stored raster (brush stroke in progress, previews). */
  raster(layer: Layer): Raster | null;
  maskRaster(layer: Layer): Raster | null;
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
  source: TextureSource;
  /** Grid pixels per texture pixel when the raster exceeds the maximum texture size. */
  reduction: number;
  lastUsed: number;
}

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
  private readonly passes = new Map<string, Pass>();
  private readonly slots = new Map<string, Slot>();
  private readonly pool: RenderTexture[] = [];
  private readonly inUse = new Set<RenderTexture>();
  private frame = 0;
  private readonly white: TextureSource;
  private lutSources = new Map<string, TextureSource>();
  /** The LUT bytes last uploaded per layer, so an unchanged adjustment is not re-uploaded every frame. */
  private lutUploaded = new Map<string, Uint8Array>();
  adjustmentPrograms: AdjustmentProgramProvider = adjustmentProgram;
  /** Adjustment layers drawn without a GPU implementation in the last composite. */
  skippedAdjustments = 0;

  private constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.gl = renderer.gl as WebGL2RenderingContext;
    this.maxTextureSize = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
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
    for (const slot of this.slots.values()) slot.source.destroy();
    this.slots.clear();
    for (const rt of this.pool) rt.destroy(true);
    for (const rt of this.inUse) rt.destroy(true);
    for (const lut of this.lutSources.values()) lut.destroy();
    this.mesh.destroy();
    this.white.destroy();
    this.renderer.destroy();
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
        uSampling: { value: 1, type: 'i32' },
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
      coverage: [COVERAGE_FRAGMENT, {
        uKind: { value: 0, type: 'i32' },
        uHasPrevious: { value: 0, type: 'i32' },
        uViewToDoc: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uDocToMask: { value: new Float32Array(IDENTITY9), type: 'mat3x3<f32>' },
        uMaskSize: { value: new Float32Array(2), type: 'vec2<f32>' },
        uMaskEdge: { value: new Float32Array(2), type: 'vec2<f32>' },
        uSnap: { value: 0, type: 'i32' },
      }, ['uPrevious', 'uSource']],
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
    uniforms: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(uniforms)) {
      const current = pass.uniforms.uniforms[key];
      if (current instanceof Float32Array && value instanceof Float32Array) current.set(value);
      else pass.uniforms.uniforms[key] = value;
    }
    pass.uniforms.update();
    for (const [key, source] of Object.entries(textures)) (pass.shader.resources as Record<string, unknown>)[key] = source;
    this.mesh.shader = pass.shader;
    this.mesh.scale.set(width, height);
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

  /** The GPU texture for a raster in `slotKey`, uploading only tiles that changed since last time. */
  private texture(slotKey: string, raster: Raster): Slot {
    const gl = this.gl;
    const existing = this.slots.get(slotKey);
    const reduction = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(raster.width, raster.height) / this.maxTextureSize)));
    if (existing && existing.raster === raster) { existing.lastUsed = this.frame; return existing; }
    const width = Math.ceil(raster.width / reduction), height = Math.ceil(raster.height / reduction);
    const compatible = existing && existing.reduction === reduction && existing.raster.width === raster.width
      && existing.raster.height === raster.height && existing.raster.channels === raster.channels;
    let slot: Slot;
    if (compatible) {
      slot = existing!;
    } else {
      existing?.source.destroy();
      const mips = Math.floor(Math.log2(Math.max(width, height))) + 1;
      const source = new TextureSource({
        width, height, format: raster.channels === 4 ? 'rgba8unorm' : 'r8unorm', mipLevelCount: mips,
        autoGenerateMipmaps: false, scaleMode: 'linear', mipmapFilter: 'linear', addressMode: 'clamp-to-edge', maxAnisotropy: 1,
      });
      slot = { raster, source, reduction, lastUsed: this.frame };
      this.slots.set(slotKey, slot);
    }
    this.renderer.texture.bindSource(slot.source, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, raster.channels === 4);
    const format = raster.channels === 4 ? gl.RGBA : gl.RED;
    const previous = compatible ? existing!.raster : null;
    let changed = false;
    if (reduction === 1) {
      for (let row = 0; row < raster.rows; row++) {
        for (let col = 0; col < raster.cols; col++) {
          const index = row * raster.cols + col;
          const tile = raster.tiles[index] ?? null;
          if (previous && previous.tiles[index] === tile) continue;
          const tw = raster.tileWidth(col), th = raster.tileHeight(row);
          const data = tile ?? new Uint8Array(tw * th * raster.channels);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, col * TILE, row * TILE, tw, th, format, gl.UNSIGNED_BYTE, data);
          changed = true;
        }
      }
    } else {
      // Too large for one texture: a box-filtered reduction for display.
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.UNSIGNED_BYTE, reduceRaster(raster, reduction));
      changed = true;
    }
    if (changed || !compatible) gl.generateMipmap(gl.TEXTURE_2D);
    this.restoreUnpack();
    slot.raster = raster;
    slot.lastUsed = this.frame;
    return slot;
  }

  /** Drops textures of layers not drawn for a while. */
  private collectTextures(): void {
    for (const [key, slot] of this.slots) {
      if (this.frame - slot.lastUsed > 120) { slot.source.destroy(); this.slots.delete(key); }
    }
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
    const ids = renderLayers(document.layers).filter((l) => hooks.raster(l) || l.adjustment).map((l) => l.id);
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

  private layerUniforms(layer: Layer, raster: Raster, slot: Slot, transform: LayerTransform, view: ViewSpec) {
    const docToGrid = invert(pixelToDocument(transform, raster.width, raster.height));
    // Target px per grid px along each local axis, for edge AA and mip choice.
    const gx = Math.hypot(transform.size.width / raster.width, 0) * (view.snap ? 1 : view.scale);
    const gy = Math.hypot(transform.size.height / raster.height, 0) * (view.snap ? 1 : view.scale);
    const minified = Math.min(gx, gy) < 0.999;
    const nearest = transform.sampling === 'Nearest';
    const reduce = slot.reduction > 1 ? concat(docToGrid, { a: 1 / slot.reduction, b: 0, c: 0, d: 1 / slot.reduction, tx: 0, ty: 0 }) : docToGrid;
    return {
      uDocToLayer: mat3(reduce),
      uLayerSize: new Float32Array([Math.ceil(raster.width / slot.reduction), Math.ceil(raster.height / slot.reduction)]),
      uLayerEdge: new Float32Array([gx * slot.reduction, gy * slot.reduction]),
      uSampling: nearest ? 0 : (minified || slot.reduction > 1 ? 2 : 1),
      layer,
    };
  }

  /** One layer pass onto `backdrop` → a new target. */
  private drawLayer(backdrop: RenderTexture, layer: Layer, view: ViewSpec, hooks: CompositeHooks, clip: RenderTexture | null,
    mode: BlendMode, replace = false): RenderTexture {
    const raster = hooks.raster(layer);
    const out = this.acquire(view.width, view.height);
    if (!raster) {
      this.copy(backdrop, out, view);
      return out;
    }
    const transform = hooks.transform(layer);
    const slot = this.texture(`px:${layer.id}`, raster);
    const u = this.layerUniforms(layer, raster, slot, transform, view);
    let maskSource: TextureSource = this.white;
    const maskUniforms: Record<string, unknown> = { uHasMask: 0 };
    const maskRaster = layer.mask?.enabled ? hooks.maskRaster(layer) : null;
    if (layer.mask && maskRaster) {
      const placement = hooks.maskPlacement(layer);
      const maskPlace = placement ?? transform;
      const maskSlot = this.texture(`mask:${layer.id}`, maskRaster);
      const m = this.layerUniforms(layer, maskRaster, maskSlot, maskPlace, view);
      maskSource = maskSlot.source;
      Object.assign(maskUniforms, {
        uHasMask: 1, uDocToMask: m.uDocToLayer, uMaskSize: m.uLayerSize, uMaskEdge: m.uLayerEdge,
        uMaskSampling: m.uSampling === 0 ? 1 : m.uSampling,
        uMaskPlaced: placement ? 1 : 0, uMaskBackground: placement ? maskBackground(maskRaster) : 1,
      });
    }
    this.run(this.pass('layer'), out, view.width, view.height, {
      uBackdrop: backdrop.source, uLayer: slot.source, uMask: maskSource, uClip: clip?.source ?? this.white,
    }, {
      uTarget: new Float32Array([view.width, view.height]), uViewToDoc: mat3(view.viewToDoc),
      uDocToLayer: u.uDocToLayer, uLayerSize: u.uLayerSize, uLayerEdge: u.uLayerEdge, uSampling: u.uSampling,
      uOpacity: layer.opacity, uMode: BLEND_INDEX[mode] ?? 0, uHasClip: clip ? 1 : 0, uSnap: view.snap ? 1 : 0,
      uReplace: replace ? 1 : 0, ...maskUniforms,
    });
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
    const slot = this.texture(slotKey, raster);
    const docToGrid = invert(pixelToDocument(placement, raster.width, raster.height));
    const gx = placement.size.width / raster.width * (view.snap ? 1 : view.scale);
    const gy = placement.size.height / raster.height * (view.snap ? 1 : view.scale);
    const out = this.acquire(view.width, view.height);
    temporaries.push(out);
    this.run(this.pass('coverage'), out, view.width, view.height, {
      uPrevious: previous?.source ?? this.white, uSource: slot.source,
    }, {
      uKind: 0, uHasPrevious: previous ? 1 : 0, uViewToDoc: mat3(view.viewToDoc), uDocToMask: mat3(docToGrid),
      uMaskSize: new Float32Array([raster.width, raster.height]), uMaskEdge: new Float32Array([gx, gy]), uSnap: view.snap ? 1 : 0,
    });
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

/** Box-filtered reduction of a raster by an integer factor, for layers beyond the texture limit. */
function reduceRaster(raster: Raster, factor: number): Uint8Array {
  const ch = raster.channels;
  const width = Math.ceil(raster.width / factor), height = Math.ceil(raster.height / factor);
  const out = new Uint8Array(width * height * ch);
  for (let y = 0; y < height; y++) {
    const band = raster.readRegion(0, y * factor, raster.width, factor);
    for (let x = 0; x < width; x++) {
      const sums = new Float64Array(4);
      let alphaSum = 0, n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= raster.width || y * factor + dy >= raster.height) continue;
          const i = (dy * raster.width + sx) * ch;
          if (ch === 4) {
            const a = band[i + 3]!;
            sums[0]! += band[i]! * a; sums[1]! += band[i + 1]! * a; sums[2]! += band[i + 2]! * a;
            alphaSum += a;
          } else sums[0]! += band[i]!;
          n++;
        }
      }
      const o = (y * width + x) * ch;
      if (ch === 4) {
        if (alphaSum > 0) { out[o] = sums[0]! / alphaSum; out[o + 1] = sums[1]! / alphaSum; out[o + 2] = sums[2]! / alphaSum; }
        out[o + 3] = Math.round(alphaSum / Math.max(1, n));
      } else out[o] = Math.round(sums[0]! / Math.max(1, n));
    }
  }
  return out;
}

export { storedMaskTransform };
