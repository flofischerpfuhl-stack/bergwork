import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The demo page (demo/) shows every component in a berg:work Image window, light and dark.
export default defineConfig({
  root: 'demo',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5230, strictPort: true },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});
