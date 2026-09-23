import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  worker: { format: 'es' },
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'zustand/vanilla', 'immer', 'idb', 'fflate', 'pixi.js', 'onnxruntime-web/webgpu'] },
  build: { target: 'es2022', sourcemap: true, outDir: '../../dist-tauri', emptyOutDir: true },
});
