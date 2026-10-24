/**
 * The berg:work design base (packages/ui) for both Vite builds (web and Tauri frontend). apps/image is not an npm
 * workspace yet, so the package is aliased to its sources; React is deduplicated so packages/ui and the editor
 * share this app's copy.
 */
import { fileURLToPath } from 'node:url';

const ui = (path: string) => fileURLToPath(new URL(`../../packages/ui/src/${path}`, import.meta.url));

export const bergworkResolve = {
  alias: [
    { find: /^@bergwork\/ui\/styles\.css$/, replacement: ui('css/index.css') },
    { find: /^@bergwork\/ui$/, replacement: ui('index.ts') },
  ],
  dedupe: ['react', 'react-dom'],
};

/** The repository root: the dev server must serve packages/ui and its fonts from node_modules. */
export const bergworkRoot = fileURLToPath(new URL('../..', import.meta.url));
