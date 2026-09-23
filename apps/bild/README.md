# Compositor browser port

A browser port of [Compositor](https://github.com/robbietilton/Compositor) (macOS, Swift/SwiftUI/C, MIT) at upstream
commit `a19db9011282399785dc18efcfded904627bdcc2`, for later integration into Fernwork (web, Tauri/Electron). It is a
standalone package: Fernwork's existing photo editor is not touched. The host contract is `contracts.ts` (unchanged).

Upstream behaviour is the specification: formulas, state transitions, limits, undo naming and error texts are ported
from the Swift/C sources and their tests, and the source files are cited in the code. Where a browser has no exact
equivalent of an Apple API the closest faithful replacement is used; every such deviation is listed below.

## Run

```sh
npm install
npm run dev          # editor at http://localhost:5173 (standalone host: file pickers, downloads)
npm run build        # production build in dist/
npx vite preview     # serve the build
```

Embedding: `import { mountEditor } from './src/index'` and pass a `HostAdapter` (see `contracts.ts`). Hosts may also
implement the optional `saveFileAs`/`saveFileTo` capabilities of `FileTargetHost` (`src/platform/browserHost.ts`) for
Save/Save As to a chosen file; without them Save hands the archive to `saveFile`.

## Tests

| Command | What |
|---|---|
| `npm run typecheck` | TypeScript strict, whole project |
| `npm run test:unit` | Vitest: engines against ported upstream test cases (pixels, documents, history) |
| `npm run test:e2e` | Playwright in Chromium: real UI workflows, GPU compositor vs CPU reference, adjustments, subject model |
| `npx playwright test --project=perf-gpu` | Real-GPU timings (pan, zoom, brush feedback) → `artifacts/performance/` |
| `E2E_ALL_BROWSERS=1 npx playwright test --project=firefox --project=webkit` | Workflow specs in Firefox and WebKit |
| `npm run test:perf` | Node timings of engines → `artifacts/performance/core.json` |

Browsers for Playwright: `npx playwright install chromium firefox webkit`.

## Architecture

- `src/core` — framework-free engines and the document model: tiled immutable rasters (256 px tiles, copy-on-write),
  `EditorSession` (commands, transactions, snapshot undo sharing raster tiles), workspace tabs, selection, brush,
  retouch, adjustments/filters, transforms/distort, canvas operations, subject removal, import queue.
- `src/render` — WebGL2 compositor on PixiJS: view-space passes with custom GLSL (blend modes in sRGB as upstream,
  masks, clipping stacks, pass-through folders, live adjustment programs), tile-diff texture uploads, exact readback
  for export.
- `src/workers`, `src/wasm` — Web Workers for heavy work (archive encoding, image operations, adjustment/filter jobs,
  subject model) and the upstream C kernels compiled to WASM.
- `src/io` — PNG/JPEG/TIFF/HEIC import, PNG/JPEG export, the port's project archive (`ProjectManifestV1`), and the
  macOS app's `.comp` package format (versions 1–7, read and write).
- `src/ui`, `src/app` — React UI (desktop and compact/phone layouts, German and English) and the feature modules that
  wire engines to menus, tools, context bars and non-modal panels.
- `src/platform` — browser host (pickers, downloads, File System Access) and IndexedDB recovery copies.

## Deviations from upstream

- **Renderer:** WebGL 2 is required; there is no software-rendering fallback. Without WebGL 2 the canvas shows an
  error message.
- **HEIC:** decoded only where the browser can (Safari); elsewhere a readable error asks for JPEG/PNG. No
  licence-compatible bundled HEVC decoder exists.
- **Remove Background:** Apple Vision is replaced by the local U²-Netp model (Apache-2.0, ONNX Runtime Web, WebGPU or
  WASM). It yields one fused salient-object map instead of separate subject instances.
- **Core Image filters:** Gaussian and axis-aligned motion blur use three sliding box passes; oblique motion blur uses
  sampled Gaussian convolution. Results are close to, not bit-identical with, Core Image.
- **Colour management:** documents are sRGB; embedded ICC profiles are not converted.
- **Keyboard:** browsers reserve ⌘N/⌘W, so New Canvas and Close Project are ⌥⌘N/⌥⌘W in a browser. ⌘N/⌘W also work
  where the host passes them on (desktop shells).
- **Quitting:** a browser only allows its generic "leave page?" prompt for unsaved tabs. Per-tab Save/Don't Save is
  asked when a tab is closed. Recovery copies in IndexedDB cover crashes and reloads.
- **Saving:** in Chromium, Save overwrites the chosen file through the File System Access API. Other browsers download
  a new file each time.
- **Project format:** the default format is the host contract's ZIP archive. The macOS `.comp` package can be opened
  (zipped, or as a folder) and a copy saved for the Mac app.

Open issues are tracked in the handoff report (`artifacts/handoff.md`).

## Licences

Upstream Compositor: MIT, see `LICENSE.upstream`. Copied C kernels, the U²-Netp model and ONNX Runtime Web are listed
in `THIRD_PARTY_NOTICES.md` and `MODEL_LICENSES.md`.
