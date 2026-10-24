# berg:work architecture

berg:work ships a PDF editor and an image editor, first as web apps on the website and later as native apps
(Tauri 2) for Windows, Linux and Android, the last one aimed at Googlebooks (Android-based laptops, sold in Germany
from 2026-10-05). The image editor is developed in this repository; the PDF editor is still taken over from
Fernwork (see below).

## Layout

| Path | Owns |
| --- | --- |
| `apps/pdf/` | berg:work PDF: Tauri shell (`src-tauri/`), host page (`web/`), packaging. `upstream/` holds the pinned editor build; `dist/` is assembled from `web/` and `upstream/` (see `apps/pdf/README.md`). |
| `apps/image/` | berg:work Image: the image editor itself (source, tests, Tauri shell in `src-tauri/`), moved here with its history from the former fwimg repository on 2026-10-24. Its own `package.json`/`package-lock.json`; not an npm workspace yet. |
| `packages/ui/` | The design base shared by both apps: tokens, fonts and React components after the Himmel:CAD Builder UI lab, with a demo page (`npm run dev --workspace @bergwork/ui`). |
| `packages/host-tauri/` | Host implementation shared by both apps: files, models, OCR, fonts, codecs, printing. |
| `packages/hardware-profile/` | Hardware identity, capabilities, budgets and device quirks (TypeScript side). |
| `crates/` | Native Rust code: the hardware profile and native compute (ONNX Runtime, OCR, codecs). |
| `scripts/sync-upstream.mjs` | Pins, materialises and checks the upstream editor builds. |
| `website/` | Marketing site. |

## Editors and where they live

| Editor | Home | Status |
| --- | --- | --- |
| Image | this repository, `apps/image/` | Developed here. Its rendering and editing code grew from the MIT-licensed macOS editor Compositor (`apps/image/LICENSE.upstream`, parity tracking in `apps/image/parity.json`). |
| PDF | Fernwork (`../17_fernwork`, branch `main`), pinned in `upstream.lock.json` | Taken over as the committed bundle `tools/vendor/pdf-tools`, `pdf-runtime` and the OCR engine `tesseract-5.0.4`. Planned: a fork into this repository, after which Fernwork PDF changes are ported here by an agent. |

Rules:

1. **Pinned upstreams are not edited here.** `npm run sync:check` fails when a file under `apps/*/upstream/`
   differs from the pinned build; a defect in pinned editor code is fixed upstream and pinned again. This applies to
   the PDF editor until it is forked; the image editor in `apps/image/` is ordinary source.
2. **Hosts, not forks of behaviour.** An editor receives a host object at mount time. The browser host keeps the
   web behaviour; the Tauri host maps the same capabilities to native code. Features that the native apps have and
   the browser does not are optional capabilities or registered modules, never `if (tauri)` branches inside the
   editor.
3. **Each editor owns its contract.** Image editor: `apps/image/src/platform/hosts/types.ts`; PDF editor: to be
   introduced, see `docs/PDF-HOST-CONTRACT.md`. One Tauri host implements both contracts.
4. **Pins move deliberately.** `npm run sync:update <name>` pins a new upstream commit and prints the upstream
   changes since the old pin.

The pinned upstream builds are not committed. `npm run sync:install` recreates them from `upstream.lock.json` and
fails if the result does not match the locked digest. Per machine, an upstream checkout can be moved with
`BERGWORK_UPSTREAM_<NAME>` (for example `BERGWORK_UPSTREAM_FERNWORK_PDF`).

## Hardware and platforms

Platform differences are kept out of the editors and out of shared code paths:

- **Capabilities, not vendor checks.** Code asks "can this device do X", never "is this an AMD GPU". Device
  fixes are rules in one quirk file in `packages/hardware-profile`, generated into the Rust table, with a drift
  check (copied from Himmel:CAD ADR 0032 § 3).
- **One adapter per platform behind the same contract.** Browser (upstream), Tauri desktop, Tauri Android.
  The same contract tests run against every adapter, so an Android optimisation cannot change desktop or
  browser behaviour.
- **Truthful status.** The app shows which backend really runs (WebGPU, WebGL2 or software) and recovers from a
  lost GPU device through a persisted fallback.
- **Native where it pays.** Candidates: ONNX Runtime with NPU/GPU execution providers for background removal
  and OCR, native PDFium, codecs through the OS (HEIC through Android `ImageDecoder`, Windows WIC), no 4 GB
  WebAssembly memory limit for very large documents. Each native path keeps the WebAssembly path as fallback.

Known platform risks: WebKitGTK on Linux (slower canvas/WebGL, no WebGPU; if it is not good enough, Electron
with the same Rust core is the desktop fallback), Android WebView memory limits, x86_64 and arm64 builds for
Android, large models versus the Play Store's base-module size (Play Asset Delivery).

## Googlebook desktop quality

Google's desktop app quality guidelines
(https://developer.android.com/docs/quality-guidelines/adaptive-app-quality/experiences/desktop) are the
acceptance list for the Android builds. Most relevant for document editors: File_Handlers, File_Picker,
File_Management_Basics, Printing_Support, Multi-Instance, Drag_Drop_Support, Keyboard_Parity,
Input_Combinations, Custom_Cursors, Scrollbar_Display, Desktop_Menus, Offline_Support.

## Licence

Same Business Source License 1.1 as Fernwork and Himmel:CAD; see `LICENSING.md`. Tauri builds stay internal until
the owner's legal review is done.
