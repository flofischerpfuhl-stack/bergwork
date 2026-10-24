// Printing the current document. A browser with a built-in PDF viewer prints
// the PDF itself (vector, exact); a web view without one (WKWebView,
// WebKitGTK, Android WebView) prints page images instead.

export const PRINT_RASTER_MAX_PAGES = 300;
const PRINT_RASTER_DPI = 150;

export function canPrintPdfNatively(nav = globalThis.navigator) {
  // `pdfViewerEnabled` is false where an embedded PDF cannot be shown at all.
  return nav?.pdfViewerEnabled !== false;
}

function hiddenPrintFrame(doc = globalThis.document) {
  const frame = doc.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px', border: '0', opacity: '0', pointerEvents: 'none' });
  return frame;
}

function printFrame(frame, cleanup) {
  const target = frame.contentWindow;
  if (!target) throw new Error('The print preview could not be opened.');
  // Closing the dialog fires afterprint; a fallback timer frees the frame in
  // engines that never send it for embedded content.
  const release = () => { window.setTimeout(cleanup, 500); };
  target.addEventListener?.('afterprint', release, { once: true });
  window.setTimeout(cleanup, 10 * 60 * 1000);
  target.focus();
  target.print();
}

export function printPdfBytesNatively(bytes, doc = globalThis.document) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const frame = hiddenPrintFrame(doc);
    let done = false;
    const cleanup = () => { frame.remove(); URL.revokeObjectURL(url); };
    frame.addEventListener('load', () => {
      if (done) return;
      done = true;
      // The embedded viewer needs a moment after load before it can print.
      window.setTimeout(() => {
        try { printFrame(frame, cleanup); resolve('native'); } catch (error) { cleanup(); reject(error); }
      }, 350);
    });
    frame.addEventListener('error', () => { if (!done) { done = true; cleanup(); reject(new Error('The PDF could not be prepared for printing.')); } });
    frame.src = url;
    doc.body.appendChild(frame);
  });
}

// `pdf` is a PDF.js document of the bytes to print.
export async function printPdfAsImages(pdf, { onProgress, doc = globalThis.document } = {}) {
  if (pdf.numPages > PRINT_RASTER_MAX_PAGES) {
    throw new Error(`This device prints page images, which is limited to ${PRINT_RASTER_MAX_PAGES} pages. Export the PDF and print it from a PDF viewer.`);
  }
  const urls = [];
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const size = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PRINT_RASTER_DPI / 72 });
      const canvas = doc.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error(`Page ${pageNumber} could not be prepared for printing.`);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      pages.push({ url, width: size.width, height: size.height });
      onProgress?.(pageNumber / pdf.numPages);
    }
    const first = pages[0];
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>
      @page { size: ${first.width}pt ${first.height}pt; margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      img { display: block; page-break-after: always; break-after: page; }
      img:last-child { page-break-after: auto; break-after: auto; }
    </style></head><body>${pages.map(entry =>
      `<img src="${entry.url}" style="width:${entry.width}pt;height:${entry.height}pt" alt="">`).join('')}</body></html>`;
    const frame = hiddenPrintFrame(doc);
    const cleanup = () => { frame.remove(); urls.forEach(url => URL.revokeObjectURL(url)); };
    await new Promise((resolve, reject) => {
      frame.addEventListener('load', async () => {
        try {
          await Promise.all([...frame.contentDocument.images].map(image => image.decode?.().catch(() => {})));
          printFrame(frame, cleanup);
          resolve();
        } catch (error) { cleanup(); reject(error); }
      }, { once: true });
      frame.srcdoc = html;
      doc.body.appendChild(frame);
    });
    return 'images';
  } catch (error) {
    urls.forEach(url => URL.revokeObjectURL(url));
    throw error;
  }
}
