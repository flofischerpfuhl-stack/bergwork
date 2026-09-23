/**
 * Crop tool, Canvas Size, Image Size and Distort Apply (Crop.swift, CanvasSize.swift, ImageResizer,
 * CropControls/CanvasSizeSheet/ImageSizeSheet, EditorCanvas crop dragging). Heavy work runs in the
 * operations worker; results install as one undo step and fit the view like applyDocumentSize.
 */

import { useState } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { useSession } from '../ui/hooks';
import { NumberField } from '../ui/ContextBar';
import {
  applyCropRatio, applyCropSnap, canvasSizeDraftValid, cropRatioChoice, cropSnapTargets, displayedCanvasDimension,
  makeCanvasSizeDraft, setCanvasDimension, updateCropDrag, validCropRect,
  type CanvasExtensionColor, type CanvasUnit, type CropDrag, type CropRatioChoice, type ImageResample,
} from '../core/canvasOps';
import { maskBackground } from '../core/distort';
import { HANDLES, LAYER_SAMPLINGS, type LayerSampling, type LayerTransform, type Point, type Rect } from '../core/geometry';
import type { Raster } from '../core/raster';
import type { EditorSession } from '../core/session';
import { documentFromTransfer, documentToTransfer, rasterFromTransfer, rasterToTransfer } from '../core/transfer';
import { runInWorker } from '../workers/opsClient';
import type { OpsRequest } from '../workers/opsProtocol';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';

const RATIOS: CropRatioChoice[] = ['Free', 'Original', '1:1', '4:3', '16:9'];

/** Runs a document operation in the worker and installs the result as one undo step. */
async function applyDocumentOp(controller: EditorController, session: EditorSession, name: string, request: (doc: ReturnType<typeof documentToTransfer>) => OpsRequest): Promise<boolean> {
  const document = session.document;
  if (!document || !session.canStartProjectOperation) return false;
  session.isProjectBusy = true;
  session.notify('ui');
  try {
    const response = await runInWorker(request(documentToTransfer(document)));
    if (!response.ok || !response.document) throw new Error(response.ok ? 'No result' : response.error);
    // A document replaced meanwhile (undo, another operation) must not receive a stale result.
    if (session.document !== document) return false;
    const next = documentFromTransfer(response.document, document);
    session.isProjectBusy = false;
    session.beginEdit(name);
    session.replaceDocument(next);
    session.endEdit();
    session.viewport.fit(next);
    session.notify('view');
    return true;
  } catch (error) {
    controller.reportError('operation-failed', error);
    return false;
  } finally {
    session.isProjectBusy = false;
    session.notify('ui');
  }
}

async function commitCrop(controller: EditorController, session: EditorSession): Promise<void> {
  const rect = session.cropRect;
  if (!rect || !validCropRect(rect)) return;
  const ok = await applyDocumentOp(controller, session, 'Crop', (document) => ({ op: 'crop', document, rect, options: {} }));
  if (ok) session.cropRect = null;
  session.notify('document');
}

function cropViewRect(session: EditorSession): Rect | null {
  const rect = session.cropRect, document = session.document;
  if (session.tool !== 'crop' || !rect || !document) return null;
  const origin = session.viewport.viewPoint({ x: rect.x, y: rect.y }, document);
  const ppp = session.viewport.pointsPerPixel;
  return { x: origin.x, y: origin.y, width: rect.width * ppp, height: rect.height * ppp };
}

/** Regions that resize the crop: corner squares and whole edges (TransformOverlay.cropResizeRegions). */
function cropHandleAt(session: EditorSession, point: Point, radius: number): number | null {
  const rect = cropViewRect(session);
  if (!rect) return null;
  const handles = HANDLES.map((h) => ({ x: rect.x + h.x * rect.width, y: rect.y + h.y * rect.height }));
  for (const index of [0, 2, 4, 6]) {
    const h = handles[index]!;
    if (Math.abs(point.x - h.x) <= radius && Math.abs(point.y - h.y) <= radius) return index;
  }
  for (const index of [1, 5]) {
    const h = handles[index]!;
    if (point.x >= rect.x + radius && point.x <= rect.x + rect.width - radius && Math.abs(point.y - h.y) <= radius) return index;
  }
  for (const index of [3, 7]) {
    const h = handles[index]!;
    if (point.y >= rect.y + radius && point.y <= rect.y + rect.height - radius && Math.abs(point.x - h.x) <= radius) return index;
  }
  return null;
}

class CropTool implements ToolHandler {
  private drag: CropDrag | null = null;
  private snap: { xs: number[]; ys: number[]; tolerance: number } | null = null;
  constructor(private readonly controller: EditorController) {}

  down(c: ToolContext): void {
    const session = c.session;
    const document = session.document;
    if (!document || session.isProjectBusy) return;
    const rect = session.cropRect ?? { x: c.pixel.x, y: c.pixel.y, width: 0, height: 0 };
    const handle = cropHandleAt(session, c.point, c.pointerType === 'touch' ? 22 : 10);
    const full = rect.x === 0 && rect.y === 0 && rect.width === document.width && rect.height === document.height;
    let mode: CropDrag['mode'];
    if (handle !== null) mode = { kind: 'resize', handle };
    else if (session.cropRect && !full && c.pixel.x >= rect.x && c.pixel.x <= rect.x + rect.width && c.pixel.y >= rect.y && c.pixel.y <= rect.y + rect.height) mode = { kind: 'move' };
    else { mode = { kind: 'create' }; session.cropRect = null; }
    this.drag = { start: c.pixel, original: rect, mode };
    const targets = cropSnapTargets(document);
    this.snap = { ...targets, tolerance: 8 / Math.max(session.viewport.pointsPerPixel, 0.0001) };
  }
  move(c: ToolContext): void {
    const drag = this.drag, session = c.session, document = session.document;
    if (!drag || !document) return;
    const ratio = cropRatioChoice(session.cropRatioChoice as CropRatioChoice, document);
    let next = updateCropDrag(drag, c.pixel, ratio, c.modifiers.option);
    if (this.snap && !c.modifiers.control) next = applyCropSnap(next, drag, c.pixel, ratio, this.snap, c.modifiers.option);
    if (validCropRect(next)) {
      const inside = (r: { x: number; y: number; width: number; height: number } | null) =>
        !!r && r.x >= 0 && r.y >= 0 && r.x + r.width <= document.width && r.y + r.height <= document.height;
      // Within the canvas only the frame moves; past its edge the shown region grows, so the canvas redraws.
      this.lastOverlayOnly = inside(session.cropRect) && inside(next);
      session.cropRect = next;
      session.notify(this.lastOverlayOnly ? 'overlay' : 'document');
    }
  }
  private lastOverlayOnly = false;
  overlayOnly(): boolean { return this.lastOverlayOnly; }
  up(c: ToolContext): void {
    this.drag = null;
    if (!c.session.cropRect && c.session.document) {
      c.session.cropRect = { x: 0, y: 0, width: c.session.document.width, height: c.session.document.height };
    }
    c.session.notify('document');
  }
  cancel(session: EditorSession): void {
    if (this.drag) { session.cropRect = this.drag.original.width ? this.drag.original : null; session.notify('document'); }
    this.drag = null;
  }
  hover(c: ToolContext): string {
    const handle = cropHandleAt(c.session, c.point, 10);
    if (handle !== null) return handle === 1 || handle === 5 ? 'ns-resize' : handle === 3 || handle === 7 ? 'ew-resize' : handle === 0 || handle === 4 ? 'nwse-resize' : 'nesw-resize';
    return 'crosshair';
  }
}

function paintCrop(context: CanvasRenderingContext2D, session: EditorSession): void {
  const rect = cropViewRect(session);
  if (!rect) return;
  const canvas = context.canvas;
  const dpr = window.devicePixelRatio || 1;
  context.beginPath();
  context.rect(0, 0, canvas.width / dpr, canvas.height / dpr);
  context.rect(rect.x, rect.y, rect.width, rect.height);
  context.fillStyle = 'rgba(0,0,0,0.6)';
  context.fill('evenodd');
  context.strokeStyle = '#fff';
  context.lineWidth = 1;
  context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  context.strokeStyle = 'rgba(255,255,255,0.4)';
  context.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    context.moveTo(rect.x + rect.width * f, rect.y); context.lineTo(rect.x + rect.width * f, rect.y + rect.height);
    context.moveTo(rect.x, rect.y + rect.height * f); context.lineTo(rect.x + rect.width, rect.y + rect.height * f);
  }
  context.stroke();
  context.fillStyle = '#fff';
  context.strokeStyle = '#000';
  const touch = matchMedia('(pointer: coarse)').matches;
  const half = touch ? 7 : 4;
  for (const h of HANDLES) {
    const x = rect.x + h.x * rect.width, y = rect.y + h.y * rect.height;
    context.fillRect(x - half, y - half, half * 2, half * 2);
    context.strokeRect(x - half, y - half, half * 2, half * 2);
  }
}

function CropBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const t = controller.t;
  const rect = session.cropRect;
  return (
    <>
      <span className={styles.headerTitle}>{t('Crop')}</span>
      <select className={styles.select} value={session.cropRatioChoice} aria-label={t('Ratio')} disabled={session.isProjectBusy || !session.document}
        onChange={(event) => {
          session.cropRatioChoice = event.target.value;
          const document = session.document;
          const ratio = document ? cropRatioChoice(event.target.value as CropRatioChoice, document) : null;
          if (rect && ratio) { const next = applyCropRatio(rect, ratio); if (validCropRect(next)) session.cropRect = next; }
          session.notify('document');
        }}>
        {RATIOS.map((r) => <option key={r} value={r}>{t(r)}</option>)}
      </select>
      {rect ? <span className={styles.secondary} style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(rect.width)} × {Math.round(rect.height)} px</span> : null}
      <span className={styles.spacer} />
      <button type="button" className={styles.pill} disabled={!rect || session.isProjectBusy} onClick={() => session.cancelCrop()}>{t('Cancel')}</button>
      <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!rect || session.isProjectBusy} data-testid="applyCrop"
        onClick={() => void commitCrop(controller, session)}>{t('Apply Crop')}</button>
    </>
  );
}

const ANCHORS = ['Top left', 'Top center', 'Top right', 'Middle left', 'Center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'];
const UNITS: CanvasUnit[] = ['Pixels', 'Percent', 'Inches', 'Centimeters'];

function bytes(width: number, height: number): string {
  const value = width * height * 4;
  return value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : value >= 1e6 ? `${(value / 1e6).toFixed(1)} MB` : `${Math.round(value / 1e3)} KB`;
}

function CanvasSizeDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const t = controller.t;
  const session = controller.session;
  const document = session.document!;
  const [draft, setDraft] = useState(() => makeCanvasSizeDraft(document.width, document.height, document.resolution));
  const [anchor, setAnchor] = useState(4);
  const [extension, setExtension] = useState('Transparent');
  const [custom, setCustom] = useState('#ffffff');
  const valid = canvasSizeDraftValid(draft);
  const fill = (): CanvasExtensionColor | null => {
    const hex = (h: string) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
    switch (extension) {
      case 'Transparent': return null;
      case 'Black': return { red: 0, green: 0, blue: 0 };
      case 'White': return { red: 1, green: 1, blue: 1 };
      case 'Foreground': return session.foregroundColor;
      case 'Background': return session.backgroundColor;
      default: return hex(custom);
    }
  };
  const w = Math.round(draft.width), h = Math.round(draft.height);
  return (
    <form className={styles.dialog} role="dialog" aria-modal aria-label={t('Canvas Size…')} onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      close();
      void applyDocumentOp(controller, session, 'Canvas Size', (doc) => ({ op: 'canvasSize', document: doc, width: w, height: h, anchor, options: { fill: fill(), extensionName: session.label('Canvas Extension') } }));
    }}>
      <h2 className={styles.dialogTitle}>{t('Canvas Size…').replace('…', '')}</h2>
      <span>{`Current: ${document.width} × ${document.height} pixels`}</span>
      <span className={styles.secondary}>{bytes(document.width, document.height)} uncompressed RGBA canvas</span>
      <label className={styles.appearanceRow}><span style={{ width: 70 }}>Units</span>
        <select className={styles.select} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as CanvasUnit })}>
          {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </select></label>
      <NumberField label={t('Width')} value={displayedCanvasDimension(draft, true)} width={110} testId="canvasSizeWidth" onChange={(v) => setDraft(setCanvasDimension(draft, v, true))} />
      <NumberField label={t('Height')} value={displayedCanvasDimension(draft, false)} width={110} testId="canvasSizeHeight" onChange={(v) => setDraft(setCanvasDimension(draft, v, false))} />
      <label className={styles.check}><input type="checkbox" checked={draft.relative} onChange={(e) => setDraft({ ...draft, relative: e.target.checked })} />Relative to current dimensions</label>
      <label className={styles.check}><input type="checkbox" checked={draft.locked} onChange={(e) => {
        const next = { ...draft, locked: e.target.checked };
        setDraft(e.target.checked ? setCanvasDimension(next, displayedCanvasDimension(next, true), true) : next);
      }} />Lock original aspect ratio</label>
      <span className={valid ? styles.secondary : styles.warning}>{valid ? `New: ${w} × ${h} pixels · ${bytes(w, h)} uncompressed` : 'Final dimensions must be 1–30,000 pixels per side.'}</span>
      <div style={{ display: 'flex', gap: 24 }}>
        <div role="radiogroup" aria-label="Anchor" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 28px)', gap: 3 }}>
          {ANCHORS.map((name, index) => (
            <button key={name} type="button" role="radio" aria-checked={anchor === index} aria-label={name} title={name}
              className={`${styles.iconButton} ${anchor === index ? styles.iconButtonOn : ''}`} style={{ minWidth: 28, height: 28 }}
              onClick={() => setAnchor(index)}>{anchor === index ? '●' : '○'}</button>
          ))}
        </div>
        <div><strong>{ANCHORS[anchor]}</strong><p className={styles.dialogMessage}>Keeps this point fixed. Artwork is not scaled; cropped content remains outside the canvas.</p></div>
      </div>
      <label className={styles.appearanceRow}><span style={{ width: 120 }}>Canvas extension</span>
        <select className={styles.select} value={extension} onChange={(e) => setExtension(e.target.value)}>
          {['Transparent', 'Foreground', 'Background', 'Black', 'White', 'Custom'].map((x) => <option key={x}>{x}</option>)}
        </select>
        {extension === 'Custom' ? <input type="color" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Extension color" /> : null}
      </label>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close}>{t('Cancel')}</button>
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!valid} data-testid="canvasSizeOK">{t('OK')}</button>
      </div>
    </form>
  );
}

function ImageSizeDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const t = controller.t;
  const session = controller.session;
  const document = session.document!;
  const [width, setWidth] = useState(document.width);
  const [height, setHeight] = useState(document.height);
  const [resolution, setResolution] = useState(document.resolution);
  const [locked, setLocked] = useState(true);
  const [resample, setResample] = useState(true);
  const [unit, setUnit] = useState<CanvasUnit>('Pixels');
  const [sampling, setSampling] = useState<LayerSampling>('High quality');
  const valid = [width, height, resolution].every(Number.isFinite) && resolution >= 1 && resolution <= 9600
    && Math.round(width) >= 1 && Math.round(width) <= 30000 && Math.round(height) >= 1 && Math.round(height) <= 30000
    && (!resample || Math.round(width) * Math.round(height) <= 100_000_000);
  const display = (pixels: number, original: number) => unit === 'Percent' ? pixels / original * 100 : unit === 'Inches' ? pixels / resolution
    : unit === 'Centimeters' ? pixels / resolution * 2.54 : pixels;
  const set = (value: number, isWidth: boolean) => {
    if (!Number.isFinite(value) || value <= 0) return;
    if (!resample) { setResolution((isWidth ? width : height) / value * (unit === 'Centimeters' ? 2.54 : 1)); return; }
    const original = isWidth ? document.width : document.height;
    const pixels = unit === 'Percent' ? value / 100 * original : unit === 'Inches' ? value * resolution : unit === 'Centimeters' ? value / 2.54 * resolution : value;
    if (isWidth) { if (locked) setHeight(pixels * height / width); setWidth(pixels); }
    else { if (locked) setWidth(pixels * width / height); setHeight(pixels); }
  };
  return (
    <form className={styles.dialog} role="dialog" aria-modal aria-label={t('Image Size…')} onSubmit={(event) => {
      event.preventDefault();
      if (!valid) return;
      close();
      const mode: ImageResample = resample ? sampling : false;
      void applyDocumentOp(controller, session, 'Image Size', (doc) => ({ op: 'imageSize', document: doc,
        width: Math.round(width), height: Math.round(height), resolution, resample: mode }));
    }}>
      <h2 className={styles.dialogTitle}>{t('Image Size…').replace('…', '')}</h2>
      <span className={styles.secondary}>{`Current: ${document.width} × ${document.height} pixels`}</span>
      <label className={styles.appearanceRow}><span style={{ width: 70 }}>Units</span>
        <select className={styles.select} value={unit} onChange={(e) => setUnit(e.target.value as CanvasUnit)}>
          {UNITS.filter((u) => resample || (u !== 'Pixels' && u !== 'Percent')).map((u) => <option key={u}>{u}</option>)}
        </select></label>
      <NumberField label={t('Width')} value={display(width, document.width)} width={110} testId="imageSizeWidth" onChange={(v) => set(v, true)} />
      <NumberField label={t('Height')} value={display(height, document.height)} width={110} testId="imageSizeHeight" onChange={(v) => set(v, false)} />
      <label className={styles.check}><input type="checkbox" checked={locked} disabled={!resample} onChange={(e) => setLocked(e.target.checked)} />Lock aspect ratio</label>
      <NumberField label="Resolution" suffix="pixels/inch" value={resolution} width={90} onChange={(v) => {
        if (resample && (unit === 'Inches' || unit === 'Centimeters') && resolution > 0 && v > 0) { setWidth(width * v / resolution); setHeight(height * v / resolution); }
        setResolution(v);
      }} />
      <label className={styles.check}><input type="checkbox" checked={resample} onChange={(e) => {
        setResample(e.target.checked);
        if (!e.target.checked) { setWidth(document.width); setHeight(document.height); setLocked(true); if (unit === 'Pixels' || unit === 'Percent') setUnit('Inches'); }
      }} />Resample</label>
      {resample ? (
        <>
          <label className={styles.appearanceRow}><span style={{ width: 70 }}>{t('Sampling')}</span>
            <select className={styles.select} value={sampling} onChange={(e) => setSampling(e.target.value as LayerSampling)}>
              {LAYER_SAMPLINGS.map((s) => <option key={s} value={s}>{t(s)}</option>)}
            </select></label>
          <span className={styles.secondary}>Resizes layer pixels and applies existing transforms. Undo restores the originals.</span>
        </>
      ) : <span className={styles.secondary}>Only print dimensions and resolution change. Pixels stay unchanged.</span>}
      <span className={valid ? styles.secondary : styles.warning}>{valid ? `Result: ${Math.round(width)} × ${Math.round(height)} pixels`
        : 'Use 1–30,000 pixels per side, up to 100 megapixels, and 1–9,600 pixels/inch.'}</span>
      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close}>{t('Cancel')}</button>
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!valid} data-testid="imageSizeOK">Resize</button>
      </div>
    </form>
  );
}

export function installCanvasOps(controller: EditorController): void {
  controller.availableTools.add('crop');
  controller.canvasSetups.push((view) => {
    view.tools.crop = new CropTool(controller);
    view.painters.push((context, session) => paintCrop(context, session));
  });
  controller.contextBars.crop = (session) => <CropBar controller={controller} session={session} />;
  controller.statusHints.crop = () => controller.t('Drag to crop · Enter apply · Escape cancel · Space to pan');
  controller.keyHandlers.push((event) => {
    const session = controller.session;
    if (session.tool !== 'crop' || !session.cropRect) return false;
    if (event.key === 'Escape') { session.cancelCrop(); return true; }
    if (event.key === 'Enter') { void commitCrop(controller, session); return true; }
    return false;
  });
  controller.dialogs.canvasSize = (close) => <CanvasSizeDialog controller={controller} close={close} />;
  controller.dialogs.imageSize = (close) => <ImageSizeDialog controller={controller} close={close} />;
  controller.features.canvasSize = { enabled: () => !!controller.session.document && controller.workspace.canSwitch, run: () => controller.showDialog({ kind: 'canvasSize' }) };
  controller.features.imageSize = { enabled: () => !!controller.session.document && controller.workspace.canSwitch, run: () => controller.showDialog({ kind: 'imageSize' }) };
  // Distort Apply resamples pixels into the quadrilateral in the worker.
  const distort = async (raster: Raster, transform: LayerTransform, corners: readonly Point[]) => {
    const mask = raster.channels === 1;
    const response = await runInWorker({ op: 'warp', raster: rasterToTransfer(raster), transform, corners: corners.map((p) => ({ ...p })), mask, background: mask ? maskBackground(raster) : 0 });
    if (!response.ok || !response.raster || !response.transform) throw new Error(response.ok ? 'No result' : response.error);
    return { raster: rasterFromTransfer(response.raster), transform: response.transform };
  };
  const services = controller.workspace.services;
  if (services) services.distort = distort;
}
