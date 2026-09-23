import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1' },
  worker: { format: 'es' },
  // Pre-bundle every runtime dependency up front so the dev server never re-optimises (and reloads
  // the page) when a feature first imports one.
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'zustand/vanilla', 'immer', 'idb', 'fflate', 'pixi.js', 'onnxruntime-web/webgpu'] },
  build: { target: 'es2022', sourcemap: true },
});
