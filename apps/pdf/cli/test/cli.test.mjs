// One test per CLI command, against apps/pdf/scripts/fixtures/smoke.pdf (4 pages, text, a form field) and
// scanned-page.pdf (an image-only page). Each result is checked with qpdf and poppler, not with the engine itself.
//
//   npm run test:cli -w @bergwork/pdf
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cli, pdfinfo, pdftotext, qpdfCheck, scanned, setupMissing, smoke, tempDir, tools } from './helpers.mjs';

const skip = setupMissing || (!tools.qpdf || !tools.pdftotext || !tools.pdfinfo ? 'qpdf and poppler are needed' : false);
const ok = (run) => {
  assert.equal(run.code, 0, `exit ${run.code}: ${run.stdout}${run.stderr}`);
  assert.equal(run.out?.ok, true);
  return run.out.result;
};
const failed = (run, exit, code) => {
  assert.equal(run.code, exit, `exit ${run.code}: ${run.stdout}${run.stderr}`);
  assert.equal(run.out?.ok, false);
  assert.equal(run.out.error.code, code);
  return run.out.error;
};
const flat = (text) => text.replace(/\s+/g, ' ');

test('info', { skip }, async () => {
  const result = ok(await cli(['info', smoke]));
  assert.equal(result.pageCount, 4);
  assert.equal(result.pageCount, pdfinfo(smoke).pages);
  assert.deepEqual(result.pages[3], { page: 4, width: 842, height: 595, rotation: 0, textChars: result.pages[3].textChars });
  assert.ok(result.pages[0].textChars > 100);
  assert.equal(result.metadata.title, 'Site survey report');
  assert.equal(result.form.fields, 1);
  assert.equal(result.encrypted, false);
  const scan = ok(await cli(['info', scanned]));
  assert.equal(scan.pages[0].textChars, 0);
});

test('text', { skip }, async () => {
  const result = ok(await cli(['text', smoke, '-p', '1']));
  assert.match(result.pages[0].text, /Plot 14, Hillside Road/);
  assert.match(flat(pdftotext(smoke, { first: 1, last: 1 })), /Plot 14, Hillside Road/);
  const pdfjs = ok(await cli(['text', smoke, '-p', '2-3', '--engine', 'pdfjs']));
  assert.deepEqual(pdfjs.pages.map((item) => item.page), [2, 3]);
  failed(await cli(['text', smoke, '-p', '9']), 2, 'bad-argument');
});

test('render', { skip }, async (t) => {
  const dir = tempDir(t);
  const result = ok(await cli(['render', smoke, '-p', '1,4', '--dpi', '72', '-o', path.join(dir, 'page.png')]));
  assert.deepEqual(result.outputs.map((item) => path.basename(item.path)), ['page-1.png', 'page-4.png']);
  for (const [index, size] of [[0, [595, 842]], [1, [842, 595]]]) {
    const png = readFileSync(result.outputs[index].path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.ok(Math.abs(width - size[0]) <= 1 && Math.abs(height - size[1]) <= 1, `${width}x${height}`);
  }
});

test('ocr', { skip }, async (t) => {
  const dir = tempDir(t);
  assert.equal(pdftotext(scanned).trim(), '');
  const text = ok(await cli(['ocr', scanned]));
  assert.match(text.pages[0].text, /Hillside Road/);
  const output = path.join(dir, 'searchable.pdf');
  const layered = ok(await cli(['ocr', scanned, '--lang', 'eng', '-o', output]));
  assert.equal(layered.output.path, output);
  assert.ok(qpdfCheck(output));
  assert.match(flat(pdftotext(output)), /Plot 14, Hillside Road/);
  assert.equal(pdfinfo(output).pages, 1);
});

test('redact', { skip }, async (t) => {
  const dir = tempDir(t);
  const output = path.join(dir, 'redacted.pdf');
  assert.match(pdftotext(smoke), /Maria Keller, \+49 7121 555 0183/);
  const result = ok(await cli(['redact', smoke, '--term', 'Maria Keller', '--regex', '\\+49[\\d ]+\\d', '-o', output]));
  assert.equal(result.matches, 2);
  assert.ok(qpdfCheck(output));
  const text = pdftotext(output);
  assert.doesNotMatch(text, /Maria Keller|\+49|0183/);
  assert.match(text, /Site contact/);
  assert.match(text, /maria\.keller@example\.com/); // not matched: the dot is not whitespace
  assert.equal(pdfinfo(output).pages, 4);
  failed(await cli(['redact', smoke, '--term', 'no such words', '-o', path.join(dir, 'none.pdf')]), 3, 'no-match');
  failed(await cli(['redact', smoke, '--term', 'Keller', '-o', output]), 2, 'output-exists');
});

test('replace-text', { skip }, async (t) => {
  const dir = tempDir(t);
  const output = path.join(dir, 'replaced.pdf');
  const result = ok(await cli(['replace-text', smoke, '--find', 'Hillside Road', '--replace', 'Bergweg 7', '-o', output]));
  assert.equal(result.replaced.length, 1);
  assert.deepEqual(result.fontChanges, []);
  assert.ok(qpdfCheck(output));
  const text = flat(pdftotext(output, { first: 1, last: 1 }));
  assert.match(text, /Plot 14, Bergweg 7/);
  assert.doesNotMatch(text, /Hillside/);
  // Characters the source font cannot encode: refused with --keep-fonts, nothing written.
  const strict = path.join(dir, 'strict.pdf');
  const error = failed(await cli(['replace-text', smoke, '--find', 'Hillside Road', '--replace', '道路', '--keep-fonts', '-o', strict]), 3, 'unsupported');
  assert.ok(error.details.fontChanges.length);
  assert.throws(() => readFileSync(strict));
  failed(await cli(['replace-text', scanned, '--find', 'Hillside', '--replace', 'x', '-o', path.join(dir, 'scan.pdf')]), 3, 'no-match');
});

test('form-fields and fill-form', { skip }, async (t) => {
  const dir = tempDir(t);
  const fields = ok(await cli(['form-fields', smoke]));
  assert.deepEqual(fields.fields.map((field) => [field.name, field.type]), [['checked_by', 'text']]);
  const filled = path.join(dir, 'filled.pdf');
  const valuesFile = path.join(dir, 'values.json');
  writeFileSync(valuesFile, JSON.stringify({ checked_by: 'F. Fischer' }));
  ok(await cli(['fill-form', smoke, '--values', `@${valuesFile}`, '-o', filled]));
  assert.ok(qpdfCheck(filled));
  assert.equal(ok(await cli(['form-fields', filled])).fields[0].value, 'F. Fischer');
  const flattened = path.join(dir, 'flat.pdf');
  ok(await cli(['fill-form', smoke, '--values', '-', '--flatten', '-o', flattened], { input: '{"checked_by":"Anna B."}' }));
  assert.ok(qpdfCheck(flattened));
  assert.match(pdftotext(flattened), /Anna B\./);
  assert.equal(pdfinfo(flattened).fields.Form, 'none');
  failed(await cli(['fill-form', smoke, '--values', '{"nope":"x"}', '-o', path.join(dir, 'x.pdf')]), 3, 'unknown-field');
});

test('pages: rotate, delete, move, extract, split', { skip }, async (t) => {
  const dir = tempDir(t);
  const rotated = path.join(dir, 'rotated.pdf');
  ok(await cli(['pages', 'rotate', smoke, '-p', '2', '--angle', '90', '-o', rotated]));
  assert.ok(qpdfCheck(rotated));
  assert.match(pdfinfo(rotated, { first: 1, last: 4 }).text, /Page +1 rot: +0\n[\s\S]*Page +2 rot: +90\n[\s\S]*Page +3 rot: +0/);

  const deleted = path.join(dir, 'deleted.pdf');
  ok(await cli(['pages', 'delete', smoke, '-p', '2-3', '-o', deleted]));
  assert.ok(qpdfCheck(deleted));
  assert.equal(pdfinfo(deleted).pages, 2);
  assert.ok(flat(pdftotext(deleted, { first: 2, last: 2 })).includes(flat(pdftotext(smoke, { first: 4, last: 4 })).slice(0, 40)));

  const moved = path.join(dir, 'moved.pdf');
  const move = ok(await cli(['pages', 'move', smoke, '-p', '4', '--to', '1', '-o', moved]));
  assert.deepEqual(move.order, [4, 1, 2, 3]);
  assert.match(pdfinfo(moved, { first: 1 }).text, /Page +1 size: +842 x 595/);

  const extracted = path.join(dir, 'extracted.pdf');
  ok(await cli(['pages', 'extract', smoke, '-p', '3,1', '-o', extracted]));
  assert.equal(pdfinfo(extracted).pages, 2);
  assert.match(pdftotext(extracted, { first: 1, last: 1 }), /Appendix A/);
  assert.match(pdftotext(extracted, { first: 2, last: 2 }), /Hillside Road/);

  const split = ok(await cli(['pages', 'split', smoke, '--ranges', '1-2;3-', '-o', path.join(dir, 'parts') + '/']));
  assert.deepEqual(split.outputs.map((item) => [path.basename(item.path), pdfinfo(item.path).pages]), [['smoke-1.pdf', 2], ['smoke-2.pdf', 2]]);
  assert.deepEqual(readdirSync(path.join(dir, 'parts')).sort(), ['smoke-1.pdf', 'smoke-2.pdf']);
  for (const item of split.outputs) assert.ok(qpdfCheck(item.path));
});

test('merge', { skip }, async (t) => {
  const dir = tempDir(t);
  // The smoke PDF has a form; the engine refuses importing into a form PDF (no cross-document field-tree repair).
  failed(await cli(['merge', smoke, scanned, '-o', path.join(dir, 'refused.pdf')]), 3, 'refused');
  const merged = path.join(dir, 'merged.pdf');
  const result = ok(await cli(['pages', 'merge', scanned, scanned, '-o', merged]));
  assert.equal(result.output.pages, 2);
  assert.ok(qpdfCheck(merged));
  assert.equal(pdfinfo(merged).pages, 2);
});

test('optimize', { skip }, async (t) => {
  const dir = tempDir(t);
  const lossless = path.join(dir, 'lossless.pdf');
  const result = ok(await cli(['optimize', smoke, '-o', lossless]));
  assert.ok(result.outputBytes <= result.inputBytes);
  assert.ok(qpdfCheck(lossless));
  assert.equal(pdfinfo(lossless).pages, 4);
  assert.equal(flat(pdftotext(lossless)), flat(pdftotext(smoke)));
  const images = path.join(dir, 'images.pdf');
  const imageResult = ok(await cli(['optimize', scanned, '--profile', 'images', '--dpi', '100', '-o', images]));
  assert.ok(imageResult.outputBytes < imageResult.inputBytes);
  assert.ok(qpdfCheck(images));
});

test('protect and unlock', { skip }, async (t) => {
  const dir = tempDir(t);
  const protectedPdf = path.join(dir, 'protected.pdf');
  const ownerFile = path.join(dir, 'owner.txt');
  writeFileSync(ownerFile, 'owner-secret\n');
  ok(await cli(['protect', smoke, '--owner-password-file', ownerFile, '--user-password', 'open-me', '--restrict', 'print,copy', '-o', protectedPdf]));
  assert.ok(qpdfCheck(protectedPdf, 'open-me'));
  const info = pdfinfo(protectedPdf, { password: 'open-me' });
  assert.match(info.fields.Encrypted, /^yes .*print:no.*copy:no/);
  failed(await cli(['info', protectedPdf]), 4, 'password-required');
  failed(await cli(['info', protectedPdf, '--password', 'wrong']), 4, 'wrong-password');
  assert.equal(ok(await cli(['info', protectedPdf, '--password', 'open-me'])).pageCount, 4);
  const unlocked = path.join(dir, 'unlocked.pdf');
  ok(await cli(['unlock', protectedPdf, '--password', 'open-me', '-o', unlocked]));
  assert.ok(qpdfCheck(unlocked));
  assert.equal(pdfinfo(unlocked).fields.Encrypted, 'no');
  assert.equal(flat(pdftotext(unlocked)), flat(pdftotext(smoke)));
});

test('metadata', { skip }, async (t) => {
  const dir = tempDir(t);
  assert.equal(ok(await cli(['metadata', smoke])).metadata.title, 'Site survey report');
  const changed = path.join(dir, 'changed.pdf');
  ok(await cli(['metadata', smoke, '--set', 'title=Vermessung Bergweg', '--set', 'author=Flo Ä', '-o', changed]));
  assert.ok(qpdfCheck(changed));
  assert.equal(pdfinfo(changed).fields.Title, 'Vermessung Bergweg');
  assert.equal(pdfinfo(changed).fields.Author, 'Flo Ä');
  const stripped = path.join(dir, 'stripped.pdf');
  ok(await cli(['metadata', smoke, '--strip', '-o', stripped]));
  assert.equal(pdfinfo(stripped).fields.Title, undefined);
  failed(await cli(['metadata', smoke, '--set', 'colour=red', '-o', path.join(dir, 'x.pdf')]), 2, 'bad-argument');
});

test('usage errors', { skip: setupMissing || false }, async () => {
  failed(await cli(['frobnicate']), 2, 'bad-argument');
  failed(await cli(['redact', smoke, '--term', 'x']), 2, 'bad-argument');
  failed(await cli(['info', path.join(path.dirname(smoke), 'make-smoke-pdf.mjs')]), 4, 'not-pdf');
});
