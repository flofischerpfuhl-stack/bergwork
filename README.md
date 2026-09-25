# berg:work

Brand home for the desktop spin-offs of Fernwork:

- **berg:work PDF**: the Fernwork PDF editor as its own Tauri app.
- **berg:work Image**: the image editor as its own Tauri app.

Sister brand of Himmel:CAD, with the same visual language; the faux-Cyrillic wordmark replaces
Himmel:CAD's faux-Japanese Kamikaze face.

## Layout

Monorepo; the architecture and the rules for the upstream editors are in `docs/ARCHITECTURE.md`.

- `apps/pdf/`, `apps/bild/`: the two apps. Each pins its editor build from upstream (`upstream.lock.json`,
  `npm run sync:install|check|status|update`).
- `packages/`, `crates/`: host implementation and hardware profile shared by both apps.
- `website/`: static marketing site (see `website/README.md`).
- `scripts/build-wordmark-font.py`: rebuilds the Bergschrift wordmark font.
- `.codex/`: Codex briefs and the screenshot/axe helper scripts used for the site.
- `archive/`: unused hero candidates and the font-picker build script from the design round (2026-09-25:
  chosen were Stalinist One with light faux-Cyrillic Я/И/Ш and the four mine images).

## Product status

- The PDF editor works in Fernwork's browser build. Its separate Tauri shell has not started.
- The image editor has an internal Tauri build on the compositor workspace's `integration` branch.
- Neither app has a public build. Pricing and final first-release scope have not been announced.

## Licence

berg:work is source-available under the [Business Source License 1.1](LICENSE) with the same Additional Use Grant as
Fernwork and Himmel:CAD; each release becomes AGPL-3.0-or-later four years after it is first published. See
[LICENSING.md](LICENSING.md) for a plain-language summary, [CLA.md](CLA.md) for contributions and
[LICENSES/THIRD_PARTY.md](LICENSES/THIRD_PARTY.md) for third-party components.
