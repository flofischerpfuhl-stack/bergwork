#!/usr/bin/env node
// The same idea as the browser walks, one layer down and without a browser: random rich-text documents, random chains of
// edits (character formatting, colour, paragraph formatting, typing over a selection, plain-text reconciliation, opacity,
// whole-font replacement) and random commands through `createPdfCommand`, thousands of sequences per minute. The editor
// code is the vendored build itself; nothing here is a copy of it except `Model`, a deliberately naive per-character
// re-implementation that every result is compared with.
//
//   node apps/pdf/tests/fuzz/run-commands.mjs [--seed N] [--seconds N] [--out dir] [--max-ops 10]
//   node apps/pdf/tests/fuzz/run-commands.mjs --replay found/<family>.json
//
// Oracles (none of them knows a scenario):
//  - a valid edit never throws; a refused one throws one of the editor's own errors, never a runtime crash (`undefined`...)
//  - the result is canonical: creating it again gives the same document, runs tile the text on grapheme boundaries, merged
//  - the result equals the naive per-character model
//  - the document goes through `createPdfCommand` as TEXT_REPLACE / TEXT_BLOCK_REPLACE, the command survives the journal's
//    JSON round trip and `richTextDocumentInputMatchesCanonical`
//  - every command type: a payload that the validators accept is stable under canonicalSerialize and a JSON round trip,
//    a refused one is refused with the editor's own message
//  - text an edit was given raw (CR, CRLF) is not a command text of its own: a caller that sends the raw string next to the
//    canonical document is refused ("trap" families, reported as such)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_RECORDER, extractThrowSites, throwCoverage, throwCoverageLines } from '../lib/throw-sites.mjs';
import { recordErrorsInNode } from '../lib/throw-sites.mjs';

const testsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.dirname(testsDir);
const srcDir = path.join(appDir, 'editor', 'vendor', 'build', 'src');
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
const seed = Number(arg('--seed', Date.now() % 1_000_000));
const seconds = Number(arg('--seconds', 60));
const maxOps = Number(arg('--max-ops', 10));
const outDir = path.resolve(arg('--out') || path.join(testsDir, '.out', `fuzz-${seed}-${Date.now()}`));
void ERROR_RECORDER;
const thrown = recordErrorsInNode();
const observations = new Set();

const load = file => import(path.join(srcDir, 'pdf-editor', file));
const rich = await load('model/rich-text-document.js');
const { richTextDocumentWithOpacity, richTextOpacityState } = await load('model/rich-text-opacity.js');
const { replaceRichTextDocumentWholeFont } = await load('model/rich-text-whole-font.js');
const { CommandType, createPdfCommand, createPdfTransaction, canonicalSerialize } = await load('model/commands.js');
const { base14RichResources, canonicalBase14RichFrameMetadata } = await load('text/base14-rich-frame.js');
const projection = await load('model/rich-text-frame-projection.js');
const autofit = await load('model/text-autofit-materialization.js');

function makeRng(start) {
  let state = start >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (rng, low, high) => low + Math.floor(rng() * (high - low + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const hex = (rng, count) => Array.from({ length: count }, () => Math.floor(rng() * 16).toString(16)).join('');
const stable = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1))) : item));
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemeEdges = text => [...new Set([0, ...[...segmenter.segment(text)].map(item => item.index + item.segment.length)])];

// ---------------------------------------------------------------------------------------------------------------- generating

const PIECES = ['a', 'b', 'Hello', ' ', ' ', 'wor', 'ld', '12', 'é', 'é', 'ß', 'Ünï', '—', '"', '日本', '😀', '👨‍👩‍👧', '🇩🇪', '\n', '\n', 'ffi', 'W', '(', '%', '€', '\t', ' '];
const randomText = (rng, max = 14) => Array.from({ length: between(rng, 0, max) }, () => pick(rng, PIECES)).join('');

function randomResources(rng) {
  const mode = pick(rng, ['base14', 'base14', 'embedded', 'mixed']);
  const resources = [];
  if (mode !== 'embedded') {
    const all = base14RichResources();
    for (const resource of all.filter(() => rng() < 0.4).slice(0, 5)) resources.push({ ...resource });
    if (!resources.length) resources.push({ ...pick(rng, all) });
  }
  if (mode !== 'base14') {
    for (let index = 0; index < between(rng, 1, 3); index += 1) {
      resources.push({ resourceId: hex(rng, 64), kind: 'embedded', family: `Face ${index} ${pick(rng, ['Sans', 'Serif', 'Mono', 'Ünï'])}`,
        weight: pick(rng, ['100', '300', '400', '500', '700', '900']), style: pick(rng, ['normal', 'italic', 'oblique']) });
    }
  }
  return resources;
}
const styleOf = (resource, rng, decoration = {}) => ({
  resourceId: resource.resourceId, family: resource.family, weight: resource.weight, style: resource.style,
  fontSize: pick(rng, [6, 8, 9.96, 10, 11, 12, 14, 18, 24, 36, 72, 0.5, 100.25]),
  color: `#${hex(rng, 6)}${pick(rng, ['ff', 'ff', '80', '00', hex(rng, 2)])}`,
  decoration,
});

function randomDocument(rng) {
  const resources = randomResources(rng);
  const canonicalText = randomText(rng).replace(/\r/gu, '');
  const defaultStyle = styleOf(pick(rng, resources), rng, { underline: rng() < 0.2, strike: rng() < 0.2 });
  const edges = graphemeEdges(canonicalText);
  const runs = [];
  let cursor = 0;
  while (cursor < canonicalText.length && rng() < 0.85) {
    const startIndex = edges.findIndex(edge => edge >= cursor);
    const from = edges[Math.min(edges.length - 1, startIndex + between(rng, 0, 2))];
    const to = edges[Math.min(edges.length - 1, edges.indexOf(from) + between(rng, 1, 4))];
    if (to > from) runs.push({ start: from, end: to, style: styleOf(pick(rng, resources), rng, { underline: rng() < 0.3, strike: rng() < 0.2 }) });
    cursor = Math.max(to, from + 1);
  }
  const bounds = [];
  let start = 0;
  for (let index = 0; index <= canonicalText.length; index += 1) {
    if (index === canonicalText.length || canonicalText[index] === '\n') { bounds.push({ start, end: index }); start = index + 1; }
  }
  const paragraphs = rng() < 0.5 ? undefined : bounds.map(bound => ({ ...bound, style: rng() < 0.5 ? {} : randomParagraphPatch(rng) }));
  return {
    // The text a caller hands in may use CRLF; the offsets above address the canonical text.
    text: rng() < 0.15 ? canonicalText.replace(/\n/gu, '\r\n') : canonicalText,
    fontResources: resources,
    defaultCharacterStyle: defaultStyle,
    defaultParagraphStyle: rng() < 0.5 ? undefined : randomParagraphPatch(rng),
    runs: canonicalText.length ? runs : undefined,
    paragraphs,
  };
}

function randomParagraphPatch(rng) {
  const patch = {};
  if (rng() < 0.5) patch.alignment = pick(rng, ['start', 'center', 'end', 'justify']);
  if (rng() < 0.4) patch.lineHeight = pick(rng, [1, 1.15, 1.2, 1.5, 2, 0.8]);
  if (rng() < 0.3) patch.spaceBefore = pick(rng, [0, 4, 12.5]);
  if (rng() < 0.3) patch.spaceAfter = pick(rng, [0, 4, 12.5]);
  if (rng() < 0.3) patch.indentStart = pick(rng, [0, 18, 36]);
  if (rng() < 0.2) patch.firstLineIndent = pick(rng, [-18, 0, 18]);
  if (rng() < 0.3) patch.list = rng() < 0.3 ? null : { type: pick(rng, ['ordered', 'unordered']), level: between(rng, 0, 3) };
  return patch;
}

/** An operation as data: selections are fractions of the text (snapped to grapheme edges when applied), faces are indexes. */
function randomOp(rng) {
  const kind = pick(rng, ['format', 'format', 'format', 'decoration', 'decoration', 'color', 'size', 'face', 'paragraph', 'type', 'type', 'plain', 'plain-explicit', 'opacity', 'whole-font', 'journal', 'command', 'command-raw']);
  const op = { kind, a: rng(), b: rng() };
  switch (kind) {
    case 'decoration': op.decoration = { [pick(rng, ['underline', 'strike'])]: rng() < 0.7 }; if (rng() < 0.3) op.decoration.strike = rng() < 0.5; break;
    case 'color': op.rgb = `#${hex(rng, 6)}`; break;
    case 'size': op.fontSize = pick(rng, [6, 9, 10, 12, 18, 33.3, 144]); break;
    case 'face': op.face = rng(); break;
    case 'format': op.face = rng(); op.fontSize = pick(rng, [undefined, 9, 24]); op.decoration = rng() < 0.5 ? { underline: rng() < 0.5 } : undefined; op.color = rng() < 0.3 ? `#${hex(rng, 6)}${hex(rng, 2)}` : undefined; break;
    case 'paragraph': op.patch = randomParagraphPatch(rng); break;
    case 'type': op.text = randomText(rng, 5); op.typing = rng() < 0.25 ? { decoration: { underline: rng() < 0.5 }, face: rng() } : null; op.raw = rng() < 0.2 ? pick(rng, ['\r\n', '\r', 'a\r\nb', ' ']) : null; break;
    case 'plain': op.text = randomText(rng, 8); break;
    case 'plain-explicit': op.text = randomText(rng, 4); break;
    case 'opacity': op.opacity = pick(rng, [0, 1, 0.5, 0.25, 0.333, rng()]); break;
    case 'whole-font': op.id = hex(rng, 64); op.family = 'Whole Font'; op.weight = pick(rng, ['400', '700']); op.style = pick(rng, ['normal', 'italic']); break;
    default: break;
  }
  return op;
}

// ---------------------------------------------------------------------------------------------------------- the naive model

/** Per UTF-16 unit style, nothing else. Written from the meaning of the operations, not from the editor's code. */
class Model {
  constructor(doc) {
    this.text = doc.text;
    this.units = Array.from({ length: doc.text.length }, (_, index) => {
      const run = doc.runs.find(item => item.start <= index && index < item.end);
      return stable(run ? run.style : doc.defaultCharacterStyle);
    });
    this.defaultStyle = stable(doc.defaultCharacterStyle);
  }

  styleAt(offset) {
    if (!this.text.length) return this.defaultStyle;
    return this.units[offset === this.text.length ? offset - 1 : offset];
  }

  format(start, end, patch) {
    for (let index = start; index < end; index += 1) {
      const style = JSON.parse(this.units[index]);
      this.units[index] = stable({ ...style, ...patch, decoration: { ...style.decoration, ...(patch.decoration || {}) } });
    }
  }

  replace(start, end, inserted, typing) {
    const basis = JSON.parse(start === end ? this.styleAt(start) : this.styleAt(Math.max(start, end - 1)));
    const insertion = stable({ ...basis, ...(typing || {}), decoration: { ...basis.decoration, ...(typing?.decoration || {}) } });
    if (inserted === this.text.slice(start, end)) {
      if (typing && start !== end) this.format(start, end, typing);
      return;
    }
    this.text = this.text.slice(0, start) + inserted + this.text.slice(end);
    this.units.splice(start, end - start, ...Array.from({ length: inserted.length }, () => insertion));
  }
}

const unitStyles = doc => {
  const out = [];
  for (let index = 0; index < doc.text.length; index += 1) {
    out.push(stable(doc.runs.find(run => run.start <= index && index < run.end)?.style || doc.defaultCharacterStyle));
  }
  return out;
};

// -------------------------------------------------------------------------------------------------------------- the oracles

class Finding extends Error {
  constructor(signature, detail) { super(detail); this.signature = signature; this.detail = detail; }
}

const RUNTIME_CRASH = /Cannot read propert|Cannot destructure|is not a function|is not iterable|is not defined|Maximum call stack|Invalid array length|of undefined|of null/u;
const OWN_ERRORS = new Set(['TypeError', 'RangeError', 'Error']);

/** An edit that must work. */
function mustWork(label, action) {
  try {
    return action();
  } catch (error) {
    if (error instanceof Finding) throw error;
    const crash = !OWN_ERRORS.has(error?.name) || RUNTIME_CRASH.test(String(error?.message));
    throw new Finding(`${crash ? 'runtime crash' : 'refused valid edit'} in ${label}: ${String(error?.message).replace(/\d+/gu, '#').slice(0, 110)}`, String(error?.stack || error).split('\n').slice(0, 3).join(' | '));
  }
}

function checkCanonical(label, doc) {
  const again = mustWork(`${label} (canonical again)`, () => rich.createRichTextDocument(doc));
  const { version, ...bare } = doc;
  void version;
  if (stable(again) !== stable(bare)) throw new Finding(`not canonical after ${label}`, 'createRichTextDocument(result) differs from result');
  let cursor = 0;
  const edges = new Set(graphemeEdges(doc.text));
  for (const run of doc.runs) {
    if (run.start !== cursor || run.end <= run.start || !edges.has(run.start) || !edges.has(run.end)) {
      throw new Finding(`runs do not tile the text after ${label}`, `run ${run.start}-${run.end} at ${cursor} in ${doc.text.length} units`);
    }
    cursor = run.end;
  }
  if (doc.text.length && cursor !== doc.text.length) throw new Finding(`runs do not cover the text after ${label}`, `${cursor} of ${doc.text.length}`);
  const lines = doc.text.split('\n');
  if (doc.paragraphs.length !== lines.length) throw new Finding(`paragraph count differs from the lines after ${label}`, `${doc.paragraphs.length} vs ${lines.length}`);
  for (let index = 1; index < doc.runs.length; index += 1) {
    if (stable(doc.runs[index].style) === stable(doc.runs[index - 1].style)) throw new Finding(`neighbouring runs with the same style after ${label}`, `at ${doc.runs[index].start}`);
  }
}

function checkCommand(label, doc) {
  const payload = { text: doc.text, richTextDocument: { version: 1, ...doc } };
  for (const type of [CommandType.TEXT_REPLACE, CommandType.TEXT_BLOCK_REPLACE]) {
    const command = mustWork(`${label} (${type})`, () => createPdfCommand({ commandId: 'c1', type, targetId: 't1', payload }));
    const serialized = canonicalSerialize(command);
    const journal = JSON.parse(serialized);
    const again = mustWork(`${label} (journal round trip of ${type})`, () => createPdfCommand({ commandId: 'c1', type, targetId: 't1', payload: journal.payload }));
    if (canonicalSerialize(again) !== serialized) throw new Finding(`command not stable under the journal round trip after ${label}`, type);
    // A strict verifier compares with JSON.stringify, so it depends on key order; canonicalSerialize sorts the keys.
    if (!rich.richTextDocumentInputMatchesCanonical(journal.payload.richTextDocument, { version: 1, ...rich.createRichTextDocument(journal.payload.richTextDocument) })) {
      observations.add('richTextDocumentInputMatchesCanonical is false for a rich document copied through canonicalSerialize (sorted keys): the strict verifier depends on key order');
    }
  }
}

function snap(edges, fraction) {
  return edges[Math.min(edges.length - 1, Math.floor(fraction * edges.length))];
}

function selectionFor(doc, op) {
  const edges = graphemeEdges(doc.text);
  const first = snap(edges, op.a);
  const second = snap(edges, op.b);
  return { start: Math.min(first, second), end: Math.max(first, second) };
}

function patchFor(doc, op) {
  const resource = doc.fontResources[Math.floor(op.face * doc.fontResources.length)];
  const patch = {};
  if (op.kind === 'format' || op.kind === 'face') Object.assign(patch, { resourceId: resource.resourceId, family: resource.family, weight: resource.weight, style: resource.style });
  if (op.kind === 'size' || op.fontSize) patch.fontSize = op.fontSize;
  if (op.decoration) patch.decoration = op.decoration;
  if (op.color) patch.color = op.color;
  return patch;
}

/** Applies one operation, checks it against the model and returns the next state. */
function applyOp(state, op, trace) {
  const { doc } = state;
  let next = doc;
  switch (op.kind) {
    case 'format': case 'decoration': case 'size': case 'face': {
      const selection = selectionFor(doc, op);
      const patch = patchFor(doc, op);
      trace.push(`format ${selection.start}-${selection.end} with ${stable(patch)}`);
      next = mustWork('applyCharacterFormatting', () => rich.applyCharacterFormatting(doc, selection, patch));
      state.model.format(selection.start, selection.end, patch);
      break;
    }
    case 'color': {
      const selection = selectionFor(doc, op);
      trace.push(`colour ${selection.start}-${selection.end} ${op.rgb}`);
      next = mustWork('applyCharacterRgbFormatting', () => rich.applyCharacterRgbFormatting(doc, selection, op.rgb));
      for (let index = selection.start; index < selection.end; index += 1) {
        const style = JSON.parse(state.model.units[index]);
        state.model.units[index] = stable({ ...style, color: `${op.rgb}${style.color.slice(7)}` });
      }
      break;
    }
    case 'paragraph': {
      const selection = selectionFor(doc, op);
      trace.push(`paragraph ${selection.start}-${selection.end} ${stable(op.patch)}`);
      next = mustWork('applyParagraphFormatting', () => rich.applyParagraphFormatting(doc, selection, op.patch));
      break;
    }
    case 'type': {
      const selection = selectionFor(doc, op);
      const typing = op.typing ? { ...(op.typing.decoration ? { decoration: op.typing.decoration } : {}),
        ...(() => { const resource = doc.fontResources[Math.floor(op.typing.face * doc.fontResources.length)]; return { resourceId: resource.resourceId, family: resource.family, weight: resource.weight, style: resource.style }; })() } : null;
      const inserted = op.raw ?? op.text;
      trace.push(`replace ${selection.start}-${selection.end} with ${JSON.stringify(inserted)}${typing ? ` typing ${stable(typing)}` : ''}`);
      const normalized = inserted.replace(/\r\n?/gu, '\n');
      try {
        next = mustWork('replaceRichText', () => rich.replaceRichText(doc, selection, inserted, typing));
      } catch (error) {
        // A lone surrogate half cannot come out of the grapheme walk above; any other refusal is a finding.
        throw error;
      }
      state.model.replace(selection.start, selection.end, normalized, typing);
      if (op.raw != null && rich.createRichTextDocument(doc).text.slice(0, selection.start) + op.raw + doc.text.slice(selection.end) !== next.text) {
        state.trap = `raw text ${JSON.stringify(op.raw)} spliced into the old text is not the canonical text`;
      }
      break;
    }
    case 'plain': {
      trace.push(`plain projection ${JSON.stringify(op.text)}`);
      next = mustWork('replaceRichTextPlainProjection', () => rich.replaceRichTextPlainProjection(doc, op.text));
      if (next.text !== op.text.replace(/\r\n?/gu, '\n')) throw new Finding('plain projection result text differs from the given text', `${JSON.stringify(next.text)} vs ${JSON.stringify(op.text)}`);
      // The model: reconcile by the longest common prefix/suffix; unchanged ends keep their styles.
      const before = state.model.text;
      let prefix = 0;
      while (prefix < before.length && prefix < next.text.length && before[prefix] === next.text[prefix]) prefix += 1;
      // The shared start must also be a grapheme boundary of both texts (two emoji share their first surrogate).
      const beforeEdges = new Set(graphemeEdges(before));
      const afterEdges = new Set(graphemeEdges(next.text));
      while (!beforeEdges.has(prefix) || !afterEdges.has(prefix)) prefix -= 1;
      const survivors = [];
      for (let index = 0; index < prefix; index += 1) survivors.push(state.model.units[index]);
      state.plainFrom = prefix;
      state.model.text = next.text;
      state.model.units = next.text.split('').map((_, index) => (index < prefix ? survivors[index] : unitStyles(next)[index]));
      break;
    }
    case 'plain-explicit': {
      const selection = selectionFor(doc, op);
      const text = doc.text.slice(0, selection.start) + op.text + doc.text.slice(selection.end);
      trace.push(`plain projection with the edit ${selection.start}-${selection.end} -> ${JSON.stringify(op.text)}`);
      next = mustWork('replaceRichTextPlainProjection (explicit edit)', () => rich.replaceRichTextPlainProjection(doc, text, { ...selection, replacement: op.text }));
      state.model.replace(selection.start, selection.end, op.text.replace(/\r\n?/gu, '\n'), null);
      break;
    }
    case 'opacity': {
      trace.push(`opacity ${op.opacity}`);
      next = mustWork('richTextDocumentWithOpacity', () => richTextDocumentWithOpacity(doc, op.opacity));
      const alpha = Math.round(op.opacity * 255).toString(16).padStart(2, '0');
      const withAlpha = text => { const style = JSON.parse(text); return stable({ ...style, color: `${style.color.slice(0, 7)}${alpha}` }); };
      state.model.units = state.model.units.map(withAlpha);
      state.model.defaultStyle = withAlpha(state.model.defaultStyle);
      const reading = mustWork('richTextOpacityState', () => richTextOpacityState(next));
      if (reading.mixed || Math.abs(reading.value - Math.round(op.opacity * 255) / 255) > 1e-9) throw new Finding('opacity read back differs from the opacity set', `${stable(reading)} vs ${op.opacity}`);
      break;
    }
    case 'whole-font': {
      const resource = { resourceId: op.id, kind: 'embedded', family: op.family, weight: op.weight, style: op.style };
      trace.push(`replace the font of the whole document with ${op.family} ${op.weight} ${op.style}`);
      next = mustWork('replaceRichTextDocumentWholeFont', () => rich.createRichTextDocument(replaceRichTextDocumentWholeFont(doc, resource)));
      const whole = text => stable({ ...JSON.parse(text), resourceId: resource.resourceId, family: resource.family, weight: resource.weight, style: resource.style });
      state.model.units = state.model.units.map(whole);
      state.model.defaultStyle = whole(state.model.defaultStyle);
      break;
    }
    case 'journal': {
      trace.push('JSON round trip of the document (as the journal stores it)');
      const copy = JSON.parse(JSON.stringify({ version: 1, ...doc }));
      if (!rich.richTextDocumentInputMatchesCanonical(copy, { version: 1, ...mustWork('journal copy', () => rich.createRichTextDocument(copy)) })) {
        throw new Finding('journal copy does not match its canonical form', 'richTextDocumentInputMatchesCanonical is false');
      }
      return;
    }
    case 'command': case 'command-raw': {
      trace.push(op.kind === 'command' ? 'send the document as a command' : 'send the document with the raw spliced text');
      checkCommand('chain', doc);
      return;
    }
    default: throw new Error(`unknown op ${op.kind}`);
  }
  // The text of a formatting edit does not change.
  if (!['type', 'plain', 'plain-explicit'].includes(op.kind) && next.text !== doc.text) throw new Finding(`${op.kind} changed the text`, `${JSON.stringify(doc.text)} -> ${JSON.stringify(next.text)}`);
  checkCanonical(op.kind, next);
  if (next.text !== state.model.text) throw new Finding(`${op.kind}: text differs from the model`, `${JSON.stringify(next.text)} vs ${JSON.stringify(state.model.text)}`);
  const actual = unitStyles(next);
  const wrong = actual.findIndex((style, index) => style !== state.model.units[index]);
  if (wrong >= 0) throw new Finding(`${op.kind}: character style differs from the model`, `unit ${wrong}: ${actual[wrong]} vs ${state.model.units[wrong]}`);
  checkCommand(op.kind, next);
  state.doc = next;
}

function runSequence(sequence) {
  const trace = [];
  const state = {};
  try {
    state.doc = mustWork('createRichTextDocument', () => rich.createRichTextDocument(sequence.doc));
    state.model = new Model(state.doc);
    checkCanonical('create', state.doc);
    checkCommand('create', state.doc);
    for (const op of sequence.ops) {
      applyOp(state, op, trace);
      if (state.trap) { trace.push(`TRAP: ${state.trap}`); }
    }
  } catch (error) {
    if (error instanceof Finding) return { finding: error, trace, step: trace.length };
    throw error;
  }
  return { finding: null, trace, trap: state.trap || null };
}

// ----------------------------------------------------------------------------------------------- the command layer itself

const COMMAND_PAYLOADS = rng => {
  const sha = hex(rng, 64);
  const finite = () => pick(rng, [0, 1, -1, 12.5, 595.28, 1e6]);
  const sometimes = (valid, broken) => (rng() < 0.8 ? valid : broken);
  const index = () => sometimes(between(rng, 0, 9), pick(rng, [-1, 1.5, '3', null, NaN, Infinity]));
  const matrix = () => sometimes([1, 0, 0, 1, finite(), finite()], pick(rng, [[1, 2, 3], [1, 0, 0, 1, NaN, 0], 'matrix', null, [1, 0, 0, 1, 0, Infinity]]));
  const id = () => sometimes(`id-${hex(rng, 4)}`, pick(rng, ['', '  ', null, 5, undefined]));
  return {
    [CommandType.OBJECT_TRANSFORM]: () => ({ matrix: rng() < 0.5 ? matrix() : undefined, bounds: rng() < 0.5 ? sometimes({ left: 0, bottom: 0, right: 10, top: 10 }, { left: 0, bottom: NaN, right: 10 }) : undefined }),
    [CommandType.OBJECT_REORDER]: () => ({ pageIndex: index(), destinationIndex: index() }),
    [CommandType.OBJECT_DUPLICATE]: () => ({ pageIndex: index(), newStableId: id(), dx: finite(), dy: sometimes(finite(), NaN), destinationPageIndex: rng() < 0.3 ? index() : undefined, transform: rng() < 0.3 ? matrix() : undefined }),
    [CommandType.OBJECT_PASTE]: () => ({ resourceHash: sometimes(sha, 'xyz'), sourceStableId: id(), pageIndex: index(), transform: sometimes([1, 0, 0, 1, 5, 5], [0, 0, 0, 0, 1, 1]), sourceText: rng() < 0.3 ? sometimes('text', 5) : undefined }),
    [CommandType.PAGE_ROTATE]: () => ({ pageIndex: index(), rotation: sometimes(between(rng, 0, 3), pick(rng, [4, -1, 1.5, '1'])) }),
    [CommandType.PAGE_MOVE]: () => ({ destinationIndex: index() }),
    [CommandType.PAGE_NEW]: () => ({ pageIndex: index(), width: sometimes(595, pick(rng, [0, -5, NaN])), height: sometimes(842, 0) }),
    [CommandType.PAGE_DUPLICATE]: () => ({ pageIndex: index(), newPageId: id() }),
    [CommandType.PAGE_IMPORT]: () => { const count = between(rng, 0, 3); return { pageIndex: index(), resourceHash: sometimes(sha, 'x'), sourcePageIndices: Array.from({ length: count }, () => index()), pageIds: Array.from({ length: sometimes(count, count + 1) }, () => `p${hex(rng, 3)}`) }; },
    [CommandType.OCR_INSERT]: () => ({ pageIndex: index(), fontResourceHash: sometimes(sha, ''), words: Array.from({ length: between(rng, 0, 3) }, () => ({ text: sometimes('word', ' '), basis: sometimes({ origin: [0, 0], baseline: [10, 0], ascent: [0, 8] }, { origin: [0, 0], baseline: [0, 0], ascent: [0, 0] }) })) }),
    [CommandType.DOCUMENT_RESTORE_SNAPSHOT]: () => ({ resourceHash: sometimes(sha, 'nope') }),
    [CommandType.OBJECT_SET_PROPERTIES]: () => ({ properties: { opacity: finite(), nested: { list: [1, 'a', true, null] } }, bad: rng() < 0.15 ? pick(rng, [NaN, undefined, () => 1, 10n]) : 1 }),
    [CommandType.TEXT_REPLACE]: () => ({ text: randomText(rng, 5), richTextDocument: rng() < 0.4 ? { version: sometimes(1, 2), text: randomText(rng, 5), fontResources: randomResources(rng), defaultCharacterStyle: styleOf(base14RichResources()[0], rng) } : undefined }),
  };
};

function runCommandCase(rng) {
  const payloads = COMMAND_PAYLOADS(rng);
  const type = pick(rng, Object.keys(payloads));
  const payload = payloads[type]();
  const label = `createPdfCommand(${type})`;
  let command;
  try {
    command = createPdfCommand({ commandId: id(rng), type, targetId: id(rng), payload });
  } catch (error) {
    const crash = !OWN_ERRORS.has(error?.name) || RUNTIME_CRASH.test(String(error?.message));
    if (crash && !/must be a non-empty string|Value is not journal-serializable|payload must be an object/u.test(error?.message)) {
      return { finding: new Finding(`runtime crash in ${label}: ${String(error?.message).replace(/\d+/gu, '#').slice(0, 100)}`, JSON.stringify(payload).slice(0, 300)), trace: [label] };
    }
    return { finding: null, trace: [label] };
  }
  const serialized = canonicalSerialize(command);
  const again = createPdfCommand({ commandId: command.commandId, type, targetId: command.targetId, payload: JSON.parse(serialized).payload });
  if (canonicalSerialize(again) !== serialized) return { finding: new Finding(`${label}: accepted payload is not stable under the journal round trip`, serialized.slice(0, 200)), trace: [label] };
  const transaction = createPdfTransaction({ transactionId: 'x', sessionId: 's', baseRevision: 0, createdAt: 0, commands: [command, createPdfCommand({ commandId: `${command.commandId}b`, type, targetId: command.targetId, payload: command.payload })] });
  if (transaction.commands.length !== 2) return { finding: new Finding('transaction lost a command', ''), trace: [label] };
  return { finding: null, trace: [label] };
}
const id = rng => (rng() < 0.9 ? `i${hex(rng, 5)}` : pick(rng, ['', ' ', undefined]));

// Frames the shell hands to the projections: random, mostly plausible, sometimes forged.
function runFrameCase(rng) {
  const doc = rich.createRichTextDocument(randomDocument(rng));
  const verified = rng() < 0.5;
  const item = {
    textFrame: rng() < 0.8, complexText: rng() < 0.8, nativeTypeName: pick(rng, ['form', 'text', 'Form', 'path']),
    base14Rich: rng() < 0.2 ? true : undefined, richTextCapability: verified ? 'verified-base14-rich-v1' : rng() < 0.1 ? 'forged' : undefined,
    text: rng() < 0.85 ? doc.text : `${doc.text}x`, richTextDocument: rng() < 0.85 ? { version: 1, ...doc } : undefined,
    block: { overflow: pick(rng, ['shrink', 'visible', 'clip']), fontSize: pick(rng, [9, 12, 0, -1, NaN]), minFontSize: pick(rng, [undefined, 4, 8]) },
    fontSize: 12, color: pick(rng, ['#112233', '#11223344', 'red']), uniformTextAppearance: rng() < 0.5, richTextFontResources: rng() < 0.5 ? doc.fontResources : undefined,
  };
  const calls = [
    ['richTextDocumentForVerifiedFrame', () => projection.richTextDocumentForVerifiedFrame(item)],
    ['materializeLegacyTextAutofitForResize', () => autofit.materializeLegacyTextAutofitForResize(item, { block: { x: 1 } })],
    ['legacyTextAutofitPropertyPatch', () => autofit.legacyTextAutofitPropertyPatch(item, item, { text: 'x' })],
    ['richTextInspectorPropertyItem', () => projection.richTextInspectorPropertyItem(item, { text: item.text, richTextDocument: item.richTextDocument })],
    ['canonicalBase14RichFrameMetadata', () => canonicalBase14RichFrameMetadata({ version: 1, frameResourceId: hex(rng, 32), richTextDocument: item.richTextDocument, fontResources: doc.fontResources.map(resource => ({ resourceId: resource.resourceId, baseFont: resource.resourceId.replace('base14:', ''), encoding: 'WinAnsiEncoding' })) })],
  ];
  for (const [name, call] of calls) {
    let result;
    try {
      result = call();
    } catch (error) {
      const own = OWN_ERRORS.has(error?.name) && !RUNTIME_CRASH.test(String(error?.message));
      if (own && name === 'canonicalBase14RichFrameMetadata') continue;
      return { finding: new Finding(`${own ? 'unexpected refusal' : 'runtime crash'} in ${name}: ${String(error?.message).replace(/\d+/gu, '#').slice(0, 100)}`, JSON.stringify(item).slice(0, 200)), trace: [name] };
    }
    const resultDoc = result?.richTextDocument || (name === 'richTextDocumentForVerifiedFrame' ? result : null);
    if (resultDoc && typeof resultDoc.text === 'string') {
      try { checkCanonical(name, resultDoc); checkCommand(name, resultDoc); } catch (error) { if (error instanceof Finding) return { finding: error, trace: [name] }; throw error; }
      if (name === 'richTextDocumentForVerifiedFrame' && resultDoc.text !== String(item.text).replace(/\r\n?/gu, '\n')) {
        return { finding: new Finding('frame projection text differs from the frame text', ''), trace: [name] };
      }
    }
  }
  return { finding: null, trace: ['frame'] };
}

// ------------------------------------------------------------------------------------------------------------------- loop

function shrinkSequence(sequence, signature) {
  let ops = sequence.ops;
  const failsWith = candidate => runSequence({ doc: sequence.doc, ops: candidate }).finding?.signature === signature;
  let parts = 2;
  while (ops.length >= 2) {
    const size = Math.ceil(ops.length / parts);
    let reduced = false;
    for (let part = 0; part < parts && !reduced; part += 1) {
      const complement = ops.filter((_, index) => index < part * size || index >= (part + 1) * size);
      if (complement.length < ops.length && failsWith(complement)) { ops = complement; parts = Math.max(2, parts - 1); reduced = true; }
    }
    if (!reduced) { if (parts >= ops.length) break; parts = Math.min(ops.length, parts * 2); }
  }
  // Shorter text, then fewer runs, while it still fails.
  let doc = sequence.doc;
  const simpler = [
    candidate => ({ ...candidate, runs: undefined, paragraphs: undefined }),
    candidate => ({ ...candidate, paragraphs: undefined }),
    candidate => ({ ...candidate, defaultParagraphStyle: undefined }),
    candidate => ({ ...candidate, fontResources: candidate.fontResources.slice(0, 1), runs: undefined }),
  ];
  for (const simplify of simpler) {
    try {
      const candidate = simplify(doc);
      if (runSequence({ doc: candidate, ops }).finding?.signature === signature) doc = candidate;
    } catch { /* the simplification itself may be invalid */ }
  }
  return { doc, ops };
}

if (arg('--replay')) {
  const data = JSON.parse(await fs.readFile(arg('--replay'), 'utf8'));
  const result = runSequence(data.sequence);
  console.log(result.finding ? `STILL FAILS: ${result.finding.signature}\n${result.trace.map((line, index) => `${index + 1}. ${line}`).join('\n')}` : 'no longer fails');
  process.exit(result.finding ? 1 : 0);
}

await fs.mkdir(path.join(outDir, 'found'), { recursive: true });
const sites = await extractThrowSites(srcDir);
const found = new Map();
const traps = new Map();
const startedAt = Date.now();
const deadline = startedAt + seconds * 1000;
let sequences = 0;
let ops = 0;
let commands = 0;
let frames = 0;
const rng = makeRng(seed);
while (Date.now() < deadline) {
  const roll = rng();
  const caseSeed = Math.floor(rng() * 2 ** 31);
  const local = makeRng(caseSeed);
  let result;
  let sequence = null;
  if (roll < 0.8) {
    sequence = { doc: randomDocument(local), ops: Array.from({ length: between(local, 1, maxOps) }, () => randomOp(local)) };
    result = runSequence(sequence);
    sequences += 1;
    ops += sequence.ops.length;
  } else if (roll < 0.93) {
    result = runCommandCase(local);
    commands += 1;
  } else {
    result = runFrameCase(local);
    frames += 1;
  }
  if (result.trap) {
    const key = result.trap.replace(/".*?"/gu, '"…"');
    traps.set(key, (traps.get(key) || 0) + 1);
  }
  if (!result.finding) continue;
  const { signature } = result.finding;
  const known = found.get(signature);
  if (known) { known.count += 1; continue; }
  const family = { count: 1, detail: result.finding.detail, caseSeed, trace: result.trace };
  found.set(signature, family);
  if (sequence) {
    const small = shrinkSequence(sequence, signature);
    const final = runSequence(small);
    family.trace = final.trace;
    family.originalOps = sequence.ops.length;
    family.file = path.join(outDir, 'found', `${String(found.size).padStart(2, '0')}-${signature.replace(/[^A-Za-z0-9]+/gu, '-').slice(0, 60)}.json`);
    family.minimal = { ops: small.ops.length, textLength: small.doc.text.length };
    await fs.writeFile(family.file, JSON.stringify({ signature, detail: result.finding.detail, caseSeed, sequence: small, readable: final.trace }, null, 1));
  }
  console.log(`NEW ${signature}`);
}

const minutes = (Date.now() - startedAt) / 60_000;
const coverage = throwCoverage(sites, thrown);
const lines = [
  `# Command-layer fuzz: seed ${seed}`, '',
  `${sequences} edit sequences (${ops} edits), ${commands} command payloads and ${frames} frame projections in ${minutes.toFixed(2)} min: ` +
    `${Math.round((sequences + commands + frames) / minutes)} cases/min, ${Math.round(sequences / minutes)} sequences/min.`, '',
  '## Failure families', '',
];
if (!found.size) lines.push('None found.');
for (const [signature, family] of [...found].sort((left, right) => right[1].count - left[1].count)) {
  lines.push(`### ${signature}`, '', `${family.count}×. ${String(family.detail).slice(0, 220)}`);
  if (family.file) lines.push(`Shrunk from ${family.originalOps} to ${family.minimal.ops} edit(s), text ${family.minimal.textLength} unit(s). Replay: \`node apps/pdf/tests/fuzz/run-commands.mjs --replay ${family.file}\``);
  lines.push('', ...family.trace.map((line, index) => `${index + 1}. ${line}`), '');
}
if (observations.size) lines.push('## Observations (not counted as failures)', '', ...[...observations].map(text => `- ${text}`), '');
if (traps.size) {
  lines.push('## Traps (a caller that sends the raw string)', '', ...[...traps].map(([text, count]) => `- ${text} (${count}×)`), '');
}
lines.push('## Throw sites', '', ...throwCoverageLines(coverage));
await fs.writeFile(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
await fs.writeFile(path.join(outDir, 'thrown.json'), JSON.stringify(Object.fromEntries(thrown)));
console.log(`fuzz: ${sequences} sequences, ${commands} commands, ${frames} frames in ${minutes.toFixed(2)} min, ${found.size} failure families; ${path.join(outDir, 'summary.md')}`);
process.exitCode = found.size ? 1 : 0;
