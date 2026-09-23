import type { PaletteColor } from './session';
import type { EditorSession } from './session';
import type { Point } from './geometry';
import { Raster, TILE } from './raster';
import type { DocumentSelection } from './selection';
import { editableTarget, RasterMapping, clampByte, selectionCoverage, validPoint } from './retouch/common';

export type GradientShape = 'Linear' | 'Radial';
export type GradientStyle = 'Foreground to Background' | 'Foreground to Transparent';

/** Document/Gradient.swift `GradientSettings`, including palette colors for worker-safe rasterisation. */
export interface GradientSettings {
  readonly shape: GradientShape;
  readonly style: GradientStyle;
  readonly reversed: boolean;
  readonly opacity: number;
  readonly foreground: PaletteColor;
  readonly background: PaletteColor;
}

export function defaultGradientSettings(foreground: PaletteColor = { red: 0, green: 0, blue: 0 },
  background: PaletteColor = { red: 1, green: 1, blue: 1 }): GradientSettings {
  return { shape: 'Linear', style: 'Foreground to Transparent', reversed: false, opacity: 1, foreground, background };
}

export interface GradientRasterOptions {
  readonly base: Raster;
  readonly transform: import('./geometry').LayerTransform;
  readonly start: Point;
  readonly end: Point;
  readonly settings: GradientSettings;
  readonly selection?: DocumentSelection | null;
}

interface GradientEnd { readonly color: PaletteColor; readonly alpha: number }

/** BrushStroke.fillGradient: source-over a clamped linear/radial ramp, tile by tile. */
export function rasterizeGradient(options: GradientRasterOptions): Raster {
  const { base, start, end, settings } = options;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance < 0.5) return base;
  const mapping = new RasterMapping(base, options.transform);
  let ends: [GradientEnd, GradientEnd] = settings.style === 'Foreground to Background'
    ? [{ color: settings.foreground, alpha: 1 }, { color: settings.background, alpha: 1 }]
    : [{ color: settings.foreground, alpha: 1 }, { color: settings.foreground, alpha: 0 }];
  if (settings.reversed) ends = [ends[1], ends[0]];
  const opacity = Math.min(1, Math.max(0, Number.isFinite(settings.opacity) ? settings.opacity : 1));
  const dx = end.x - start.x, dy = end.y - start.y, denominator = dx * dx + dy * dy;
  const m = mapping.pixelToDocument;
  const tiles = base.tiles.slice();
  for (let row = 0; row < base.rows; row++) {
    for (let col = 0; col < base.cols; col++) {
      const x0 = col * TILE, y0 = row * TILE, width = base.tileWidth(col), height = base.tileHeight(row);
      const pixels = base.readRegion(x0, y0, width, height);
      let changed = false;
      for (let y = 0; y < height; y++) {
        let docX = m.a * (x0 + 0.5) + m.c * (y0 + y + 0.5) + m.tx;
        let docY = m.b * (x0 + 0.5) + m.d * (y0 + y + 0.5) + m.ty;
        for (let x = 0; x < width; x++, docX += m.a, docY += m.b) {
          const t0 = settings.shape === 'Radial'
            ? Math.hypot(docX - start.x, docY - start.y) / distance
            : ((docX - start.x) * dx + (docY - start.y) * dy) / denominator;
          const t = Math.min(1, Math.max(0, t0));
          const selected = selectionCoverage(options.selection ?? null, { x: docX, y: docY });
          const alpha = (ends[0].alpha + (ends[1].alpha - ends[0].alpha) * t) * opacity * selected;
          if (alpha <= 0) continue;
          const red = ends[0].color.red + (ends[1].color.red - ends[0].color.red) * t;
          const green = ends[0].color.green + (ends[1].color.green - ends[0].color.green) * t;
          const blue = ends[0].color.blue + (ends[1].color.blue - ends[0].color.blue) * t;
          const i = (y * width + x) * base.channels;
          if (base.channels === 1) {
            const value = clampByte(red * 255 * alpha + pixels[i]! * (1 - alpha));
            changed ||= value !== pixels[i]; pixels[i] = value;
          } else {
            const destinationAlpha = pixels[i + 3]! / 255;
            const outAlpha = alpha + destinationAlpha * (1 - alpha);
            const keep = destinationAlpha * (1 - alpha);
            const r = outAlpha > 0 ? clampByte((red * 255 * alpha + pixels[i]! * keep) / outAlpha) : 0;
            const g = outAlpha > 0 ? clampByte((green * 255 * alpha + pixels[i + 1]! * keep) / outAlpha) : 0;
            const b = outAlpha > 0 ? clampByte((blue * 255 * alpha + pixels[i + 2]! * keep) / outAlpha) : 0;
            const a = clampByte(outAlpha * 255);
            changed ||= r !== pixels[i] || g !== pixels[i + 1] || b !== pixels[i + 2] || a !== pixels[i + 3];
            pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
          }
        }
      }
      if (changed) tiles[row * base.cols + col] = allZero(pixels) ? null : pixels;
    }
  }
  return new Raster(base.width, base.height, base.channels, tiles);
}

function allZero(pixels: Uint8Array): boolean {
  for (let i = 0; i < pixels.length; i++) if (pixels[i]) return false;
  return true;
}

/** An uncommitted line whose preview always starts from the same original pixels. */
export class GradientEdit {
  start: Point;
  end: Point;
  private preview: Raster;

  constructor(readonly original: Raster, readonly transform: import('./geometry').LayerTransform,
    start: Point, readonly selection: DocumentSelection | null, private settings: GradientSettings) {
    this.start = { ...start };
    this.end = { ...start };
    this.preview = original;
  }

  get hasLine(): boolean { return Math.hypot(this.end.x - this.start.x, this.end.y - this.start.y) >= 0.5; }
  currentRaster(): Raster { return this.preview; }
  update(point: Point, settings: GradientSettings = this.settings, shift = false): Raster {
    this.settings = settings;
    this.end = shift ? snapGradientPoint(point, this.start) : { ...point };
    this.preview = this.hasLine ? rasterizeGradient({ base: this.original, transform: this.transform,
      start: this.start, end: this.end, settings, selection: this.selection }) : this.original;
    return this.preview;
  }
  updateStart(point: Point, settings: GradientSettings = this.settings, shift = false): Raster {
    const next = shift ? snapGradientPoint(point, this.end) : point;
    this.start = { ...next };
    this.settings = settings;
    this.preview = this.hasLine ? rasterizeGradient({ base: this.original, transform: this.transform,
      start: this.start, end: this.end, settings, selection: this.selection }) : this.original;
    return this.preview;
  }
  refresh(settings: GradientSettings = this.settings): Raster { return this.update(this.end, settings, false); }
  refreshPalette(foreground: PaletteColor, background: PaletteColor): Raster {
    return this.refresh({ ...this.settings, foreground, background });
  }
}

/** EditorCanvas.snapped: preserve length and round direction to a multiple of 45 degrees. */
export function snapGradientPoint(point: Point, around: Point): Point {
  const dx = point.x - around.x, dy = point.y - around.y, length = Math.hypot(dx, dy);
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: around.x + Math.cos(angle) * length, y: around.y + Math.sin(angle) * length };
}

interface PendingGradient { readonly layerId: string; readonly mask: boolean; readonly edit: GradientEdit }
const pending = new WeakMap<EditorSession, PendingGradient>();

export function pendingGradient(session: EditorSession): GradientEdit | null { return pending.get(session)?.edit ?? null; }
export function hasPendingGradient(session: EditorSession): boolean { return pending.has(session); }
/** The pending gradient for the canvas preview. */
export function pendingGradientPreview(session: EditorSession): { layerId: string; mask: boolean; raster: Raster; transform: import('./geometry').LayerTransform } | null {
  const active = pending.get(session);
  return active ? { layerId: active.layerId, mask: active.mask, raster: active.edit.currentRaster(), transform: active.edit.transform } : null;
}
export function gradientPreview(session: EditorSession): Raster | null { return pending.get(session)?.edit.currentRaster() ?? null; }

export function beginGradient(session: EditorSession, point: Point,
  settings: GradientSettings = settingsFromSession(session)): boolean {
  if (!validPoint(point) || session.tool !== 'gradient') return false;
  const layer = session.activeLayer;
  if (!layer || layer.isGroup || (!session.isMaskSelected && layer.adjustment)) return false;
  const current = pending.get(session);
  if (current && current.layerId === layer.id && current.mask === session.isMaskSelected) {
    const edit = new GradientEdit(current.edit.original, current.edit.transform, point, session.selection, settings);
    pending.set(session, { ...current, edit });
    return true;
  }
  if (!session.canEditLayers || session.selectedLayerIds.size !== 1) return false;
  const document = session.document;
  if (!document) return false;
  const target = editableTarget(layer, session.isMaskSelected, { width: document.width, height: document.height });
  if (!target) return false;
  pending.set(session, { layerId: layer.id, mask: target.mask,
    edit: new GradientEdit(target.raster, target.transform, point, session.selection, settings) });
  session.notify('ui');
  return true;
}

export function updateGradient(session: EditorSession, point: Point,
  options: { readonly endpoint?: 'start' | 'end'; readonly shift?: boolean; readonly settings?: GradientSettings } = {}): Raster | null {
  const active = pending.get(session);
  if (!active || !validPoint(point)) return null;
  const result = options.endpoint === 'start'
    ? active.edit.updateStart(point, options.settings, options.shift ?? false)
    : active.edit.update(point, options.settings, options.shift ?? false);
  session.notify('ui');
  return result;
}

export function refreshGradient(session: EditorSession, settings?: GradientSettings): Raster | null {
  const edit = pending.get(session)?.edit;
  if (!edit) return null;
  const result = edit.refresh(settings);
  session.notify('ui');
  return result;
}

/** ColorPalette.swift didSet behavior: palette changes redraw the pending ramp. */
export function refreshGradientPalette(session: EditorSession): Raster | null {
  const edit = pending.get(session)?.edit;
  if (!edit) return null;
  const palette = settingsFromSession(session);
  const result = edit.refreshPalette(palette.foreground, palette.background);
  session.notify('ui');
  return result;
}

export function endGradientDrag(session: EditorSession): boolean {
  const edit = pending.get(session)?.edit;
  if (!edit) return false;
  if (!edit.hasLine) cancelGradient(session);
  return edit.hasLine;
}

export function cancelGradient(session: EditorSession): boolean {
  if (!pending.delete(session)) return false;
  session.notify('ui');
  return true;
}

export function commitGradient(session: EditorSession): boolean {
  const active = pending.get(session);
  if (!active) return false;
  if (!active.edit.hasLine) { cancelGradient(session); return false; }
  const layer = session.layer(active.layerId);
  if (!layer || active.mask !== session.isMaskSelected) { cancelGradient(session); return false; }
  const raster = active.edit.currentRaster();
  const name = active.mask ? 'Gradient Mask' : 'Gradient';
  pending.delete(session);
  if (active.mask) session.replaceMaskPixels(active.layerId, raster, name);
  else {
    session.beginEdit(name);
    const document = session.document;
    if (document) session.replaceDocument({ ...document, layers: document.layers.map((item) => item.id === active.layerId
      ? { ...item, raster, transform: active.edit.transform, shape: null } : item) });
    session.endEdit();
  }
  return true;
}

/** Switching tools/layers/targets applies the pending edit upstream. */
export function resolveGradient(session: EditorSession): boolean { return commitGradient(session); }

/** First Undo cancels a pending gradient, matching EditorSession.undo upstream. */
export function undoGradientOrHistory(session: EditorSession): boolean {
  return cancelGradient(session) || session.undo();
}

/** Escape cancels and Enter applies; returns whether a pending edit handled the key. */
export function handleGradientKey(session: EditorSession, key: 'Enter' | 'Escape'): boolean {
  if (!pending.has(session)) return false;
  return key === 'Escape' ? cancelGradient(session) : commitGradient(session);
}

function settingsFromSession(session: EditorSession): GradientSettings {
  const foreground = session.isMaskSelected
    ? (session.maskPaintWhite ? { red: 1, green: 1, blue: 1 } : { red: 0, green: 0, blue: 0 })
    : session.foregroundColor;
  const background = session.isMaskSelected
    ? (session.maskPaintWhite ? { red: 0, green: 0, blue: 0 } : { red: 1, green: 1, blue: 1 })
    : session.backgroundColor;
  return defaultGradientSettings(foreground, background);
}
