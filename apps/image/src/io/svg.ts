/**
 * Deterministic SVG placement through CanvasKit paths (PRODUCT-PLAN A5/6.8).
 * This intentionally implements a reviewed illustration subset instead of delegating SVG to each browser.
 */

import type { Canvas, CanvasKit, Paint, Path, Surface } from 'canvaskit-wasm';
import { Raster, TILE } from '../core/raster';
import type { TextEngine } from '../text';

export interface SvgInfo {
  readonly width: number;
  readonly height: number;
  readonly viewBox: readonly [number, number, number, number];
}

export interface SvgRenderResult {
  readonly raster: Raster;
  readonly info: SvgInfo;
  readonly unsupported: readonly string[];
}

interface CanvasKitEngine extends TextEngine { readonly kit: CanvasKit }
interface Style {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  fillOpacity: number;
  strokeOpacity: number;
  fillRule: 'nonzero' | 'evenodd';
  lineCap: 'butt' | 'round' | 'square';
  lineJoin: 'miter' | 'round' | 'bevel';
  miterLimit: number;
  dash: readonly number[] | null;
  dashOffset: number;
  hidden: boolean;
}

const DEFAULT_STYLE: Style = {
  fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1,
  fillRule: 'nonzero', lineCap: 'butt', lineJoin: 'miter', miterLimit: 4, dash: null, dashOffset: 0, hidden: false,
};

function text(bytes: Uint8Array): string {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!doctype|<!entity/i.test(value)) throw new Error('SVG document types and entities are not supported.');
  return value;
}

function attributes(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    result[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? '');
  }
  return result;
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:quot|apos|lt|gt|amp);/g, (entity) => ({
    '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&',
  })[entity]!);
}

function number(value: string | undefined, fallback = 0): number {
  const result = value === undefined ? fallback : Number.parseFloat(value);
  return Number.isFinite(result) ? result : fallback;
}

function length(value: string | undefined, fallback: number): number {
  if (value === undefined || /%$/.test(value.trim())) return fallback;
  const amount = number(value, fallback), unit = value.trim().match(/[a-z]+$/i)?.[0]?.toLowerCase() ?? 'px';
  const scale = unit === 'in' ? 96 : unit === 'cm' ? 96 / 2.54 : unit === 'mm' ? 96 / 25.4 : unit === 'pt' ? 96 / 72 : unit === 'pc' ? 16 : 1;
  return amount * scale;
}

export function svgInfo(bytes: Uint8Array): SvgInfo {
  const source = text(bytes), root = /<svg\b([^>]*)>/i.exec(source);
  if (!root) throw new Error('The file has no SVG root element.');
  const attrs = attributes(root[1] ?? '');
  const values = (attrs.viewbox ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const validViewBox = values.length === 4 && values.every(Number.isFinite) && values[2]! > 0 && values[3]! > 0;
  const viewWidth = validViewBox ? values[2]! : 300, viewHeight = validViewBox ? values[3]! : 150;
  const width = length(attrs.width, viewWidth), height = length(attrs.height, viewHeight);
  if (!(width > 0 && height > 0 && width <= 30_000 && height <= 30_000)) throw new RangeError('Invalid SVG dimensions.');
  return { width, height, viewBox: validViewBox
    ? [values[0]!, values[1]!, values[2]!, values[3]!] : [0, 0, width, height] };
}

function clamp(value: number): number { return Math.min(1, Math.max(0, value)); }

function style(parent: Style, attrs: Record<string, string>): Style {
  const values: Record<string, string> = { ...attrs };
  for (const declaration of (attrs.style ?? '').split(';')) {
    const split = declaration.indexOf(':');
    if (split > 0) values[declaration.slice(0, split).trim().toLowerCase()] = declaration.slice(split + 1).trim();
  }
  const dashText = values['stroke-dasharray'];
  const dash = dashText === undefined ? parent.dash : dashText === 'none' ? null
    : dashText.split(/[\s,]+/).map(Number).filter((value) => value > 0 && Number.isFinite(value));
  return {
    fill: values.fill ?? parent.fill, stroke: values.stroke ?? parent.stroke,
    strokeWidth: Math.max(0, number(values['stroke-width'], parent.strokeWidth)),
    opacity: parent.opacity * clamp(number(values.opacity, 1)),
    fillOpacity: parent.fillOpacity * clamp(number(values['fill-opacity'], 1)),
    strokeOpacity: parent.strokeOpacity * clamp(number(values['stroke-opacity'], 1)),
    fillRule: values['fill-rule'] === 'evenodd' ? 'evenodd' : parent.fillRule,
    lineCap: values['stroke-linecap'] === 'round' || values['stroke-linecap'] === 'square' ? values['stroke-linecap'] : parent.lineCap,
    lineJoin: values['stroke-linejoin'] === 'round' || values['stroke-linejoin'] === 'bevel' ? values['stroke-linejoin'] : parent.lineJoin,
    miterLimit: Math.max(1, number(values['stroke-miterlimit'], parent.miterLimit)),
    dash: dash?.length ? (dash.length % 2 ? [...dash, ...dash] : dash) : null,
    dashOffset: number(values['stroke-dashoffset'], parent.dashOffset),
    hidden: parent.hidden || values.display === 'none' || values.visibility === 'hidden',
  };
}

function color(kit: CanvasKit, value: string, alpha: number): ReturnType<CanvasKit['Color']> | null {
  const source = value.trim().toLowerCase();
  if (source === 'none') return null;
  const names: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
    gray: '#808080', grey: '#808080', yellow: '#ffff00', magenta: '#ff00ff', fuchsia: '#ff00ff', cyan: '#00ffff', aqua: '#00ffff',
    transparent: '#00000000', currentcolor: '#000000',
  };
  const normalized = names[source] ?? source;
  let r = 0, g = 0, b = 0, a = 1;
  if (/^#[0-9a-f]{3,4}$/i.test(normalized)) {
    r = Number.parseInt(normalized[1]! + normalized[1]!, 16); g = Number.parseInt(normalized[2]! + normalized[2]!, 16);
    b = Number.parseInt(normalized[3]! + normalized[3]!, 16); if (normalized.length === 5) a = Number.parseInt(normalized[4]! + normalized[4]!, 16) / 255;
  } else if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(normalized)) {
    r = Number.parseInt(normalized.slice(1, 3), 16); g = Number.parseInt(normalized.slice(3, 5), 16); b = Number.parseInt(normalized.slice(5, 7), 16);
    if (normalized.length === 9) a = Number.parseInt(normalized.slice(7, 9), 16) / 255;
  } else {
    const rgb = /^rgba?\(([^)]+)\)$/.exec(normalized);
    if (!rgb) return null;
    const parts = rgb[1]!.split(/[\s,\/]+/).filter(Boolean);
    const channel = (entry: string | undefined): number => entry?.endsWith('%') ? number(entry) * 2.55 : number(entry);
    r = channel(parts[0]); g = channel(parts[1]); b = channel(parts[2]); a = parts[3]?.endsWith('%') ? number(parts[3]) / 100 : number(parts[3], 1);
  }
  return kit.Color(r, g, b, clamp(a * alpha));
}

function applyTransform(canvas: Canvas, source: string | undefined): void {
  if (!source) return;
  const expression = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  for (let match = expression.exec(source); match; match = expression.exec(source)) {
    const values = match[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (!values.every(Number.isFinite)) continue;
    switch (match[1]!.toLowerCase()) {
      case 'matrix': if (values.length >= 6) canvas.concat([values[0]!, values[2]!, values[4]!, values[1]!, values[3]!, values[5]!, 0, 0, 1]); break;
      case 'translate': canvas.translate(values[0] ?? 0, values[1] ?? 0); break;
      case 'scale': canvas.scale(values[0] ?? 1, values[1] ?? values[0] ?? 1); break;
      case 'rotate': canvas.rotate(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0); break;
      case 'skewx': canvas.skew(Math.tan((values[0] ?? 0) * Math.PI / 180), 0); break;
      case 'skewy': canvas.skew(0, Math.tan((values[0] ?? 0) * Math.PI / 180)); break;
    }
  }
}

function pathFor(kit: CanvasKit, tag: string, attrs: Record<string, string>): Path | null {
  let data = '';
  switch (tag) {
    case 'path': data = attrs.d ?? ''; break;
    case 'line': data = `M${number(attrs.x1)} ${number(attrs.y1)}L${number(attrs.x2)} ${number(attrs.y2)}`; break;
    case 'polyline': case 'polygon': {
      const points = (attrs.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (points.length < 4 || points.length % 2) return null;
      data = `M${points[0]} ${points[1]}`;
      for (let index = 2; index < points.length; index += 2) data += `L${points[index]} ${points[index + 1]}`;
      if (tag === 'polygon') data += 'Z';
      break;
    }
    default: return null;
  }
  return data ? kit.Path.MakeFromSVGString(data) : null;
}

function paint(kit: CanvasKit, styleValue: Style, fill: boolean): Paint | null {
  const resolved = color(kit, fill ? styleValue.fill : styleValue.stroke,
    styleValue.opacity * (fill ? styleValue.fillOpacity : styleValue.strokeOpacity));
  if (!resolved || (!fill && !(styleValue.strokeWidth > 0))) return null;
  const result = new kit.Paint();
  result.setAntiAlias(true); result.setColor(resolved); result.setStyle(fill ? kit.PaintStyle.Fill : kit.PaintStyle.Stroke);
  if (!fill) {
    result.setStrokeWidth(styleValue.strokeWidth); result.setStrokeMiter(styleValue.miterLimit);
    result.setStrokeCap(styleValue.lineCap === 'round' ? kit.StrokeCap.Round : styleValue.lineCap === 'square' ? kit.StrokeCap.Square : kit.StrokeCap.Butt);
    result.setStrokeJoin(styleValue.lineJoin === 'round' ? kit.StrokeJoin.Round : styleValue.lineJoin === 'bevel' ? kit.StrokeJoin.Bevel : kit.StrokeJoin.Miter);
    if (styleValue.dash) {
      const effect = kit.PathEffect.MakeDash([...styleValue.dash], styleValue.dashOffset);
      result.setPathEffect(effect); effect.delete();
    }
  }
  return result;
}

function drawShape(kit: CanvasKit, canvas: Canvas, tag: string, attrs: Record<string, string>, styleValue: Style): boolean {
  let path: Path | null = pathFor(kit, tag, attrs);
  const fill = paint(kit, styleValue, true), stroke = paint(kit, styleValue, false);
  try {
    if (path) {
      path.setFillType(styleValue.fillRule === 'evenodd' ? kit.FillType.EvenOdd : kit.FillType.Winding);
      if (fill) canvas.drawPath(path, fill); if (stroke) canvas.drawPath(path, stroke); return true;
    }
    if (tag === 'rect') {
      const rect = kit.XYWHRect(number(attrs.x), number(attrs.y), Math.max(0, number(attrs.width)), Math.max(0, number(attrs.height)));
      const rx = Math.max(0, number(attrs.rx)), ry = Math.max(0, number(attrs.ry, rx));
      if (fill) rx || ry ? canvas.drawRRect(kit.RRectXY(rect, rx, ry), fill) : canvas.drawRect(rect, fill);
      if (stroke) rx || ry ? canvas.drawRRect(kit.RRectXY(rect, rx, ry), stroke) : canvas.drawRect(rect, stroke);
      return true;
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const cx = number(attrs.cx), cy = number(attrs.cy), rx = Math.max(0, tag === 'circle' ? number(attrs.r) : number(attrs.rx));
      const ry = Math.max(0, tag === 'circle' ? number(attrs.r) : number(attrs.ry));
      const oval = kit.LTRBRect(cx - rx, cy - ry, cx + rx, cy + ry);
      if (fill) canvas.drawOval(oval, fill); if (stroke) canvas.drawOval(oval, stroke); return true;
    }
    return false;
  } finally { path?.delete(); fill?.delete(); stroke?.delete(); }
}

function raster(surface: Surface, kit: CanvasKit, width: number, height: number): Raster {
  const pixels = surface.getCanvas().readPixels(0, 0, { width, height, colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB });
  if (!(pixels instanceof Uint8Array)) throw new Error('CanvasKit SVG readback failed.');
  const cols = Math.ceil(width / TILE), rows = Math.ceil(height / TILE), tiles: Uint8Array[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const tw = Math.min(TILE, width - col * TILE), th = Math.min(TILE, height - row * TILE), tile = new Uint8Array(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const from = ((row * TILE + y) * width + col * TILE) * 4;
      tile.set(pixels.subarray(from, from + tw * 4), y * tw * 4);
    }
    tiles.push(tile);
  }
  return new Raster(width, height, 4, tiles);
}

/** Renders supported SVG geometry identically in every host; never calls Canvas2D or drawImage(svg). */
export function renderSvg(bytes: Uint8Array, width: number, height: number, engine: TextEngine): SvgRenderResult {
  if (!(width >= 1 && height >= 1 && width <= 30_000 && height <= 30_000 && width * height <= 100_000_000)) {
    throw new RangeError('SVG render dimensions exceed the document limits.');
  }
  const info = svgInfo(bytes), source = text(bytes), kit = (engine as CanvasKitEngine).kit;
  if (!kit?.MakeSurface) throw new Error('The loaded vector engine does not expose CanvasKit raster surfaces.');
  const surface = kit.MakeSurface(Math.ceil(width), Math.ceil(height));
  if (!surface) throw new Error(`CanvasKit could not allocate an SVG surface of ${width}×${height}.`);
  const canvas = surface.getCanvas(), unsupported = new Set<string>(), stack: { tag: string; style: Style }[] = [];
  let suppressed = 0;
  try {
    for (const tag of ['lineargradient', 'radialgradient', 'clippath', 'mask', 'pattern', 'filter', 'text', 'image', 'use', 'symbol']) {
      if (new RegExp(`<${tag}\\b`, 'i').test(source)) unsupported.add(tag);
    }
    if (/\b(?:fill|stroke)\s*=\s*["']url\s*\(/i.test(source)) unsupported.add('paint-server');
    const rootAttributes = attributes(/<svg\b([^>]*)>/i.exec(source)?.[1] ?? '');
    if (rootAttributes.preserveaspectratio && !/^xmidymid\s+meet$/i.test(rootAttributes.preserveaspectratio.trim())) {
      unsupported.add('preserveaspectratio');
    }
    canvas.clear(kit.TRANSPARENT);
    const [vx, vy, vw, vh] = info.viewBox, scale = Math.min(width / vw, height / vh);
    const left = (width - vw * scale) / 2, top = (height - vh * scale) / 2;
    canvas.translate(left, top); canvas.scale(scale, scale); canvas.translate(-vx, -vy);
    const tokens = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)([^>]*)>/g;
    for (let match = tokens.exec(source); match; match = tokens.exec(source)) {
      if (match[0]!.startsWith('<!--')) continue;
      const closing = match[0]![1] === '/', tag = (match[1] ?? '').toLowerCase();
      const selfClosing = /\/\s*>$/.test(match[0]!);
      if (suppressed) {
        if (closing) suppressed--; else if (!selfClosing) suppressed++;
        continue;
      }
      if (closing) {
        if (tag === 'g' || (tag === 'svg' && stack.length > 1)) { canvas.restore(); stack.pop(); }
        continue;
      }
      const attrs = attributes(match[2] ?? ''), parent = stack.at(-1)?.style ?? DEFAULT_STYLE, current = style(parent, attrs);
      if (tag === 'svg') {
        if (stack.length) { unsupported.add('nested-svg'); if (!selfClosing) suppressed = 1; continue; }
        stack.push({ tag, style: current }); continue;
      }
      if (tag === 'g') {
        canvas.save(); applyTransform(canvas, attrs.transform); stack.push({ tag, style: current });
        if (selfClosing) { canvas.restore(); stack.pop(); }
        continue;
      }
      if (['title', 'desc', 'metadata'].includes(tag)) { if (!selfClosing) suppressed = 1; continue; }
      if (['defs', 'lineargradient', 'radialgradient', 'clippath', 'mask', 'pattern', 'filter', 'text', 'symbol'].includes(tag)) {
        if (tag !== 'defs') unsupported.add(tag);
        if (!selfClosing) suppressed = 1;
        continue;
      }
      if (['stop', 'image', 'use'].includes(tag)) {
        unsupported.add(tag); continue;
      }
      if (current.hidden) continue;
      canvas.save(); applyTransform(canvas, attrs.transform);
      if (!drawShape(kit, canvas, tag, attrs, current) && !['style'].includes(tag)) unsupported.add(tag);
      canvas.restore();
    }
    return { raster: raster(surface, kit, Math.ceil(width), Math.ceil(height)), info, unsupported: [...unsupported].sort() };
  } finally { surface.delete(); }
}
