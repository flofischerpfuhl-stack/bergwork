// A horizontal or vertical stroke has a bounding box of zero (or hairline) width or height. A filter that wants both sides
// above 1 dropped every table rule and separator from the page's objects and from Layers; only an object that is tiny in
// both directions may be dropped.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/vendor/build/src');

test('no object filter needs both sides of a bounding box above 1', async () => {
  const files = (await readdir(src, { recursive: true })).filter(file => /\.jsx?$/u.test(file));
  assert.ok(files.length > 3);
  const found = [];
  for (const file of files) {
    for (const [index, line] of (await readFile(path.join(src, file), 'utf8')).split('\n').entries()) {
      if (/\.filter\(.*bbox\??\.w\s*>\s*1\s*&&\s*[\w?.]*bbox\??\.h\s*>\s*1/u.test(line)) found.push(`${file}:${index + 1}`);
    }
  }
  assert.deepEqual(found, []);
});
