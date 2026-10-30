# berg:work PDF: what a mobile app can do that the PWA cannot

Snapshot of 2026-10-30, `origin/main` `f8fdac9`. Research only: no builds, no device tests. Mobile apps are planned for
berg:work only; Fernwork stays web. Today's blockers (no Android SDK, Play account, Mac, Apple account) are deliberately
ignored here.

Marks: `[n]` source at the end · **repo** checked in this repository or in the pinned build · **est.** my estimate, like
every person-day (PD) figure · **unverified** one weak source, sources in conflict, or general knowledge without a
source I could read.

## 1. Recommendation

**Build a real iOS and iPadOS app, iPad first. Keep Android a Trusted Web Activity until that app exists. Do not port
the engine to native PDFium.**

The two platforms differ sharply:

- **iOS is where the web loses.** A PWA there cannot receive a file, cannot appear in the share sheet and cannot save
  back to the file it opened. Those are the first three things a PDF editor must do. No browser escapes this: every iOS
  browser is WebKit, and no other engine has shipped, even in the EU [15].
- **Android is where the web nearly wins.** Chrome already gives share target, camera, Web NFC and pen data, and
  possibly save-to-original. A TWA adds the store listing for 3–5 PD with the unchanged engine.

The editor's depth (live text, paths, images, paragraph edit, measuring, redaction, compare) is the same in all three
shells, so no shell should fork it.

| Step | What | Platform | Effort (est.) | Why here |
|---|---|---|---|---|
| 0 | Web fixes: `persist()`, pen input, iOS save through the share sheet, camera input, device checks | Web | 6–9 PD | Helps every later shell, needs no account |
| 1 | Touch pass from the Fernwork TODO, on real devices | Web | 10–20 PD | Gate: store reviews judge what is rough today |
| 2 | Android TWA on Play | Android | 3–5 PD + 14-day closed test | Cheapest store presence, measures demand |
| 3 | iOS/iPadOS app on Tauri: base, open-in-place, share extension, AirPrint, lifecycle, keyboard and menu | iOS | 25–40 PD | Largest real gain over the PWA |
| 4 | Document scanner and Vision OCR on iOS | iOS | 3–5 PD | Small effort, expected feature |
| 5 | Native ink with PencilKit | iPadOS | 10–15 PD | Pencil is why people edit PDFs on an iPad |
| 6 | Android on Tauri: same package name and key as the TWA, SAF, ML Kit scanner, Ink, Googlebook acceptance list | Android | 22–39 PD | Only once the host layer exists from steps 3–5 |
| 7 | Measure PDFium WASM on devices; port only if numbers demand it | Both | 2 PD to measure | See section 4 |

Steps 3–6 are 60–100 PD (est.), the same order as the report's 60–120 PD. **Gate before any store:**
`docs/ARCHITECTURE.md` keeps Tauri builds internal until the owner's legal review is done, and section 11 adds two
licence checks.

### The five advantages that matter most

1. **Files on iOS.** Open from any app, Share to berg:work, edit the original in place in iCloud, OneDrive or on a
   server, and be the default PDF app (iOS 26 lets the user set "Always Open With" per file type [37]). The PWA can do
   none of this.
2. **Being found.** Store search is how people look for a PDF editor on a phone. The lead over free apps in editing
   depth is invisible without a listing. An honest "Data Not Collected" label beats Adobe's long list [60].
3. **Scanner into the editor.** Edge detection and perspective from VisionKit or ML Kit [41][43], OCR with tables from
   Vision [42], then the same live text editing as any other PDF, local and without page caps. Scanner apps stop at the
   searchable PDF.
4. **Pencil and S Pen ink.** 9 ms best case with PencilKit on a 120 Hz iPad [53] instead of a web canvas, plus squeeze,
   double tap and handwriting recognition [45][49]. Annotators like GoodNotes cannot touch the page's real text;
   berg:work could turn a pen strike-through into a real text deletion (idea, not researched further).
5. **Reliability.** Drafts in app storage that the system does not evict, a bounded flush when the app is suspended,
   vector printing through AirPrint and PrintManager [69][70]. Today's WebView print path falls back to 150 dpi rasters
   and 300 pages (**repo**, `print-document.js`).

### What a PWA can do after all

- **Both:** pressure, tilt, coalesced and predicted pen events (Safari 18.2+, long in Chrome) [3]. The editor reads none
  of them (**repo**), so much of the ink gap is ours, not the platform's.
- **Both:** offline, OPFS, outgoing Web Share, camera through `<input capture>` (general knowledge, check on devices).
- **iOS:** the same 60 % disk quota as Safari for a Home Screen app, and `persist()` is likely granted there [1]. The
  editor never asks (**repo**).
- **Android:** share target (shipped) and a usable save-to-original if the Chrome 132 File System Access claim holds
  [3][16], though caniuse disagrees [4]. "Open with" is undecided: Chrome's docs say desktop only [17], Chromium describes
  an Android path [18].
- **Android:** Web NFC [3], though it should not reach the eID card's protocol (unverified, section 8).

### Corrections to earlier documents

- **"Android WebView has no cross-origin isolation, so PDFium and Tesseract need single-thread builds"** (TODO) is
  outdated twice. The builds are already single-threaded: `pdfium.wasm`, `qpdf.wasm` and `harfbuzz.wasm` have unshared
  memory, the four Tesseract cores contain no threads, and `SharedArrayBuffer` appears only in one Tesseract feature
  test (**repo**, pinned build). And the old WebView limit [25] is gone: WebView 156 (2026-10-07) with androidx.webkit
  1.18.0 (stable 2026-10-21) offers `Profile#setCrossOriginIsolatedAllowlist` plus the `Document-Isolation-Policy`
  header [23][24][26].
- **"iOS wrapper: check SharedArrayBuffer"** (TODO) is therefore moot for PDF. Memory is the real check.
- **"Mobile apps are not worth it; the market is full and free"** (report, question 3) measured the wrong thing, and the
  iOS file gap was underrated.
- **"Editing existing content is paywalled"** (TODO) has one exception. PDFgear on mobile is reported as free, offline,
  without account, editing text with matched font and moving images [65]; a review disagrees for iOS [67], and the
  vendor page says text works [66]. No source mentions vector paths. **It is the benchmark to test on a device**, since
  the lead over it rests on paths, paragraph edit, redaction, compare, form design and measuring rather than on text.

## 2. Where the web app stands today

Checked in the source fork at `f8fdac9`. WASM files and the worker were read from the build installed in the main
checkout, Fernwork `c46ed765`, one pin behind `9c70a1ae`; re-check after a sync that touches the engine build.

| Fact | Consequence on mobile |
|---|---|
| PDFium WASM caps at 2048 MB (`max pages 32768`) | Hard ceiling regardless of device |
| Worker loads with `FPDF_LoadMemDocument`, also for clones and snapshot restores | Whole file sits in linear memory, at times twice |
| Checkpoint ring 192 MB, resources 256 MB, OPFS resources 2 GB | Large budgets against a 2 GB process on iOS |
| Touch: 6 MP page raster, 96 MB raster cache | Defensive limits, sharp thanks to tiles |
| No `navigator.storage.persist()` call anywhere | Drafts are best-effort on every browser |
| No `pressure`, `tiltX`, `getCoalescedEvents` in the shell; `pen` named in one branch | A pen acts as a mouse; no "pen draws, finger scrolls" |
| No `navigator.share`, no camera path | iOS has no reliable save; no in-app capture |
| `web/src/native-files.js` shims `showSaveFilePicker` over a native dialog | The same shim fits SAF and iOS pickers without touching the editor |
| `PrintHost.printPdf` is designed in `docs/PDF-HOST-CONTRACT.md` | Native printing is a host job, not an editor job |
| Cargo crate already builds `staticlib`/`cdylib` for `tauri android\|ios` | Mobile was planned for from the start |

## 3. Platform limits of the PWA

| Limit | iOS / iPadOS (WebKit) | Android (Chrome) | Android WebView / WKWebView in an app |
|---|---|---|---|
| `file_handlers` | No [5][6] | Docs: desktop only [17]; TWA path described [18][19]; test | App manifest instead |
| `share_target` | No [5][6] | Yes, when installed [20]; TWA behaviour differs by browser [22] | App intent or extension instead |
| Pick and write back (`showSaveFilePicker`) | No [3][4] | MDN and Chrome: since 132 [3][16]; caniuse: no [4]; test | Shim over native dialog (**repo**) |
| Origin quota | 60 % of disk, also Home Screen [1] | About 60 % (MDN) [7] | iOS "other apps": 15 %, overall 20 % [1]; keep drafts in app files instead |
| Eviction | Best effort, LRU; `persist()` by heuristics [1]. The 7-day rule's reach is disputed [5][6] | Best effort unless persisted [7] | App files are not evicted |
| WASM and process memory | WebContent killed near 2048 MiB, by process type, not RAM [11]; iPad maybe higher (unverified); the increased-memory entitlement reportedly does not reach it (unverified) [13] | Up to 4 GB in theory; our build stops at 2 GB | Same WebContent limit on iOS [11]. The app's own process is not bound by it [13] |
| WASM threads, SAB | Fine when isolated; JSPI new in 27 [2] | Fine when isolated | iOS custom scheme hides the SAB global although `crossOriginIsolated` is true [11]; irrelevant to PDF |
| JIT | Yes | Yes | WKWebView keeps JIT: WebContent holds the entitlement [11] (one device, not guaranteed) |
| Saving a generated file | Standalone blob downloads fail silently in reports [8][10] | Works | Native |
| Printing | Standalone `window.print` unreliable in old reports [9]; iOS 26 unknown | Works in browser; raster fallback when `pdfViewerEnabled` is false (**repo**) | Raster fallback (**repo**) unless the host prints |

**Where the web app hits walls today:** on iOS the install-to-save path (nothing to file, nothing back), on both platforms
draft durability and pen quality, and on iOS long sessions, because WASM memory cannot shrink [12] while checkpoints
accumulate. All other mobile problems in the report are touch UX and commit latency, which no shell fixes.

**Competitors:** all are native, so none has these limits.

## 4. Native engine

| Question | Finding |
|---|---|
| Is it available? | Yes: `pdfium-binaries` ships Android and iOS (framework, since the App Store rejects loose dylibs) [29]; `pdfium-render` wraps it in Rust [30] |
| Speed | No PDFium native-versus-WASM benchmark exists that I could find. Toy benchmark on an iPhone Air: native 10,110 MIPS, WASM JIT about 8,800 ±20 % [11]. Expect 1.3–2× for real CPU-bound work (est.) |
| Threads | No win inside one document: PDFium is not thread-safe, Android's own framework serialises it behind a lock [30][31]. Parallelism needs processes |
| Memory | Real win: `FPDF_LoadCustomDocument` reads ranges instead of holding the file twice, no 2 GB cap, memory returns to the OS |
| Large files | Real win above roughly 300–600 MB on iOS (est.; measure) |
| Battery | No data found. Proportional to CPU time, so 1.3–2× at most (est.) |
| Editing feel | **Small.** The report's 1.6–14 s after release and the 1.3 s per markup are the worker → snapshot → new page round trip, not WASM speed. Twice as fast is still slow; regenerating only the changed region fixes it |
| Cost | The worker is 1.37 MB of minified code against WASM exports (**repo**). Porting it behind the same protocol: 40–80 PD (est.), plus two engines to keep equal on the corpus |

**Verdict: not now.** `docs/ARCHITECTURE.md` already says "native where it pays" and keeps WASM as the fallback. Measure
after step 3: open, render, commit and peak memory for GeoTopo and a 500 MB scan on a 3-year-old iPhone and a mid-range
Android. Port only for files WASM cannot hold. The cheaper win is in Fernwork: native worker commands and region-only
regeneration, which help every platform.

**Competitors:** Xodo, Foxit, Acrobat and PDF Expert all run native engines; users notice on huge files, less on typical
ones (unverified).

## 5. Files

| Capability | What a native app gets | PDF value | PWA iOS | PWA Android | Effort (est.) | Step |
|---|---|---|---|---|---|---|
| "Open in", file association | `CFBundleDocumentTypes`, intent filters; Tauri generates both and emits `RunEvent::Opened` [32][33] | Very high | No | Unclear [17][18] | 1–2 PD | 3, 2 |
| Share to the app | iOS share extension (separate target, not generated by Tauri, unverified); Android Send and SendMultiple are Tauri defaults [32] | Very high | No | Yes | iOS 3–5 PD | 3 |
| Edit the original in place | `LSSupportsOpeningDocumentsInPlace` [34], security-scoped URLs, file coordination [35]; Android persisted grants, up to 512 [39] | Very high | No | Maybe [16] | iOS 3–5 PD, Android 3–5 PD | 3, 6 |
| Default PDF app | iOS 26 Files: "Always Open With" per type [37]; Apple's default-apps page does not list it [14]; Android user choice | High | No | No | 0.5 PD | 3 |
| iCloud, OneDrive, Google Drive | File Provider extensions appear in Files [36]; in-place depends on the provider [34], test each | High | Copy only | Copy, or handle | Included | 3 |
| SMB | iOS Files connects to servers natively [38]; Android needs a third-party provider (unverified) | Medium; high at VBP | Copy only | Copy | 0 | 3 |
| Offline | Bundled assets, no service worker eviction | Medium | Works, can be evicted | Works | 0 | 3 |
| All-files access (Android) | Play allows document managers, but they must justify why SAF is not enough [40] | Low | – | – | Avoid | No |
| Own File Provider | Expose berg:work's projects in Files | Low | No | No | 8+ PD | No |

Tauri's docs do not cover `content://`, write-back or security scope [32]. Expect a small custom Swift and Kotlin plugin
behind the existing `showSaveFilePicker` shim.

**Competitors:** Acrobat, Foxit, Xodo, PDF Expert all do this; table stakes. iOS 26's Preview app sets the free baseline
(unverified, search returned nothing direct).

## 6. Camera and scanner

| Capability | What a native app gets | PDF value | PWA iOS | PWA Android | Effort (est.) | Step |
|---|---|---|---|---|---|---|
| Live edge detection, perspective, multi-page | `VNDocumentCameraViewController` [41]; ML Kit scanner: UI from Play services, about 300 KB, JPEG and PDF, page limit, gallery import, 1.7 GB RAM [43] | Very high | Own JS only | Own JS only | iOS 1–2 PD, Android 2–3 PD | 4, 6 |
| Layout-aware OCR | `RecognizeDocumentsRequest`, iOS 26: paragraphs, tables, lists, 26 languages [41][42] | High | No | No | 2–3 PD | 4 |
| Other scripts | ML Kit text v2: Chinese, Devanagari, Japanese, Korean, Latin; 4 MB per script on Android, 38 MB on iOS [44] | Medium | No | No | 2–3 PD | Later |
| Live Text in images | Copy text from a photo in the document | Low | Partly (browser) | No | 1 PD | Later |

The web route still has value: `<input capture>` for a photo (0.5 PD) and perspective correction, which is already open
in the TODO's OCR section. Quality stays below VisionKit (est.). Tesseract remains the fallback and keeps 46 languages.
ML Kit's page does not say whether camera permission is needed (unverified: I recall it is not).

**Competitors:** Adobe Scan is free, with OCR raised "from 5 to 100 pages" by paying [46]; Microsoft Lens is retired and
scanning moved to Copilot and OneDrive [47]; iOS and Google Drive scan free. A scanner alone wins nothing; **scanner plus
real editing, locally and without page caps, does.**

## 7. Stylus

| Capability | What a native app gets | PDF value | PWA iOS | PWA Android | Effort (est.) | Step |
|---|---|---|---|---|---|---|
| Pressure, tilt, all samples | Same data; Pencil samples at 240 Hz, the frame runs far slower, so plain `pointermove` drops most [48] | High | **Yes**, 18.2+ [3] | **Yes** [3] | 3–5 PD on the web | 0 |
| Pen draws, finger scrolls | Same logic; OS palm rejection underneath | High | **Yes** | **Yes** | In step 0 | 0 |
| Lowest latency | PencilKit 9 ms on 120 Hz, up to about 40 ms at 60 Hz [53]; Android Ink 1.0 (Jan 2026) [55], front-buffer `androidx.graphics.lowlatency` [56] | High | No number found; 30–60 ms (est.) | `desynchronized` canvas [27]; delegated ink one frame better, Android status unknown [28] | iOS 10–15 PD, Android 5–8 PD | 5, 6 |
| Double tap, squeeze, barrel roll | `UIPencilInteraction` [51], `rollAngle` [50] | Medium | No | No | In step 5 | 5 |
| Hover | Preview of the tool under the tip [49] | Medium | Unverified | Unverified | In step 5 | 5 |
| Scribble in text fields | Works through UIKit text input | High for forms | Likely, the editor uses `textarea`; rough edges reported in WKWebView [54] | Android handwriting in fields: unverified | Test first | 3 |
| Handwriting to text in the document | ML Kit Digital Ink: 300+ languages, offline, on Android and iOS, also gestures and shapes [45] | Medium | No | No | 3–5 PD | Later |
| Native markup kit | PaperKit, iOS 26: shapes, images, text boxes and ink on one canvas (third-party description) [52]. Not useful: our markup must stay PDF annotations | Low | No | No | – | No |
| S Pen specifics | Samsung SDKs, not researched | Low | No | No | – | Later |

**How native ink fits the hybrid:** a native view above the WebView draws wet ink only during a stroke; on lift the points
go to the engine as an `/Ink` annotation and the page tile replaces it. This is the design of the existing
`drag-composition-overlay`. Risk: keeping the overlay in register during pinch zoom and scrolling. Pressure needs a
filled appearance stream, since `/Ink` has one width.

**Sequence matters:** do step 0 first and judge it on an iPad before spending step 5's 10–15 PD.

**Competitors:** GoodNotes 15+ and Notability 20+ handwriting languages [57], PDF annotation only. Samsung Notes imports
PDFs for drawing but cannot edit them [58]; conversion to text needs an S Pen [59]. PDF Expert and Acrobat edit text but
their ink is no better than these (unverified). **Nobody combines pen-first input with editing the page's real content.**

## 8. System integration

| Capability | What a native app gets | PDF value | PWA iOS | PWA Android | Effort (est.) | Step |
|---|---|---|---|---|---|---|
| Printing | `UIPrintInteractionController` takes PDF data directly [69]; `PrintManager` [70] | High | Unreliable [9] | Yes | 1–2 PD each | 3, 6 |
| Lifecycle flush | Native background callbacks into the existing flush path (`PDF-HOST-CONTRACT.md`) | High | `pagehide` only | `pagehide` only | 1–2 PD | 3 |
| Keyboard, trackpad | `UIKeyCommand`, shortcut overlay; iPadOS 26 menu bar only if the app supplies one [75] | High on iPad | Keys work, no menu | Same | 2–3 PD | 3 |
| Windows, Stage Manager | iPadOS 26 windowing replaced Split View; Stage Manager on external displays needs M1+ [75][76] | Medium | Unverified | Yes | 1 PD adaptive pass | 3 |
| Drag and drop | Drag pages or images out to other apps; drop in works on the web too | Medium | Drop in | Drop in | 2–3 PD | Later |
| DeX, Android desktop | Android 16 desktop mode is built on DeX [77]; Google's desktop quality list is the acceptance list (`ARCHITECTURE.md`) | Medium | – | Chrome window works | In step 6 | 6 |
| Googlebook | Android-based laptops, in Germany since 2026-10-05 [78]; PWA handling there unconfirmed | Medium | – | Unverified | In step 6 | 6 |
| Biometrics | App or document lock; official Tauri plugin [79] | Low alone | Passkeys only | Passkeys only | 1 PD | With next row |
| Keychain, certificates | Keep the signing `.p12` in the keychain behind Face ID; Android `KeyChain` picker [71]. Today it is a file each time | Medium | No | No | 5–8 PD | Later |
| Hardware tokens | USB-C and NFC PIV tokens, QES cards | Low; niche | No | No | 15+ PD | Later |
| eID and NFC | AusweisApp SDK 2.6.1 embeds in iOS and Android apps, Swift and Kotlin wrappers [72]. It proves identity; **it does not sign** | Low now | No (no Web NFC [3]) | Web NFC cannot run the eID protocol (unverified) | Watch | Later |
| EUDI wallet "d-you" | Germany from 2027-01-02 (date from a secondary source) [74], free; QES "in the course of 2027", method undecided [73] | High if it comes | Unknown | Unknown | Re-check mid-2027 | Later |
| Shortcuts, App Intents | "OCR this", "merge these" as actions; needs the engine without UI | Medium | No | No | 3–5 PD | Later |
| Siri | iOS 27 Siri AI is reported unavailable to EU developers [80] (unverified) | Low | No | – | No | No |
| Background work | `BGContinuedProcessingTask` finishes user-started work with visible progress [68]. **Catch:** our engine runs in WebContent, which suspends. Only native parts (Vision OCR) can use it. Android: same question for WebView under a foreground service (unverified) | Medium | No | No | With a native engine | 7 |
| Widgets | Recent files | Low | No | No | 2 PD | No |
| Quick Look | Preview and thumbnail for `.bwpdf` in Files; PDFs are already covered | Low | No | No | 2–3 PD | Later |
| Notifications | Local "OCR done" only matters with background work | Low | Push since 16.4 | Yes | – | No |
| External display | Presentation view | Low | Mirrors | Mirrors | 2 PD | No |

**Competitors:** Acrobat's mobile app is free to read and manage, editing and exporting need a subscription [61]; Foxit
puts mobile editing in its top tier [62]. Acrobat and PDF Expert have most of these rows on iOS; digital certificates on
mobile vary by paid tier (unverified).

## 9. Local AI

| Capability | What a native app gets | PDF value | PWA | Effort (est.) | Step |
|---|---|---|---|---|---|
| OCR and layout | Vision and ML Kit (section 6) | High | Tesseract WASM | See section 6 | 4 |
| Summarise, rewrite on iOS | Foundation Models: free, offline, iOS 26+ on Apple Intelligence devices with it enabled, in supported regions [81][82]. 15 languages, German and EU status unconfirmed [83] | Medium | No | 2–3 PD | Later |
| Summarise, rewrite on Android | ML Kit GenAI on Gemini Nano through AICore, on a device list; 140 million devices [84][85] | Medium | No (Chrome Prompt API on Android not found) | 2–3 PD | Later |
| Own models | ONNX or Core ML for layout; Play Asset Delivery for size (`ARCHITECTURE.md`) | Low now | WebGPU possible, memory-heavy | 15+ PD | No |

Neither system model reaches most devices, so AI can only be optional, and it cannot replace the semantic paragraph work
in Fernwork. **Competitors:** Adobe sells an AI Assistant at 6.99 $ [60]; Foxit has one [62]; PDFgear's Copilot is
ChatGPT-based [66]. They are cloud services, so "summary that never leaves the device" is a real distinction, later.

## 10. Technology paths

| | TWA | Capacitor | Tauri Mobile | React Native + WebView | Fully native |
|---|---|---|---|---|---|
| Editor reused | 100 % | 100 % | 100 % | 100 % in a WebView | 0 % |
| Runs in | Chrome | WKWebView, Android WebView | WKWebView, Android WebView | Same | PDFKit or PDFium, own UI |
| Android | Yes | Yes | Yes | Yes | Yes |
| iOS | **No** | Yes | Yes | Yes | Yes |
| Native code | Almost none; a separate Activity at best | Swift, Kotlin plugins; largest ecosystem | Swift, Kotlin plugins; Rust core shared with desktop | Largest native-module ecosystem, second JS runtime | All |
| Host work | None | New second host | `packages/host-tauri`, already planned | New second host | None |
| Updates | Instant, like the site | Store release | Store release | Store release | Store release |
| Base effort Android (est.) | 3–5 PD | 10–15 PD | 10–20 PD | 20–30 PD | 250+ PD |
| Base effort iOS (est.) | – | 12–20 PD | 12–20 PD | 20–30 PD | 250+ PD |
| Risk | Depends on the default browser [21][22]; share and file intents need testing | Low; store-proven, Capacitor 8 since Dec 2025 [96] | Medium: younger, fewer plugins, `content://` and security scope undocumented [32] | High for no gain | Rewrite; parity lost for years |

Capabilities by path:

| Capability | TWA | Capacitor | Tauri | RN + WebView | Native |
|---|---|---|---|---|---|
| Store listing | Android | Both | Both | Both | Both |
| Open-with, share | Android, test | Both | Both; iOS share extension by hand | Both | Both |
| Save to original | Chrome API, test | Plugin | Own plugin | Plugin | Yes |
| Scanner | Hard | Yes | Own plugin | Yes | Yes |
| Native ink over the page | No | Yes | Yes | Yes, hardest to compose | Yes |
| Print PDF natively | No | Yes | Yes | Yes | Yes |
| Native PDFium later | No | Yes | **Best: Rust is already there** | Yes | Yes |
| Shared with desktop | Web only | Web only | **Web and native host** | Web only | Nothing |

**Decision: Tauri, with Capacitor as the fallback.** Capacitor is safer on day one, but we would write our own Swift and
Kotlin for every feature that matters here (in-place files, ink, scanner glue) either way, and the Tauri host, CSP,
capabilities, file associations and Rust crate exist. `docs/ARCHITECTURE.md` already commits to one Tauri host. File
associations, a gap until recently, are now official [32][33]. **Kill criterion:** spike 3 PD on iOS (open in place,
save, print, 100-page session) before committing. If `WKWebView` under Tauri blocks one of them, switch to Capacitor; the
web bundle does not change.

React Native adds a second runtime around a WebView and buys nothing. Fully native rewrites a 48,618-line shell, its
engine layer and every feature twice, for one person (est. 250+ PD each, likely well above). Native surfaces inside the
hybrid (scanner, ink, document browser) capture most of the benefit.

Moving from TWA to Tauri later keeps the listing: same package name, same Play signing key, a normal update. Unsaved
drafts in Chrome storage do not move over (unverified: treat as lost, warn in release notes).

## 11. Distribution

| Topic | Facts | Consequence |
|---|---|---|
| Discovery | Store search; TWA reaches Play, nothing reaches the App Store without an app | The main business reason for steps 2–3 |
| Accounts | Apple 99 $/year; Play 25 $ once | Cheap |
| Play onboarding | New personal accounts need a closed test: 12 testers, 14 continuous days, review usually within 7 days [86] | Plan 3–4 weeks for step 2 |
| Play targets | API 36 for new apps and updates since 2026-08-31 [87] | Keep current yearly |
| Android outside Play | Developer verification: 2026-09-30 in four countries, certified devices globally during 2027 [88] | Direct APK downloads will also need a registered developer for an ordinary install; adb and an advanced flow remain |
| App Store SDK | Xcode 26 and iOS 26 SDK since 2026-04-28 [89] | New requirement each spring |
| App Review | 4.2: more than a repackaged website; 2.5.2: self-contained, no downloaded code [90] | Bundled editor plus native files, scan and print clears 4.2 (est.). OCR language data is data, check against 2.5.2 |
| Encryption | AES-256 in "Protect" needs an honest export answer [91] | Do not blindly set `false`; check |
| EU trader rules | Traders show address, phone and e-mail; individuals may give a PO box; "any revenue" makes a trader [92] | Decide before a paid tier; the public address matters |
| Privacy labels | Acrobat tracks identifiers and links contact info, contacts, user content [60] | "Data Not Collected" is a lead. Opt-in crash reports must be declared honestly |
| Monetisation | Free: no commission. EU from 2026-10-01: IAP 26 % (15 % small business), link-out 15 % (10 %) [93]. Play: 20 % plus 5 % for Play Billing, 10 % subscriptions, rollout from 2026-06-30, secondary sources in conflict [94] | No decision needed for a free app |
| Updates | Native builds pass review; each Fernwork pin becomes a release | Batch pins for apps, monthly at most (est.) |
| Size | `dist/` 124 MB (report); Acrobat 579 MB [60] | A selling point. Keep OCR languages on demand |
| Licence: own code | BUSL-1.1 | Legal review gate in `ARCHITECTURE.md` |
| Licence: PDFium | BSD-3-Clause; notices screen exists | Fine |
| Licence: libheif | LGPL-3.0, only in berg:work Image, optional and off by default; **no HEIC code in the PDF app** (**repo**) | Use OS decoders for HEIC on mobile; no LGPL and no HEVC patent question |
| Licence: fonts | Bundle includes **Liberation Sans Narrow, GPL-2.0 with font exception** (**repo**). The FSF treated App Store terms as conflicting with the GPL; VLC was pulled in 2011 [95] | Legal check, or drop it from the iOS bundle (0.5 PD) |
| Licence: dual | `jszip`, `node-forge`: MIT or BSD option | Take the permissive option |

**Competitor pricing:** Acrobat Premium 12.99 $/month, 69.99 $/year on iOS [60]; Foxit Editor+ 159.99 $ list [62]; Xodo
11.99 $/month [63]; PDF Expert about 50–80 $/year, conflicting [64]; PDFgear free [65].

## 12. Open checks on real devices

1. **PDFgear on iPhone and Android:** what does it really edit, and what does it break? This decides how the listing
   argues.
2. **Android Chrome:** does `showSaveFilePicker` exist, and does a TWA or WebAPK receive `file_handlers` launches?
3. **iOS Home Screen app:** does `persist()` return true? Does a blob save work? Does `window.print` work?
4. **iPad memory:** a long editing session on GeoTopo and a 500 MB scan: when does WebContent die?
5. **Ink:** after step 0, is web ink on an iPad good enough?
6. **Scribble** in the editor's `textarea` in Safari and WKWebView.
7. **Tauri iOS:** open in place, save, print (the 3 PD spike).

## Sources

All read or seen in search results on 2026-10-30; publication dates where known. [61] could not be fetched (HTTP 403):
known from a search excerpt only.

**WebKit and iOS web**
1. WebKit, Updates to Storage Policy (2023): https://webkit.org/blog/14403/updates-to-storage-policy/
2. WebKit Features for Safari 27.0: https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
3. MDN browser-compat-data, `main`: https://github.com/mdn/browser-compat-data (`api/Window`, `PointerEvent`, `StorageManager`, `NDEFReader`)
4. caniuse, File System Access: https://caniuse.com/native-filesystem-api
5. PWAs on iOS and iPadOS: https://progressivewebapps.com/platforms/ios-safari/
6. Synthetixis, PWAs on iPhone in 2026: https://synthetixis.com/writing/pwa-ios-2026
7. MDN, Storage quotas and eviction: https://developer.mozilla.org/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
8. WebKit bug 275288, installed PWA not downloading: https://bugs.webkit.org/show_bug.cgi?id=275288
9. Apple forums, print in full-screen web app: https://developer.apple.com/forums/thread/22911
10. Apple forums, download in a PWA: https://developer.apple.com/forums/thread/119017
11. wkwebview-jit-bench (iPhone Air, iOS 27.0.1): https://github.com/gagarinyury/wkwebview-jit-bench
12. webkit-wasm-compiler-memory-repro: https://github.com/frankhinek/webkit-wasm-compiler-memory-repro
13. Memory entitlements for iOS apps: https://zenn.dev/mtfum/articles/ios_memory_entitlements?locale=en
14. Apple Support, default apps on iPhone and iPad: https://support.apple.com/en-us/121430
15. Gigazine, Blink on iOS (2026-06): https://gigazine.net/gsc_news/en/20260618-blink-on-ios

**Chrome, Android web, WebView**

16. Chrome 132 release notes: https://developer.chrome.com/release-notes/132
17. Chrome, File Handling: https://developer.chrome.com/docs/capabilities/web-apis/file-handling
18. Chromium, file handling: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/webapps/file_handling.md
19. Bubblewrap 1.23 `TwaManifest`: https://app.unpkg.com/@bubblewrap/core@1.23.0/files/dist/lib/TwaManifest.d.ts
20. Chrome, Web Share Target: https://developer.chrome.com/docs/capabilities/web-apis/web-share-target
21. Chrome, TWA overview: https://developer.chrome.com/docs/android/trusted-web-activity/overview
22. Samsung forum, Share Target in TWAs: https://forum.developer.samsung.com/t/bug-share-target-api-doesn-t-receive-files-in-twas/13001
23. Google System Updates, WebView v156 (2026-10-07): https://support.google.com/product-documentation/answer/14343500?hl=en
24. androidx.webkit 1.18.0 (2026-10-21): https://developer.android.com/jetpack/androidx/releases/webkit
25. Chromium issue 40914606: https://issues.chromium.org/issues/40914606
26. Chrome, Document Isolation Policy: https://developer.chrome.com/blog/document-isolation-policy
27. Chrome, desynchronized canvas: https://developer.chrome.com/blog/desynchronized
28. WICG ink enhancement: https://github.com/WICG/ink-enhancement/blob/main/README.md

**Engine**

29. pdfium-binaries: https://github.com/bblanchon/pdfium-binaries
30. pdfium-render: https://crates.io/crates/pdfium-render
31. Android framework, PDFium lock: https://android.googlesource.com/platform/frameworks/base/+/366262d%5E!/

**Files**

32. Tauri, file associations on mobile: https://v2.tauri.app/learn/mobile-file-associations/
33. Tauri PR 14486: https://github.com/tauri-apps/tauri/pull/14486
34. Apple, `LSSupportsOpeningDocumentsInPlace`: https://developer.apple.com/tutorials/data/documentation/bundleresources/information-property-list/lssupportsopeningdocumentsinplace.md
35. OWASP MASTG-KNOW-0122: https://mas.owasp.org/MASTG/knowledge/ios/MASVS-PLATFORM/MASTG-KNOW-0122/
36. Apple, File Provider: https://developer.apple.com/documentation/fileprovider
37. Default app per file type on iOS 26: https://tech-fairy.com/how-to-set-a-default-app-to-open-a-certain-file-type-on-ios-26-ipados-26/ and https://maketecheasier.com/how-to-change-default-apps-ios/
38. Apple Support, Connect to Server in Files: https://support.apple.com/guide/iphone/connect-external-devices-or-servers-iph8d8f0f1a0/15.0/ios/15.0
39. CommonsWare, SAF grants: https://commonsware.com/blog/2020/06/13/count-your-saf-uri-permission-grants.html
40. Play Console, All files access: https://support.google.com/googleplay/android-developer/answer/10467955

**Scanner and OCR**

41. WWDC25, Read documents using Vision: https://developer.apple.com/videos/play/wwdc2025/272/ and, for the VisionKit camera, https://mistergrizzly.medium.com/scanning-documents-with-vision-and-visionkit-on-ios-13-913c0a6f9392
42. Apple, `RecognizeDocumentsRequest`: https://developer.apple.com/documentation/vision/recognizedocumentsrequest.md
43. ML Kit document scanner (2026-10-23): https://developers.google.com/ml-kit/vision/doc-scanner/android
44. ML Kit text recognition v2: https://developers.google.com/ml-kit/vision/text-recognition/v2
45. ML Kit Digital Ink: https://developers.google.com/ml-kit/vision/digital-ink-recognition
46. Adobe Scan on Play: https://play.google.com/store/apps/details?id=com.adobe.scan.android&hl=en_US
47. TechCrunch, Lens retired (2025-08-08): https://techcrunch.com/2025/08/08/rip-microsoft-lens-a-simple-little-app-thats-getting-replaced-by-ai/

**Stylus**

48. Reading Apple Pencil pressure in the browser: https://dev.to/sendotltd/reading-apple-pencil-pressure-in-the-browser-pointerevent-getcoalescedevents-and-the-2e23
49. Apple, Apple Pencil updates: https://developer.apple.com/documentation/updates/applepencil.md
50. Apple, `UITouch.rollAngle`: https://developer.apple.com/documentation/uikit/uitouch/rollangle.md
51. WWDC24 session 10214: https://developer.apple.com/br/videos/play/wwdc2024/10214/
52. PencilKit and PaperKit guide: https://charleswiltgen.github.io/Axiom/skills/ui-design/pencilkit-paperkit
53. Macworld, Apple Pencil in iPadOS 13: https://www.macworld.com/article/232892/apple-pencil-changes-and-improvements-in-ipados-13.html
54. Apple forums, Scribble in WKWebView: https://developer.apple.com/forums/thread/848865 and https://developer.apple.com/forums/thread/713851
55. Jetpack Ink: https://developer.android.com/jetpack/androidx/releases/ink
56. `androidx.graphics.lowlatency`: https://developer.android.com/reference/androidx/graphics/lowlatency/package-summary
57. Goodnotes vs Notability: https://www.goodnotes.com/blog/goodnotes-vs-notability
58. Samsung, PDFs in Samsung Notes: https://www.samsung.com/us/support/answer/ANS10002404/
59. Samsung, convert handwriting: https://www.samsung.com/sg/support/mobile-devices/how-do-you-convert-handwriting-to-text-and-other-formats-using-s-pen-and-samsung-notes/

**Competitors**

60. Acrobat on the App Store: https://apps.apple.com/us/app/acrobat-reader-pdf-editor/id469337564
61. Adobe, mobile app FAQ: https://helpx.adobe.com/acrobat/mobile-app-faq.html
62. Foxit store: https://www.foxit.com/shopping/
63. Xodo plans: https://xodo.com/blog/xodo-plans-explained
64. PDF Expert on the App Store: https://apps.apple.com/ca/app/pdf-expert-reader-editor-app/id743974925
65. MakeUseOf, PDFgear on Android (2026-05-03): https://www.makeuseof.com/edit-pdf-on-android-with-pdfgear/
66. PDFgear for iOS: https://www.pdfgear.com/pdfgear-for-ios
67. SwifDoo, PDFgear review: https://www.swifdoo.com/edit-pdfs/pdfgear-review

**System**

68. WWDC25, Finish tasks in the background: https://developer.apple.com/videos/play/wwdc2025/227/
69. Apple, Printing: https://developer.apple.com/library/archive/documentation/2DDrawing/Conceptual/DrawingPrintingiOS/Printing/Printing.html
70. Android, `PrintManager`: https://developer.android.com/reference/android/print/PrintManager
71. Android, `KeyChain`: https://developer.android.com/reference/android/security/KeyChain
72. AusweisApp: https://www.ausweisapp.bund.de/en/faq-for-developers and https://github.com/Governikus/AusweisApp/releases
73. EUDI Wallet FAQ: https://eudi-wallet.gov.de/en/faq
74. Germany's EUDI Wallet: https://didit.me/blog/germany-eudi-wallet/
75. MacStories, iPadOS 26 menu bar: https://www.macstories.net/stories/ios-and-ipados-26-the-macstories-review/11
76. MacRumors, Stage Manager on more iPads: https://www.macrumors.com/2025/06/22/ipados-26-expands-stage-manager-to-more-ipads/
77. 9to5Google, DeX on Android 16: https://9to5google.com/2025/07/25/samsung-dex-android-16-desktop-mode-redesign/
78. 9to5Google, Googlebook launch (2026-09-21): https://9to5google.com/2026/09/21/googlebook-launch/
79. Tauri plugins: https://v2.tauri.app/plugin/
80. Apple forums, App Intents and Siri AI: https://developer.apple.com/forums/thread/832602

**Local AI**

81. Apple, Foundation Models (2025-09): https://www.apple.com/newsroom/2025/09/apples-foundation-models-framework-unlocks-new-intelligent-app-experiences/
82. WWDC25, Meet the Foundation Models framework: https://developer.apple.com/videos/play/wwdc2025/286/
83. Apple ML Research, models 2025: https://machinelearning.apple.com/research/apple-foundation-models-2025-updates
84. ML Kit GenAI: https://developers.google.com/ml-kit/genai
85. Android Developers Blog, on-device inference (2026-07): https://android-developers.googleblog.com/2026/07/android-on-device-inference.html

**Distribution**

86. Play Console, testing for new personal accounts: https://support.google.com/googleplay/android-developer/answer/14151465?hl=en
87. Android, target SDK: https://developer.android.com/google/play/requirements/target-sdk
88. Android developer verification: https://android-developers.googleblog.com/2026/06/android-developer-verification.html and https://www.androidauthority.com/android-sideloading-changes-timeline-3679204/
89. Apple, SDK minimum requirements: https://www.developer.apple.com/news/upcoming-requirements/
90. App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
91. Apple, `ITSAppUsesNonExemptEncryption`: https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption
92. MacRumors, EU trader requirement (2024-10-17): https://www.macrumors.com/2024/10/17/developers-eu-app-store-trader-requirements/
93. Apple Newsroom, EU changes (2026-08): https://www.apple.com/newsroom/2026/08/apple-announces-changes-for-apps-in-the-european-union/
94. Yahoo Finance, Google and Epic settlement: https://finance.yahoo.com/news/google-settles-epic-games-drops-200512326.html
95. The GPL and the iOS App Store: https://michelf.ca/blog/2011/gpl-ios-app-store
96. Ionic, Capacitor 8 (2025-12-08): https://ionic.io/blog/announcing-capacitor-8
