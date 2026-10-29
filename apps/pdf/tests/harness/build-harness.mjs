#!/usr/bin/env node
// Bundles the corpus test harness into apps/pdf/tests/.build/: harness.js (the editor's engine, model and a set of
// document-level helpers from pdf-tools-shell.jsx) and harness.html. The bundling itself (shell internals exported in
// memory, the editor sources never written) is headless/bundle.mjs, shared with the agent CLI.
//
//   node apps/pdf/tests/harness/build-harness.mjs
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleEnginePage, sourceDir } from '../../headless/bundle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.dirname(here);
// Each source tree builds into its own folder, so runs against different checkouts can go on side by side.
export const outDir = process.env.BERGWORK_PDF_EDITOR_SRC
  ? path.join(testsDir, '.build', `src-${createHash('sha256').update(sourceDir).digest('hex').slice(0, 10)}`)
  : path.join(testsDir, '.build');

// Top-level helpers of pdf-tools-shell.jsx the harness calls. Missing names (renamed upstream) are reported and
// skipped; the harness marks the operations that need them as unavailable instead of failing to build.
export const SHELL_INTERNALS = [
  'postprocessPdfiumExportBytes', 'repairGeneratedFreeTextAppearances', 'repairDanglingFontResources',
  'packExportPdfBytes', 'restrictPdfBytes', 'compressEditedPdf', 'fillMaterializedFormPdfBytes',
  'finalizeFlattenedPdfBytes', 'pdfBytesWithBookmarks', 'pdfBytesWithFormValues', 'getPdfToolkit', 'loadPdfFile',
  'readPdfMetadata', 'applyMetadata', 'stripMetadata', 'openPdfJsDocument', 'imageDataUrlToRgbaResource',
  'checkpointToPdfSnapshotResource', 'pdfSnapshotResourceFromBytes', 'PDF_OPT_PROFILES', 'serializePdfProjectEntries',
  'loadFernworkPdfProjectFile', 'pdfiumWorkerRequest', 'formWidgetsForDocument', 'documentHasXfaForm',
  'pdfBytesContainCryptographicSignature', 'sourceForLivePdfiumSession', 'materializeDurableNativePdfBytes',
  'pdfiumColorWithOpacity', 'extractTextForDoc',
];

export async function buildHarness({ quiet = false } = {}) {
  const { info, bytes } = await bundleEnginePage({
    entry: path.join(here, 'entry.js'), html: path.join(here, 'harness.html'), outDir, internals: SHELL_INTERNALS,
  });
  if (!quiet) {
    console.log(`build-harness: ${path.relative(process.cwd(), outDir) || '.'} (${(bytes / 1e6).toFixed(1)} MB)` +
      (info.missingInternals.length ? `, missing shell internals: ${info.missingInternals.join(', ')}` : ''));
  }
  return info;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildHarness();
