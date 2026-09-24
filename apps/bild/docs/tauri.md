# Tauri 2 desktop shell

Fernwork Bildeditor uses one engine and two host entries: the ordinary browser entry and
`src-tauri/frontend/main.ts`. The Tauri entry mounts the same exported editor with
`createTauriHost(): FileTargetHost`. It provides `chooseImages()`, `chooseProject()`,
`saveFileAs(blob, suggestedName, kind)`, `saveFileTo(target, blob)`, and the contract fallback
`saveFile(blob, suggestedName)` through Tauri's dialog and filesystem plugins. Selected paths are
the only paths passed to the filesystem plugin. No updater, telemetry, background service, or
runtime network call is included.

The adapter also publishes the A0 versioned capability registry: native file
targets and OS-open events, system-font enumeration/loading, SHA-256 compute,
verified model caching, and display ICC lookup. Recent files are stored in the
Tauri application config directory; AI models are stored in the application
cache directory. A remote model is fetched only for an explicit user action
and only from its configured URL, then verified before it is cached.

The editor draws its own menu bar on Linux and Windows. Only macOS gets a native File menu (it is the global
menu bar there); it forwards ⌘N and ⌘W to the existing editor command dispatcher, and Quit exits the application. `.fwimg`, `.psd`, and common raster extensions are declared
as associations. Command-line association paths, including paths delivered to
a second instance, are emitted to the running editor and recorded in Recents
after a successful open.

## Commands

```bash
npm run tauri:dev
npm run tauri:build
npm run tauri:build -- --no-bundle
bash scripts/tauri-webview-matrix.sh /tmp/fernwork-webkitgtk-matrix.json
bash scripts/tauri-build.sh --features a6-spike --no-bundle
bash scripts/tauri-a6b.sh /tmp/fernwork-a6b-results
bash scripts/tauri-offline-probe.sh 300
```

`npm run tauri:*` goes through `scripts/tauri.mjs`: on Linux it runs `scripts/tauri-{dev,build}.sh` (rootless
WebKitGTK environment), on Windows and macOS it calls the Tauri CLI directly, so no bash is needed there (a fresh
Windows checkout otherwise picks WSL's `bash.exe`). `.gitattributes` keeps `*.sh` with LF endings.

`tauri:build` creates `.deb` and `.rpm` bundles on Linux; `-- --no-bundle` stops after the release binary. The Linux
binary is `src-tauri/target/release/fernwork-bildeditor`. The scripts source
`scripts/tauri-env.sh`, so a new login shell is not required after rustup.

`tauri-a6b.sh` is the Linux-only A6 follow-up harness. It records `uptime` before each process,
waits while the one-minute load average is above 3, runs default and forced-SHM rendering three
times each (plus an optional `GDK_SCALE=2` resize/DPR visual check), and compares native-window and raw
WebGL captures. Its full runs also compare the browser JPEG pipeline with a one-response native
decode for compressible and noisy 46-MP fixtures. Pillow is required only by this measurement
script, not by the product.

`tauri-offline-probe.sh` launches only the specified release binary and samples the sockets of that
process tree. It fails on TCP or connected-UDP remote endpoints and terminates only the PID it
started. Linux `/proc` does not expose unconnected UDP `sendto` destinations; this limitation is
printed in the probe result.

The release CSP deliberately omits JavaScript `'unsafe-eval'`. The WebGL compositor imports
`pixi.js/unsafe-eval`; despite that module name, it installs Pixi's static CSP-safe synchronisers
and does not weaken the policy or enable string evaluation. Without the adapter, Pixi falls back to
the software compositor in the hardened Tauri build.

The product does not force WebKitGTK's shared-memory renderer. A6b found one forced-SHM run with a
99.99 ms native after-paint p95 and 53 dropped refresh intervals, so the presentation gate failed
despite lower `gl.finish` timings. `WEBKIT_DMABUF_RENDERER_FORCE_SHM` remains entirely user-controlled.

## Rootless Linux setup reproduced on this laptop

Host: Linux Mint 22.2 / Ubuntu noble amd64, WebKitGTK runtime 2.52.6. Rust was installed without
sudo using rustup (`stable`, rustc 1.98.1). `scripts/tauri-install-linux-deps.sh` uses
`apt-get download` and `dpkg-deb -x` into
`${FERNWORK_TAURI_PREFIX:-$XDG_CACHE_HOME/fernwork-tauri-deps}` (falling back to
`$HOME/.cache/fernwork-tauri-deps`). It resolves the missing development-package closure, rewrites
only the extracted pkg-config prefixes, and points broken development symlinks at the matching
already-installed runtime libraries. It never invokes `sudo` or changes dpkg state.

The exact extracted set for the successful 2026-09-24 build was:

```text
gir1.2-freedesktop-dev=1.80.1-1
gir1.2-girepository-2.0-dev=1.80.1-1
gir1.2-glib-2.0-dev=2.80.0-6ubuntu3.9
libatk-bridge2.0-dev=2.52.0-1build1
libatk1.0-dev=2.52.0-1build1
libatspi2.0-dev=2.52.0-1build1
libayatana-appindicator3-dev=0.5.93-1build3
libayatana-ido3-dev=0.10.1-1build2
libayatana-indicator3-dev=0.9.4-1build1
libblkid-dev=2.39.3-9ubuntu6.6
libbrotli-dev=1.1.0-2build2
libbz2-dev=1.0.8-5.1ubuntu0.1
libcairo2-dev=1.18.0-3build1
libdatrie-dev=0.2.13-3build1
libdbus-1-dev=1.14.10-4ubuntu4.1
libdbusmenu-glib-dev=18.10.20180917~bzr492+repack1-3.1ubuntu5
libdeflate-dev=1.19-1build1.1
libegl-dev=1.7.0-1build1
libegl1-mesa-dev=25.2.8-0ubuntu0.24.04.2
libepoxy-dev=1.5.10-1build1
libffi-dev=3.4.6-1build1
libfontconfig-dev=2.15.0-1.1ubuntu2
libfontconfig1-dev=2.15.0-1.1ubuntu2
libfreetype-dev=2.13.2+dfsg-1ubuntu0.1
libfribidi-dev=1.0.13-3build1
libgdk-pixbuf-2.0-dev=2.42.10+dfsg-3ubuntu3.3
libgirepository-1.0-dev=1.80.1-1
libgirepository1.0-dev=1.80.1-1
libgles-dev=1.7.0-1build1
libglib2.0-dev=2.80.0-6ubuntu3.9
libglvnd-core-dev=1.7.0-1build1
libglvnd-dev=1.7.0-1build1
libgraphite2-dev=1.3.14-2ubuntu0.24.04.1
libgtk-3-dev=3.24.41-4ubuntu1.3
libharfbuzz-dev=8.3.0-2build2
libice-dev=2:1.0.10-1build3
libjavascriptcoregtk-4.1-dev=2.52.6-0ubuntu0.24.04.1
libjbig-dev=2.1-6.1ubuntu2
libjpeg-dev=8c-2ubuntu11
libjpeg-turbo8-dev=2.1.5-2ubuntu2
libjpeg8-dev=8c-2ubuntu11
liblerc-dev=4.0.0+ds-4ubuntu2
liblzma-dev=5.6.1+really5.4.5-1ubuntu0.3
libmount-dev=2.39.3-9ubuntu6.6
libnghttp2-dev=1.59.0-1ubuntu0.4
libpango1.0-dev=1.52.1+ds-1build1
libpcre2-dev=10.42-4ubuntu2.1
libpixman-1-dev=0.42.2-1build1
libpng-dev=1.6.43-5ubuntu0.6
libpsl-dev=0.21.2-1.1build1
librsvg2-dev=2.58.0+dfsg-1build1
libselinux1-dev=3.5-2ubuntu2.1
libsepol-dev=3.5-2build1
libsharpyuv-dev=1.3.2-0.4build3
libsm-dev=2:1.2.3-1build3
libsoup-3.0-dev=3.4.4-5ubuntu0.8
libsqlite3-dev=3.45.1-1ubuntu2.8
libsysprof-capture-4-dev=46.0-1build1
libthai-dev=0.1.29-2build1
libtiff-dev=4.5.1+git230720-4ubuntu2.5
libwayland-dev=1.22.0-2.1build1
libwebkit2gtk-4.1-dev=2.52.6-0ubuntu0.24.04.1
libwebp-dev=1.3.2-0.4build3
libxcb-render0-dev=1.15-1ubuntu2
libxcb-shm0-dev=1.15-1ubuntu2
libxcomposite-dev=1:0.4.5-1build3
libxcursor-dev=1:1.2.1-1build1
libxdamage-dev=1:1.1.6-1build1
libxdo-dev=1:3.20160805.1-5build1
libxext-dev=2:1.3.4-1build2
libxfixes-dev=1:6.0.0-2build1
libxft-dev=2.3.6-1build1
libxi-dev=2:1.8.1-1build1
libxinerama-dev=2:1.1.4-3build1
libxkbcommon-dev=1.6.0-1build1
libxrandr-dev=2:1.5.2-2build1
libxrender-dev=1:0.9.10-1.1build1
libxtst-dev=2:1.2.3-1.1build1
libzstd-dev=1.5.5+dfsg2-2build1.1
patchelf=0.18.0-1.1build1
uuid-dev=2.39.3-9ubuntu6.6
x11proto-core-dev=2023.2-1
x11proto-record-dev=2023.2-1
x11proto-render-dev=2:2023.2-1
x11proto-xext-dev=2023.2-1
```

The script also writes this list, including architecture, to `$prefix/manifest.txt`. Already-present
system prerequisites were `build-essential`, `curl`, `file`, `wget`, `libssl-dev`, and the matching
runtime libraries. `PKG_CONFIG_PATH`, `LIBRARY_PATH`, and `LD_LIBRARY_PATH` are scoped to the build
or launch command by `tauri-env.sh`.

## Measurement harness

`tests/webview/matrix.ts` is the one script used by packaged Tauri/WebKitGTK and Playwright
Chromium. The optional `scripts/tauri-webkitgtk-fallback.py` loads the same Vite page through the
installed `python3-gi` WebKit2 4.1 typelib if a Tauri build is unavailable. On this machine the
packaged Tauri lane worked, so the fallback was not used.

The heap probe retains numeric arrays in a module worker and reports both the engine-advertised
limit (when exposed) and successful retained allocation. It has a 1024 MiB safety ceiling to avoid
killing the desktop session; therefore a non-failing result is a lower bound, not a measured hard
limit. This is the one deliberate deviation from “allocate to failure”.

## Host diagnostics

On Linux, `display_icc_profile` reads the X root `_ICC_PROFILE` property with
`xprop`. On a Wayland-only session or when no profile is published it returns
an explicit sRGB assumption. On Windows the `cfg(windows)` implementation uses
`GetICMProfileW`; it must be checked by the Windows integration lane because
the MSVC target is not installed here. Font enumeration scans the standard OS
font directories and returns font-file bytes to the CanvasKit text engine.

The release binary has an explicit console smoke mode which runs discovery
before the WebView starts:

```bash
source scripts/tauri-env.sh
FERNWORK_HOST_SMOKE=1 src-tauri/target/release/fernwork-bildeditor
```

It logs the system-font count and display-profile result. Absence of an ICC
payload is valid only when the returned `assumed` flag is true.

## Screen eyedropper (`ScreenColorHost`)

The colour picker and the Colour panel sample from anywhere on the screen (PRODUCT-PLAN 6.1). The editor uses
the browser EyeDropper API when the webview has it (WebView2 on Windows), otherwise the `screenColor` capability
(`pick_screen_color`, `src-tauri/src/screen_color.rs`): the next left click anywhere picks one desktop pixel;
right click, Escape or 60 s cancel.

- Linux X11: pointer and keyboard grab on the root window with a crosshair cursor, then `XGetImage` of one
  pixel. libX11 is opened at run time (`x11-dl`), so systems without it still start.
- Windows: low-level mouse/keyboard hooks swallow the picking click, then `GetPixel` on the desktop DC. Only
  `cargo check` on Linux has compiled this module; the `cfg(windows)` branch must be checked by the Windows lane.
- Wayland: clients cannot read other clients' pixels or grab the pointer globally, and under XWayland the root
  window shows X clients only. The command refuses with `wayland-unsupported` and the editor falls back to the
  canvas eyedropper. The proper route is the xdg-desktop-portal `Screenshot.PickColor` call (D-Bus client and
  response-signal listener), not implemented yet.

## Current scope

The host reads and writes whole files through plugin byte arrays; A6 binary channels, scratch mmap,
native codec acceleration and A6 high-volume binary IPC are not implemented;
the named checksum job is the real A0 ComputeHost reference job. Updater support
is not implemented. The A1 measurement entry writes a JSON result only when explicitly launched with
`FERNWORK_WEBVIEW_MATRIX=1` and `FERNWORK_MATRIX_RESULT`; ordinary runtime has no such write or
network activity. Linux bundles are currently `.deb` and `.rpm`; Tauri's downloaded `linuxdeploy`
helper exited nonzero while attempting an AppImage on this host, so AppImage is not a configured
Linux target yet.
