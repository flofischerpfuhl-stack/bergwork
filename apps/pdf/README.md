# berg:work PDF

Tauri 2 app around the Fernwork PDF editor. Internal builds only; there is no public release.

## Layout

| Path | Owns |
| --- | --- |
| `upstream/` | Pinned editor build (not committed): the files listed for `fernwork-pdf` in `../../upstream.lock.json`, laid out as in Fernwork (`tools/vendor/pdf-tools`, `pdf-runtime`, `tesseract-5.0.4`). Recreate it with `npm run sync:install`. Never edited here. |
| `web/` | Host page owned by berg:work: `index.html`, `main.js` (Fernwork's bootstrap without site navigation, service worker and file-open router), `host.js` (the host object passed to `mount`), `theme.css` (system light/dark, grey accent, title-bar controls). Plain ES modules, no bundler. |
| `scripts/build-frontend.mjs` | Assembles `dist/` (not committed): `web/` at the root and the pinned build under `dist/tools/vendor/`, because the bundle still loads its workers, WASM and fonts from absolute `/tools/vendor/...` URLs. |
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

## Host and title bar

The editor is mounted with `mount(element, { host })`. `host.js` supplies the `shell` capability: `setTitle` sets
the window title (`• name — berg:work PDF` for unsaved changes), and `titleBar` hands the editor the app icon and
the window controls, which it places in its own top row; `startDrag` and `toggleMaximize` move and maximise the
undecorated window. Outside Tauri all window calls do nothing and the controls stay hidden, so `dist/` can be
opened in a normal browser for tests (serve it with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, as the app does).

The pinned build needs Fernwork `6f9537d` or later for this; older builds ignore the second argument and show
no title bar. The editor has no fullscreen toggle in the app because the shell offers no `setFullscreen`.

The accent is a mid grey in both themes because it also draws selection frames and handles on the white page.

The rest of the contract (native files, OCR, fonts) is drafted in `../../docs/PDF-HOST-CONTRACT.md` and has to
land in Fernwork first.

## Naming

The product name in `tauri.conf.json` is `bergwork PDF`: Tauri rejects `:` there because the name also becomes
file names, the Windows install directory and shortcut names. Everything the user reads says `berg:work PDF`: the
window title, the Linux launcher (`src-tauri/linux/bergwork-pdf.desktop`) and the package descriptions. The
binary is `bergwork-pdf`, the Debian package `bergwork-pdf`, the identifier `app.bergwork.pdf`.
