import { useState } from 'react';
import styles from '../ui/editor.module.css';
import type { EditorController } from '../ui/controller';
import { NumberField } from '../ui/ContextBar';
import { useSession } from '../ui/hooks';
import type { EditorSession } from '../core/session';
import type { Point } from '../core/geometry';
import { createMeshWarp, meshColumns, meshPoint, meshPreset, meshRows, type WarpPreset } from '../core/meshWarp';
import { detectStraightenAngle, straightenDocument } from '../core/straighten';
import { WarpStroke, type WarpMode } from '../core/retouch';
import type { Raster } from '../core/raster';
import type { ToolContext, ToolHandler } from '../ui/canvas/tools';
import { FloatingPanel } from './panels';

const PRESETS: readonly WarpPreset[] = ['custom', 'arc', 'flag', 'bulge', 'wave', 'fish', 'rise', 'inflate', 'squeeze'];

interface WarpDrag {
  readonly layerId: string;
  readonly index: number;
  readonly original: import('../core/model').LayerWarp | null;
  mesh: import('../core/model').WarpMesh;
}

class MeshWarpTool implements ToolHandler {
  private drag: WarpDrag | null = null;
  down(c: ToolContext): void {
    const layer = c.session.activeLayer, document = c.session.document;
    if (!layer || !document || layer.kind === 'group' || !c.session.displayedRaster(layer)) return;
    const mesh = layer.warp?.kind === 'mesh' ? layer.warp : createMeshWarp(layer.transform);
    let index = -1, distance = c.pointerType === 'touch' ? 22 : 11;
    mesh.points.forEach((point, candidate) => {
      const view = c.session.viewport.viewPoint(point, document), d = Math.hypot(view.x - c.point.x, view.y - c.point.y);
      if (d <= distance) { distance = d; index = candidate; }
    });
    if (index >= 0) this.drag = { layerId: layer.id, index, original: layer.warp, mesh };
  }
  move(c: ToolContext): void {
    if (!this.drag) return;
    const points = this.drag.mesh.points.slice(); points[this.drag.index] = { ...c.pixel };
    this.drag.mesh = { ...this.drag.mesh, points, preset: 'custom' };
    c.session.previewLayerWarp(this.drag.layerId, this.drag.mesh);
  }
  up(c: ToolContext): void {
    const drag = this.drag; this.drag = null;
    if (drag) c.session.commitLayerWarp(drag.layerId, drag.original, drag.mesh, 'Warp');
  }
  cancel(session: EditorSession): void {
    const drag = this.drag; this.drag = null;
    if (drag) session.previewLayerWarp(drag.layerId, drag.original);
  }
  hover(): string { return 'move'; }
}

function paintMesh(context: CanvasRenderingContext2D, session: EditorSession): void {
  if (session.tool !== 'warp') return;
  const layer = session.activeLayer, document = session.document;
  if (!layer || !document || layer.kind === 'group') return;
  const mesh = layer.warp?.kind === 'mesh' ? layer.warp : createMeshWarp(layer.transform);
  const view = (point: Point) => session.viewport.viewPoint(point, document);
  context.strokeStyle = '#43a7ff'; context.lineWidth = 1; context.beginPath();
  const curve = (fixed: number, vertical: boolean) => {
    for (let step = 0; step <= 32; step++) {
      const value = step / 32, p = view(meshPoint(mesh, vertical ? { x: fixed, y: value } : { x: value, y: fixed }));
      if (step) context.lineTo(p.x, p.y); else context.moveTo(p.x, p.y);
    }
  };
  for (let x = 0; x <= mesh.splits.x; x++) curve(x / mesh.splits.x, true);
  for (let y = 0; y <= mesh.splits.y; y++) curve(y / mesh.splits.y, false);
  context.stroke();
  const columns = meshColumns(mesh), rows = meshRows(mesh);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const point = view(mesh.points[row * columns + column]!);
    const anchor = row % 3 === 0 && column % 3 === 0;
    context.fillStyle = anchor ? '#fff' : '#43a7ff'; context.strokeStyle = '#111';
    context.beginPath(); context.arc(point.x, point.y, anchor ? 4.5 : 3, 0, Math.PI * 2); context.fill(); context.stroke();
  }
}

function WarpBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session);
  const [amount, setAmount] = useState(25), layer = session.activeLayer, t = controller.t;
  const mesh = layer?.warp?.kind === 'mesh' ? layer.warp : null;
  const apply = (preset: WarpPreset, splits = mesh?.splits ?? { x: 1, y: 1 }) => {
    if (!layer || layer.kind === 'group') return;
    const next = preset === 'custom' ? createMeshWarp(layer.transform, splits)
      : meshPreset(layer.transform, preset, amount / 100, splits);
    session.commitLayerWarp(layer.id, layer.warp, next, 'Warp');
  };
  return <>
    <span className={styles.headerTitle}>{t('Warp')}</span>
    <label className={styles.field}><span>{t('Preset')}</span><select className={styles.select} data-testid="warp-preset"
      value={mesh?.preset ?? 'custom'} onChange={(event) => apply(event.target.value as WarpPreset)}>
      {PRESETS.map((preset) => <option key={preset} value={preset}>{t(preset[0]!.toUpperCase() + preset.slice(1))}</option>)}</select></label>
    <NumberField label={t('Bend')} suffix="%" value={amount} width={64} onChange={(value) => setAmount(Math.max(-100, Math.min(100, value)))} />
    <label className={styles.field}><span>{t('Grid')}</span><select className={styles.select} data-testid="warp-grid"
      value={`${mesh?.splits.x ?? 1}x${mesh?.splits.y ?? 1}`} onChange={(event) => {
        const [x, y] = event.target.value.split('x').map(Number); if (x && y) apply('custom', { x, y });
      }}><option value="1x1">4 × 4</option><option value="2x2">7 × 7</option><option value="3x3">10 × 10</option></select></label>
    <button type="button" className={styles.pill} disabled={!layer?.warp} onClick={() => layer && session.commitLayerWarp(layer.id, layer.warp, null, 'Remove Warp')}>{t('Remove Warp')}</button>
  </>;
}

const straightenLines = new WeakMap<EditorSession, { start: Point; end: Point }>();

function applyStraighten(session: EditorSession, angle: number): boolean {
  const document = session.document;
  if (!document || !Number.isFinite(angle) || Math.abs(angle) < 0.005) return false;
  session.beginEdit('Straighten');
  try { session.replaceDocument(straightenDocument(document, angle)); }
  finally { session.endEdit(); }
  session.viewport.fit(session.document!); session.notify('document');
  return true;
}

class StraightenTool implements ToolHandler {
  down(c: ToolContext): void { straightenLines.set(c.session, { start: c.pixel, end: c.pixel }); c.session.notify('overlay'); }
  move(c: ToolContext): void { const line = straightenLines.get(c.session); if (line) { line.end = c.pixel; c.session.notify('overlay'); } }
  up(c: ToolContext): void {
    const line = straightenLines.get(c.session); straightenLines.delete(c.session);
    if (line) applyStraighten(c.session, Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x) * 180 / Math.PI);
  }
  cancel(session: EditorSession): void { straightenLines.delete(session); session.notify('overlay'); }
  hover(): string { return 'crosshair'; }
}

function paintStraighten(context: CanvasRenderingContext2D, session: EditorSession): void {
  const line = straightenLines.get(session), document = session.document;
  if (!line || !document) return;
  const a = session.viewport.viewPoint(line.start, document), b = session.viewport.viewPoint(line.end, document);
  context.strokeStyle = '#43a7ff'; context.lineWidth = 2; context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
}

function StraightenBar({ controller, session }: { controller: EditorController; session: EditorSession }) {
  useSession(session); const t = controller.t;
  return <><span className={styles.headerTitle}>{t('Straighten')}</span><span>{t('Draw along the horizon')}</span>
    <button type="button" className={styles.pill} data-testid="straighten-auto" disabled={!session.activeLayer?.raster}
      onClick={() => { const raster = session.activeLayer?.raster; if (raster) { const angle = detectStraightenAngle(raster); if (angle !== null) applyStraighten(session, angle); } }}>{t('Auto')}</button></>;
}

interface LiquifyState {
  readonly layerId: string;
  readonly original: Raster;
  readonly transform: import('../core/geometry').LayerTransform;
  working: Raster;
  mode: Exclude<WarpMode, 'smudge' | 'liquify'>;
  size: number;
  pressure: number;
  density: number;
  stroke: WarpStroke | null;
}
const liquify = new WeakMap<EditorSession, LiquifyState>();
const liquifyPreviewInstalled = new WeakSet<EditorSession>();

function ensureLiquifyPreview(session: EditorSession): void {
  if (liquifyPreviewInstalled.has(session)) return;
  liquifyPreviewInstalled.add(session);
  session.previewSources.push((value) => { const state = liquify.get(value); return state
    ? { layerId: state.layerId, mask: false, raster: state.stroke?.currentRaster() ?? state.working, transform: state.transform } : null; });
}

function openLiquify(session: EditorSession): boolean {
  const layer = session.activeLayer;
  if (!layer?.raster || session.editBlocker(layer.id, 'pixels')) return false;
  ensureLiquifyPreview(session);
  liquify.set(session, { layerId: layer.id, original: layer.raster, working: layer.raster, transform: layer.transform,
    mode: 'push', size: 100, pressure: 0.5, density: 0.5, stroke: null });
  session.selectTool('liquify'); session.notify('document'); return true;
}

function closeLiquify(session: EditorSession, apply: boolean): void {
  const state = liquify.get(session); if (!state) return;
  state.stroke?.cancel(); liquify.delete(session);
  if (apply && state.working !== state.original) session.replaceLayerPixels(state.layerId, state.working, 'Liquify', state.transform);
  session.selectTool('move'); session.notify('document');
}

class LiquifyTool implements ToolHandler {
  down(c: ToolContext): void {
    const state = liquify.get(c.session); if (!state) return;
    state.stroke = new WarpStroke(state.working, state.transform, state.mode,
      { diameter: state.size, hardness: 0.15, strength: state.pressure * (c.pressure ?? 1), density: state.density },
      c.session.selection, state.original);
    state.stroke.addPoints([c.pixel]); c.session.notify('document');
  }
  move(c: ToolContext): void { const state = liquify.get(c.session); if (state?.stroke) { state.stroke.addPoints([c.pixel]); c.session.notify('document'); } }
  up(c: ToolContext): void { const state = liquify.get(c.session); if (state?.stroke) { state.working = state.stroke.finish(); state.stroke = null; c.session.notify('document'); } }
  cancel(session: EditorSession): void { const state = liquify.get(session); state?.stroke?.cancel(); if (state) state.stroke = null; session.notify('document'); }
  hover(): string { return 'none'; }
  hydrationBounds(c: ToolContext): import('../core/geometry').Rect {
    const radius = (liquify.get(c.session)?.size ?? 100) / 2 + 3;
    return { x: c.pixel.x - radius, y: c.pixel.y - radius, width: radius * 2, height: radius * 2 };
  }
}

function LiquifyPanel({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session), state = liquify.get(session), t = controller.t;
  if (!state) return null;
  const set = (patch: Partial<LiquifyState>) => { Object.assign(state, patch); session.notify('ui'); };
  const modes: readonly LiquifyState['mode'][] = ['push', 'bloat', 'pucker', 'reconstruct'];
  const labels = { push: 'Forward Warp', bloat: 'Bloat', pucker: 'Pucker', reconstruct: 'Reconstruct' } as const;
  return <FloatingPanel name="liquify" title={t('Liquify')} onClose={() => closeLiquify(session, false)} closeLabel={t('Cancel')} testId="liquify-panel">
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{modes.map((mode) => <button key={mode} type="button"
      className={`${styles.pill} ${state.mode === mode ? styles.pillOn : ''}`} data-testid={`liquify-${mode}`} onClick={() => set({ mode })}>{t(labels[mode])}</button>)}</div>
    <NumberField label={t('Brush Size')} value={state.size} suffix="px" onChange={(value) => set({ size: Math.max(2, Math.min(2000, value)) })} />
    <NumberField label={t('Pressure')} value={state.pressure * 100} suffix="%" onChange={(value) => set({ pressure: Math.max(1, Math.min(100, value)) / 100 })} />
    <NumberField label={t('Density')} value={state.density * 100} suffix="%" onChange={(value) => set({ density: Math.max(1, Math.min(100, value)) / 100 })} />
    <div className={styles.dialogButtons}><button type="button" className={styles.pill} onClick={() => closeLiquify(session, false)}>{t('Cancel')}</button>
      <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} data-testid="liquify-apply" onClick={() => closeLiquify(session, true)}>{t('Apply')}</button></div>
  </FloatingPanel>;
}

export function installWarp(controller: EditorController): void {
  controller.canvasSetups.push((view) => {
    view.tools.warp = new MeshWarpTool(); view.tools.straighten = new StraightenTool(); view.tools.liquify = new LiquifyTool();
    view.painters.push(paintMesh, paintStraighten);
  });
  controller.contextBars.warp = (session) => <WarpBar controller={controller} session={session} />;
  controller.contextBars.straighten = (session) => <StraightenBar controller={controller} session={session} />;
  controller.contextBars.liquify = () => <span className={styles.headerTitle}>{controller.t('Liquify')}</span>;
  controller.panels.push(() => <LiquifyPanel controller={controller} />);
  controller.features.warp = { enabled: () => controller.session.canTransform && controller.session.selectedLayerIds.size === 1,
    run: () => controller.session.selectTool('warp') };
  controller.features.perspective = { enabled: () => controller.session.canTransform,
    run: () => { const session = controller.session; session.selectTool('move'); session.perspectiveConstrained = true; session.beginTransform(); session.beginDistort(); } };
  controller.features.straighten = { enabled: () => !!controller.session.document,
    run: () => controller.session.selectTool('straighten') };
  controller.features.liquify = { enabled: () => !!controller.session.activeLayer?.raster,
    run: () => { openLiquify(controller.session); } };
}
