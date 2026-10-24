# berg:work Image

The image editor of berg:work: an offline-first image editor for the web and a Tauri 2 desktop shell. Its rendering
and editing code grew from the MIT-licensed macOS editor Compositor; that origin is recorded in the About dialog and
`LICENSE.upstream`, not used as the product name. It was developed as "Fernwork Bildeditor" in the separate fwimg
repository and moved here with its history on 2026-10-24; the in-app name still reads "Fernwork Bildeditor" until
the berg:work UI round.

The web page (`index.html`, `src/app/shell.tsx`) is the berg:work window: the title bar of the design base
(`packages/ui`, aliased in `vite.bergwork.ts`) above the editor; the editor's colours, type and radii come from the
design base's tokens (`src/ui/editor.module.css`).

This directory is a standalone npm project (own `package-lock.json`, Node 22): run the commands below inside
`apps/image/`. Parity with Compositor is tracked in `parity.json`.

## Run and build

```sh
npm install
npm run dev
npm run typecheck
npm run build
npm run tauri:dev
npm run tauri:build
```

The web build is written to `dist/`; the Tauri frontend is written to `dist-tauri/`. The application has no
telemetry and makes no network request without a user action. Optional model downloads are resolved, verified, and
cached by the host's `ModelHost` capability.

## Public API

Import `mountEditor` from `src/index.ts` and pass a DOM element plus a `HostAdapter` from the frozen v1
`contracts.ts`. V2 document/handle types live in `contracts-v2.ts`. Platform integrations should expose optional,
versioned capabilities from `src/platform/hosts/types.ts` through `host.capabilities`:

- `files` for native pickers, recent files, and streaming save targets
- `fonts` for system-font discovery and loading
- `codecs` for host image decoding and the explicit opt-in HEIC decoder
- `compute`, `models`, `color`, `screenColor`, and `scratch` for native acceleration or OS integration

The browser implementation is `createBrowserHost()` in `src/platform/browserHost.ts`; the desktop implementation is
`createTauriHost()` in `src-tauri/frontend/host.ts`.

## Architecture

- `src/core` contains the document model, tiled immutable rasters, editing engines, selections, history, and
  framework-free commands.
- `src/render` contains the PixiJS/WebGL2 compositor and its software fallback.
- `src/workers` and `src/wasm` contain worker-owned heavy operations and the compiled image kernels/codecs.
- `src/io` reads and writes the V2 `.fwimg` archive, retains the V1 reader, imports PSD/PSB and raster formats, and
  reads/writes Compositor `.comp` packages for interoperability.
- `src/ui` and `src/app` contain the React 19 interface and feature wiring.
- `src/platform` contains browser adapters, recovery storage, and the versioned host capability model.

## Tests

| Command | Coverage |
| --- | --- |
| `npm run typecheck` | Whole-project strict TypeScript |
| `npm run test:unit` | Pixel, document, history, import/export, and engine tests |
| `npm run test:e2e` | Chromium UI workflows and real compositor/document results |
| `E2E_ALL_BROWSERS=1 npx playwright test --project=firefox --project=webkit` | Cross-browser workflow subset |
| `npm run test:perf` | Explicit performance/large-document tests |
| `npm run notices` | Regenerate npm and Rust dependency inventories in `THIRD_PARTY_NOTICES.md` |

Use `PLAYWRIGHT_BROWSERS_PATH` when browsers are installed in a shared cache. Performance measurements record
`uptime` because this repository is commonly tested on a shared machine.

## Platform differences

WebGL2 is preferred and the CPU/Canvas 2D compositor is the fallback. Browser HEIC decode is used when available;
otherwise a host codec may handle it or explicitly enable the separately replaceable LGPL libheif WASM component.
Colour-managed PNG, TIFF, JPEG, WebP, and AVIF paths use the documented Little CMS/native codec components. The
Fast U²-Netp subject model is bundled; the larger BiRefNet model is downloaded only after the user selects it and is
cached by `ModelHost`.

Chromium can overwrite a granted file through File System Access. Other browsers fall back to downloads. The Tauri
shell uses native file targets and streams project archives to disk. Browser-reserved New/Close shortcuts use
Option+Command on macOS; native shells forward Command+N/Command+W.

## Licences

See `THIRD_PARTY_NOTICES.md` for the generated production dependency inventory plus native codecs, fonts, models,
and copied kernels. Model provenance and immutable checksums are in `MODEL_LICENSES.md`.
