#!/usr/bin/env node
// Writes smoke.pdf: four pages with headings, body text, tables, vector shapes and a form field — enough for the
// web smoke test and for the screenshots on bergwork.app. Regenerate with `node scripts/fixtures/make-smoke-pdf.mjs`.
import { writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const doc = await PDFDocument.create();
doc.setTitle('Site survey report');
doc.setCreationDate(new Date('2026-10-01T09:00:00Z'));
doc.setModificationDate(new Date('2026-10-01T09:00:00Z'));
const regular = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const ink = rgb(0.11, 0.1, 0.09), muted = rgb(0.42, 0.4, 0.38), red = rgb(0.84, 0.25, 0.2), line = rgb(0.85, 0.83, 0.8);

const body = 'The survey covers the plot boundary, the existing building and the access road. Heights are given above '
  + 'sea level, distances in metres. Points marked in red were checked twice on site.';
function wrap(text, width, font, size) {
  const lines = []; let current = '';
  for (const word of text.split(' ')) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width) { lines.push(current); current = word; } else current = next;
  }
  return [...lines, current];
}

const page = doc.addPage([595, 842]);
page.drawRectangle({ x: 0, y: 792, width: 595, height: 50, color: ink });
page.drawText('Site survey report', { x: 48, y: 810, size: 18, font: bold, color: rgb(1, 1, 1) });
page.drawText('Plot 14, Hillside Road', { x: 48, y: 750, size: 24, font: bold, color: ink });
page.drawText('Survey date 1 October 2026 · Project 2026-117', { x: 48, y: 728, size: 10, font: regular, color: muted });
wrap(body, 499, regular, 11).forEach((text, index) => page.drawText(text, { x: 48, y: 696 - index * 16, size: 11, font: regular, color: ink }));

const rows = [['Point', 'East', 'North', 'Height'], ['P1', '512 340.12', '5 401 220.48', '412.31'], ['P2', '512 362.80', '5 401 231.07', '412.88'],
  ['P3', '512 371.45', '5 401 205.66', '411.94'], ['P4', '512 349.02', '5 401 196.30', '411.52']];
rows.forEach((row, r) => {
  const y = 610 - r * 22;
  if (r) page.drawLine({ start: { x: 48, y: y + 16 }, end: { x: 547, y: y + 16 }, thickness: 0.5, color: line });
  row.forEach((cell, c) => page.drawText(cell, { x: 48 + c * 125, y, size: 10, font: r ? regular : bold, color: r === 2 && c === 0 ? red : ink }));
});

// Plan sketch: plot outline, building and the checked points.
page.drawRectangle({ x: 48, y: 210, width: 499, height: 250, borderColor: line, borderWidth: 1 });
const corners = [[90, 240], [470, 220], [500, 410], [120, 430]];
corners.forEach((start, index) => {
  const end = corners[(index + 1) % corners.length];
  page.drawLine({ start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, thickness: 1.5, color: ink });
});
page.drawRectangle({ x: 230, y: 300, width: 120, height: 80, color: rgb(0.93, 0.91, 0.88), borderColor: ink, borderWidth: 1 });
corners.forEach(([x, y], index) => {
  page.drawCircle({ x, y, size: 4, color: index === 1 ? red : ink });
});
page.drawText('Existing building', { x: 245, y: 336, size: 9, font: regular, color: muted });

// Contact details: the kind of personal data a redaction removes before the report goes out.
page.drawText('Site contact: Maria Keller, +49 7121 555 0183, maria.keller@example.com', { x: 48, y: 180, size: 10, font: regular, color: ink });

const form = doc.getForm();
page.drawText('Checked by', { x: 48, y: 150, size: 10, font: bold, color: ink });
const field = form.createTextField('checked_by');
field.addToPage(page, { x: 130, y: 140, width: 200, height: 22, borderColor: line });

const second = doc.addPage([595, 842]);
second.drawText('Notes', { x: 48, y: 780, size: 20, font: bold, color: ink });
wrap(`${body} ${body}`, 499, regular, 11).forEach((text, index) => second.drawText(text, { x: 48, y: 750 - index * 16, size: 11, font: regular, color: ink }));

const third = doc.addPage([595, 842]);
third.drawText('Appendix A · Sections', { x: 48, y: 780, size: 20, font: bold, color: ink });
for (let i = 0; i < 3; i += 1) {
  const top = 720 - i * 220;
  third.drawText(`Section ${String.fromCharCode(65 + i)}–${String.fromCharCode(65 + i)}'`, { x: 48, y: top, size: 11, font: bold, color: ink });
  const ground = [[48, top - 150], [160, top - 120], [300, top - 135], [420, top - 95], [547, top - 110]];
  ground.slice(1).forEach((point, index) => third.drawLine({
    start: { x: ground[index][0], y: ground[index][1] }, end: { x: point[0], y: point[1] }, thickness: 1.5, color: ink,
  }));
  third.drawRectangle({ x: 230 + i * 20, y: top - 128, width: 110, height: 70, borderColor: ink, borderWidth: 1, color: rgb(0.93, 0.91, 0.88) });
  third.drawLine({ start: { x: 48, y: top - 40 }, end: { x: 547, y: top - 40 }, thickness: 0.5, color: line, dashArray: [4, 3] });
  third.drawText(`${412 + i}.00`, { x: 500, y: top - 36, size: 8, font: regular, color: muted });
}

const fourth = doc.addPage([842, 595]);
fourth.drawText('Appendix B · Point list', { x: 48, y: 540, size: 20, font: bold, color: ink });
const header = ['Point', 'East', 'North', 'Height', 'Code', 'Checked'];
for (let r = 0; r < 18; r += 1) {
  const y = 500 - r * 24;
  const row = r === 0 ? header : [`P${r}`, `512 ${300 + r * 7}.${(r * 13) % 100}`, `5 401 ${180 + r * 5}.${(r * 29) % 100}`, `${(411 + r * 0.07).toFixed(2)}`, r % 3 ? 'BOUNDARY' : 'BUILDING', r % 4 ? 'yes' : 'twice'];
  if (r) fourth.drawLine({ start: { x: 48, y: y + 16 }, end: { x: 794, y: y + 16 }, thickness: 0.5, color: line });
  row.forEach((cell, c) => fourth.drawText(cell, { x: 48 + c * 125, y, size: 10, font: r ? regular : bold, color: r && cell === 'twice' ? red : ink }));
}

await writeFile(new URL('./smoke.pdf', import.meta.url), await doc.save({ useObjectStreams: false }));
console.log('smoke.pdf written');
