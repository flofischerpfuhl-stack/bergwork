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

Where the macOS app relies on Apple frameworks, the port uses the closest available replacement:

- **Renderer:** WebGL 2 normally. Without it, a CPU/Canvas 2D renderer takes over; it has the same compositing
  semantics but is slower.
- **HEIC:** decoded natively where the browser can (Safari). Otherwise a host may decode it (the planned Tauri app
  through OS codecs, see `docs/tauri-heic.md`). A web host may also opt in to a separately loaded LGPL-3.0
  libheif/libde265 WASM decoder (`heicDecoder: 'lgpl-wasm'`, off by default; HEVC patents are the distributor's
  responsibility). If none of these is available, the user gets a readable error.
- **Colour:** embedded ICC profiles in PNG and TIFF are converted to sRGB with Little CMS 2 (MIT). JPEG uses the
  browser's colour-managed decoder.
- **Remove Background:** Apple Vision is replaced by two local models on ONNX Runtime Web:
  - "Fast": U²-Netp, bundled, 4.6 MB.
  - "Best quality": BiRefNet_lite, MIT, 200 MB, downloaded once and cached. Hosts should self-host it through
    `subjectModelUrls`.

  Separate subjects are found as connected components of the mask.
- **Blurs:** a true Gaussian (σ = radius) and a Gaussian-weighted directional motion blur, as Core Image uses them.
  They are close to, but not bit-identical with, Apple's proprietary implementation.
- **Keyboard:** browsers reserve ⌘N/⌘W, so New Canvas and Close Project are ⌥⌘N/⌥⌘W in a browser. ⌘N/⌘W also work
  where the host passes them on (desktop shells).
- **Quitting:** a browser only allows its generic "leave page?" prompt for unsaved tabs. Per-tab Save/Don't Save is
  asked when a tab is closed. Recovery copies in IndexedDB cover crashes and reloads.
- **Saving:** in Chromium, Save overwrites the chosen file through the File System Access API. Other browsers download
  a new file each time.
- **Project format:** the default format is the host contract's ZIP archive. The macOS `.comp` package (versions 1–7)
  can be opened (zipped, or as a folder) and a copy saved for the Mac app.

Optional host fields beyond `contracts.ts`:
- `saveFileAs` / `saveFileTo`: Save and Save As to a chosen file.
- `decodeImage`: decoding with host (e.g. OS) codecs.
- `heicDecoder`: turns on the LGPL HEIC decoder.
- `subjectModelUrls`: where the subject models are loaded from.

Open issues are tracked in the handoff report (`artifacts/handoff.md`).

## Licences

Upstream Compositor: MIT, see `LICENSE.upstream`. The following are listed with their licences in
`THIRD_PARTY_NOTICES.md` and `MODEL_LICENSES.md`: the copied C kernels, Little CMS (MIT), ONNX Runtime Web (MIT),
U²-Netp (Apache-2.0), BiRefNet_lite (MIT), and the optional LGPL-3.0 HEIC decoder.
