# berg:work Image

Tauri 2 app around the image editor from the compositor repository. The internal Tauri build still lives in that
repository (`src-tauri/`, branch `integration`); it moves here once the host is split out.

- `upstream/` (not committed): the web build of the pinned commit (`compositor-image` in
  `../../upstream.lock.json`). Recreate it with `npm run sync:install`.
- The editor already takes a host through its capability registry (`src/platform/hosts/types.ts` upstream).
