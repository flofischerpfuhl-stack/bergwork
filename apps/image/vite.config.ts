import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { gzipSync } from 'node:zlib';
import { bergworkResolve } from './vite.bergwork';

/** Build evidence and the source of truth for A10's generated bundle-budget gate. */
function bundleReport(): Plugin {
  return {
    name: 'fernwork-bundle-report',
    generateBundle(_options, bundle) {
      const files = Object.entries(bundle).flatMap(([fileName, output]) => {
        if (fileName.endsWith('.map')) return [];
        const source = output.type === 'chunk' ? output.code : output.source;
        const bytes = typeof source === 'string' ? Buffer.from(source) : Buffer.from(source);
        const modules = output.type === 'chunk' ? Object.entries(output.modules).map(([id, info]) => ({
          id: id.startsWith(process.cwd()) ? id.slice(process.cwd().length + 1) : id,
          renderedBytes: info.renderedLength ?? 0,
        })).sort((a, b) => b.renderedBytes - a.renderedBytes) : [];
        return [{ fileName, bytes: bytes.byteLength, gzipBytes: gzipSync(bytes).byteLength,
          kind: output.type, isEntry: output.type === 'chunk' && output.isEntry,
          isDynamicEntry: output.type === 'chunk' && output.isDynamicEntry,
          liteStart: modules.some((module) => module.id === 'src/ui/mountEditor.tsx'), modules }];
      });
      this.emitFile({ type: 'asset', fileName: 'bundle-report.json', source: JSON.stringify({ files }, null, 2) });
    },
  };
}

/**
 * Dev only: WebKit rejects a module a worker imports when the dev server revalidates it with a bare 304 (no COEP header),
 * which stopped every worker under cross-origin isolation. Serving full responses keeps the headers on each module.
 */
function fullResponsesForWorkers(): Plugin {
  return {
    name: 'fernwork-dev-full-responses',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => { delete req.headers['if-none-match']; delete req.headers['if-modified-since']; next(); });
    },
  };
}

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [fullResponsesForWorkers(), react(), bundleReport()],
  resolve: bergworkResolve,
  server: { host: '127.0.0.1', headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es' },
  // Worktrees share one symlinked node_modules; a per-server cache keeps one dev server's re-optimisation from
  // breaking another server's already-loaded chunks (the e2e webServer sets VITE_CACHE_DIR per port).
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  // Pre-bundle every runtime dependency up front so the dev server never re-optimises (and reloads
  // the page) when a feature first imports one.
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'zustand/vanilla', 'immer', 'idb', 'fflate', 'pixi.js', 'pixi.js/unsafe-eval', 'canvaskit-wasm', 'ag-psd', 'onnxruntime-web/webgpu'] },
  build: { target: 'es2022', sourcemap: true, manifest: true },
});
