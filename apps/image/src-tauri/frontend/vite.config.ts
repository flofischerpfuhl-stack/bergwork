import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { bergworkResolve, bergworkRoot } from '../../vite.bergwork';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  resolve: bergworkResolve,
  base: './',
  // The shared public/ folder (bundled OFL fonts, U²-Netp model, …): root is src-tauri/frontend, so Vite would look there.
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    headers: isolationHeaders,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url)), bergworkRoot] },
  },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'zustand/vanilla', 'immer', 'idb', 'fflate', 'pixi.js', 'onnxruntime-web/webgpu'] },
  build: { target: 'es2022', sourcemap: true, outDir: '../../dist-tauri', emptyOutDir: true },
});
