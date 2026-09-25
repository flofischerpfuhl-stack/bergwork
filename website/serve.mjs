import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function safePath(urlPath) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(urlPath, 'http://local').pathname); } catch { return null; }
  const relative = pathname.replace(/^\/+/, '');
  const candidates = pathname.endsWith('/') ? [path.join(relative, 'index.html')] : [relative, path.join(relative, 'index.html')];
  for (const candidate of candidates) {
    const resolved = path.resolve(dist, candidate);
    if (!resolved.startsWith(`${path.resolve(dist)}${path.sep}`) && resolved !== path.resolve(dist)) continue;
    if (existsSync(resolved)) return resolved;
  }
  return path.join(dist, '404.html');
}

export async function startServer({ port = Number(process.env.PORT || 8080), host = '127.0.0.1', quiet = false } = {}) {
  const server = createServer(async (request, response) => {
    const file = safePath(request.url || '/');
    const notFound = file?.endsWith('404.html') && !String(request.url).startsWith('/404.html');
    try {
      const info = await stat(file);
      const extension = path.extname(file).toLowerCase();
      const headers = {
        ...securityHeaders,
        'Content-Type': mime.get(extension) || 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      response.writeHead(notFound ? 404 : 200, headers);
      if (request.method === 'HEAD') response.end(); else createReadStream(file).pipe(response);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Server error');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const url = `http://${host}:${address.port}`;
  if (!quiet) console.log(`berg:work preview: ${url}`);
  return { server, url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
