// Lists English UI strings in the source that the German translator returns unchanged.
import fs from 'node:fs';
import path from 'node:path';
const root = new URL('../../src/', import.meta.url).pathname;
const { translator } = await import(new URL('../../src/ui/i18n.ts', import.meta.url).href);
const t = translator('de');
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(tsx?|ts)$/.test(f.name)) files.push(p); } };
walk(root);
const patterns = [/\bt\(\s*'((?:[^'\\]|\\.)+)'/g, /\bt\(\s*"((?:[^"\\]|\\.)+)"/g, /\b(?:edit|beginEdit)\(\s*'((?:[^'\\]|\\.)+)'/g,
  /\blabel:\s*'((?:[^'\\]|\\.)+)'/g, /\btitle:\s*'((?:[^'\\]|\\.)+)'/g];
const out = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  for (const re of patterns) for (const m of src.matchAll(re)) {
    const s = m[1].replace(/\\'/g, "'");
    if (!/[A-Za-z]{2}/.test(s)) continue;
    if (t(s) === s) out.set(s, (out.get(s) ?? new Set()).add(path.relative(root, f)));
  }
}
for (const [s, fs_] of [...out].sort()) console.log(JSON.stringify(s), '<-', [...fs_].join(', '));
console.error(`${out.size} untranslated candidates`);
