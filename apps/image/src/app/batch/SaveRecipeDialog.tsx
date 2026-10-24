/**
 * Layer › Save Recipe… (PRODUCT-PLAN 6.9): names the recipe, shows the steps captured from the active layer (its
 * live filters, layer style and the adjustment layers above it) with a switch each, and the optional output steps
 * File › Batch… uses — crop to an aspect ratio, resize, the current Export As settings.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from '../../ui/editor.module.css';
import css from './batch.module.css';
import type { EditorController } from '../../ui/controller';
import { captureRecipeSteps, createRecipe, recipeSourceLayer, type RecipeExportPreset, type RecipeResize } from '../../core/recipes';
import { currentExportSettings, exportSettingsRequest } from '../../ui/ExportDialog';
import { addRecipe, showRecipesPanel } from './library';
import { stepLabel } from './describe';

const FORMAT_LABELS = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', tiff: 'TIFF' } as const;

function positive(value: string, integer = false): number | null {
  const number = Number(value.trim().replace(',', '.'));
  return Number.isFinite(number) && number > 0 && (!integer || (Number.isInteger(number) && number <= 30_000)) ? number : null;
}

export function SaveRecipeDialog({ controller, close }: { controller: EditorController; close: () => void }) {
  const t = controller.t;
  const session = controller.session;
  const document = session.document;
  const source = document && session.activeLayerId ? recipeSourceLayer(document, session.activeLayerId) : null;
  const steps = useMemo(() => (document && source ? captureRecipeSteps(document, source.id) : []), [document, source]);
  const [name, setName] = useState(() => source?.name ?? t('Recipe'));
  const [included, setIncluded] = useState<readonly boolean[]>(() => steps.map(() => true));
  const [crop, setCrop] = useState({ on: false, width: '4', height: '5' });
  const [resize, setResize] = useState<{ on: boolean; mode: RecipeResize['mode']; pixels: string }>({ on: false, mode: 'longEdge', pixels: '2048' });
  const [withExport, setWithExport] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const exportRequest = exportSettingsRequest(currentExportSettings(session));
  const cropValue = crop.on ? { width: positive(crop.width), height: positive(crop.height) } : null;
  const resizeValue = resize.on ? positive(resize.pixels, true) : null;
  const invalid = (cropValue !== null && (cropValue.width === null || cropValue.height === null)) || (resize.on && resizeValue === null);
  const chosen = steps.filter((_step, index) => included[index]);
  const empty = !chosen.length && !crop.on && !resize.on && !withExport;

  const save = () => {
    if (invalid || empty || !name.trim()) return;
    const preset: RecipeExportPreset | null = withExport && exportRequest ? {
      format: exportRequest.format, quality: exportRequest.quality, lossless: exportRequest.lossless, bitDepth: exportRequest.bitDepth,
      transparent: exportRequest.transparent, matte: exportRequest.matte, sizes: exportRequest.sizes, metadata: {
        colorProfile: exportRequest.metadata?.colorProfile, resolution: exportRequest.metadata?.resolution,
        info: exportRequest.metadata?.info ? { copyright: exportRequest.metadata.info.copyright, artist: exportRequest.metadata.info.artist } : null,
      },
    } : null;
    const recipe = createRecipe(name, chosen, {
      crop: cropValue ? { width: cropValue.width!, height: cropValue.height! } : null,
      resize: resizeValue ? { mode: resize.mode, pixels: resizeValue } : null,
      // Undefined fields are dropped by JSON; the preset keeps only what is set.
      export: preset ? JSON.parse(JSON.stringify(preset)) as RecipeExportPreset : null,
    });
    addRecipe(controller, recipe);
    showRecipesPanel(controller);
    close();
  };

  const exportSummary = exportRequest
    ? [FORMAT_LABELS[exportRequest.format], exportRequest.quality !== undefined ? `${Math.round(exportRequest.quality * 100)} %` : null,
      (exportRequest.sizes ?? []).map((size) => ('scale' in size ? `${size.scale.toLocaleString(controller.locale)}x`
        : `${size.width ?? size.height} px`)).join(', ')].filter(Boolean).join(' · ')
    : '';

  return (
    <form className={`${styles.dialog} ${css.recipeDialog}`} role="dialog" aria-modal aria-labelledby="cmp-save-recipe-title" data-testid="save-recipe-dialog"
      onSubmit={(event) => { event.preventDefault(); save(); }}>
      <h2 className={styles.dialogTitle} id="cmp-save-recipe-title">{t('Save Recipe')}</h2>
      <label className={styles.exportRow}>
        <span className={`${styles.exportLabel} ${styles.exportLabelFixed}`}>{t('Name')}</span>
        <input ref={input} className={styles.exportText} value={name} data-testid="recipe-name" onChange={(e) => setName(e.target.value)} />
      </label>

      <section className={styles.exportSection} aria-label={t('Steps')}>
        <h3 className={styles.exportSectionTitle}>{t('Steps')}</h3>
        {steps.length ? (
          <div className={css.steps}>
            {steps.map((step, index) => (
              <label key={index} className={styles.exportCheckRow}>
                <input type="checkbox" checked={included[index] ?? false} data-testid="recipe-step"
                  onChange={(e) => setIncluded(included.map((value, at) => (at === index ? e.target.checked : value)))} />
                <span className={styles.exportCheckName}>{stepLabel(controller, step)}</span>
              </label>
            ))}
          </div>
        ) : <p className={css.hint}>{t('This layer has no adjustments, filters or layer style to save.')}</p>}
      </section>

      <section className={styles.exportSection} aria-label={t('Output')}>
        <h3 className={styles.exportSectionTitle}>{t('Output')}</h3>
        <p className={css.hint}>{t('Used by Batch: crop, size and export settings.')}</p>
        <div className={css.optionRow}>
          <label className={styles.check}>
            <input type="checkbox" checked={crop.on} data-testid="recipe-crop" onChange={(e) => setCrop({ ...crop, on: e.target.checked })} />
            {t('Crop to aspect ratio')}
          </label>
          <label className={styles.field}><input className={css.small} inputMode="decimal" value={crop.width} disabled={!crop.on} aria-label={t('Width')}
            data-testid="recipe-crop-width" onChange={(e) => setCrop({ ...crop, width: e.target.value })} /></label>
          <span className={css.ratio}>:</span>
          <label className={styles.field}><input className={css.small} inputMode="decimal" value={crop.height} disabled={!crop.on} aria-label={t('Height')}
            data-testid="recipe-crop-height" onChange={(e) => setCrop({ ...crop, height: e.target.value })} /></label>
        </div>
        <div className={css.optionRow}>
          <label className={styles.check}>
            <input type="checkbox" checked={resize.on} data-testid="recipe-resize" onChange={(e) => setResize({ ...resize, on: e.target.checked })} />
            {t('Resize')}
          </label>
          <select className={styles.select} value={resize.mode} disabled={!resize.on} aria-label={t('Resize')} data-testid="recipe-resize-mode"
            onChange={(e) => setResize({ ...resize, mode: e.target.value as RecipeResize['mode'] })}>
            <option value="longEdge">{t('Long edge')}</option>
            <option value="width">{t('Width')}</option>
            <option value="height">{t('Height')}</option>
          </select>
          <label className={styles.field}><input inputMode="numeric" value={resize.pixels} disabled={!resize.on} aria-label={t('Resize')}
            data-testid="recipe-resize-pixels" aria-invalid={resize.on && resizeValue === null} onChange={(e) => setResize({ ...resize, pixels: e.target.value })} /><span>px</span></label>
        </div>
        <div className={css.optionRow}>
          <label className={styles.check}>
            <input type="checkbox" checked={withExport} disabled={!exportRequest} data-testid="recipe-export" onChange={(e) => setWithExport(e.target.checked)} />
            {t('Export settings')}
          </label>
          <span className={styles.exportCheckMeta} style={{ color: 'var(--cmp-text-secondary)' }}>{exportSummary}</span>
        </div>
      </section>

      <div className={styles.dialogButtons}>
        <button type="button" className={styles.pill} onClick={close}>{t('Cancel')}</button>
        <button type="submit" className={`${styles.pill} ${styles.pillPrimary}`} disabled={invalid || empty || !name.trim()} data-testid="recipe-save">{t('Save')}</button>
      </div>
    </form>
  );
}
