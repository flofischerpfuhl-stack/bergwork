// Start payload of a `vite build`: the main app chunk (assets/src-*.js) plus everything it imports
// statically, gzip -9. Usage: node scripts/export-start-size.mjs <outDir>   (A10 Lite budget check)
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/export-start-size.mjs <vite outDir>');
const entry = `assets/${readdirSync(join(dir, 'assets')).find((f) => /^src-.*\.js$/.test(f))}`;
const seen = new Set();
const list = [];
let total = 0;
const visit = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const code = readFileSync(join(dir, file));
  const size = gzipSync(code, { level: 9 }).length;
  total += size;
  list.push(`${file.replace('assets/', '')}: ${(size / 1024).toFixed(2)} KB`);
  const text = code.toString('utf8');
  for (const match of text.matchAll(/(?:^|[;\n}])\s*import\s*(?:[^'"()]*?from\s*)?["'](\.\/[^"']+\.js)["']/g)) visit(join(dirname(file), match[1]));
  for (const match of text.matchAll(/export\s*\*?\s*(?:\{[^}]*\})?\s*from\s*["'](\.\/[^"']+\.js)["']/g)) visit(join(dirname(file), match[1]));
};
visit(entry);
console.log(list.join('\n'));
console.log(`total gzip: ${(total / 1024).toFixed(2)} KB`);
