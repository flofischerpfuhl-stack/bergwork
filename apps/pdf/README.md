# berg:work PDF

Tauri 2 app around the Fernwork PDF editor. Internal builds only; there is no public release.

## Layout

| Path | Owns |
| --- | --- |
| `upstream/` | Pinned editor build (not committed): the files listed for `fernwork-pdf` in `../../upstream.lock.json`, laid out as in Fernwork (`tools/vendor/pdf-tools`, `pdf-runtime`, `tesseract-5.0.4`). Recreate it with `npm run sync:install`. Never edited here. |
| `editor/` | Source fork of the editor's UI (the PDF Tools shell and every file it imports), committed, with Fernwork's paths (`assets/`, `vendor/build/src/`). `fork.json` names the Fernwork commit and the files. `scripts/editor-fork.mjs` creates, reports on and ports it (`npm run fork:status`, `fork:port`, `fork:check`); `scripts/build-editor.mjs` bundles it into `editor-dist/` (not committed). |
| `web/` | Host page owned by berg:work, built with Vite (`vite.config.ts`, root `web/`): `src/shell.tsx` (the design base's title bar from `@bergwork/ui` — mark, wordmark, document, about menu with version and licences, appearance menu, window buttons in the app — above the editor), `src/editor.ts` (loads the PDF.js and pdf-lib runtimes, the editor CSS and bundle from `tools/vendor/` and mounts it), `src/desktopWindow.ts` (Tauri window: drag, maximise, rounded corners on Linux), `src/bergwork-pdf.css` (the editor's `--pdf-*` tokens from the design base's `--bw-*` tokens, buttons, corners, licences dialog), `src/native-files.js` (native open/save), `src/licenses-view.js`, `public/` (pre-paint appearance script, icons). |
| `scripts/build-frontend.mjs` | Assembles `dist/` (not committed): the Vite build of `web/` at the root, the pinned build under `dist/tools/vendor/` with the fork's bundle, chunks and CSS in place of the pinned ones in `pdf-tools/`, and `licenses.json`. The bundle finds `tools/vendor/` next to the page (`globalThis.__bergworkVendor`, set by `src/editor.ts`), so the same `dist/` runs in the app and at `/app/pdf/` on bergwork.app. |
| `cli/` | Agent CLI `bergwork-pdf-cli` and MCP server (`npm run cli -w @bergwork/pdf -- …`): the editor's engine headless, see `cli/README.md`. |
| `headless/` | Headless engine page shared by the CLI and the corpus suite (`tests/`): engine session, bundler, server, browser host. |
| `scripts/collect-licenses.mjs` | Licence data for the app and `THIRD_PARTY_NOTICES.md` (see Licences). |
| `scripts/tauri*.sh`, `scripts/tauri.mjs` | Tauri CLI entry points; on Linux they point the build at a rootless WebKitGTK prefix (see below). |
| `src-tauri/` | Rust app, `tauri.conf.json` (window, CSP, bundles, file associations), capabilities, icons (copied from `branding/logos/generated/bergwork-pdf/tauri/`), Linux desktop template and MIME definition. |

## Build and run

From the repository root:

```sh
npm install
npm run sync:install                      # once, and after every pin change
npm run tauri:build -w @bergwork/pdf      # release binary, .deb, .rpm and .AppImage
npm run tauri:dev -w @bergwork/pdf        # debug build, serves dist/ without a dev server
npm run build:web -w @bergwork/pdf        # only assemble dist/
```

Outputs land in the workspace `target/`: the binary is `target/release/bergwork-pdf`, the packages are in
`target/release/bundle/{deb,rpm,appimage}/`. Windows (`nsis`, `msi`) is configured in
`src-tauri/tauri.windows.conf.json` but has not been built yet.

`tauri:dev` builds `dist/` once and does not watch `web/`; restart it after changes to the host page. For
`cargo build`, `cargo clippy` or running the binary by hand on Linux, source the environment first:
`source apps/pdf/scripts/tauri-env.sh`.

### Linux without root

The WebKitGTK and GTK development packages do not have to be installed system-wide. `scripts/tauri-env.sh` uses
the prefix from `BERGWORK_TAURI_PREFIX`, else `FERNWORK_TAURI_PREFIX`, else `~/.cache/fernwork-tauri-deps` (shared
with the Fernwork compositor workspace). If `pkg-config` cannot find the libraries there,
`scripts/tauri-install-linux-deps.sh` downloads the `.deb` files with `apt-get download` and unpacks them into the
prefix (Ubuntu 24.04 amd64 only). For the AppImage, `tauri-build.sh` puts `scripts/appimage-pkgconf/` on the
`PATH`, so linuxdeploy's GTK plugin takes GTK modules, pixbuf loaders and GSettings schemas from the system rather
than from the prefix, which holds only headers and link stubs.

## Host, title bar and files

The window is the same as berg:work Image's (`apps/image/src/app/shell.tsx`): the design base's title bar with the
PDF mark (a variant per theme), the `berg:work` wordmark in Bergschrift in the site red, `PDF`, the document name in
the middle, an about menu (version, licences), the appearance menu (light/dark/system, round/sharp corners, stored as
`bergwork.appearance` and shared with Image) and, in the app, the window buttons. The bar is the window's drag area; a
double click maximises. On Linux the window is transparent with rounded corners (`tauri.linux.conf.json`), square when
maximised. The editor follows `html[data-theme]` and `html[data-corners]`; `src/bergwork-pdf.css` restyles it from
outside the source fork, so Fernwork's changes keep applying to `editor/`.

The editor is mounted with `mount(element, { host })` and `shell.chrome: 'islands'`: the fork's `islandChrome` lays the
editor's controls out as berg:work Image does after the Builder UI — top left the document and the tools (Pan, Edit
PDF, Insert, Markup, Guides), top right Save, Undo/Redo, Print, Document tools and Layers, at the bottom status islands
for zoom and page, Pages and rotation, and Find/comments/link outlines; tool options sit under the top row. Phones and
hosts without the option keep Fernwork's layout. The controls are shared JSX variables in `pdf-tools-shell.jsx`, so a
Fernwork change to one of them reaches both layouts. With `shell.inspector: 'manual'` Properties opens only on request (Layers button, *Show properties*); selecting an
object no longer opens it. Formatting lives in the **mini toolbar** (fork: `MiniToolbarHost`, Inspector `miniToolbar`,
`RichTextInspectorEditor` `compact`): a right-click on a text object shows font, size, bold/italic/underline/strike,
colour and (for reflowing text blocks) alignment above the context menu; selecting characters in the on-page text editor
shows it faintly above the text until the pointer comes near, and Ctrl/⌘+B/I/U use it. The toolbar is filled by the
same rich-text editor as Properties (a hidden Properties copy computes the row), so it commits through the same path
and undo steps. Shapes, lines and PDF paths get fill and stroke colour wells (`ColorMenuButton`), stroke width and
opacity there, images opacity and 90° rotation, highlights and comments their colour. Text placed with Insert › Text
grows with what is typed (`autoWidth`) until its frame is resized, and keys typed before its editor mounts are kept.
`?` or a right-click on the page opens the keyboard shortcut overview (`ShortcutsDialog`). Clicking the active
Edit PDF keeps it on; Pan stops editing. The host supplies `shell.setTitle` (the window title,
`• name — berg:work PDF` for unsaved changes, and the document in the title bar); the editor shows no fullscreen toggle
because the shell offers no `setFullscreen`. The editor's `titleBar` slots are not used.

In the web app (outside Tauri) the mark and wordmark link back to https://bergwork.app/ (`web/src/homeLink.tsx`, a
link laid over the design base's title bar), and the host passes `shell.sample` (`{ label, open }`, a berg:work
addition to the fork's `normalizeShellHost`): the empty state then offers "Try a sample PDF" next to "Choose PDF or
project". The sample is `scripts/fixtures/smoke.pdf`, emitted by Vite into `assets/` (`web/src/sample.ts`);
`/app/pdf/?sample` opens it once the editor has restored its workspace and drops the parameter. The desktop app keeps
a plain logo and offers no sample.

Files (`web/src/native-files.js`, commands in `src-tauri/src/lib.rs`):

- Opening a PDF or `.bwpdf`/`.fwdoc` project from the file manager, or passing it on the command line, opens it
  in the editor; a second launch forwards its files to the running window (single instance).
- Save, Save as and Export use the native save dialog (`window.showSaveFilePicker` is provided for the editor),
  so Save overwrites the chosen file afterwards. Other downloads the editor starts also go through the dialog.
- The Rust side reads and writes only paths the user chose or the system passed in; writes go to a temporary
  file that replaces the target.

Outside Tauri all window and file calls fall back to the browser behaviour and the controls stay hidden, so
`dist/` can be opened in a normal browser for tests (serve it with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, as the app does); `?preview` shows the window controls inert.

The palette follows VS Code's Dark/Light Modern surfaces with a warm stone grey as accent (red would read as
Close, blue does not fit berg:work); the page accent is a mid grey because it also draws selection frames and
handles on the white page.

## Licences

`npm run licenses -w @bergwork/pdf` regenerates `THIRD_PARTY_NOTICES.md` (committed) from the pinned editor
build's `licenses.json` and the Rust crates compiled into the app (`cargo metadata`, normal dependencies, host
target). `build:web` writes the same data to `dist/licenses.json`, which the app shows under Settings →
Licences. `npm run licenses:check -w @bergwork/pdf` fails when the notices are out of date.

The rest of the host contract (native PDFium/OCR, fonts, printing, close with unsaved changes) is drafted in
`../../docs/PDF-HOST-CONTRACT.md` and has to land in Fernwork first.

## Naming

The product name in `tauri.conf.json` is `bergwork PDF`: Tauri rejects `:` there because the name also becomes
file names, the Windows install directory and shortcut names. Everything the user reads says `berg:work PDF`: the
window title, the Linux launcher (`src-tauri/linux/bergwork-pdf.desktop`) and the package descriptions. The
binary is `bergwork-pdf`, the Debian package `bergwork-pdf`, the identifier `app.bergwork.pdf`.
