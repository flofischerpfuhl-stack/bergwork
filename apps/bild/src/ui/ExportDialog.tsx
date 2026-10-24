/**
 * File > Export As… (PRODUCT-PLAN 6.1 "ein Export-Dialog", P4 "pro Aufgabe genau ein Weg"): the only way to export
 * images. Photoshop's Export As in the editor's own style: what to export (whole document, artboards, selected
 * layers), format with only the options that format has, sizes (@0.5x…@4x or a width/height), metadata, a
 * preview of the first file at the chosen settings and a real-encode size estimate per file.
 *
 * The Export button calls `controller.exportWith` synchronously in its click handler: the browser shows its save
 * dialog only while the click still counts, so nothing may be awaited before (large-save.spec.ts).
 * The last settings are remembered per document tab for the session, not globally.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import type { EditorSession } from '../core/session';
import { Icon } from './icons';
import { isCancellation } from './errors';
import {
  EXPORT_FORMATS, ExportError, formatHasAlpha, formatSupports16Bit,
  type ExportFormat, type ExportPlanItem, type ExportRequest, type ExportSize, type ExportTarget,
} from '../io/exportPlan';
import type { ExportSizeEstimate } from '../io/exportPipeline';
import { profileHasFeature } from '../app/profiles';
import { markUiRender } from './performance';

type SizeRow = { readonly id: number; readonly mode: 'scale'; readonly scale: number } | { readonly id: number; readonly mode: 'width' | 'height'; readonly value: string };

export interface ExportSettings {
  readonly document: boolean;
  readonly artboards: readonly string[];
  readonly layers: boolean;
  readonly format: ExportFormat;
  readonly colorModel: 'rgb' | 'cmyk';
  readonly quality: { readonly jpeg: number; readonly webp: number; readonly avif: number };
  readonly lossless: boolean;
  readonly bitDepth: 8 | 16;
  readonly transparent: boolean;
  readonly matte: string;
  readonly sizes: readonly SizeRow[];
  readonly colorProfile: boolean;
  readonly resolution: boolean;
  readonly info: 'none' | 'copyright';
  readonly copyright: string;
  readonly artist: string;
}

/** Last settings per document tab (session), for this page load only. */
const remembered = new WeakMap<EditorSession, ExportSettings>();

export const EXPORT_SCALES = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const FORMAT_LABELS: Record<ExportFormat, string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', tiff: 'TIFF' };
const PREVIEW_BOX = { width: 560, height: 420 };
let nextRowId = 1;

function defaultSettings(session: EditorSession): ExportSettings {
  const artboards = (session.document?.artboards ?? []).map((artboard) => artboard.id);
  return {
    document: artboards.length === 0, artboards, layers: false, format: 'png', colorModel: 'rgb',
    quality: { jpeg: 0.85, webp: 0.85, avif: 0.75 }, lossless: false, bitDepth: 8, transparent: true, matte: '#ffffff',
    sizes: [{ id: nextRowId++, mode: 'scale', scale: 1 }], colorProfile: true, resolution: true, info: 'none', copyright: '', artist: '',
  };
}

function initialSettings(session: EditorSession): ExportSettings {
  const saved = remembered.get(session);
  if (!saved) return defaultSettings(session);
  const existing = new Set((session.document?.artboards ?? []).map((artboard) => artboard.id));
  const artboards = saved.artboards.filter((id) => existing.has(id));
  const layers = saved.layers && session.selectedLayerIds.size > 0;
  // Nothing left to export (artboards deleted, selection gone): start from the defaults' targets.
  if (!saved.document && !artboards.length && !layers) {
    const fallback = defaultSettings(session);
    return { ...saved, document: fallback.document, artboards: fallback.artboards, layers: false };
  }
  return { ...saved, artboards, layers };
}

function rgb(hex: string): { red: number; green: number; blue: number } {
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { red: channel(1), green: channel(3), blue: channel(5) };
}

/** A size row as a request size, or null when its number is not a whole pixel count from 1 to 30,000. */
function sizeOf(row: SizeRow): ExportSize | null {
  if (row.mode === 'scale') return { scale: row.scale };
  const value = Number(row.value.trim());
  if (!Number.isInteger(value) || value < 1 || value > 30_000) return null;
  return row.mode === 'width' ? { width: value } : { height: value };
}

function selectedLayerTargets(session: EditorSession): ExportTarget[] {
  // Top of the stack first, like the Layers panel.
  return [...(session.document?.layers ?? [])].reverse().filter((layer) => session.selectedLayerIds.has(layer.id)).map((layer) => ({ kind: 'layer', id: layer.id }));
}

/**
 * The request fields the file settings stand for (format, quality, sizes, metadata), without targets; null when a size is
 * invalid or the CMYK profile is still loading. CMYK needs the document session's proof setup, so without `session`
 * (batch) the settings export as RGB.
 */
export function exportSettingsRequest(settings: ExportSettings, session?: EditorSession): Omit<ExportRequest, 'targets' | 'baseName'> | null {
  const sizes = settings.sizes.map(sizeOf);
  if (sizes.some((size) => size === null)) return null;
  const format = settings.format;
  const cmyk = !!session && settings.colorModel === 'cmyk' && (format === 'jpeg' || format === 'tiff');
  if (cmyk && !session.proofProfile) return null;
  const lossless = format === 'webp' && settings.lossless;
  const quality = format === 'jpeg' || format === 'avif' || (format === 'webp' && !lossless) ? settings.quality[format] : undefined;
  return {
    format, sizes: sizes as ExportSize[], quality, lossless: format === 'webp' ? lossless : undefined,
    bitDepth: formatSupports16Bit(format) ? settings.bitDepth : 8,
    transparent: cmyk ? false : formatHasAlpha(format) ? settings.transparent : false,
    tiffCompression: cmyk && format === 'tiff' ? 'lzw' : undefined,
    cmyk: cmyk ? { profile: session.proofProfile!, intent: session.proofOptions.intent,
      blackPointCompensation: session.proofOptions.blackPointCompensation } : undefined,
    matte: rgb(settings.matte),
    metadata: {
      colorProfile: cmyk || settings.colorProfile ? 'embed' : 'strip', resolution: settings.resolution,
      info: settings.info === 'none' ? null : { copyright: settings.copyright.trim() || undefined, artist: settings.artist.trim() || undefined },
    },
  };
}

/** File settings from request fields (a recipe's export preset), over `base` for everything the request leaves out. */
export function exportSettingsFrom(request: Partial<Omit<ExportRequest, 'targets' | 'baseName'>>, base: ExportSettings): ExportSettings {
  const format = request.format ?? base.format;
  const hex = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0');
  const sizes = request.sizes?.length ? request.sizes.map((size): SizeRow => ('scale' in size ? { id: nextRowId++, mode: 'scale', scale: size.scale }
    : size.width !== undefined ? { id: nextRowId++, mode: 'width', value: String(size.width) } : { id: nextRowId++, mode: 'height', value: String(size.height) }))
    : base.sizes;
  const info = request.metadata?.info;
  return {
    ...base, format, sizes,
    quality: request.quality !== undefined && format !== 'png' && format !== 'tiff' ? { ...base.quality, [format]: request.quality } : base.quality,
    lossless: request.lossless ?? base.lossless, bitDepth: request.bitDepth ?? base.bitDepth, transparent: request.transparent ?? base.transparent,
    matte: request.matte ? `#${hex(request.matte.red)}${hex(request.matte.green)}${hex(request.matte.blue)}` : base.matte,
    colorProfile: request.metadata?.colorProfile ? request.metadata.colorProfile === 'embed' : base.colorProfile,
    resolution: request.metadata?.resolution ?? base.resolution,
    ...(info === undefined ? {} : info === null ? { info: 'none' as const } : { info: 'copyright' as const, copyright: info.copyright ?? '', artist: info.artist ?? '' }),
  };
}

/** The Export As settings last used for a document tab (or the defaults): where Batch… and Save Recipe… start. */
export function currentExportSettings(session: EditorSession): ExportSettings { return initialSettings(session); }

export function exportRequestFor(controller: EditorController, session: EditorSession, settings: ExportSettings): ExportRequest | null {
  const document = session.document;
  if (!document) return null;
  const targets: ExportTarget[] = [];
  if (settings.document) targets.push({ kind: 'document' });
  for (const artboard of document.artboards ?? []) if (settings.artboards.includes(artboard.id)) targets.push({ kind: 'artboard', id: artboard.id });
  if (settings.layers) targets.push(...selectedLayerTargets(session));
  const options = exportSettingsRequest(settings, session);
  if (!options) return null;
  return controller.exportRequest(options.format, { targets, ...options }, session);
}

/** ExportError messages in the UI language. */
export function exportErrorText(error: unknown, t: (text: string) => string): string {
  if (error instanceof ExportError && error.code === 'empty') {
    const name = /^“(.*)” has no pixels/.exec(error.message)?.[1] ?? '';
    return t('“{name}” has no pixels on the canvas to export.').replace('{name}', name);
  }
  return t(error instanceof Error ? error.message : String(error));
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit > 0 && value < 100 ? 1 : 0 })} ${units[unit]}`;
}

function estimateText(estimate: ExportSizeEstimate | undefined, locale: string): string {
  if (!estimate) return '…';
  return `${estimate.exact ? '' : '≈ '}${formatBytes(estimate.bytes, locale)}`;
}

/** The request for the preview: the first file's target, fitted into the preview box, in a format the browser shows. */
function previewRequest(request: ExportRequest, item: ExportPlanItem): ExportRequest {
  const scale = Math.min(1, PREVIEW_BOX.width / item.region.width, PREVIEW_BOX.height / item.region.height);
  // Lossless formats look exactly like PNG; lossy ones are previewed in their own format to show the artefacts.
  const lossy = request.format === 'jpeg' || request.format === 'avif' || (request.format === 'webp' && !request.lossless);
  const format: ExportFormat = lossy ? request.format : 'png';
  return {
    targets: [item.target], format, sizes: [{ scale }],
    quality: lossy ? request.quality : undefined, speed: request.speed, bitDepth: 8,
    transparent: request.transparent, matte: request.matte, baseName: request.baseName,
    cmyk: lossy ? request.cmyk : undefined,
    metadata: { colorProfile: 'embed', resolution: false, info: null },
  };
}

export function ExportDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  markUiRender('ExportDialog');
  const t = controller.t, locale = controller.locale;
  const session = controller.session;
  const document = session.document;
  const [settings, setSettingsState] = useState<ExportSettings>(() => initialSettings(session));
  const setSettings = (update: Partial<ExportSettings>) => setSettingsState((current) => {
    const next = { ...current, ...update };
    remembered.set(session, next);
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [profileRevision, setProfileRevision] = useState(0);
  const [preview, setPreview] = useState<{ url: string; key: string } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [estimates, setEstimates] = useState<{ key: string; list: readonly ExportSizeEstimate[] } | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const running = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);

  const request = useMemo(() => exportRequestFor(controller, session, settings), [controller, session, settings, profileRevision]);
  const planned = useMemo((): { plan: ExportPlanItem[]; error: string | null } => {
    if (!request) return { plan: [], error: t('Enter whole numbers from 1 to 30,000 pixels.') };
    try { return { plan: controller.planExport(request, session), error: null }; } catch (error) { return { plan: [], error: exportErrorText(error, t) }; }
  }, [controller, session, request, t]);
  const { plan, error } = planned;
  const key = request && !error ? JSON.stringify(request) : null;

  // Preview, then the size estimate: debounced, and every change cancels the work for the previous settings.
  useEffect(() => {
    if (!key || !request || !plan.length || busy) return;
    const abort = new AbortController();
    running.current = abort;
    setEstimateError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [file] = await controller.exportFiles(previewRequest(request, plan[0]!), { signal: abort.signal }, session);
          if (abort.signal.aborted || !file) return;
          const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }));
          if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
          previewUrl.current = url;
          setPreviewFailed(false);
          setPreview({ url, key });
          const list = await controller.estimateExport(request, { signal: abort.signal }, session);
          if (!abort.signal.aborted) setEstimates({ key, list });
        } catch (failure) {
          if (!abort.signal.aborted && !isCancellation(failure)) setEstimateError(exportErrorText(failure, t));
        }
      })();
    }, 300);
    return () => { clearTimeout(timer); abort.abort(); if (running.current === abort) running.current = null; };
    // `key` stands for the request and the plan.
  }, [key, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); }, []);

  const format = settings.format;
  const cmykAvailable = profileHasFeature(controller.profile, 'cmyk-export', controller.capabilities);
  const cmyk = settings.colorModel === 'cmyk' && (format === 'jpeg' || format === 'tiff');
  useEffect(() => {
    if (!cmyk || session.proofProfile) return;
    let active = true;
    void controller.ensureProofSetup(session).then(() => { if (active) setProfileRevision((value) => value + 1); });
    return () => { active = false; };
  }, [cmyk, controller, session]);

  if (!document) return null;
  const t2 = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(text));
  const px = (width: number, height: number) => `${width.toLocaleString(locale)} × ${height.toLocaleString(locale)}`;
  const current = estimates?.key === key ? estimates.list : null;
  const byName = new Map(current?.map((estimate) => [estimate.item.name, estimate]) ?? []);
  const total = current?.reduce((sum, estimate) => sum + estimate.bytes, 0) ?? null;
  const artboards = document.artboards ?? [];
  const selectedLayers = session.selectedLayerIds.size;
  const lossy = format === 'jpeg' || format === 'avif' || (format === 'webp' && !settings.lossless);
  const flattened = cmyk || !formatHasAlpha(format) || !settings.transparent;
  const warnings: string[] = [];
  if (format === 'avif' && settings.info !== 'none') warnings.push(t('AVIF export does not write EXIF creator fields.'));
  const view = controller.canvasView;
  if (formatSupports16Bit(format) && settings.bitDepth === 16 && view?.rendererKind === 'webgl2' && view.gpu && !view.gpu.floatTargets) {
    warnings.push(t('16-bit export used 8-bit rendering: this renderer has no float readback.'));
  }
  const firstTargetCount = settings.sizes.length;
  const rowResult = (index: number) => (plan.length >= firstTargetCount ? plan[index] : undefined);

  const onExport = () => {
    if (!request || error || busy) return;
    running.current?.abort();
    remembered.set(session, settings);
    setBusy(true);
    // Called synchronously in the click handler: the save picker needs the click's user activation.
    const exporting = controller.exportWith(request);
    void exporting.then((exported) => { if (exported) close(); else setBusy(false); });
  };

  return (
    <div ref={root} tabIndex={-1} className={`${styles.dialog} ${styles.exportDialog}`} role="dialog" aria-modal aria-labelledby="cmp-export-title" data-testid="export-dialog">
      <h2 className={styles.dialogTitle} id="cmp-export-title">{t('Export As')}</h2>
      <div className={styles.exportBody}>
        <div className={styles.exportPreviewPane}>
          <div className={styles.exportPreview} data-testid="export-preview">
            {preview && !previewFailed ? (
              <img src={preview.url} alt={t('Preview')} data-testid="export-preview-image" className={preview.key === key ? '' : styles.exportPreviewStale}
                onError={() => setPreviewFailed(true)} />
            ) : <span className={styles.secondary}>{error ? '' : previewFailed ? t('This browser cannot show this format.') : t('Preparing preview…')}</span>}
          </div>
          {plan[0] ? (
            <div className={styles.exportCaption}>
              <span className={styles.exportCaptionName}>{plan[0].label}</span>
              <span>{px(plan[0].width, plan[0].height)} px · {FORMAT_LABELS[format]}{flattened ? '' : ` · ${t('Transparency')}`}</span>
            </div>
          ) : null}
          <div className={styles.exportFiles} role="list" aria-label={t('Files')} data-testid="export-files">
            {plan.map((item) => (
              <div key={item.name} role="listitem" className={styles.exportFile} data-testid="export-file">
                <span className={styles.exportFileName} title={item.name}>{item.name}</span>
                <span className={styles.exportFileMeta}>{px(item.width, item.height)}</span>
                <span className={styles.exportFileSize} data-testid="export-estimate">{estimateText(byName.get(item.name), locale)}</span>
              </div>
            ))}
          </div>
          <div className={styles.exportSummary} data-testid="export-summary">
            <span>{plan.length > 1 ? t2('{n} files · saved as one ZIP archive', { n: plan.length }) : plan.length === 1 ? t('1 file') : ''}</span>
            <span>{total !== null && plan.length > 1 ? `${t('File size')}: ${current!.every((e) => e.exact) ? '' : '≈ '}${formatBytes(total, locale)}` : ''}</span>
          </div>
        </div>

        <div className={styles.exportSettings}>
          <section className={styles.exportSection} aria-label={t('Export')}>
            <h3 className={styles.exportSectionTitle}>{t('Export')}</h3>
            <label className={styles.exportCheckRow}>
              <input type="checkbox" checked={settings.document} data-testid="export-target-document" onChange={(e) => setSettings({ document: e.target.checked })} />
              <span className={styles.exportCheckName}>{t('Whole document')}</span>
              <span className={styles.exportCheckMeta}>{px(document.width, document.height)}</span>
            </label>
            {artboards.map((artboard) => (
              <label key={artboard.id} className={styles.exportCheckRow}>
                <input type="checkbox" checked={settings.artboards.includes(artboard.id)} data-testid="export-target-artboard" data-artboard-id={artboard.id}
                  onChange={(e) => setSettings({ artboards: e.target.checked ? [...settings.artboards, artboard.id] : settings.artboards.filter((id) => id !== artboard.id) })} />
                <Icon name="artboard" size={13} />
                <span className={styles.exportCheckName}>{artboard.name}</span>
                <span className={styles.exportCheckMeta}>{px(artboard.rect.width, artboard.rect.height)}</span>
              </label>
            ))}
            <label className={`${styles.exportCheckRow} ${selectedLayers ? '' : styles.exportCheckDisabled}`}>
              <input type="checkbox" checked={settings.layers && selectedLayers > 0} disabled={!selectedLayers} data-testid="export-target-layers"
                onChange={(e) => setSettings({ layers: e.target.checked })} />
              <span className={styles.exportCheckName}>{t('Selected layers')}</span>
              <span className={styles.exportCheckMeta}>{selectedLayers}</span>
            </label>
          </section>

          <ExportFileSettings controller={controller} settings={settings} setSettings={setSettings} rowResult={rowResult} resolution={document.resolution} session={session} />
        </div>
      </div>
      <div className={styles.dialogButtons}>
        <span className={styles.exportStatus} role="status" data-testid="export-status">
          {error ? <span className={styles.warning}>{error}</span>
            : estimateError ? <span className={styles.warning}>{estimateError}</span>
              : warnings.length ? <span className={styles.warning}>{warnings.join(' ')}</span>
                : busy ? t('Exporting…') : ''}
        </span>
        <button type="button" className={styles.pill} onClick={close}>{t('Cancel')}</button>
        <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!!error || !request || busy} data-testid="export-confirm"
          onClick={onExport}>{t('Export')}</button>
      </div>
    </div>
  );
}

/**
 * The file settings of Export As — format and its options, sizes, metadata — shared with File › Batch…, which
 * exports with the same settings (one set of export options, P4). `rowResult` gives a size row's pixel result when
 * it is known (the batch dialog has no single target to measure).
 */
export function ExportFileSettings({ controller, settings, setSettings, rowResult, resolution, session }: {
  controller: EditorController; settings: ExportSettings; setSettings: (update: Partial<ExportSettings>) => void;
  rowResult: (index: number) => { readonly width: number; readonly height: number } | undefined; resolution: number | null;
  /** The document session whose proof setup drives CMYK export; without it (batch) CMYK is not offered. */
  session?: EditorSession;
}) {
  const t = controller.t, locale = controller.locale;
  const t2 = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(text));
  const px = (width: number, height: number) => `${width.toLocaleString(locale)} × ${height.toLocaleString(locale)}`;
  const format = settings.format;
  const cmykAvailable = !!session && profileHasFeature(controller.profile, 'cmyk-export', controller.capabilities);
  const cmyk = !!session && settings.colorModel === 'cmyk' && (format === 'jpeg' || format === 'tiff');
  const lossy = format === 'jpeg' || format === 'avif' || (format === 'webp' && !settings.lossless);
  const flattened = cmyk || !formatHasAlpha(format) || !settings.transparent;
  const addSize = () => {
    const used = new Set(settings.sizes.flatMap((row) => (row.mode === 'scale' ? [row.scale] : [])));
    const scale = [2, 3, 4, 1.5, 0.5, 0.75, 1].find((s) => !used.has(s)) ?? 2;
    setSettings({ sizes: [...settings.sizes, { id: nextRowId++, mode: 'scale', scale }] });
  };
  const updateRow = (id: number, row: SizeRow) => setSettings({ sizes: settings.sizes.map((r) => (r.id === id ? row : r)) });
  return (
    <>
      <section className={styles.exportSection} aria-label={t('File Settings')}>
        <h3 className={styles.exportSectionTitle}>{t('Format')}</h3>
        <div className={`${styles.segmented} ${styles.exportSegmented}`} role="radiogroup" aria-label={t('Format')}>
          {EXPORT_FORMATS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={format === f} data-testid={`export-format-${f}`}
              className={`${styles.segment} ${format === f ? styles.segmentOn : ''}`} onClick={() => setSettings({ format: f })}>{FORMAT_LABELS[f]}</button>
          ))}
        </div>
        {cmykAvailable && (format === 'jpeg' || format === 'tiff') ? (
          <div className={styles.exportRow}>
            <span className={styles.exportLabel}>{t('Color')}</span>
            <div className={styles.segmented} role="radiogroup" aria-label={t('Color')}>
              {(['rgb', 'cmyk'] as const).map((model) => (
                <button key={model} type="button" role="radio" aria-checked={settings.colorModel === model}
                  data-testid={`export-color-${model}`} className={`${styles.segment} ${settings.colorModel === model ? styles.segmentOn : ''}`}
                  onClick={() => setSettings({ colorModel: model })}>{model.toUpperCase()}</button>
              ))}
            </div>
          </div>
        ) : null}
        {cmyk && session ? (
          <div className={styles.dialogMessage} data-testid="export-cmyk-settings">
            {session.proofProfile?.name ?? t('Preparing profile…')} · {t(session.proofOptions.intent === 'perceptual' ? 'Perceptual' : 'Relative Colorimetric')}
            {session.proofOptions.blackPointCompensation ? ` · ${t('Black Point Compensation')}` : ''}
          </div>
        ) : null}
        {format === 'webp' ? (
          <label className={styles.check}>
            <input type="checkbox" checked={settings.lossless} data-testid="export-lossless" onChange={(e) => setSettings({ lossless: e.target.checked })} />
            {t('Lossless')}
          </label>
        ) : null}
        {lossy ? (
          <label className={styles.exportRow}>
            <span className={styles.exportLabel}>{t('Quality')}</span>
            <input className={styles.slider} type="range" min={0} max={100} step={1} data-testid="export-quality" aria-label={t('Quality')}
              value={Math.round(settings.quality[format as 'jpeg' | 'webp' | 'avif'] * 100)}
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(e) => setSettings({ quality: { ...settings.quality, [format]: Number(e.target.value) / 100 } })} />
            <span className={styles.exportValue}>{Math.round(settings.quality[format as 'jpeg' | 'webp' | 'avif'] * 100)} %</span>
          </label>
        ) : null}
        {formatSupports16Bit(format) ? (
          <div className={styles.exportRow}>
            <span className={styles.exportLabel}>{t('Bit depth')}</span>
            <div className={styles.segmented} role="radiogroup" aria-label={t('Bit depth')}>
              {([8, 16] as const).map((depth) => (
                <button key={depth} type="button" role="radio" aria-checked={settings.bitDepth === depth} data-testid={`export-depth-${depth}`}
                  className={`${styles.segment} ${settings.bitDepth === depth ? styles.segmentOn : ''}`} onClick={() => setSettings({ bitDepth: depth })}>
                  {t2('{n}-bit', { n: depth })}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {formatHasAlpha(format) && !cmyk ? (
          <label className={styles.check}>
            <input type="checkbox" checked={settings.transparent} data-testid="export-transparency" onChange={(e) => setSettings({ transparent: e.target.checked })} />
            {t('Transparency')}
          </label>
        ) : null}
        {flattened ? (
          <label className={styles.exportRow}>
            <span className={styles.exportLabel}>{t('Background for transparency')}</span>
            <input type="color" className={styles.colorWell} value={settings.matte} data-testid="export-matte" aria-label={t('Background for transparency')}
              onChange={(e) => setSettings({ matte: e.target.value })} />
          </label>
        ) : null}
      </section>

      <section className={styles.exportSection} aria-label={t('Size')}>
        <div className={styles.exportSectionHeader}>
          <h3 className={styles.exportSectionTitle}>{t('Size')}</h3>
          <button type="button" className={styles.exportMini} aria-label={t('Add size')} title={t('Add size')} data-testid="export-add-size" onClick={addSize}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {settings.sizes.map((row, index) => {
          const item = rowResult(index);
          const invalid = row.mode !== 'scale' && sizeOf(row) === null;
          return (
            <div key={row.id} className={styles.exportSizeRow} data-testid="export-size-row">
              <select className={styles.select} aria-label={t('Scale')} data-testid="export-size-mode"
                value={row.mode === 'scale' ? String(row.scale) : row.mode}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === 'width' || value === 'height') {
                    const reference = rowResult(index);
                    updateRow(row.id, { id: row.id, mode: value, value: String(reference ? (value === 'width' ? reference.width : reference.height) : 1000) });
                  } else updateRow(row.id, { id: row.id, mode: 'scale', scale: Number(value) });
                }}>
                {EXPORT_SCALES.map((scale) => <option key={scale} value={String(scale)}>{scale.toLocaleString(locale)}x</option>)}
                <option value="width">{t('Width')}</option>
                <option value="height">{t('Height')}</option>
              </select>
              {row.mode !== 'scale' ? (
                <label className={styles.field}>
                  <input inputMode="numeric" value={row.value} aria-label={t(row.mode === 'width' ? 'Width' : 'Height')} data-testid="export-size-value"
                    aria-invalid={invalid} style={invalid ? { borderColor: 'var(--cmp-danger)' } : undefined}
                    onKeyDown={(event) => event.stopPropagation()}
                    onChange={(e) => updateRow(row.id, { ...row, value: e.target.value })} />
                  <span>px</span>
                </label>
              ) : null}
              <span className={styles.exportSizeResult} data-testid="export-size-result">{item && !invalid ? `${px(item.width, item.height)} px` : '—'}</span>
              <button type="button" className={styles.exportMini} aria-label={t('Remove size')} title={t('Remove size')} data-testid="export-remove-size"
                disabled={settings.sizes.length === 1} onClick={() => setSettings({ sizes: settings.sizes.filter((r) => r.id !== row.id) })}>
                <Icon name="minus" size={14} />
              </button>
            </div>
          );
        })}
      </section>

      <section className={styles.exportSection} aria-label={t('Metadata')}>
        <h3 className={styles.exportSectionTitle}>{t('Metadata')}</h3>
        <select className={`${styles.select} ${styles.exportSelect}`} value={settings.info} aria-label={t('Metadata')} data-testid="export-info"
          onChange={(e) => setSettings({ info: e.target.value as ExportSettings['info'] })}>
          <option value="none">{t('None')}</option>
          <option value="copyright">{t('Copyright and Contact Info')}</option>
        </select>
        {settings.info === 'copyright' ? (
          <>
            <label className={styles.exportRow}>
              <span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{t('Copyright')}</span>
              <input className={styles.exportText} value={settings.copyright} placeholder="© 2026 …" data-testid="export-copyright"
                onKeyDown={(event) => event.stopPropagation()} onChange={(e) => setSettings({ copyright: e.target.value })} />
            </label>
            <label className={styles.exportRow}>
              <span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{t('Author')}</span>
              <input className={styles.exportText} value={settings.artist} data-testid="export-artist"
                onKeyDown={(event) => event.stopPropagation()} onChange={(e) => setSettings({ artist: e.target.value })} />
            </label>
          </>
        ) : null}
        <label className={styles.check}>
          <input type="checkbox" checked={cmyk || settings.colorProfile} disabled={cmyk} data-testid="export-icc" onChange={(e) => setSettings({ colorProfile: e.target.checked })} />
          {t('Embed color profile')} ({cmyk ? session?.proofProfile?.name ?? 'CMYK' : 'sRGB'})
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={settings.resolution} data-testid="export-resolution" onChange={(e) => setSettings({ resolution: e.target.checked })} />
          {t('Resolution')}{resolution === null ? '' : ` (${resolution.toLocaleString(locale)} ppi)`}
        </label>
      </section>
    </>
  );
}
