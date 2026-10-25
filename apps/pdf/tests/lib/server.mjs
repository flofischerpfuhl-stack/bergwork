// Static server for the corpus suite: the assembled frontend (apps/pdf/dist) at the root, so the editor's
// "/tools/vendor/…" paths resolve as in the app, the harness bundle under /__harness/, the corpus under /__corpus/
// and an upload endpoint (POST /__out/<name>) the harness writes exported PDFs to, so the runner can check them with
// independent tools without moving bytes through the DevTools protocol. Cross-origin isolated like the app.
import { createReadStream, promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.traineddata': 'application/octet-stream',
  '.gz': 'application/gzip',
};

function inside(root, relative) {
  const resolved = path.resolve(root, `.${path.sep}${relative}`);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * @param {{ distDir: string, harnessDir: string, corpusRoot: string, outDir: string, port?: number }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, uploads: Map<string, string> }>}
 */
export async function startServer({ distDir, harnessDir, corpusRoot, outDir, port = 0 }) {
  await fs.mkdir(outDir, { recursive: true });
  const uploads = new Map();
  const server = http.createServer(async (request, response) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === 'POST' && pathname.startsWith('/__out/')) {
        const name = pathname.slice('/__out/'.length).replace(/[^A-Za-z0-9._-]/g, '_');
        const target = inside(outDir, name);
        if (!target) throw Object.assign(new Error('bad name'), { status: 400 });
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        // Large outputs arrive in chunks (see harness upload()): the first one truncates, the others append.
        await fs.writeFile(target, Buffer.concat(chunks), { flag: url.searchParams.get('append') === '1' ? 'a' : 'w' });
        uploads.set(name, target);
        response.writeHead(204, headers).end();
        return;
      }
      let root = distDir;
      let relative = pathname;
      if (pathname.startsWith('/__harness/')) { root = harnessDir; relative = pathname.slice('/__harness/'.length); }
      else if (pathname.startsWith('/__corpus/')) { root = corpusRoot; relative = pathname.slice('/__corpus/'.length); }
      else if (pathname.startsWith('/__out/')) { root = outDir; relative = pathname.slice('/__out/'.length); }
      let file = inside(root, relative);
      if (!file) throw Object.assign(new Error('forbidden'), { status: 403 });
      let stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) { file = path.join(file, 'index.html'); stat = await fs.stat(file).catch(() => null); }
      if (!stat) throw Object.assign(new Error('not found'), { status: 404 });
      response.writeHead(200, {
        ...headers,
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      createReadStream(file).pipe(response);
    } catch (error) {
      response.writeHead(error.status || 500, { ...headers, 'Content-Type': 'text/plain' }).end(String(error.message));
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address();
  return {
    url: `http://127.0.0.1:${actual}`,
    uploads,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
