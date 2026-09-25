# PDF editor host contract

Status: design proposal. The first slice exists in Fernwork since 2026-09-25 (see "Implemented so far" below);
the rest is not implemented.

## Implemented so far

`mount(element, options?)` accepts `options.host.capabilities.shell` with `version: 1` and uses these members of
`ShellHost`; everything else in this document is still a proposal. Without a host the editor behaves as the
Fernwork browser tool.

| Member | Editor behaviour |
| --- | --- |
| `setTitle(title, { dirty })` | Called with the active document's name and its unsaved state instead of setting `document.title`. |
| `setFullscreen?(fullscreen)` | With a shell but without this method the editor shows no fullscreen toggle. |
| `titleBar?.leading`, `titleBar?.trailing` | DOM nodes the editor places first and last in its top row (app icon, window controls). The host keeps ownership; unmounting only detaches them. |
| `titleBar?.startDrag()`, `titleBar?.toggleMaximize()` | Called on a primary-button press (a second press of a double-click toggles maximise) on empty space of the top row or the tab strip. |

Source: `vendor/build/src/pdf-tools-shell.jsx` (`normalizeShellHost`, `HostSlot`), covered by
`test/e2e/pdf-floating-toolbar.spec.ts` in Fernwork. The editor stylesheet also carries zero-specificity toast
defaults so a host page does not need Fernwork's site stylesheet.

This document describes the host boundary that Fernwork's PDF editor should expose to berg:work. Source references are relative to the Fernwork repository unless another root is named, and line numbers refer to the working tree inspected on 2026-09-25. The implementation remains in Fernwork; berg:work consumes only the committed upstream build, as required by `upstream.lock.json:4-33` and `docs/ARCHITECTURE.md:19-40` in this repository.

## Decision summary

The public entry point should become:

```ts
mount(element, { host })
```

The editor must not detect Tauri, Android, WebView2, or WebKitGTK. It asks a versioned capability registry for services. Fernwork supplies `createBrowserPdfHost()`, whose behavior is the behavior of the browser product today. berg:work supplies a Tauri host. The initial compatibility adapter must also accept today's `mount(element)` call, so `tools/js/pdf-tools-shell.js` can migrate independently.

The design follows the image editor's `VersionedCapability`, capability map, `getCapability`/`hasCapability`, ownership binding, and legacy-adapter pattern (`src/platform/hosts/types.ts:4-27,104-176` in the compositor workspace). The shared `FileSystemHost`, `FontHost`, `ComputeHost`, and `ModelHost` data shapes remain compatible. PDF-specific file kinds, persistence, PDFium transport, OCR, printing, signing, shell integration, and asset resolution are additional capabilities.

Two rules keep browser behavior stable:

1. Browser APIs live in `createBrowserPdfHost()`, not in editor controllers or React components.
2. Absence of an optional capability has one documented fallback. The editor never invents a second network, file, or persistence path.

## Current boundary and inventory

### Mount and page bootstrap

| Touchpoint | Current behavior | Why it matters outside a browser tab |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:37009-37017` | Exports `mount(host)`, but `host` is an `HTMLElement`; it renders `<App />` with no platform object. | There is no injection point for Tauri services. The parameter should be renamed `element`, with an options object added. |
| `tools/js/pdf-tools-shell.js:60-66` | Finds `#pdf-tools-root`, adds a class to `document.body`, performs storage cleanup, loads CSS, dynamically imports the bundle, and calls `bundle.mount(host)`. | Page ownership, storage migration, and editor mounting are coupled. A native shell needs explicit initialization and cleanup, and multiple windows or mounts must not share accidental body-global state. |
| `tools/pdf-tools.html:964-985` | Loads PDF-Lib and PDF.js, writes them to `window`, sets the PDF.js worker URL, waits for service-worker readiness, initializes the shell, then installs the file-open router. | Tauri cannot depend on a service worker or globals populated in a particular script order. The browser host/bootstrap may retain them; the editor contract should receive runtime and asset services explicitly. |
| `vendor/build/src/pdf-tools-shell.jsx:128-129` | Reads `window.pdfjsLib` and `window.PDFLib`. | A packaged WebView needs deterministic module loading and CSP-compatible URLs. These globals also prevent isolated multiple mounts. |

### Opening files and operating-system file handlers

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:471-487` | `FileButton` creates hidden HTML file inputs. | Native pickers need SAF on Android and native dialogs on desktop; HTML inputs cannot retain a native document identity for later overwrite. |
| `vendor/build/src/pdf-tools-shell.jsx:22542-22549` | Hidden inputs open PDF/project files, append PDFs, insert images, and choose signature images. Additional inputs select watermarks (`:33778`), locked PDFs (`:34153`), and certificates (`:34252,34264,34274`). | Every picker must be routed through a common file capability so `content://` permission grants and desktop paths stay opaque to the editor. |
| `vendor/build/src/pdf-editor/interaction/rich-text-inspector-editor.jsx:351-352` | A hidden input accepts local font files. | This is another file-picker entry point and must use the same host lifecycle and size/type policy. |
| `vendor/build/src/pdf-tools-shell.jsx:9986-10011,10023-10070` | `FileReader` copies an input `File` into memory and loads it as a PDF. The source handle/path is discarded. | Direct Save cannot target the opened document; recents, canonical identity, permissions, and cross-window ownership are lost. |
| `vendor/build/src/pdf-tools-shell.jsx:15416-15475` | `openFiles` filters PDF/project files and opens multiple selections in order, reporting progress and errors. | This sequencing is useful and should remain editor-owned. The host supplies references and bytes, preserving order and per-file failures. |
| `vendor/build/src/pdf-tools-shell.jsx:23201-23227` | The empty state handles browser drag/drop; its Choose button clicks the first matching input. | Tauri must normalize OS drop events to the same open-file stream. Android desktop mode must accept single and batch drops. |
| `vendor/build/src/pdf-tools-shell.jsx:15513-15533` | Registers the editor with the shared paste target and listens for `oo-open-file-pdf` document events. | These are browser transport mechanisms, not the editor contract. They belong in `BrowserFileSystemHost`. |
| `assets/file-paste.js:15-40,42-74,77-107` | A document-wide capture listener extracts clipboard files, dispatches them to registered targets, or synthesizes a `DataTransfer` for a file input. | Document-global registration is unsafe for multiple editor instances. Native clipboard/drop delivery must be routed to the intended window and mount. |
| `assets/file-open.js:50-88` | If `window.launchQueue` exists, consumes `FileSystemFileHandle`s, reads the files, chooses a viewer by URL hash, and dispatches `oo-open-file-*`. | Chromium-only PWA plumbing must become one implementation of `files.onOpenFiles`. Tauri desktop associations and Android `application/pdf` intents produce the same event without simulating DOM events. |

The current editor has no persistent source reference, no `content://` representation, and no lifecycle for Android persistable URI grants. A host reference must therefore be opaque; editor code must never parse it as a path or URL.

### Saving, Save As, and exports

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:2512-2533` | Detects `window.showSaveFilePicker`, chooses a handle, then calls `createWritable()`, `write()`, `close()`, and `abort()` on failure. | File System Access is absent in WebKitGTK and many Android WebViews. Native targets need an equivalent close-confirmed write, including SAF streams. |
| `vendor/build/src/pdf-tools-shell.jsx:14442-14443` | Stores native save handles in memory and creates one `DocumentSaveCoordinator`. | Handles do not survive reload, do not originate from normal input/open routes, and are not portable. The coordinator must remain editor-owned while targets are host-owned. |
| `vendor/build/src/pdf-editor/persistence/document-save-coordinator.js:37-72` | Coalesces saves by document and kind, invokes `work()` synchronously to preserve transient user activation, and lets callers wait for one document. | This ordering is a contract requirement. A host picker must be called synchronously from the initiating command on browsers; native hosts may not need activation but must preserve the same save serialization. |
| `vendor/build/src/pdf-tools-shell.jsx:20585-20613,20762-20786` | A normal full PDF save uses/reuses a picker handle when available. Otherwise it downloads `*-edited.pdf`. Saved-version state advances only after the write closes; a download records a separate last-downloaded version. | The host result must distinguish a durable write from a download/export. Cancel and write failure must never clear dirty state. |
| `vendor/build/src/pdf-tools-shell.jsx:20813-20829` | Range, flattened, and suffixed exports use distinct coordinator keys. | Export operations must not accidentally coalesce with Save or update the document's source target. |
| `vendor/build/src/pdf-tools-shell.jsx:20972-21113` | Project save behaves similarly but writes `.fwdoc`; `Ctrl+Shift+S` means Save Project, not Save As. | The product currently has no explicit Save As command. Native UX must not silently assign conventional Save As semantics without an owner decision. |
| `assets/utils.js:19-27` | Fallback export creates an object URL, clicks an `<a download>`, then revokes it. | This does not provide a chosen destination or completion guarantee in a WebView. It belongs in the browser file host only. |
| `vendor/build/src/pdf-tools-shell.jsx:20769,20935-20938,21073,21589-21649,21934,22001,33708-33710,34366` | PDF variants, signed PDFs, project files, optimized/restricted/unlocked PDFs, form output, batch ZIPs, generated certificates, and OCR text use direct downloads in at least one path. | All emitted files need a single host export operation with consistent cancellation, filename, MIME type, and completion semantics. |
| `vendor/build/src/pdf-tools-shell.jsx:22371-22401,23046-23078` | Closing a dirty tab offers Save, Discard, or Cancel. A browser download requires an additional confirmation before close. | Native durable writes can close immediately after confirmed completion; download-only fallback retains today's confirmation. |
| `vendor/build/src/pdf-tools-shell.jsx:21115-21141,22669-22680` | `Ctrl/Cmd+O`, `Ctrl/Cmd+P`, `Ctrl/Cmd+S`, and `Ctrl/Cmd+Shift+S` are handled in the DOM and advertised with ARIA shortcuts. | Native menu commands and hardware keyboards must converge on the same editor commands without executing them twice. |

There is no explicit current Save As. The first normal save acts like Save As; later normal saves overwrite only the picker handle remembered during that session. A file opened by input, drop, paste, or `launchQueue` never becomes that target.

### Workspace persistence, recovery, and ownership

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:233-236,1468-1488` | Opens the `oo-pdf-workbench` IndexedDB database. | IndexedDB availability, quota, WebView data-directory behavior, and upgrades vary. Native persistence needs explicit durability and errors. |
| `vendor/build/src/pdf-tools-shell.jsx:2410-2505,2536-2578` | Writes workspace metadata and serializes per-document persistence; later reads it to restore sessions. | The atomic unit and ordering must survive a native backend substitution. |
| `vendor/build/src/pdf-tools-shell.jsx:14811-14931` | Loads the workspace, restores UI state, tracks durability, and debounces writes by 350 ms. | Debounce and editor-state projection remain editor policy; the storage medium belongs to the host. |
| `vendor/build/src/pdf-tools-shell.jsx:14975-15012` | Flushes on `pagehide`/hidden visibility and installs `beforeunload` while commits or undurable changes exist. | Tauri close requests and Android lifecycle callbacks are more reliable than `beforeunload`; they must enter the same flush/confirm path. |
| `tools/js/pdf-tools-shell.js:6-47` | Opens the same workspace DB before mount, removes a legacy `sessionStorage` key, and clears the DB when the application storage version changes. | Schema/version migration is split between bootstrap and editor. It should become a browser persistence-host initialization step, and a native host needs its own transactional equivalent. |
| `vendor/build/src/pdf-tools-shell.jsx:15014-15029` | Saved signature drawings are stored in `localStorage`. | This is user data, not UI implementation detail; a native store must scope it to profile/app and document the privacy policy. |
| `vendor/build/src/pdf-editor/model/journal-store.js:3-9,162-194,197-238,396-470` | Journals use IndexedDB plus OPFS for content-addressed resources and checkpoints, with explicit size budgets, cleanup, and IDB fallback. | Android WebView and WebKitGTK OPFS support/quota cannot be assumed. The host must preserve content addressing, atomic manifests, cleanup, and recovery semantics, or the browser implementation must remain available. |
| `vendor/build/src/pdf-editor/persistence/writer-lease.js:18-21,39-47,98-128,162-220` | Uses Web Locks when available and a `localStorage` heartbeat fallback to ensure one writer. | This covers same-origin browser contexts, not native instances with distinct WebView stores. A native inter-process lease must use canonical document/source identity. |
| `vendor/build/src/pdf-tools-shell.jsx:6855-6858,6905-6943,7107-7113` | The session combines transport, journal, and lease; it retries ownership and becomes read-only on contention, releasing only after writes settle. | That fail-safe behavior must remain, while the host supplies the lease primitive and meaningful identity. |

### Asset URLs, workers, WebAssembly, and PDF runtimes

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:137-149` | PDF.js CMaps and standard fonts use absolute `/tools/vendor/pdf-runtime/...` URLs. | Absolute web-root paths do not map reliably to Tauri asset protocols or Android packaged resources. |
| `vendor/build/src/pdf-tools-shell.jsx:269,8961-8972` | qpdf uses absolute `/tools/vendor/pdf-tools/qpdf.wasm` with the dynamically imported `pdfstudio` package. | WASM location, CSP, and MIME behavior differ by WebView. qpdf should receive a resolved asset or be replaced by `ComputeHost`. |
| `vendor/build/src/pdf-tools-shell.jsx:3091-3135` | A legacy PDFium state creates a module worker at an absolute `/tools/vendor/pdf-tools/pdfium-worker.js` URL. | Worker construction must be CSP- and origin-safe and share the same asset resolver as the main path. |
| `vendor/build/src/pdf-editor/engine/worker-transport.js:20-29` | The normal transport also defaults to the absolute PDFium worker URL. | A transport factory is a cleaner seam than leaking `Worker` and URLs throughout editor code. |
| `vendor/build/src/pdf-tools-shell.jsx:7133,9520-9532` | Live and inactive sessions open PDFium workers with an explicit WASM URL. | Both paths must use the same capability; missing one creates hard-to-find native-only failures. |
| `vendor/build/src/pdfium-worker.js:63,216-227` | The worker has a relative `import.meta.url` fallback and fetches the PDFium WASM bytes. | Module-worker base URLs and `fetch(file:)` behavior are inconsistent across packaged WebViews. |
| `vendor/build/src/pdfium-worker.js:137-158,11143-11169` | Fallback font descriptors resolve relative to the worker and are fetched lazily. | All script-specific fallback fonts must be packaged and addressable offline from the worker context. |
| `vendor/build/src/pdfium-worker.js:10520-10531`; `vendor/build/src/pdf-editor/text/bundled-font-programs.js:10-50` | Bundled full font programs are fetched from paths relative to `import.meta.url`. | A native asset catalog must cover these too, not only the obvious WASM files. |
| `vendor/build/src/pdf-editor/text/complex-text.js:11`; `vendor/build/build.mjs:297-301,383-389` | HarfBuzz is dynamically imported and its JS/WASM directory is copied beside the build. | Dynamic chunk and WASM resolution must work under the packaged scheme and CSP. |
| `vendor/build/build.mjs:227-301,313-395` | The build emits code-split editor/signature chunks and copies PDFium, qpdf, fallback fonts, HarfBuzz, PDF.js, CMaps, and standard fonts. | The build manifest should generate the host asset catalog; hand-maintained URL lists will drift. |
| `tools/pdf-tools.html:973-979` | The PDF.js worker URL is set from `import.meta.url`, then startup waits for the service worker. | Native packaging must not require a service worker. PDF.js still needs a packaged, same-origin/CSP-safe worker URL. |

The rendering engine also assumes browser primitives: `OffscreenCanvas` and `createImageBitmap` in `vendor/build/src/pdfium-worker.js:14916-14954`, plus main-thread `createImageBitmap` at `vendor/build/src/pdf-tools-shell.jsx:26059-26079`; Web Crypto is used for content/font hashes at `vendor/build/src/pdf-tools-shell.jsx:3217-3257,18540-18649,21779`; `ResizeObserver`, device-pixel ratio, pointer media queries, visibility, and `navigator.deviceMemory` influence layout and caches at `vendor/build/src/pdf-tools-shell.jsx:575-685`. These are WebView runtime prerequisites, not all host calls. The optional environment capability below supplies budgets/quirks; the browser host retains present feature detection and fallbacks. Unsupported required rendering primitives must fail conformance at startup, not halfway through editing.

### OCR and language data

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-editor/ocr/runtime.js:1-3,20-38` | Hard-codes `/tools/vendor/tesseract-5.0.4`, six languages (`eng`, `deu`, `fra`, `spa`, `ita`, `por`), and dynamically imports Tesseract ESM. | berg:work bundles native OCR and must neither import this engine nor download models when native OCR is selected. Browser URLs still need asset resolution. |
| `vendor/build/src/pdf-editor/ocr/runtime.js:46-107` | Creates a Tesseract worker with explicit worker/core/language paths and terminates it on cancellation. Language data is gzip-compressed. | Cancellation and progress are part of the semantic contract; a native task must be killable and free resources. |
| `vendor/build/src/pdf-tools-shell.jsx:21664-21855` | OCR materializes the document, renders pages at 2x, processes them serially, optionally fetches Noto Sans from an absolute path, converts recognized words to a searchable layer, subsets the font, and commits native commands. | Rendering, document mutation, word filtering, and searchable-layer creation should remain editor policy. Only recognition and its assets/models move behind the host. |

The current browser path is offline-capable because all OCR engine, core variants, and language files are shipped under `tools/vendor/tesseract-5.0.4`. A browser host must retain that exact behavior. A Tauri OCR capability returns the same normalized word geometry so native and browser output pass the same layer tests.

### Fonts

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:712-737,795-820` | Registers bundled preview fonts with `FontFace` and inspects `document.fonts`. | Packaged font URLs need the asset host; WebView font loading must be verified. |
| `vendor/build/src/pdf-tools-shell.jsx:18527-18676` | Accepts TTF/OTF/TTC uploads up to 64 MiB, hashes and registers them as kernel resources; it can also import an embedded PDF font. | File selection is host-owned, while parsing, validation, hashing, and document-resource registration remain editor-owned. |
| `vendor/build/src/pdf-editor/interaction/browser-font-preview.js:10-66` | Creates an exact browser preview from verified bytes with `FontFace`, including cleanup. | This remains valid in a WebView if `FontFace` works; it must not be confused with enumerating system fonts. |
| `vendor/build/src/pdf-editor/interaction/bundled-font-library.js:1-11,130-141` | Resolves and fetches bundled substitution fonts from an absolute asset base. | Move the base to `AssetHost`; keep font policy in the editor. |

The PDF editor does not currently call `queryLocalFonts` or enumerate system fonts. CSS generic families are only UI/rendering defaults. `FontHost` is therefore optional and additive: absence means today's Base-14, embedded, uploaded, and bundled-font behavior. When present, system font bytes still enter the same validation and embedding path; family names alone are never sufficient for portable PDF output.

### Digital signatures and certificates

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:20903,20953,33685` | Dynamically imports `pdf-digital-signature.js`. | The signature chunk and dependencies must be in the asset catalog. |
| `vendor/build/src/pdf-digital-signature.js:1-4,24,29-30,102-158` | Uses node-forge and global `PDFLib`; reads bounded PKCS#12/PEM files in JavaScript. | Imported private-key bytes currently enter the WebView. A native keystore implementation must use opaque identity handles and never return private keys. |
| `vendor/build/src/pdf-digital-signature.js:161-217` | Generates a self-signed RSA-2048 certificate synchronously in the renderer. | This can stall low-power Android devices and does not integrate with platform trust stores. It remains the browser fallback. |
| `vendor/build/src/pdf-digital-signature.js:232-258` | Validates key/certificate matching, validity, and key usage; signing/inspection is local. | Native signing must preserve these validation/error classes. Signature inspection currently proves byte integrity, not system trust. |
| `vendor/build/src/pdf-tools-shell.jsx:20882-20942,33678-33767` | Materializes exact bytes, protects existing signatures, signs, downloads the result, and provides certificate-generation/import UI. | Native identity selection and output saving must be independently injectable. Signing a document must not imply overwriting its source. |

### Clipboard

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `assets/utils.js:53-72` | Writes text through `navigator.clipboard`, then falls back to a hidden textarea and `execCommand('copy')`. | WebView clipboard permission/focus rules differ. This belongs in `BrowserClipboardHost`. |
| `vendor/build/src/pdf-tools-shell.jsx:19593-19678` | Copy/cut uses a custom `application/x-fernwork-pdf-selection` token plus `text/plain`; the token addresses an in-memory snapshot. External text paste creates an editable frame; clipboard files are left to `file-paste.js`. | Internal snapshots remain instance-local and must not be mistaken for portable clipboard data. Native text/file clipboard events need deterministic precedence and target routing. |
| `vendor/build/src/pdf-tools-shell.jsx:22512-22513,24443-24445,34365-34366` | Context-menu copy/cut, selected text, diagnostics, and OCR text use direct DOM or navigator clipboard calls. | All user-visible text writes should converge on one capability; edit-control cut/copy may remain native DOM behavior. |

### Printing

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-editor/rendering/print-document.js:1-50` | Tries a hidden iframe containing a PDF blob URL and calls `contentWindow.print()`, including explicit WebKit/WKWebView concerns. | Embedded PDF viewers and `window.print` are not reliable in Android WebView or WebKitGTK. |
| `vendor/build/src/pdf-editor/rendering/print-document.js:53-106` | Fallback rasterizes at 150 DPI, limits output to 300 pages, writes image HTML into an iframe, and prints it. | This is a useful browser fallback but expensive and lower fidelity. Native Android `PrintManager` and desktop print integration should receive PDF bytes directly. |
| `vendor/build/src/pdf-tools-shell.jsx:20831-20872,21127,22673,23003` | Materializes exact current PDF bytes and invokes the print helper from toolbar/menu/shortcut. | Materialization stays editor-owned; the host owns presenting the platform print UI and reporting cancel/failure. |

### Window, lifecycle, navigation, and external links

| Touchpoint | Current behavior | Native consequence |
| --- | --- | --- |
| `vendor/build/src/pdf-tools-shell.jsx:15562-15565` | Sets `document.title` from the active drawer panel, not the document filename. | Native window titles and task switchers may need document/dirty state; the exact desired title remains an owner decision. |
| `vendor/build/src/pdf-tools-shell.jsx:15544-15560,15673` | Uses URL hashes and `history.replaceState` for panel routing. | Multiple Tauri windows need instance-local navigation; the app URL must not become document identity. |
| `vendor/build/src/pdf-tools-shell.jsx:14975-15012` | Uses browser lifecycle events and `beforeunload` for durability and unsaved prompts. | Native window close, Android pause/stop, and process eviction need host events and bounded flushes. |
| `vendor/build/src/pdf-tools-shell.jsx:15497-15542,23777` | Calls the Fullscreen API, observes fullscreen state, and reloads with `window.location.reload()`. | Tauri window fullscreen/reload may need native APIs; reload must not bypass dirty-state protection. |
| `vendor/build/src/pdf-tools-shell.jsx:23879-23984,20485-20495` | Allows only `http`, `https`, `mailto`, and `tel`; renders external anchors and opens them with `_blank,noopener,noreferrer`. Internal PDF destinations stay in the editor. | Tauri should open allowed URLs through the OS after applying the same protocol policy. WebView navigation itself should remain blocked. |

### Network surface and Fernwork shared assets

No telemetry or application API request was found in the PDF editor. Runtime network activity is same-origin asset loading: chunks, workers, WASM, PDF.js CMaps/standard fonts, fallback/bundled fonts, HarfBuzz, and OCR files. External PDF links are launched, not fetched by the editor. `ModelHost` must preserve the image-editor rule that remote models may be fetched only after a user action (`src/platform/hosts/types.ts:66-78` in the compositor workspace); the PDF editor must never add an independent model fetch.

The shared Fernwork imports should be split as follows:

| Import | Current use | Destination |
| --- | --- | --- |
| `assets/icons.js` imported at `vendor/build/src/pdf-tools-shell.jsx:19`; icon catalog at `assets/icons.js:1-9` | Pure SVG markup/catalog. | Keep as editor/build UI code; no host capability. |
| `assets/toast.js` imported at `vendor/build/src/pdf-tools-shell.jsx:20`; body-global container at `assets/toast.js:7-29` | DOM notifications with a singleton container and `ResizeObserver`. | Keep as editor UI, but scope ownership to the mount so multiple instances cannot remove/share one another's container. Native notifications are not required. |
| `assets/utils.js` imported at `vendor/build/src/pdf-tools-shell.jsx:21-28` | Mixes pure formatting/IDs with download, clipboard, script loading, and file reading. | Move pure helpers into editor-local modules; browser-only operations become host implementations. The imported `loadScript` CDN fallback is not called by the PDF editor and should not become a native network path. |
| `assets/file-paste.js` imported at `vendor/build/src/pdf-tools-shell.jsx:29` | Global pasted-file routing. | Move behind `BrowserFileSystemHost`; native adapters emit the same open-file callback. |
| `assets/app-version.js` and CSS loading in `tools/js/pdf-tools-shell.js:1-2,63-65` | Bootstrap storage invalidation and styles. | Keep browser bootstrap concerns out of the editor; pass version/schema information to the persistence host. |

The service worker currently participates in browser offline behavior (`tools/pdf-tools.html:977-979`; precache entries in `sw.js:92-102`). Native builds must package every asset and work without registering or waiting for a service worker.

## Proposed API

### Mount lifecycle

```ts
export interface PdfMountOptions {
  readonly host: PdfHost;
}

export interface PdfEditorHandle {
  open(files: readonly HostFileReference[]): Promise<void>;
  requestClose(): Promise<'closed' | 'cancelled'>;
  dispose(): Promise<void>;
}

export function mount(element: HTMLElement, options: PdfMountOptions): PdfEditorHandle;
```

During migration only, the declaration may accept `options?: PdfMountOptions`. Omission calls `createBrowserPdfHost()` and logs no warning in production, preserving `bundle.mount(element)`. Once `tools/js/pdf-tools-shell.js` passes the browser host explicitly, the optional overload can be deprecated. `dispose()` must unregister global listeners, release leases, terminate workers/OCR, revoke object URLs, detach portals/toasts, and flush or explicitly report a failed flush.

The host is normalized and bound once:

```ts
export interface VersionedCapability { readonly version: number }

export interface PdfHost {
  readonly capabilities: PdfHostCapabilityMap;
}

export type PdfCapabilityName = keyof PdfHostCapabilityMap;
export function getCapability<K extends PdfCapabilityName>(
  host: PdfHost | PdfHostCapabilityMap,
  name: K,
  minimumVersion?: number,
): NonNullable<PdfHostCapabilityMap[K]> | null;
export function hasCapability<K extends PdfCapabilityName>(
  host: PdfHost | PdfHostCapabilityMap,
  name: K,
  minimumVersion?: number,
): boolean;
```

As in the image editor, capability objects are identity-bound to the adapter to prevent copied registries from leaking native handles. Version checks are `>= minimumVersion`; incompatible capabilities are treated as absent. Feature code receives capabilities, not the raw host.

### Shared file, font, compute, and model shapes

The following names intentionally match the image editor. They should ultimately live in one small shared contract package or be kept structurally identical until repositories can share types.

```ts
export interface HostFileReference {
  readonly name: string;
  readonly id: string; // opaque: path, URI, token, or browser object-table key
}

export interface FileSaveTarget { readonly name: string }

export interface SystemFont {
  readonly id: string;
  readonly family: string;
  readonly fullName?: string;
  readonly style: string;
  readonly postscriptName?: string;
}

export interface FontHost extends VersionedCapability {
  readonly version: 1;
  listSystemFonts(): Promise<readonly SystemFont[]>;
  loadSystemFont(id: string): Promise<Uint8Array>;
}

export interface ComputeResult {
  readonly bytes: Uint8Array;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}
export interface ComputeHost extends VersionedCapability {
  readonly version: 1;
  run(job: string, input: Uint8Array,
    options?: Readonly<Record<string, string | number | boolean>>): Promise<ComputeResult | null>;
}

export interface ModelRequest {
  readonly id: string;
  readonly sha256: string;
  readonly url?: string;
  readonly userInitiated: boolean;
}
export interface ResolvedModel { readonly bytes: Uint8Array; readonly cacheHit: boolean }
export interface ModelHost extends VersionedCapability {
  readonly version: 1;
  resolveModel(request: ModelRequest,
    progress?: (loaded: number, total: number | null) => void,
    signal?: AbortSignal): Promise<ResolvedModel | null>;
}
```

`FontHost`, `ComputeHost`, and `ModelHost` are exact reuse. `FileSystemHost` reuses the same reference, target, read/write, recents, source-to-target, and open-event concepts, but PDF needs different discriminants. The image editor's `'project'` means its own project formats; the PDF editor calls its portable project `'pdf-project'`. The PDF editor also distinguishes normal document Save from derivative export.

```ts
export type PdfOpenKind =
  | 'pdf' | 'pdf-project' | 'append-pdf' | 'image'
  | 'font' | 'certificate' | 'signature-image';

export type PdfSaveKind =
  | 'pdf' | 'pdf-project' | 'text' | 'zip' | 'certificate';

export interface PdfFileSystemHost extends VersionedCapability {
  readonly version: 1;
  chooseFiles(kind: PdfOpenKind, options?: { readonly multiple?: boolean }):
    Promise<readonly HostFileReference[]>;
  chooseSaveTarget(suggestedName: string, kind: PdfSaveKind):
    Promise<FileSaveTarget | null>;
  readFile(file: HostFileReference): Promise<Blob>;
  writeFile(target: FileSaveTarget, blob: Blob): Promise<void>;
  /** Browser download or native export when no persistent save target was selected. */
  exportFile(suggestedName: string, kind: PdfSaveKind, blob: Blob): Promise<void>;
  recentFiles(): Promise<readonly HostFileReference[]>;
  recordRecentFile(file: HostFileReference): Promise<void>;
  onOpenFiles(listener: (files: readonly HostFileReference[]) => void): () => void;
  saveTargetFor(file: HostFileReference): FileSaveTarget | null;
}
```

The shared Tauri implementation can implement image `FileSystemHost` and `PdfFileSystemHost` over the same opaque handle table and storage layer. Only accepted kinds, extensions, and export semantics differ. On Android, `id` names a retained host-side SAF token, not the literal `content://` URI exposed to editor code. `writeFile` resolves only after close/flush succeeds. Cancellation returns `null` from a picker; errors reject with stable codes. `exportFile` never changes the document's save target.

### PDF-specific capabilities

```ts
export type PdfAssetId =
  | 'pdfjs.worker' | 'pdfjs.cmaps' | 'pdfjs.standardFonts'
  | 'pdfium.worker' | 'pdfium.wasm'
  | 'qpdf.wasm' | 'harfbuzz.module'
  | `fallbackFont.${string}` | `bundledFont.${string}`
  | 'ocr.module' | 'ocr.worker' | `ocr.core.${string}` | `ocr.language.${string}`
  | 'signature.chunk';

export interface AssetHost extends VersionedCapability {
  readonly version: 1;
  /** URL must be usable from the declared context under the app's CSP. */
  url(id: PdfAssetId, context?: 'document' | 'module-worker'): string;
  /** Optional byte route for hosts/protocols where fetch is unavailable. */
  read?(id: PdfAssetId, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PdfEngineTransport {
  request<T>(operation: string, payload: unknown,
    transfer?: readonly Transferable[]): Promise<T>;
  close(): Promise<void>;
}
export interface PdfEngineHost extends VersionedCapability {
  readonly version: 1;
  openTransport(options: { readonly documentId: string }): Promise<PdfEngineTransport>;
}

export interface OcrLanguage {
  readonly id: string;
  readonly label: string;
}
export interface OcrWord {
  readonly text: string;
  readonly confidence: number;
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly baseline?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly blockIndex: number;
  readonly paragraphIndex: number;
  readonly lineIndex: number;
  readonly wordIndex: number;
}
export interface OcrHost extends VersionedCapability {
  readonly version: 1;
  languages(): Promise<readonly OcrLanguage[]>;
  recognizePage(request: {
    readonly rgba: Uint8Array;
    readonly width: number;
    readonly height: number;
    readonly language: string;
  }, progress?: (fraction: number) => void, signal?: AbortSignal): Promise<readonly OcrWord[]>;
}
```

The editor continues to render pages, normalize/filter recognition, choose font height/baseline, subset fonts, and commit the searchable layer. `OcrHost` does recognition only. Its coordinates are pixel coordinates in the supplied raster, with origin at its top-left. Ordering fields are mandatory so native OCR cannot silently reorder columns. For browser parity, the adapter wraps current Tesseract output. If native OCR requires ONNX data, it obtains verified bundled bytes through shared `ModelHost`; the editor does not download them.

```ts
export interface WorkspaceSnapshot {
  readonly schemaVersion: number;
  readonly bytes: Uint8Array;
}
export interface PersistenceLease {
  readonly mode: 'writer' | 'reader';
  release(): Promise<void>;
}
export interface PdfPersistenceHost extends VersionedCapability {
  readonly version: 1;
  loadWorkspace(): Promise<WorkspaceSnapshot | null>;
  saveWorkspace(snapshot: WorkspaceSnapshot): Promise<void>;
  clearWorkspace(reason: 'incompatible-schema' | 'user-request'): Promise<void>;
  getPreference(key: string): Promise<Uint8Array | null>;
  setPreference(key: string, value: Uint8Array | null): Promise<void>;
  openJournal(documentId: string): Promise<PdfJournal>;
  acquireLease(documentKey: string, instanceId: string): Promise<PersistenceLease>;
}

export interface PdfJournal {
  load(): Promise<unknown>;
  save(record: unknown): Promise<void>;
  loadResource(hash: string): Promise<Uint8Array | null>;
  putResource(hash: string, bytes: Uint8Array): Promise<void>;
  cleanup(retained: ReadonlySet<string>): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

The concrete journal record types should be imported from the existing journal module rather than left as `unknown`; the placeholders show ownership only. The contract must preserve content hashes, revision/checkpoint ordering, abort semantics, quotas, and explicit retained sets. It must not expose IndexedDB transactions or filesystem paths. `schemaVersion` replaces the page loader's direct application-version deletion. Migration policy should prefer typed migrations; destructive clearing remains explicit.

```ts
export interface PrintHost extends VersionedCapability {
  readonly version: 1;
  printPdf(bytes: Uint8Array, options: {
    readonly name: string;
    readonly title?: string;
    readonly signal?: AbortSignal;
  }): Promise<'printed' | 'cancelled'>;
}

export interface ClipboardHost extends VersionedCapability {
  readonly version: 1;
  writeText(text: string): Promise<void>;
  readText?(): Promise<string>;
}

export type HostCommand =
  | 'open' | 'save' | 'save-project' | 'print'
  | 'undo' | 'redo' | 'find' | 'close';
export interface ShellHost extends VersionedCapability {
  readonly version: 1;
  readonly instanceId: string;
  setTitle(title: string, options?: { readonly dirty?: boolean }): void;
  openExternal(url: string): Promise<void>;
  onCloseRequested(listener: () => Promise<'allow' | 'prevent'>): () => void;
  onLifecycle(listener: (event: 'foreground' | 'background' | 'suspend') => void): () => void;
  onCommand(listener: (command: HostCommand) => void): () => void;
  setFullscreen?(fullscreen: boolean): Promise<void>;
  reload?(): Promise<void>;
}
```

`onCommand` is an alternate input channel for native menus and Android desktop shortcuts. DOM shortcuts remain active, but the shell must suppress duplicate delivery. `openExternal` receives only URLs that already pass the editor's protocol allowlist. Close handling calls the same dirty-state and durability logic as the editor's tab close; the host never decides whether edits are safe to discard.

```ts
export interface SigningIdentity {
  readonly id: string;
  readonly label: string;
  readonly subject?: string;
  readonly validFrom?: number;
  readonly validTo?: number;
}
export interface CertificateHost extends VersionedCapability {
  readonly version: 1;
  listSigningIdentities(): Promise<readonly SigningIdentity[]>;
  signPdf(request: {
    readonly identityId: string;
    readonly pdf: Uint8Array;
    readonly field: Readonly<Record<string, string | number | boolean>>;
    readonly signal?: AbortSignal;
  }): Promise<Uint8Array>;
}

export interface EnvironmentHost extends VersionedCapability {
  readonly version: 1;
  profile(): Readonly<{
    memoryBudgetBytes?: number;
    maxRasterPixels?: number;
    maxWorkerCount?: number;
    quirks?: readonly string[];
  }>;
}
```

`CertificateHost` supplements rather than replaces file-based browser signing. The browser host exposes the existing node-forge flow; a native host may expose OS/Android keystore identities. Private-key material never crosses the boundary. Self-signed certificate creation remains a separate browser feature until its product and storage semantics are decided.

`EnvironmentHost` is advisory and maps naturally to berg:work's hardware-profile package (`docs/ARCHITECTURE.md:13-15,46-64`). Absence retains current `navigator.deviceMemory`, media-query, and runtime feature detection. Quirk strings are host-defined capabilities, never vendor checks in editor code.

```ts
export interface PdfHostCapabilityMap {
  readonly assets: AssetHost;
  readonly pdfEngine: PdfEngineHost;
  readonly files?: PdfFileSystemHost;
  readonly persistence?: PdfPersistenceHost;
  readonly ocr?: OcrHost;
  readonly printing?: PrintHost;
  readonly clipboard?: ClipboardHost;
  readonly shell?: ShellHost;
  readonly certificates?: CertificateHost;
  readonly fonts?: FontHost;
  readonly compute?: ComputeHost;
  readonly models?: ModelHost;
  readonly environment?: EnvironmentHost;
}
```

### Required capabilities and exact fallbacks

“Required” below means required for every normalized host after the migration. The browser host can satisfy a requirement with today's implementation. Optional does not mean “probe a browser global from editor code”; it means the feature follows the named fallback.

| Capability | Status | Default browser implementation | If absent from another host |
| --- | --- | --- | --- |
| `assets` | Required | Returns today's `/tools/vendor/...` and emitted-chunk URLs. | Mount fails early with a named missing capability. |
| `pdfEngine` | Required | Creates current `PdfEngineWorkerTransport` with asset-host worker/WASM URLs. | Mount fails early; there is no usable editor. |
| `files` | Required for the full shell | HTML inputs, File System Access picker when available, anchor download fallback, `launchQueue`, drop, and paste adapters. | Read-only/demo embedding only; Open/Save/export controls disabled with an explanation. berg:work must provide it. |
| `persistence` | Required for the full shell | Current IndexedDB/OPFS/Web Locks/localStorage behavior and schema cleanup. | Explicit ephemeral mode: no recovery or recents, visible warning, and close protection still applies. berg:work must provide it. |
| `shell` | Required for a native app; optional for an embedded editor | Browser title, lifecycle, `beforeunload`, external-window, fullscreen, and command adapter. | Embedded defaults: no title/fullscreen/reload, safe external anchors, component close API only. |
| `ocr` | Optional | Current local Tesseract engine and six shipped languages. | OCR action is unavailable; never fetch an engine/model independently. Browser host includes it, preserving behavior. |
| `printing` | Optional | Current native-PDF iframe then 150-DPI raster fallback. | Offer Export PDF; do not call `window.print` from editor code. Browser host includes it. |
| `clipboard` | Optional | `navigator.clipboard` then textarea/`execCommand` for text. | Text-copy actions report unavailable; native edit controls can still handle their own selection. Internal editor duplicate remains available without the system clipboard. |
| `certificates` | Optional | Existing PKCS#12/PEM/node-forge implementation. | Native identity choices are absent; file-based signing may still be exposed by a separately installed browser fallback. No private-key fallback download. |
| `fonts` | Optional | Not supplied initially. | Exact current uploaded/embedded/Base-14/bundled fonts. |
| `compute` | Optional | Not supplied initially; current qpdf WASM runs using `assets`. | Current WASM implementation. If neither exists, the affected optimize/restrict/unlock action is unavailable. |
| `models` | Optional | Shared browser resolver if a future PDF feature needs it. | Model-backed feature unavailable; no direct remote fetch. |
| `environment` | Optional | Current browser measurements/feature detection. | Conservative editor budgets. |

The registry may later make `persistence` and `shell` required after all supported embedders implement them. Capability absence must be decided once during mount and exposed in UI; scattered browser-global fallback is prohibited.

## End-to-end operation semantics

### Open and file-handler flow

1. The user picker, browser `launchQueue`, desktop association, Android intent, drag/drop, paste, or a programmatic `PdfEditorHandle.open()` yields ordered `HostFileReference`s.
2. `PdfFileSystemHost.readFile()` returns a `Blob`; the editor performs existing type/size/password/project validation and opens files sequentially.
3. The host records recent files only after successful open. Permission denial, revoked SAF grants, missing files, and malformed content are distinct failures.
4. `saveTargetFor(reference)` links a source to normal Save only when the platform and product policy permit in-place writing. A read-only intent or non-writable SAF URI returns `null`.
5. A second open delivery while a picker or prior batch is active is queued. The owning window/instance is explicit; no document-wide custom event is used.

For Android, the manifest registers `application/pdf` VIEW/EDIT intent filters. The Tauri layer takes persistable URI permission when offered, stores the URI/token natively, reads through `ContentResolver`, and does not copy a URI string into IndexedDB. For desktop, the host keeps absolute paths/native handles private for the same reason.

### Save flow

1. `DocumentSaveCoordinator.run()` still calls the target-acquisition function synchronously from the user gesture.
2. Normal Save first uses the document's current target. If none exists, it calls `chooseSaveTarget`. Derivative exports always use a new target or `exportFile` and never change the current target.
3. The editor materializes the exact revision required by that save. Existing coalescing and wait-by-document behavior stays intact.
4. The host write resolves only after bytes are closed and durable to the degree the platform reports. Cancel is not an error; permission loss, short write, close failure, and native IPC failure are errors.
5. Only successful durable normal Save advances the saved revision. Browser anchor export preserves today's last-downloaded state and close confirmation.

Whether `Ctrl/Cmd+Shift+S` remains Save Project or becomes conventional Save As is explicitly unresolved. No migration step should change it accidentally.

### Offline and network policy

The Tauri host resolves all `PdfAssetId`s and native OCR/model data from the installed package or an integrity-checked platform asset pack. No editor operation silently accesses the public network. `openExternal` is the only ordinary network-adjacent action, and it requires an explicit user gesture and the existing protocol allowlist. If future models are remotely installable, only `ModelHost.resolveModel({ userInitiated: true })` may fetch them, with checksum verification and progress/cancellation.

## Googlebook desktop-quality mapping

The acceptance criteria below map the host contract to Google's [desktop app quality guidelines](https://developer.android.com/docs/quality-guidelines/adaptive-app-quality/experiences/desktop). The guideline page calls for conventional keyboard shortcuts, independent multiple instances, drag/drop including batches, printing, file management/pickers/handlers, custom pointer icons, and core offline function.

| Guideline ID | Contract/implementation requirement | Acceptance evidence |
| --- | --- | --- |
| `File_Handlers` | Android `application/pdf` VIEW/EDIT intents and desktop file associations emit `files.onOpenFiles`; cold and warm delivery both work. | Open a PDF from the system file manager into no running instance and an existing instance; name, bytes, writable status, and URI permission are correct. |
| `File_Picker` | `chooseFiles`/`chooseSaveTarget` use SAF on Android and native dialogs on desktop. | Open, append, import font/certificate/image, Save, project export, cancellation, revoked permission, and reopen-after-restart tests. |
| `File_Management_Basics` | Opaque references, recents, source-to-save-target mapping, stable display names, and confirmed writes. | In-place Save where authorized, Save to a new location, missing/revoked recent file handling, no false clean state after failure. |
| `Printing_Support` | `PrintHost` sends current exact PDF bytes to Android `PrintManager` or desktop print service. | Dialog opens; cancel is harmless; page range/orientation/scale are honored by the platform; searchable/vector PDF is not pre-rasterized by the editor. |
| `Multi-Instance` | `ShellHost.instanceId` plus native `acquireLease` routes opens to windows and prevents two writers to one canonical source. | Two different documents edit independently; opening one document twice produces deliberate focus/read-only/prompt behavior; handoff is safe. |
| `Drag_Drop_Support` | Native drop is normalized to `files.onOpenFiles`, with hover/invalid-type feedback still rendered by the editor. | Drop PDF/project/image/font on valid and invalid targets using mouse and touchpad. |
| `Drag_Drop_Batch` | Ordered multiple references are preserved and processed by existing `openFiles`. | Drop multiple PDFs, mixed supported/unsupported files, and a batch containing one failure without losing later valid files. |
| `Keyboard_Parity` | DOM shortcuts and `ShellHost.onCommand` cover Open, Save, Print, Close, Undo/Redo, Find, editing, navigation, and context menus without duplicates. | Hardware-keyboard matrix on Android, Windows, and Linux; focus in text controls; keyboard-only picker/save/close recovery. |
| `Custom_Cursors` | Existing CSS cursors in `vendor/build/src/pdf-tools-theme.css:2081-2088,2149,2418-2441,5427,5590` must map to Android desktop pointer icons. A native cursor hook is added only if WebView CSS cannot meet this. | Resize, rotate, grab/pan, text, and default cursors change correctly at mouse and touchpad hover. |
| `Offline_Support` | `AssetHost`, native OCR/models, fonts, workers, and WASM are fully packaged; no service-worker dependency. | Block all network before launch; open, edit, OCR each installed language, print, save, reopen, and recover after restart. |

Outbound drag of a PDF is not represented in version 1. If Googlebook testing treats drag-out as required, add a separate `DragExportHost`; do not overload clipboard or `exportFile`.

## Incremental Fernwork migration plan

Every step below can land alone. Each step first moves existing behavior behind a browser implementation, then enables a native implementation later. Browser output, visible UI, keyboard bindings, filenames, storage schema, and network behavior remain unchanged unless a separate product change is approved.

### 1. Contract scaffold and compatibility mount

Add the versioned registry, ownership binding, `getCapability`/`hasCapability`, `createBrowserPdfHost()`, and `mount(element, { host })`. Keep a temporary `mount(element)` overload and return a disposable handle. Do not move behavior yet.

Existing guards: the whole PDF unit suite and basic editor E2E startup. New tests: capability minimum-version handling, capability ownership, legacy mount equivalence, listener cleanup, two independent mounts, and early missing-required-capability errors.

### 2. Asset catalog first

Introduce generated asset IDs and `BrowserAssetHost`; replace absolute bases for PDFium worker/WASM, qpdf, PDF.js worker/CMaps/standard fonts, fallback and bundled fonts, HarfBuzz, signature chunks, and OCR files. Keep the browser host's returned URLs byte-for-byte equivalent to today's paths. Make build output fail if a declared asset is missing.

Existing guards: `test/e2e/pdf-offline-runtime.spec.ts:11`, `test/unit/pdf-editor/sw-fallback-font-cache.test.mjs:58`, PDFium worker tests such as `test/e2e/pdfium-worker-verified-forward.spec.ts:33`, and bundled-font tests in `test/unit/pdf-editor/bundled-font-library.test.mjs:14-73`. New tests: complete asset-ID manifest, document-versus-worker URL resolution, CSP/module-worker smoke tests, no leading-root literal outside `BrowserAssetHost`, and startup with service workers disabled.

### 3. OCR capability

Wrap current Tesseract startup and recognition in `BrowserOcrHost`, using `AssetHost` for module/worker/core/language resources. Refactor the editor to consume normalized ordered words; keep page rendering, filtering, searchable-layer generation, and commits unchanged. Add a fake host and a native-host conformance fixture before berg:work integrates native OCR.

Existing guards: `test/e2e/ocr-offline.spec.ts:5-40`, `test/e2e/ocr.spec.ts`, `test/e2e/pdf-scan-ocr-selection.spec.ts:14-32`, and `test/unit/pdf-editor/ocr-text-layer.test.mjs:12-76`. New tests: language enumeration, geometry/order equivalence against a golden Tesseract result, progress monotonicity, abort/termination, host error recovery, unsupported language, no network, and repeat recognition without leaked workers.

### 4. PDF engine transport and runtime modules

Make current worker transport the browser `PdfEngineHost`. Remove component-level `new Worker`, WASM URLs, and `window.pdfjsLib`/`window.PDFLib` reads; the browser bootstrap supplies equivalent runtime modules. Retain current worker protocol and transfer lists.

Existing guards: PDFium worker unit/E2E suites, native round-trip suites, and `test/unit/pdf-editor/session-orchestrator.test.mjs:120-359`. New tests: transport open/close, worker crash and restart, cancellation, transferable buffers, multiple simultaneous documents, CSP failure diagnostics, and deterministic runtime-module injection.

### 5. Open files and file handlers

Move hidden-input creation, `launchQueue`, pasted-file extraction, and native/drop event adaptation into `BrowserFileSystemHost`. Change editor entry points to ordered opaque references plus `readFile`. Preserve all current accept filters and sequential progress. Initially the browser object table wraps existing `File`/`FileSystemFileHandle` objects.

Existing guards: existing PDF workbench/open/import E2E coverage, `test/e2e/pdf-project-native-portability.spec.ts:80-163`, and file-paste behavior outside the editor. New tests: picker cancel, multi-open order, mixed valid/invalid batches, drop/paste precedence, `launchQueue` cold/warm delivery, password-protected open, read failure, duplicate delivery, reference disposal, and programmatic `handle.open()`.

### 6. Save, Save Project, exports, and source targets

Route target selection, durable writes, and fallback downloads through `PdfFileSystemHost`. Keep `DocumentSaveCoordinator` editor-owned and invoke target selection synchronously. Convert every direct `downloadBlob` path, including signed PDFs, ZIPs, text, and certificates. Only after parity is proven should opened writable handles feed `saveTargetFor`.

Existing guards: `test/unit/pdf-editor/document-save-coordinator.test.mjs:16-71` and `test/e2e/pdf-save-confirmation.spec.ts:97-215`. New tests: picker called under activation, cancellation and retry, close/flush failure, same-kind coalescing, independent export kinds, source target versus derivative export, filename/MIME matrix, SAF partial-write simulation, dirty-state transitions, download confirmation parity, and an explicit regression that `Ctrl+Shift+S` still saves a project.

### 7. Native file-handler, drop, and multi-instance conformance

With open/save stable, add only adapter-facing contract tests for Tauri desktop associations, Android PDF intents/SAF permissions, batch drop, recents, canonical source identity, and instance routing. Fernwork receives test adapters and semantics, not Tauri conditionals.

Existing guards: the open/save tests from steps 5-6 and `test/unit/pdf-editor/ownership-font-policy.test.mjs:27-54`. New tests: cold/warm intent, persistable permission restart, revoked URI, read-only source, two-window writer contention/handoff, same-name different-document identity, ordered batch drop, and no event delivery after dispose.

### 8. Persistence and lifecycle

Extract current IndexedDB/OPFS workspace, journal, preference, and writer-lease code into `BrowserPersistenceHost`; move loader schema cleanup into its initialization. Preserve binary formats and recovery ordering. Then allow a native persistence adapter and native inter-process lease. Connect shell background/suspend events to the existing bounded flush path.

Existing guards: `test/unit/pdf-editor/journal-store-cleanup.test.mjs:232-517`, `test/unit/pdf-editor/portable-project-state.test.mjs:32-242`, `test/e2e/pdf-edit-crash-recovery.spec.ts:430-994`, and `test/e2e/pdf-project-native-portability.spec.ts:80-163`. New tests: browser schema compatibility, host transaction abort, quota/full disk, app-version migration, process-kill recovery, lifecycle flush deadline, corrupted snapshot, native lease contention, release after in-flight commit, and explicit ephemeral-mode warning.

### 9. Printing

Move iframe/native-viewer/raster logic to `BrowserPrintHost`; pass exact materialized bytes through `PrintHost`. Keep export as the documented absent-capability fallback.

Existing guard: save/materialization tests indirectly protect bytes; there is no dedicated printing test. New tests are required for exact input revision, capability absence, dialog cancel/failure, browser native-viewer path, raster fallback and 300-page limit, cleanup of iframes/object URLs, plus Android/Windows/Linux adapter tests.

### 10. Shell, external links, title, close, and keyboard commands

Move title, allowed external launch, fullscreen/reload, lifecycle, close request, and native command delivery into `ShellHost`. Preserve URL allowlisting and existing editor dirty dialog. Keep hash navigation inside `BrowserShellHost` until it can be replaced without breaking Fernwork URLs.

Existing guards: `test/e2e/pdf-links.spec.ts:28-83`, crash-recovery tests, and current close/save E2E. New tests: blocked schemes, native open failure, close during pending commit, close cancel/save/discard, background/foreground, title/dirty updates, no duplicate menu/DOM shortcut, focus-sensitive shortcut parity, and two mounted instances.

### 11. Clipboard and remaining file inputs

Route text writes through `ClipboardHost`; retain in-memory selection snapshots in the editor. Move font, certificate, signature image, watermark, append, and unlock inputs to the file host. Keep ordinary input/textarea editing under DOM clipboard behavior.

Existing guards: `test/e2e/pdf-clipboard-selection.spec.ts:35-152`, `test/e2e/pdf-clipboard-embedded.spec.ts:111`, `test/unit/pdf-editor/clipboard-placement.test.mjs:5-14`, and rich-text font-upload tests. New tests: permission denial, unavailable clipboard, custom-token expiry/cross-instance rejection, file-versus-text paste precedence, native menu cut/copy, and every secondary picker kind.

### 12. Fonts, certificates, and compute

Add optional shared `FontHost` without changing default font availability. Add `CertificateHost` for opaque platform identities while retaining current file-based browser signing. Allow qpdf jobs through shared `ComputeHost`, returning `null` to select current WASM. If native OCR needs ONNX, resolve only through shared `ModelHost`.

Existing guards: `test/unit/pdf-editor/browser-font-preview.test.mjs:9-102`, `test/unit/pdf-editor/bundled-font-library.test.mjs:14-73`, `test/e2e/pdf-annotation-font-faces.spec.ts:99`, digital-signature E2E cases in `test/e2e/pdf-digital-signature.spec.ts:221-694`, and `test/unit/pdf-editor/signature-byte-range.test.mjs:36-52`. New tests: system-font enumeration/load/embedding, unavailable and corrupt fonts, opaque native identity signing, cancellation and locked key, no private-key bytes crossing IPC, trust-versus-integrity wording, native/WASM qpdf equivalence, compute `null` fallback, model checksum and no implicit download.

### 13. Remove the compatibility surface

After both hosts pass the same contract suite, update `tools/js/pdf-tools-shell.js` to pass `createBrowserPdfHost()` explicitly, remove the one-argument mount overload, global `oo-open-file-pdf` bridge, direct browser API calls, and unused shared utility imports. Add a static guard for forbidden absolute asset roots and browser globals outside browser-host modules.

Existing guards: full unit and E2E suites. New tests: browser-host golden behavior matrix, Tauri-host contract matrix, no-network native package smoke test, listener/worker/URL leak test, and a source scan that permits platform APIs only in named host/bootstrap modules.

## Contract test matrix

The same adapter suite should run against the browser host with fake browser primitives, the Tauri desktop host, and the Tauri Android host. At minimum it verifies:

- capability version rejection and cleanup;
- ordered open events, cancellation, opaque references, and source-target mapping;
- write completion/failure and no dirty-state changes before success;
- lifecycle flush and one-writer lease behavior;
- asset completeness and offline resolution from both document and worker contexts;
- OCR geometry/order/progress/cancellation;
- external URL policy, clipboard failure, print cancellation, and command de-duplication;
- no network request except an explicitly user-initiated verified `ModelHost` request;
- disposal of listeners, workers, OCR jobs, native handles, leases, object URLs, and temporary files.

Browser parity needs a golden scenario that opens through each current route, edits, saves with picker support, saves with download fallback, reloads/recoveries, prints through both browser paths, runs OCR, imports a font and certificate, follows an allowed link, rejects a dangerous link, and closes dirty work. The golden observes outcomes and calls, not pixel snapshots alone.

## Open questions for the owner

1. What should **Save** mean for a PDF opened from a writable desktop path or Android `content://` URI: overwrite by default, or preserve today's always-new-output behavior? Should a separate Save As command be introduced?
2. Must `Ctrl/Cmd+Shift+S` remain Save Project, or should keyboard parity reserve it for Save As and move Save Project elsewhere?
3. What is the authoritative file extension/name for a PDF project (`.fwdoc` today), and should berg:work register it as an OS/Android file type?
4. On a second open of the same canonical document, should berg:work focus the existing window, open read-only, clone a working copy, or prompt? Is more than one independent app window a launch requirement?
5. Should workspace/session recovery be shared between windows, scoped per window, or scoped per source document? What retention, encryption-at-rest, and “clear recent data” rules apply?
6. May Android persist SAF URI permissions across restarts? If a provider supports only non-atomic streaming writes, should Save write through a temporary native copy and replace, or require Save As?
7. Which OCR languages ship in the base application, which use Play Asset Delivery, and may users install additional languages? Are recognition results expected to match Tesseract exactly or only the normalized `OcrWord` contract?
8. Which native OCR engine and ONNX models are approved, and what are the checksum, licensing, update, telemetry, and fallback policies?
9. Is native PDFium in scope for the first release, or should `PdfEngineHost` initially always wrap the existing worker/WASM transport? What level of byte/raster parity is required before switching?
10. Should system fonts be offered at all? If yes, what licenses/embedding bits must be enforced, and should fonts without embedding permission remain preview-only?
11. Are platform certificate stores/Android Keystore required, or is file-based PKCS#12/PEM sufficient initially? Does “valid signature” mean cryptographic integrity only, or chain trust/revocation/timestamp validation too?
12. May self-signed certificate generation remain in the renderer? If native, where is the generated private key stored, and is export required?
13. What exact native title should a window show: product, filename, active panel, dirty marker, or some combination?
14. On Android background/suspend, how long may the editor block for journal/workspace flush? What UX is acceptable after a full-disk or persistence failure?
15. Should Print always send vector PDF bytes, and which platforms/options (range, duplex, paper, orientation) must be exposed in-app versus delegated to the native dialog?
16. Is outbound drag of the current PDF/project required for `Drag_Drop_Support`, or is inbound single/batch drop sufficient for the first Googlebook release?
17. Must internal copied PDF objects work across windows/app instances, or is plain-text interoperability plus same-instance rich copy the intended security boundary?
18. Are `http`, `https`, `mailto`, and `tel` all allowed in the native app? Should external links show an interstitial or enterprise-policy check?
19. Is the app required to run with a strict zero-network policy, or may explicitly user-initiated model/language installation access approved endpoints?
20. Which current browser URLs, storage formats, and launchQueue behavior are public compatibility commitments, and when can the temporary one-argument `mount` overload be removed?
