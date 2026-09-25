/**
 * The canvas: a WebGL2 surface for the composite plus a 2D overlay for handles, guides and tool
 * previews (EditorCanvas.swift + TransformOverlay.swift). Framework-free; React only mounts it.
 *
 * Input: mouse, pen and touch through Pointer Events with pointer capture. Two touches pinch-zoom
 * and pan; a single touch drives the active tool. Wheel pans, Ctrl/⌘-wheel (and trackpad pinch)
 * zooms, Space or the middle button pans temporarily.
 */

import type { CanvasDocument } from '../../core/document';
import { rectUnion, type Affine, type Point } from '../../core/geometry';
import type { EditorSession, Tool } from '../../core/session';
import { currentBrushPreview, currentGpuBrushPreview } from '../../core/brush';
import { documentWithPixelAdjustmentPreview } from '../../core/adjust/editing';
import { documentWithPixelMovePreview } from '../../core/selectionCommands';
import { documentWithPixelFilterPreview, setFilterViewPreviewEnabled } from '../../core/filters/editing';
import { GpuCompositor, type CompositeHooks, type ViewSpec } from '../../render/gpuCompositor';
import { SoftwareCompositor } from '../../render/softwareCompositor';
import type { CanvasHost, EditorController, SecondaryDrag } from '../controller';
import { defaultTools, HandTool, overlayGeometry, type Modifiers, type ToolContext, type ToolHandler, type ToolRegistry } from './tools';

export type OverlayPainter = (context: CanvasRenderingContext2D, session: EditorSession, time: number) => void;

export interface CanvasPerformanceCounters {
  readonly redrawRequests: number;
  readonly overlayRedrawRequests: number;
  readonly frames: number;
  readonly overlayOnlyFrames: number;
  readonly mainThreadFramesOver50Ms: number;
  readonly observedLongTasks: number;
  readonly observedLongTaskMs: number;
  readonly maximumFrameCpuMs: number;
  readonly reducedResolutionFrames: number;
  readonly lastRenderScale: number;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Tools that change pixels of the active layer (or its mask); a pixel lock refuses them. */
const PIXEL_TOOLS: ReadonlySet<Tool> = new Set<Tool>(['brush', 'spotHealing', 'cloneStamp', 'blur', 'gradient']);

export function modifiersOf(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): Modifiers {
  return { shift: event.shiftKey, option: event.altKey, command: isMac ? event.metaKey : event.ctrlKey, control: isMac && event.ctrlKey };
}

export class CanvasView implements CanvasHost {
  readonly element: HTMLDivElement;
  private glCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  gpu: GpuCompositor | null = null;
  /** Actual backend; `gpu` remains the historical CanvasHost-compatible compositor handle. */
  private software: SoftwareCompositor | null = null;
  rendererKind: 'webgl2' | 'software' | 'none' = 'none';
  private readonly controller: EditorController;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private unsubscribe: (() => void) | null = null;
  private watched: EditorSession | null = null;
  private workspaceOff: () => void;
  tools: ToolRegistry = defaultTools();
  painters: OverlayPainter[] = [];
  /** Touch alternative for Cmd-dragging a handle. */
  distortArmed = false;
  private readonly pointers = new Map<number, Point>();
  private active: { handler: ToolHandler; pointerId: number; session: EditorSession; navigation: boolean } | null = null;
  private pinch: { distance: number; zoom: number; mid: Point } | null = null;
  private panning: { last: Point; pointerId: number } | null = null;
  private readonly hand = new HandTool();
  private lastModifiers: Modifiers = { shift: false, option: false, command: false, control: false };
  private lastPoint: Point | null = null;
  /** The mouse/pen position over the canvas (view points), for brush cursors; null when away or touching. */
  hoverPoint: Point | null = null;
  private secondary: { drag: SecondaryDrag; pointerId: number; start: Point } | null = null;
  private autoscroll: { frame: number; event: PointerEvent; point: Point } | null = null;
  private animating = false;
  private navigationInteraction = false;
  private navigationIdleTimer = 0;
  private destroyed = false;
  private readonly performanceCounterValue = {
    redrawRequests: 0, overlayRedrawRequests: 0, frames: 0, overlayOnlyFrames: 0,
    mainThreadFramesOver50Ms: 0, observedLongTasks: 0, observedLongTaskMs: 0, maximumFrameCpuMs: 0,
    reducedResolutionFrames: 0, lastRenderScale: 1,
  };
  private longTaskObserver: PerformanceObserver | null = null;
  failure: string | null = null;

  constructor(controller: EditorController) {
    this.controller = controller;
    this.element = document.createElement('div');
    this.element.className = 'compositor-canvas-host';
    this.element.style.cssText = 'position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none';
    this.glCanvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    for (const canvas of [this.glCanvas, this.overlay]) {
      canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
      this.element.append(canvas);
    }
    this.glCanvas.setAttribute('aria-label', controller.t('Canvas'));
    this.glCanvas.setAttribute('role', 'img');
    this.glCanvas.dataset.testid = 'editor-canvas';
    this.overlay.style.pointerEvents = 'none';
    this.resizeObserver = new ResizeObserver(() => this.syncGeometry());
    this.resizeObserver.observe(this.element);
    this.workspaceOff = controller.workspace.subscribe(() => this.watchSession());
    this.element.addEventListener('pointerdown', this.onPointerDown);
    this.element.addEventListener('pointermove', this.onPointerMove);
    this.element.addEventListener('pointerup', this.onPointerUp);
    this.element.addEventListener('pointercancel', this.onPointerCancel);
    this.element.addEventListener('pointerleave', this.onPointerLeave);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());
    // Safari's own pinch gesture events would zoom the page instead of the canvas.
    this.element.addEventListener('gesturestart', (event) => event.preventDefault());
    if (typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.performanceCounterValue.observedLongTasks++;
          this.performanceCounterValue.observedLongTaskMs += entry.duration;
        }
      });
      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    }
    this.watchSession();
  }

  async start(): Promise<void> {
    try {
      this.gpu = await GpuCompositor.create(this.glCanvas, 1, 1);
      this.rendererKind = 'webgl2';
    } catch (error) {
      try {
        // A failed Pixi initialization may already have selected a WebGL context mode; Canvas cannot
        // switch that element to 2D, so replace only the drawing surface and preserve its attributes.
        const replacement = document.createElement('canvas');
        replacement.style.cssText = this.glCanvas.style.cssText;
        replacement.setAttribute('aria-label', this.controller.t('Canvas')); replacement.setAttribute('role', 'img');
        replacement.dataset.testid = 'editor-canvas';
        this.glCanvas.replaceWith(replacement); this.glCanvas = replacement;
        this.software = await SoftwareCompositor.create(replacement, 1, 1);
        // Existing canvas/export/bake consumers use the compositor's public structural API through
        // this legacy property. SoftwareCompositor deliberately implements those same methods.
        this.gpu = this.software as unknown as GpuCompositor;
        this.rendererKind = 'software';
      } catch (fallbackError) {
        this.failure = `${(error as Error).message} ${(fallbackError as Error).message}`;
        this.controller.host.reportError({ code: 'canvas-renderer-unavailable', message: this.failure });
      }
    }
    if (this.destroyed) { this.gpu?.destroy(); this.gpu = null; this.software = null; this.rendererKind = 'none'; return; }
    this.syncGeometry();
    this.redraw();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearTimeout(this.navigationIdleTimer);
    this.resizeObserver.disconnect();
    this.longTaskObserver?.disconnect();
    this.unsubscribe?.();
    this.workspaceOff();
    this.gpu?.destroy();
    this.gpu = null;
    this.software = null;
    this.rendererKind = 'none';
    this.element.remove();
  }

  private watchSession(): void {
    const session = this.controller.session;
    if (session === this.watched) { this.redraw(); return; }
    if (this.active) {
      const navigation = this.active.navigation;
      this.active.handler.cancel(this.active.session); this.active = null;
      if (navigation) this.endNavigationInteraction();
    }
    this.unsubscribe?.();
    this.watched = session;
    this.unsubscribe = session.subscribe((kind) => { if (kind === 'overlay') this.redrawOverlayOnly(); else this.redraw(); });
    this.syncGeometry();
    this.redraw();
  }

  get session(): EditorSession { return this.controller.session; }

  /** Cumulative view diagnostics for performance tests and host-side audits. */
  get performanceCounters(): CanvasPerformanceCounters { return { ...this.performanceCounterValue }; }

  private syncGeometry(): void {
    const rect = this.element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = { width: rect.width, height: rect.height };
    const viewport = this.session.viewport;
    viewport.fitMargin = Math.min(rect.width, rect.height) < 500 ? 32 : 96;
    if (viewport.viewSize.width !== size.width || viewport.viewSize.height !== size.height || viewport.backingScale !== dpr) {
      viewport.resize(size, dpr, this.session.document);
    }
    this.redraw();
  }

  /** Draws immediately and waits for the GPU (measurements and tests). Returns milliseconds. */
  renderNow(): number {
    if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
    const start = performance.now();
    this.draw(start);
    this.gpu?.gl.finish();
    return performance.now() - start;
  }

  redraw(): void {
    this.performanceCounterValue.redrawRequests++;
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame((time) => { this.frame = 0; this.draw(time); });
  }

  private hooks(session: EditorSession): CompositeHooks {
    // RasterSnapshotTests.softwareFallbackKeepsTheSoftStrokeContinuous: without the Metal/WebGL
    // coverage preview, replay the exact CPU stroke and use it as the layer replacement.
    const brush = this.software ? currentBrushPreview(session) : null;
    return {
      transform: (l) => brush?.layerId === l.id && !brush.mask ? brush.transform : session.displayedTransform(l),
      maskPlacement: (l) => session.displayedMaskPlacement(l),
      blendMode: (l) => session.displayedBlendMode(l),
      raster: (l) => brush?.layerId === l.id && !brush.mask ? brush.raster : session.displayedRaster(l),
      maskRaster: (l) => brush?.layerId === l.id && brush.mask ? brush.raster : session.displayedMaskRaster(l),
      brush: this.software ? null : currentGpuBrushPreview(session),
    };
  }

  private draw(time: number): void {
    const cpuStart = performance.now();
    this.performanceCounterValue.frames++;
    const session = this.session;
    setFilterViewPreviewEnabled(session, !this.software && !!this.gpu);
    const document = session.document;
    const rect = this.element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // Navigation is transient: cap fill rate at one device pixel per CSS point, then redraw at the
    // real backing scale as soon as the gesture becomes idle. Document/view coordinates stay on
    // the full-DPR viewport, so the reduced frame cannot perturb tools or the final sample grid.
    const renderScale = this.navigationInteraction ? Math.min(1, dpr) : dpr;
    this.performanceCounterValue.lastRenderScale = renderScale;
    if (renderScale < dpr) this.performanceCounterValue.reducedResolutionFrames++;
    const width = Math.max(1, Math.round(rect.width * renderScale));
    const height = Math.max(1, Math.round(rect.height * renderScale));
    const viewport = session.viewport;
    if (viewport.viewSize.width !== rect.width || viewport.viewSize.height !== rect.height || viewport.backingScale !== dpr) {
      viewport.resize({ width: rect.width, height: rect.height }, dpr, document);
    }
    const gpu = this.gpu;
    if (gpu) {
      if (!document) {
        gpu.present(null, width, height, { x: 0, y: 0, width: 0, height: 0 }, renderScale, false, 1);
      } else {
        const docRect = viewport.documentRect(document);
        // While cropping, the frame may reach past the canvas; show what lies there too (renderBounds).
        const crop = session.tool === 'crop' ? session.cropRect : null;
        const bounds = crop ? rectUnion({ x: 0, y: 0, width: document.width, height: document.height }, crop) : { x: 0, y: 0, width: document.width, height: document.height };
        const shown = { x: docRect.x + bounds.x * viewport.pointsPerPixel, y: docRect.y + bounds.y * viewport.pointsPerPixel,
          width: bounds.width * viewport.pointsPerPixel, height: bounds.height * viewport.pointsPerPixel };
        const device = { x: shown.x * renderScale, y: shown.y * renderScale,
          width: shown.width * renderScale, height: shown.height * renderScale };
        const x0 = Math.max(0, Math.floor(device.x)), y0 = Math.max(0, Math.floor(device.y));
        const x1 = Math.min(width, Math.ceil(device.x + device.width)), y1 = Math.min(height, Math.ceil(device.y + device.height));
        const ppp = viewport.pointsPerPixel;
        let composite = null;
        if (x1 > x0 && y1 > y0) {
          const view: ViewSpec = {
            width: x1 - x0, height: y1 - y0, scale: renderScale * ppp, snap: viewport.zoom >= 2,
            viewToDoc: { a: 1 / (renderScale * ppp), b: 0, c: 0, d: 1 / (renderScale * ppp),
              tx: (x0 / renderScale - docRect.x) / ppp, ty: (y0 / renderScale - docRect.y) / ppp },
            cache: true,
          };
          const previewDocument = documentWithPixelMovePreview(session, documentWithPixelFilterPreview(session,
            documentWithPixelAdjustmentPreview(session, document)));
          composite = gpu.composite(previewDocument, view, this.hooks(session));
        }
        const proof = session.proofColors && session.proofLut ? { lut: session.proofLut, gamutWarning: session.gamutWarning } : undefined;
        gpu.present(composite, width, height, device, renderScale, session.showsPixelGrid && viewport.zoom >= 8,
          renderScale * ppp, { x: x0, y: y0 }, proof);
        if (composite) gpu.releaseTarget(composite);
      }
    }
    this.drawOverlay(width, height, dpr, time);
    const cpuMs = performance.now() - cpuStart;
    this.performanceCounterValue.maximumFrameCpuMs = Math.max(this.performanceCounterValue.maximumFrameCpuMs, cpuMs);
    if (cpuMs > 50) this.performanceCounterValue.mainThreadFramesOver50Ms++;
  }

  private drawOverlay(width: number, height: number, dpr: number, time: number): void {
    const overlay = this.overlay;
    if (overlay.width !== width || overlay.height !== height) { overlay.width = width; overlay.height = height; }
    const context = overlay.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    const session = this.session;
    const document = session.document;
    if (!document) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawSnapGuides(context, session, document);
    this.drawTransformHandles(context, session);
    let animate = false;
    for (const painter of this.painters) {
      context.save();
      painter(context, session, time);
      context.restore();
    }
    if (session.selection) animate = true;
    if (animate !== this.animating) this.animating = animate;
    if (animate) setTimeout(() => this.redrawOverlayOnly(), 120);
  }

  private overlayFrame = 0;
  private redrawOverlayOnly(): void {
    this.performanceCounterValue.overlayRedrawRequests++;
    if (this.overlayFrame || this.destroyed) return;
    this.overlayFrame = requestAnimationFrame((time) => {
      this.overlayFrame = 0;
      this.performanceCounterValue.overlayOnlyFrames++;
      const dpr = window.devicePixelRatio || 1;
      this.drawOverlay(this.overlay.width, this.overlay.height, dpr, time);
    });
  }

  private accent(): string {
    return getComputedStyle(this.element).getPropertyValue('--cmp-accent').trim() || '#0a84ff';
  }

  private drawSnapGuides(context: CanvasRenderingContext2D, session: EditorSession, document: CanvasDocument): void {
    const guides = session.snapGuides;
    if (!guides.xs.length && !guides.ys.length) return;
    const view = (p: Point) => session.viewport.viewPoint(p, document);
    context.strokeStyle = this.accent();
    context.lineWidth = 1;
    context.beginPath();
    for (const x of guides.xs) { const a = view({ x, y: 0 }), b = view({ x, y: document.height }); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); }
    for (const y of guides.ys) { const a = view({ x: 0, y }), b = view({ x: document.width, y }); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); }
    context.stroke();
  }

  private drawTransformHandles(context: CanvasRenderingContext2D, session: EditorSession): void {
    const geometry = overlayGeometry(session);
    if (!geometry) return;
    const h = geometry.handles;
    const path = new Path2D();
    path.moveTo(h[0]!.x, h[0]!.y);
    for (const i of [2, 4, 6]) path.lineTo(h[i]!.x, h[i]!.y);
    path.closePath();
    if (geometry.showsRotation) { path.moveTo(h[1]!.x, h[1]!.y); path.lineTo(geometry.rotationHandle.x, geometry.rotationHandle.y); }
    const accent = this.accent();
    context.strokeStyle = 'rgba(0,0,0,0.7)';
    context.lineWidth = 3;
    context.stroke(path);
    context.strokeStyle = accent;
    context.lineWidth = 1;
    context.stroke(path);
    context.fillStyle = '#fff';
    const touch = matchMedia('(pointer: coarse)').matches;
    const half = touch ? 6 : 3.5;
    for (const p of h) {
      context.fillRect(p.x - half, p.y - half, half * 2, half * 2);
      context.strokeRect(p.x - half, p.y - half, half * 2, half * 2);
    }
    if (geometry.showsRotation) {
      context.beginPath();
      context.arc(geometry.rotationHandle.x, geometry.rotationHandle.y, touch ? 7 : 4, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  // MARK: Pixels for export and merges

  readRegion(document: CanvasDocument, x: number, y: number, width: number, height: number): Uint8Array {
    if (!this.gpu) throw new Error(this.failure ?? 'The canvas renderer is not ready.');
    const pixels = this.gpu.readRegion(document, x, y, width, height, this.hooks(this.session));
    this.redraw();
    return pixels;
  }

  /** Export rendering (io/exportPipeline `ExportRenderer`): any scale, composited like the canvas. */
  readView(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number): Uint8Array {
    if (!this.gpu) throw new Error(this.failure ?? 'The canvas renderer is not ready.');
    const pixels = this.gpu.readView(document, width, height, viewToDoc, scale, this.hooks(this.session));
    this.redraw();
    return pixels;
  }

  /** Float export rendering for 16-bit files; null when WebGL has no float render targets. */
  readViewFloat(document: CanvasDocument, width: number, height: number, viewToDoc: Affine, scale: number): Float32Array | null {
    if (!this.gpu) throw new Error(this.failure ?? 'The canvas renderer is not ready.');
    if (!this.software && !this.gpu.floatTargets) return null;
    const pixels = this.gpu.readViewFloat(document, width, height, viewToDoc, scale, this.hooks(this.session));
    this.redraw();
    return pixels;
  }

  // MARK: Input

  private localPoint(event: { clientX: number; clientY: number }): Point {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private context(event: PointerEvent, point: Point): ToolContext {
    const session = this.session;
    const document = session.document;
    const pixel = document ? session.viewport.documentPoint(point, document) : point;
    const modifiers = modifiersOf(event);
    return {
      session, point, pixel, modifiers, pointerType: event.pointerType, distortArmed: this.distortArmed,
      pressure: event.pointerType === 'pen' ? event.pressure : null,
      tilt: event.pointerType === 'pen' ? penTilt(event) : null,
      redraw: () => this.redraw(),
      setCursor: (cursor) => { this.element.style.cursor = cursor; },
    };
  }

  private beginNavigationInteraction(): void {
    clearTimeout(this.navigationIdleTimer);
    this.navigationIdleTimer = 0;
    if (this.navigationInteraction) return;
    this.navigationInteraction = true;
    this.redraw();
  }

  private endNavigationInteraction(delay = 0): void {
    clearTimeout(this.navigationIdleTimer);
    this.navigationIdleTimer = 0;
    const finish = () => {
      this.navigationIdleTimer = 0;
      if (!this.navigationInteraction) return;
      this.navigationInteraction = false;
      this.redraw();
    };
    if (delay > 0) this.navigationIdleTimer = window.setTimeout(finish, delay);
    else finish();
  }

  private toolHandler(modifiers: Modifiers, point: Point | null = null): ToolHandler | null {
    const spaceHeld = this.controller.ui.getState().spaceHeld;
    if (spaceHeld) return this.hand;
    for (const intercept of this.controller.canvasInterceptors) {
      const handler = intercept(this.session, modifiers, point);
      if (handler) return handler;
    }
    return this.tools[this.session.tool] ?? null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.pointers.set(event.pointerId, point);
    this.element.focus?.({ preventScroll: true });
    if (event.pointerType === 'touch' && this.pointers.size === 2) {
      // A second finger turns the gesture into pinch-zoom and pan; the tool's gesture is abandoned.
      if (this.active) { this.active.handler.cancel(this.active.session); this.active = null; this.redraw(); }
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      this.pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: this.session.viewport.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      this.beginNavigationInteraction();
      return;
    }
    if (this.pointers.size > 1 || !this.session.document) return;
    if (event.button === 1 || (event.button === 0 && event.pointerType === 'mouse' && false)) {
      this.panning = { last: point, pointerId: event.pointerId };
      this.beginNavigationInteraction();
      this.element.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 2 && event.pointerType !== 'touch' && !this.active && !this.controller.ui.getState().spaceHeld) {
      const drag = this.controller.secondaryDrags.map((start) => start(this.session)).find((d) => d) ?? null;
      if (drag) {
        this.secondary = { drag, pointerId: event.pointerId, start: point };
        this.element.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
      return;
    }
    if (event.button !== 0) return;
    const handler = this.toolHandler(modifiersOf(event), point);
    if (!handler) return;
    // Painting tools on a layer whose pixels are locked: say why nothing happens (Option-click still samples colour).
    const layer = this.session.activeLayer;
    if (handler === this.tools[this.session.tool] && PIXEL_TOOLS.has(this.session.tool) && layer && !event.altKey
      && this.session.refuseLayerEdit(layer.id, 'pixels')) return;
    this.element.setPointerCapture(event.pointerId);
    const navigation = handler === this.hand || this.session.tool === 'hand' || this.session.tool === 'zoom';
    this.active = { handler, pointerId: event.pointerId, session: this.session, navigation };
    if (navigation) this.beginNavigationInteraction();
    handler.down(this.context(event, point));
    this.redraw();
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.lastPoint = point;
    this.lastModifiers = modifiersOf(event);
    if (this.secondary?.pointerId === event.pointerId) {
      // The brush circle stays where the press was while its edge follows the pointer.
      this.hoverPoint = this.secondary.start;
      this.secondary.drag.move(point.x - this.secondary.start.x, { shift: event.shiftKey });
      this.redrawOverlayOnly();
      return;
    }
    const previousHover = this.hoverPoint;
    this.hoverPoint = event.pointerType === 'touch' ? null : point;
    if (previousHover || this.hoverPoint) this.redrawOverlayOnly();
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, point);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Point, Point];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const session = this.session;
      if (session.document) {
        session.viewport.translate(mid.x - this.pinch.mid.x, mid.y - this.pinch.mid.y);
        session.viewport.setZoom(this.pinch.zoom * distance / this.pinch.distance, mid, session.document);
        this.pinch.mid = mid;
        session.notify('view');
      }
      return;
    }
    if (this.panning && this.panning.pointerId === event.pointerId) {
      this.session.viewport.translate(point.x - this.panning.last.x, point.y - this.panning.last.y);
      this.panning.last = point;
      this.session.notify('view');
      return;
    }
    if (this.active && this.active.pointerId === event.pointerId) {
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      const samples = events.length ? events : [event];
      for (const sample of samples) this.active.handler.move(this.context(sample, this.localPoint(sample)));
      if (this.active.handler.overlayOnly?.(this.active.session)) this.redrawOverlayOnly(); else this.redraw();
      this.updateAutoscroll(event, point);
      return;
    }
    if (!this.pointers.size) this.updateHoverCursor(event, point);
  };

  private onPointerUp = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.pointers.delete(event.pointerId);
    if (this.secondary?.pointerId === event.pointerId) {
      this.secondary.drag.end();
      this.secondary = null;
      this.hoverPoint = point;
      this.redrawOverlayOnly();
      return;
    }
    if (this.pinch) {
      if (this.pointers.size < 2) { this.pinch = null; this.endNavigationInteraction(); }
      return;
    }
    if (this.panning?.pointerId === event.pointerId) { this.panning = null; this.endNavigationInteraction(); return; }
    if (this.active && this.active.pointerId === event.pointerId) {
      this.stopAutoscroll();
      const { handler, navigation } = this.active;
      this.active = null;
      handler.up(this.context(event, point));
      if (navigation) this.endNavigationInteraction();
      this.redraw();
      this.updateHoverCursor(event, point);
    }
  };

  /** Past 12 points from an edge the document slides at 2 + 0.4 points per frame per point beyond, up to 40. */
  private autoscrollDelta(point: Point): Point {
    const rect = this.element.getBoundingClientRect(), margin = 12;
    const speed = (past: number) => (past <= 0 ? 0 : Math.min(40, 2 + past * 0.4));
    return {
      x: speed(margin - point.x) - speed(point.x - (rect.width - margin)),
      y: speed(margin - point.y) - speed(point.y - (rect.height - margin)),
    };
  }

  private updateAutoscroll(event: PointerEvent, point: Point): void {
    const active = this.active;
    const delta = this.autoscrollDelta(point);
    if (!active || !active.handler.autoscrolls?.(active.session) || (delta.x === 0 && delta.y === 0)) { this.stopAutoscroll(); return; }
    if (this.autoscroll) { this.autoscroll.event = event; this.autoscroll.point = point; return; }
    const step = () => {
      const scroll = this.autoscroll, current = this.active;
      if (!scroll || !current || !current.handler.autoscrolls?.(current.session)) { this.stopAutoscroll(); return; }
      const d = this.autoscrollDelta(scroll.point);
      if (d.x === 0 && d.y === 0) { this.stopAutoscroll(); return; }
      current.session.viewport.translate(d.x, d.y);
      current.session.notify('view');
      // The pointer hasn't moved, but the document has under it: the box corner or the moved selection follows.
      current.handler.move(this.context(scroll.event, scroll.point));
      this.redraw();
      scroll.frame = requestAnimationFrame(step);
    };
    this.autoscroll = { frame: requestAnimationFrame(step), event, point };
  }

  private stopAutoscroll(): void {
    if (this.autoscroll) cancelAnimationFrame(this.autoscroll.frame);
    this.autoscroll = null;
  }

  private onPointerCancel = (event: PointerEvent): void => {
    this.stopAutoscroll();
    this.pointers.delete(event.pointerId);
    if (this.secondary?.pointerId === event.pointerId) { this.secondary.drag.end(); this.secondary = null; }
    if (this.pointers.size < 2) this.pinch = null;
    if (this.active && this.active.pointerId === event.pointerId) {
      const navigation = this.active.navigation;
      this.active.handler.cancel(this.active.session);
      this.active = null;
      if (navigation) this.endNavigationInteraction();
      this.redraw();
    }
    this.panning = null;
    this.endNavigationInteraction();
  };

  private onPointerLeave = (): void => {
    this.hoverPoint = null;
    this.redrawOverlayOnly();
    this.controller.ui.setState({ pointerOverCanvas: false });
  };

  private updateHoverCursor(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; pointerType?: string }, point: Point): void {
    const handler = this.toolHandler(modifiersOf(event), point);
    const session = this.session;
    const document = session.document;
    if (!handler?.hover || !document) { this.element.style.cursor = 'default'; return; }
    const context: ToolContext = {
      session, point, pixel: session.viewport.documentPoint(point, document), modifiers: modifiersOf(event),
      pointerType: event.pointerType ?? 'mouse', distortArmed: this.distortArmed, pressure: null, redraw: () => this.redraw(),
      setCursor: (cursor) => { this.element.style.cursor = cursor; },
    };
    this.element.style.cursor = handler.hover(context);
  }

  /** Re-evaluates the hover cursor after a modifier key changes. */
  refreshCursor(event: KeyboardEvent): void {
    this.lastModifiers = modifiersOf(event);
    if (this.lastPoint && !this.active) this.updateHoverCursor(event, this.lastPoint);
  }

  /** Escape during a drag abandons the gesture. */
  cancelGesture(): boolean {
    if (!this.active) return false;
    const navigation = this.active.navigation;
    this.active.handler.cancel(this.active.session);
    this.active = null;
    if (navigation) this.endNavigationInteraction();
    this.redraw();
    return true;
  }
  get isDragging(): boolean { return this.active !== null || this.pinch !== null; }

  private onWheel = (event: WheelEvent): void => {
    const session = this.session;
    if (!session.document || this.active) return;
    event.preventDefault();
    this.beginNavigationInteraction();
    this.endNavigationInteraction(120);
    const point = this.localPoint(event);
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      session.zoomTo(session.viewport.zoom * Math.exp(-event.deltaY * scale * (event.ctrlKey && !event.metaKey ? 0.01 : 0.0025)), point);
    } else {
      session.viewport.translate(-event.deltaX * scale, -event.deltaY * scale);
      session.notify('view');
    }
  };
}

/** Pen altitude as 0 (lying flat)…1 (upright), from altitudeAngle where supported, else tiltX/tiltY. */
function penTilt(event: PointerEvent): number {
  const altitude = (event as PointerEvent & { altitudeAngle?: number }).altitudeAngle;
  if (typeof altitude === 'number' && Number.isFinite(altitude)) return Math.min(1, Math.max(0, altitude / (Math.PI / 2)));
  return 1 - Math.min(90, Math.hypot(event.tiltX || 0, event.tiltY || 0)) / 90;
}
