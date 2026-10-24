import fs from 'node:fs';
import { gzipSync } from 'node:zlib';

const reportPath = new URL('../dist/bundle-report.json', import.meta.url);
const manifestPath = new URL('../dist/.vite/manifest.json', import.meta.url);
if (!fs.existsSync(reportPath) || !fs.existsSync(manifestPath)) {
  console.error('Bundle budget: build report or Vite manifest is missing; run vite build first.');
  process.exitCode = 1;
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const startFile = manifest['src/index.ts']?.file;
  const starts = report.files.filter((file) => file.fileName === startFile && file.liteStart);
  if (starts.length !== 1) {
    console.error(`Bundle budget: expected one Lite start chunk, found ${starts.length}.`);
    process.exitCode = 1;
  } else {
    const start = starts[0];
    const gzipBytes = gzipSync(fs.readFileSync(new URL(`../dist/${start.fileName}`, import.meta.url))).byteLength;
    const limit = 400_000;
    console.log(`Lite start chunk: ${start.fileName} ${(gzipBytes / 1000).toFixed(2)} kB gzip (limit 400.00 kB)`);
    if (gzipBytes > limit) {
      console.error(`Bundle budget exceeded by ${((gzipBytes - limit) / 1000).toFixed(2)} kB.`);
      process.exitCode = 1;
    }
  }
}
