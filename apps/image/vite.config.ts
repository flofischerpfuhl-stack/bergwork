import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { constants as zlib, gzipSync } from 'node:zlib';
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

/**
 * Build only: the web host serves at most 25 MiB per file, and ONNX Runtime's WebGPU binaries are ~26 MB. Such an
 * asset ships as `<name>.gz` and every chunk that names it is pointed at the compressed file, which
 * src/workers/ortWasm.ts inflates. Runs in the worker builds, where those assets are emitted.
 */
function gzipOversizedWasm(): Plugin {
  const LIMIT = 24 * 1024 * 1024;
  return {
    name: 'bergwork-gzip-oversized-wasm',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== 'asset' || !fileName.endsWith('.wasm') || output.source.length <= LIMIT) continue;
        const source = typeof output.source === 'string' ? Buffer.from(output.source) : output.source;
        delete bundle[fileName];
        this.emitFile({ type: 'asset', fileName: `${fileName}.gz`, source: gzipSync(source, { level: zlib.Z_BEST_COMPRESSION }) });
        const name = fileName.slice(fileName.lastIndexOf('/') + 1);
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.code.includes(name)) chunk.code = chunk.code.replaceAll(name, `${name}.gz`);
        }
      }
    },
  };
}

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // The web build on bergwork.app lives under /app/image/ (website/build.mjs sets BERGWORK_BASE).
  base: process.env.BERGWORK_BASE ?? '/',
  plugins: [fullResponsesForWorkers(), react(), bundleReport()],
  resolve: bergworkResolve,
  server: { host: '127.0.0.1', headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  worker: { format: 'es', plugins: () => [gzipOversizedWasm()] },
  // Worktrees share one symlinked node_modules; a per-server cache keeps one dev server's re-optimisation from
  // breaking another server's already-loaded chunks (the e2e webServer sets VITE_CACHE_DIR per port).
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  // Pre-bundle every runtime dependency up front so the dev server never re-optimises (and reloads
  // the page) when a feature first imports one.
  optimizeDeps: { include: ['react', 'react-dom', 'react-dom/client', 'zustand', 'zustand/vanilla', 'immer', 'idb', 'fflate', 'pixi.js', 'pixi.js/unsafe-eval', 'canvaskit-wasm', 'ag-psd', 'onnxruntime-web/webgpu'] },
  build: { target: 'es2022', sourcemap: true, manifest: true },
});
