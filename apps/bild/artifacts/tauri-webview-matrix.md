# A1 Tauri/WebView matrix

Measured 2026-09-24 on the reference Linux laptop (Intel HD Graphics 630, Linux Mint 22.2,
1440×900, device scale 1). 🟢 meets the stated budget, 🔴 misses it, and ⚪ was not measured or has
no Section 8 budget. The Linux WebKit result is from the packaged Tauri 2 release binary using the
installed WebKitGTK 2.52.6 runtime; the Python-GI fallback was not used. Linux Chromium is
Playwright 1.63 / Chrome for Testing 153.0.8010.12 with the repository's `perf-gpu` flags and is the
temporary WebView2 stand-in, not a claim about Windows WebView2.

## Measurement method

Every measured engine ran `tests/webview/matrix.ts`. It creates real WebGL2 contexts and a real
module worker; compares pixels decoded with default and disabled `createImageBitmap` colour
conversion; generates, encodes, decodes, and imports a 10109×4542 (45,915,078 pixel) JPEG; and ports
the editor scenario from `tests/e2e/performance.spec.ts`. That scenario composites ten 4096² raster
layers for pan/zoom (167.8 MP of layer pixels) and five layers for brush feedback (83.9 MP, within
the current 100 MP document limit). GPU timings call `gl.finish()`.

The retained heap probe stops safely at 1024 MiB. “No failure” therefore means “at least 1024 MiB”,
not an observed hard limit; Chromium additionally exposes its engine limit. This is a documented
measurement limitation.

## Product-plan Section 8 budgets

| Gate | Pro | Lite |
|---|---:|---:|
| Cold start to usable | ≤1500 ms | ≤2500 ms cached |
| Open 46-MP JPEG | ≤1500 ms | ≤3000 ms |
| Pan/zoom p95 (4096² × 10) | ≤16 ms | ≤33 ms |
| Brush feedback p95 | ≤16 ms | ≤16 ms |
| 500-layer panel scroll/reorder p95 | ≤16 ms | ≤16 ms |
| Export 46-MP PNG | ≤3000 ms | ≤8000 ms |
| 500-character paragraph input latency | ≤16 ms | ≤33 ms |
| Recovery loss after kill | ≤5 s work | ≤10 s work |

## Linux WebKitGTK 2.52.6 in Tauri

| Capability | Result |
|---|---|
| WebGL2 | yes |
| Renderer | `Apple GPU` (WebKit's masked renderer string; physical device is Intel HD 630) |
| `EXT_color_buffer_float` | yes |
| `MAX_TEXTURE_SIZE` | 16,384 |
| `OffscreenCanvas` main / module worker | yes / yes |
| Module workers | yes |
| WebGPU | no |
| File System Access / Local Font Access | no / no (Tauri host capabilities are used instead) |
| `createImageBitmap` colour conversion | options accepted; default and `none` both `[134,117,65,255]` for the generated sRGB JPEG |
| Heap behaviour | ≥1024 MiB retained without failure; hard limit unavailable |
| Estimated ten-layer GPU texture footprint | 853 MiB |

| Measured gate | Result | Pro | Lite |
|---|---:|---:|---:|
| Open generated 46-MP JPEG | 2401 ms | 🔴 +901 ms / +60.1% | 🟢 599 ms headroom |
| Pan p95 | 14 ms | 🟢 | 🟢 |
| Zoom p95 | 25 ms | 🔴 +9 ms / +56.3% | 🟢 |
| Pan at 200% p95 | 18 ms | 🔴 +2 ms / +12.5% | 🟢 |
| Brush feedback p95, even samples | 34 ms | 🔴 +18 ms / +112.5% | 🔴 +18 ms / +112.5% |
| Brush feedback p95, irregular samples | 29 ms | 🔴 +13 ms / +81.3% | 🔴 +13 ms / +81.3% |
| Cold start / panel / export / text / recovery | not measured | ⚪ | ⚪ |

Additional timings: first brush sample 29 ms; even/irregular brush finish on the main thread 1/0
ms; background commit 355/306 ms. The 46-MP JPEG was 0.414 MiB because the generated gradient and
stripes compress strongly; dimensions were validated after editor import.

WebKitGTK's misses are split between the image-open/decode path (0.901 s over Pro), WebGL presentation
under zoom (25 ms p95 despite WebGL2, float render targets, and a 16K texture limit), and brush
feedback (34 ms p95). The completed 853 MiB texture scenario and ≥1024 MiB retained heap probe do not
show a memory failure, so this run does not justify attributing the misses to a hard memory limit.
Per PRODUCT-PLAN A1, the next architecture decision should compare these measured gaps with an A6
native-compute or native-wgpu spike before selecting either direction.

### A6b follow-up attempt (2026-09-24)

The hardened post-A6b release was queued through the updated three-run matrix harness, but no new
timing process was allowed to start. A resumed gate and two fresh consecutive 30-minute gates all
reached their ceilings with the one-minute load above the required maximum of 3 (recorded
5.23–39.38). The table above is therefore retained as the latest accepted Linux matrix history;
there is deliberately no replacement timing from a contended machine.

The final release did pass the separate 300 s offline probe: 346 process-tree socket snapshots saw
zero TCP or connected-UDP remote endpoints. The A6b frame-clock/visual measurements and the reasons
for not enabling forced SHM are recorded in `artifacts/a6b-webkit.md`.

## Linux Chromium 153 (`perf-gpu`, WebView2 stand-in)

| Capability | Result |
|---|---|
| WebGL2 | yes |
| Renderer | `ANGLE (Intel, Mesa Intel(R) HD Graphics 630 (KBL GT2), OpenGL 4.6)` |
| `EXT_color_buffer_float` | yes |
| `MAX_TEXTURE_SIZE` | 16,384 |
| `OffscreenCanvas` main / module worker | yes / yes |
| Module workers | yes |
| WebGPU | yes |
| File System Access / Local Font Access | yes / yes |
| `createImageBitmap` colour conversion | options accepted; default and `none` both `[133,116,64,255]` for the generated sRGB JPEG |
| Heap behaviour | advertised 3585.8 MiB; ≥1024 MiB retained without failure |
| Estimated ten-layer GPU texture footprint | 853 MiB |

| Measured gate | Result | Pro | Lite |
|---|---:|---:|---:|
| Open generated 46-MP JPEG | 3334.3 ms | 🔴 +1834.3 ms / +122.3% | 🔴 +334.3 ms / +11.1% |
| Pan p95 | 8.9 ms | 🟢 | 🟢 |
| Zoom p95 | 4.0 ms | 🟢 | 🟢 |
| Pan at 200% p95 | 2.3 ms | 🟢 | 🟢 |
| Brush feedback p95, even samples | 13.0 ms | 🟢 | 🟢 |
| Brush feedback p95, irregular samples | 5.7 ms | 🟢 | 🟢 |
| Cold start / panel / export / text / recovery | not measured | ⚪ | ⚪ |

Additional timings: first brush sample 23.4 ms; even/irregular finish 0.4/0.1 ms; background commit
471.5/345.7 ms. A preceding identical run opened the JPEG in 2918.8 ms, so the observed open range
was 2918.8–3334.3 ms; the table conservatively records the final acceptance run.

## Windows WebView2

Not measured. `tests/webview/windows-brief.md` is the acceptance-driven remote brief. It requires the
owner's Windows PC to clone only from `artifacts/fernwork-image-p0.bundle`, build the Tauri release,
run the same packaged page through WebView2, and return raw JSON plus process-cleanup evidence.

| Capability / gate | Result |
|---|---|
| All required capability probes | ⚪ not measured |
| All Section 8 budgets | ⚪ not measured |

## macOS WKWebView

Not measured; no Mac is available (PRODUCT-PLAN decision E3). Playwright WebKit remains only an
engine-family proxy and is not substituted for a real WKWebView result here.

| Capability / gate | Result |
|---|---|
| All required capability probes | ⚪ not measured |
| All Section 8 budgets | ⚪ not measured |

Before a Mac release, PRODUCT-PLAN A1 requires checking: WKWebView web-content-process memory limits;
WebGL2 through ANGLE/Metal including float render targets and maximum texture size; signing and
notarisation with an Apple Developer account; native menu and ⌘ shortcut conventions; and P3 display
colour handling.

## Shell and process evidence

The release build produced `src-tauri/target/release/fernwork-bildeditor`. On launch, `wmctrl -l`
reported `Fernwork Bildeditor` and `ps` showed PID 537241 running the release binary. After closing
that window with `wmctrl -c 'Fernwork Bildeditor'`, this check returned no rows:

```text
ps -eo pid,ppid,stat,comm,args | rg 'fernwork-bildeditor|WebKitWebProcess' | rg -v 'rg '
```

The normal launch log was empty. The updater is absent by design in Phase 0.


## Windows WebView2 153 in Tauri (remote lane, 2026-09-24)

Measured by the Codex agent on the owner's Windows PC from the git bundle of `integration` at `6a9c1a0`.
Setup: Windows 10 22H2 (19045), AMD Radeon Vega 8 (driver 31.0.21925.1001), WebView2 Runtime 153.0.4234.48, Tauri
release build (MSVC). The page is the same as for Linux (`tests/webview/matrix.ts`).

| Capability | Result |
|---|---|
| WebGL2 / `EXT_color_buffer_float` / `MAX_TEXTURE_SIZE` | yes / yes / 16,384 (ANGLE Direct3D11) |
| OffscreenCanvas main / worker, module workers | yes / yes, yes |
| WebGPU / File System Access / Local Font Access | yes / yes / yes |
| Heap | advertised limit 4192 MB; ≥1024 MiB retained without failure |

| Measured gate | Result | Pro | Lite |
|---|---:|---:|---:|
| Open generated 46-MP JPEG | 2777 ms | 🔴 +1277 ms / +85 % | 🟢 |
| Pan p95 | 2.7 ms | 🟢 | 🟢 |
| Zoom p95 | 1.1 ms | 🟢 | 🟢 |
| Pan at 200 % p95 | 0.6 ms | 🟢 | 🟢 |
| Brush feedback p95, even / irregular | 5.4 / 3.0 ms | 🟢 | 🟢 |
| First brush sample / background commit | 5.4 ms / 267–289 ms | ⚪ | ⚪ |

**Not verified on Windows.** The lane had no desktop control, so there is no screenshot. The window title, native
menu, Ctrl+N/Ctrl+W and Close/Quit are therefore unverified. What was verified: build, launch, and no process left
after a forced end.

**No-network gate failed.** During a 30-second monitor, the WebView2 network-service child opened outbound
connections to `2620:1ec:33:1::11:443` (Microsoft) and `2a04:4e42:6f::684:80` (CDN). No separate updater or login
process was seen. See PRODUCT-PLAN "Änderungen nach Messung" M8.

Raw JSON (unchanged, SHA-256 `6704CEF44325EDB187E375926330B4AF223F4E5BE5B55B74BB4C9809B0225CFD`):

```json
{
  "timestamp": "2026-09-23T23:29:50.155Z",
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0",
  "platform": "Win32",
  "capabilities": {
    "webgl2": true,
    "renderer": "ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x000015D8) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "extColorBufferFloat": true,
    "maxTextureSize": 16384,
    "offscreenCanvas": true,
    "offscreenCanvasInWorker": true,
    "moduleWorker": true,
    "webgpu": true,
    "fileSystemAccess": true,
    "localFontAccess": true,
    "createImageBitmapColorConversion": {
      "supported": true,
      "identical": true,
      "defaultPixel": [
        133,
        116,
        64,
        255
      ],
      "nonePixel": [
        133,
        116,
        64,
        255
      ]
    }
  },
  "jpeg46MP": {
    "width": 10109,
    "height": 4542,
    "encodedMB": 0.3518037796020508,
    "openMs": 2776.899999976158
  },
  "performance": {
    "renderer": "ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x000015D8) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "panMs": {
      "p95": 2.699999988079071,
      "median": 1.100000023841858,
      "max": 4.299999952316284
    },
    "zoomMs": {
      "p95": 1.0999999642372131,
      "median": 0.40000003576278687,
      "max": 1.5999999642372131
    },
    "panAt200PercentMs": {
      "p95": 0.6000000238418579,
      "median": 0.2999999523162842,
      "max": 0.699999988079071
    },
    "brushFeedbackMs": {
      "p95": 5.400000035762787,
      "median": 2.100000023841858,
      "max": 6.199999988079071
    },
    "brushFeedbackIrregularMs": {
      "p95": 3,
      "median": 1.9000000357627869,
      "max": 5.600000023841858
    },
    "brushFirstSampleMs": 5.400000035762787,
    "brushFinishMs": {
      "even": 0.30000001192092896,
      "irregular": 0.09999996423721313
    },
    "brushCommitMs": {
      "even": 289.4000000357628,
      "irregular": 266.89999997615814
    },
    "estimatedGpuTextureMB": 853
  },
  "heap": {
    "advertisedLimitMB": 4192,
    "allocatedMB": 1024,
    "failed": false,
    "ceilingMB": 1024
  }
}
```
