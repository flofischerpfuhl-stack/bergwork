# berg:work branding

Vector masters live in `logos/source/`; they were approved by the product owner on 2026-09-25 from the
low-poly logo round in `logos/proposals/2026-09-25/` (whose `generator/` rebuilds them).

| Product | Master | Role | SHA-256 |
| --- | --- | --- | --- |
| berg:work | `bergwork.svg` | Brand mark, Schlägel und Eisen | `029f31bf44ae1991f945b76ce4f5e54ed616515f1cac736a73fee68c42e7b727` |
| berg:work | `bergwork-on-light.svg` | Brand mark for light backgrounds (grey edge strip) | `34cc17a566b0ddec2326395e16f9090400a236e7387f764cc8f1b3ea8f882630` |
| berg:work PDF | `bergwork-pdf.svg` | PDF app mark, stone tablet | `6d511b1d4db1e8b6cd0ade1045620d15e1d7cb6b646f6d116aa946653a855a5a` |
| berg:work PDF | `bergwork-pdf-on-light.svg` | PDF app mark for light backgrounds | `bcf40b6409586804cd490329314921aa448236262a92c35f6e91d8dddcf23ef2` |
| berg:work Image | `bergwork-image.svg` | Image app mark, stone frame | `813f5e6615a5cc16a01ea6dbcb1735452d1d3b5d55444b069f7935fb7891d7eb` |
| berg:work Image | `bergwork-image-on-light.svg` | Image app mark for light backgrounds | `ca8974c5afd1081a84135d77c313dc192778cccd0ee0ed2956352a0809e089bc` |

## Generated sets

`logos/generated/<id>/` holds, per mark, the app icon card on the ink plate `#0a0a0a`
(`icon.svg`, `icon-16…1024.png`, `icon.ico`), `apple-touch-icon.png`, a full-bleed
`icon-maskable-512.png` and the bare `mark-512.png`. Rebuild with:

```bash
python3 branding/scripts/export-icons.py branding/logos/source/<id>.svg branding/logos/generated/<id> --plate '#0a0a0a'
```

`bergwork-image/tauri/` and `bergwork-pdf/tauri/` are complete `tauri icon` outputs (same layout as a
Tauri `src-tauri/icons/`), made from `icon-1024.png` with the Tauri CLI:
`tauri icon branding/logos/generated/<id>/icon-1024.png -o branding/logos/generated/<id>/tauri`.

## Where they are used

- Website: `website/src/assets/icons/` holds copies from `generated/bergwork/`
  (`bergwork-mark.svg` = `icon.svg`; `favicon.ico` is the 16/32/48 subset of the icon).
- berg:work Image: `generated/bergwork-image/tauri/` replaces `src-tauri/icons/` of the image editor
  (compositor repo, branch `integration`) — not copied yet.
- berg:work PDF: `generated/bergwork-pdf/tauri/` is ready for the Tauri shell once it exists.
