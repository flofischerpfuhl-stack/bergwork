const OCR_ASSET_ROOT = '/tools/vendor/tesseract-5.0.4';

export const OCR_LANGUAGES = Object.freeze(['eng', 'deu', 'fra', 'spa', 'ita', 'por']);

// Recognition renders a page at 2x (144 dpi), the size Tesseract reads body
// text at. A map or poster page at 2x is tens to hundreds of megapixels: more
// than a canvas holds (a 12,608 x 16,806 pt page is 850 Mpx) and minutes of
// recognition. Pages above OCR_MAX_PIXELS render at the scale that fits.
export const OCR_RENDER_SCALE = 2;
export const OCR_MAX_PIXELS = 16 * 1024 * 1024;
export function ocrRenderScale(widthPt, heightPt) {
  const area = Math.abs(Number(widthPt) * Number(heightPt));
  if (!(area > 0)) return OCR_RENDER_SCALE;
  return Math.min(OCR_RENDER_SCALE, Math.sqrt(OCR_MAX_PIXELS / area));
}

let tesseractModulePromise = null;

function asError(error, fallback) {
  if (error instanceof Error) return error;
  return new Error(error == null ? fallback : String(error));
}

function validateLanguage(language) {
  const value = String(language || 'eng');
  if (!OCR_LANGUAGES.includes(value)) {
    throw new Error(`OCR language data is not installed: ${value}`);
  }
  return value;
}

async function loadTesseract() {
  if (!tesseractModulePromise) {
    // Keep the sizeable OCR engine out of the main PDF editor bundle. The
    // dynamic import remains same-origin and is only paid for when OCR starts.
    const moduleUrl = `${OCR_ASSET_ROOT}/tesseract.esm.min.js`;
    tesseractModulePromise = import(moduleUrl)
      .then((module) => {
        const Tesseract = module.default || module;
        if (typeof Tesseract?.createWorker !== 'function') {
          throw new Error('The bundled OCR engine did not expose createWorker().');
        }
        return Tesseract;
      })
      .catch((error) => {
        tesseractModulePromise = null;
        throw new Error('Unable to load the bundled OCR engine.', { cause: asError(error) });
      });
  }
  return tesseractModulePromise;
}

/**
 * Create a Tesseract.js v5 worker using only same-origin, vendored assets.
 * Callers own the returned worker and must terminate it. Prefer
 * withOcrWorker() when the worker does not need to survive across jobs.
 */
export async function createOcrWorker(language = 'eng', options = {}) {
  const lang = validateLanguage(language);
  const { logger, errorHandler, signal } = options;

  if (signal?.aborted) throw new DOMException('OCR was cancelled.', 'AbortError');

  const Tesseract = await loadTesseract();
  let worker = null;
  try {
    worker = await Tesseract.createWorker(lang, 1, {
      workerPath: `${OCR_ASSET_ROOT}/worker.min.js`,
      corePath: `${OCR_ASSET_ROOT}/core`,
      langPath: `${OCR_ASSET_ROOT}/lang`,
      gzip: true,
      logger: typeof logger === 'function' ? logger : () => {},
      errorHandler: (error) => {
        if (typeof errorHandler === 'function') errorHandler(asError(error, 'OCR worker failed.'));
      },
    });

    if (signal?.aborted) {
      await worker.terminate();
      throw new DOMException('OCR was cancelled.', 'AbortError');
    }
    // Tesseract.js defaults to one uniform text block (PSM 6), which reads
    // multi-column pages across the columns. Automatic segmentation finds
    // the columns and reports blocks in reading order.
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    return worker;
  } catch (error) {
    if (worker) {
      try { await worker.terminate(); } catch { /* retain the original error */ }
    }
    throw asError(error, 'Unable to start the OCR worker.');
  }
}

/** Run an OCR job and always release its worker, including after failures. */
export async function withOcrWorker(language, options, job) {
  if (typeof job !== 'function') throw new TypeError('OCR job must be a function.');

  const worker = await createOcrWorker(language, options);
  if (options?.signal?.aborted) {
    await worker.terminate().catch(() => {});
    throw new DOMException('OCR was cancelled.', 'AbortError');
  }
  const abort = () => { void worker.terminate().catch(() => {}); };
  options?.signal?.addEventListener?.('abort', abort, { once: true });
  let jobError = null;
  try {
    return await job(worker);
  } catch (error) {
    jobError = error;
    throw error;
  } finally {
    options?.signal?.removeEventListener?.('abort', abort);
    try {
      await worker.terminate();
    } catch (error) {
      if (!jobError) throw new Error('OCR finished, but its worker could not be released.', { cause: asError(error) });
    }
  }
}
