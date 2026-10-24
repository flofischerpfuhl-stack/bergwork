import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The host page (web/) builds into dist/; scripts/build-frontend.mjs adds the editor under dist/tools/vendor/.
// A relative base, so the same build runs at the desktop app's root and under /app/pdf/ on bergwork.app.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
