/**
 * The canvas: a WebGL2 surface for the composite plus a 2D overlay for handles, guides and tool
 * previews (EditorCanvas.swift + TransformOverlay.swift). Framework-free; React only mounts it.
 *
 * Input: mouse, pen and touch through Pointer Events with pointer capture. Two touches pinch-zoom
 * and pan; a single touch drives the active tool. Wheel pans, Ctrl/⌘-wheel (and trackpad pinch)
 * zooms, Space or the middle button pans temporarily.
 */

import type { CanvasDocument } from '../../core/document';
import { rectUnion, type Point } from '../../core/geometry';
import type { EditorSession } from '../../core/session';
import { GpuCompositor, type CompositeHooks, type ViewSpec } from '../../render/gpuCompositor';
import type { CanvasHost, EditorController } from '../controller';
import { defaultTools, HandTool, overlayGeometry, type Modifiers, type ToolContext, type ToolHandler, type ToolRegistry } from './tools';

export type OverlayPainter = (context: CanvasRenderingContext2D, session: EditorSession, time: number) => void;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function modifiersOf(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }): Modifiers {
  return { shift: event.shiftKey, option: event.altKey, command: isMac ? event.metaKey : event.ctrlKey, control: isMac && event.ctrlKey };
}

export class CanvasView implements CanvasHost {
  readonly element: HTMLDivElement;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  gpu: GpuCompositor | null = null;
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
  private active: { handler: ToolHandler; pointerId: number; session: EditorSession } | null = null;
  private pinch: { distance: number; zoom: number; mid: Point } | null = null;
  private panning: { last: Point; pointerId: number } | null = null;
  private readonly hand = new HandTool();
  private lastModifiers: Modifiers = { shift: false, option: false, command: false, control: false };
  private lastPoint: Point | null = null;
  /** The mouse/pen position over the canvas (view points), for brush cursors; null when away or touching. */
  hoverPoint: Point | null = null;
  private animating = false;
  private destroyed = false;
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
    this.glCanvas.setAttribute('aria-label', 'Canvas');
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
    this.watchSession();
  }

  async start(): Promise<void> {
    try {
      this.gpu = await GpuCompositor.create(this.glCanvas, 1, 1);
    } catch (error) {
      this.failure = (error as Error).message;
      this.controller.host.reportError({ code: 'webgl2-unavailable', message: this.failure });
    }
    if (this.destroyed) { this.gpu?.destroy(); this.gpu = null; return; }
    this.syncGeometry();
    this.redraw();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.workspaceOff();
    this.gpu?.destroy();
    this.gpu = null;
    this.element.remove();
  }

  private watchSession(): void {
    const session = this.controller.session;
    if (session === this.watched) { this.redraw(); return; }
    if (this.active) { this.active.handler.cancel(this.active.session); this.active = null; }
    this.unsubscribe?.();
    this.watched = session;
    this.unsubscribe = session.subscribe(() => this.redraw());
    this.syncGeometry();
    this.redraw();
  }

  get session(): EditorSession { return this.controller.session; }

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
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame((time) => { this.frame = 0; this.draw(time); });
  }

  private hooks(session: EditorSession): CompositeHooks {
    return {
      transform: (l) => session.displayedTransform(l),
      maskPlacement: (l) => session.displayedMaskPlacement(l),
      blendMode: (l) => session.displayedBlendMode(l),
      raster: (l) => session.displayedRaster(l),
      maskRaster: (l) => session.displayedMaskRaster(l),
    };
  }

  private draw(time: number): void {
    const session = this.session;
    const document = session.document;
    const rect = this.element.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    const viewport = session.viewport;
    if (viewport.viewSize.width !== rect.width || viewport.viewSize.height !== rect.height || viewport.backingScale !== dpr) {
      viewport.resize({ width: rect.width, height: rect.height }, dpr, document);
    }
    const gpu = this.gpu;
    if (gpu) {
      if (!document) {
        gpu.present(null, width, height, { x: 0, y: 0, width: 0, height: 0 }, dpr, false, 1);
      } else {
        const docRect = viewport.documentRect(document);
        // While cropping, the frame may reach past the canvas; show what lies there too (renderBounds).
        const crop = session.tool === 'crop' ? session.cropRect : null;
        const bounds = crop ? rectUnion({ x: 0, y: 0, width: document.width, height: document.height }, crop) : { x: 0, y: 0, width: document.width, height: document.height };
        const shown = { x: docRect.x + bounds.x * viewport.pointsPerPixel, y: docRect.y + bounds.y * viewport.pointsPerPixel,
          width: bounds.width * viewport.pointsPerPixel, height: bounds.height * viewport.pointsPerPixel };
        const device = { x: shown.x * dpr, y: shown.y * dpr, width: shown.width * dpr, height: shown.height * dpr };
        const x0 = Math.max(0, Math.floor(device.x)), y0 = Math.max(0, Math.floor(device.y));
        const x1 = Math.min(width, Math.ceil(device.x + device.width)), y1 = Math.min(height, Math.ceil(device.y + device.height));
        const ppp = viewport.pointsPerPixel;
        let composite = null;
        if (x1 > x0 && y1 > y0) {
          const view: ViewSpec = {
            width: x1 - x0, height: y1 - y0, scale: dpr * ppp, snap: viewport.zoom >= 2,
            viewToDoc: { a: 1 / (dpr * ppp), b: 0, c: 0, d: 1 / (dpr * ppp), tx: (x0 / dpr - docRect.x) / ppp, ty: (y0 / dpr - docRect.y) / ppp },
          };
          composite = gpu.composite(document, view, this.hooks(session));
        }
        gpu.present(composite, width, height, device, dpr, session.showsPixelGrid && viewport.zoom >= 8, dpr * ppp, { x: x0, y: y0 });
        if (composite) gpu.releaseTarget(composite);
      }
    }
    this.drawOverlay(width, height, dpr, time);
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
    if (this.overlayFrame || this.destroyed) return;
    this.overlayFrame = requestAnimationFrame((time) => {
      this.overlayFrame = 0;
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
    const pixels = this.gpu.readRegion(document, x, y, width, height);
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
      redraw: () => this.redraw(),
      setCursor: (cursor) => { this.element.style.cursor = cursor; },
    };
  }

  private toolHandler(): ToolHandler | null {
    const spaceHeld = this.controller.ui.getState().spaceHeld;
    if (spaceHeld) return this.hand;
    for (const intercept of this.controller.canvasInterceptors) {
      const handler = intercept(this.session);
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
      return;
    }
    if (this.pointers.size > 1 || !this.session.document) return;
    if (event.button === 1 || (event.button === 0 && event.pointerType === 'mouse' && false)) {
      this.panning = { last: point, pointerId: event.pointerId };
      this.element.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const handler = this.toolHandler();
    if (!handler) return;
    this.element.setPointerCapture(event.pointerId);
    this.active = { handler, pointerId: event.pointerId, session: this.session };
    handler.down(this.context(event, point));
    this.redraw();
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.lastPoint = point;
    this.lastModifiers = modifiersOf(event);
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
      this.redraw();
      return;
    }
    if (!this.pointers.size) this.updateHoverCursor(event, point);
  };

  private onPointerUp = (event: PointerEvent): void => {
    const point = this.localPoint(event);
    this.pointers.delete(event.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (this.panning?.pointerId === event.pointerId) { this.panning = null; return; }
    if (this.active && this.active.pointerId === event.pointerId) {
      const { handler } = this.active;
      this.active = null;
      handler.up(this.context(event, point));
      this.redraw();
      this.updateHoverCursor(event, point);
    }
  };

  private onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.active && this.active.pointerId === event.pointerId) {
      this.active.handler.cancel(this.active.session);
      this.active = null;
      this.redraw();
    }
    this.panning = null;
  };

  private onPointerLeave = (): void => {
    this.hoverPoint = null;
    this.redrawOverlayOnly();
    this.controller.ui.setState({ pointerOverCanvas: false });
  };

  private updateHoverCursor(event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; pointerType?: string }, point: Point): void {
    const handler = this.toolHandler();
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
    this.active.handler.cancel(this.active.session);
    this.active = null;
    this.redraw();
    return true;
  }
  get isDragging(): boolean { return this.active !== null || this.pinch !== null; }

  private onWheel = (event: WheelEvent): void => {
    const session = this.session;
    if (!session.document || this.active) return;
    event.preventDefault();
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
