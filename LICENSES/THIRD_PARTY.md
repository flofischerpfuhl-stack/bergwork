# Third-Party Licenses

This file tracks third-party components that are **incorporated into a
berg:work build**, including the website. Editors taken over from Fernwork
bring their own entries from Fernwork's `LICENSES/THIRD_PARTY.md`; they are
added here when the apps start to include them.

## berg:work PDF

| Name | Version | License | Location | Upstream | Use |
| --- | --- | --- | --- | --- | --- |
| libheif WebAssembly build (libheif-js, with libheif and libde265) | 1.23.5 | LGPL-3.0 | `apps/pdf/upstream/tools/vendor/libheif-js-1.23.5/` (pinned from Fernwork, not committed; licence text in `LICENSE`), shipped unmodified as `tools/vendor/libheif-js-1.23.5/libheif-bundle.js` | https://github.com/catdad-experiments/libheif-js (tag `v1.23.5`), https://github.com/strukturag/libheif, https://github.com/strukturag/libde265 | Reads HEIC and HEIF photos. Loaded separately by the worker `tools/js/converters/heic-decode-worker.js` on the first HEIC photo and can be replaced by the user. |

## Website

| Name | Version | License | Location | Upstream | Use |
| --- | --- | --- | --- | --- | --- |
| Stalinist One (modified as "Bergschrift") | Google Fonts release, © 2009–2011 Alexey Maslov, Jovanny Lemonad | SIL Open Font License 1.1 | `website/src/assets/fonts/` (licence text in `OFL.txt`) | https://fonts.google.com/specimen/Stalinist+One | Wordmark font with light faux-Cyrillic letters. Renamed because of the Reserved Font Name "Stalinist"; rebuilt by `scripts/build-wordmark-font.py`. |
