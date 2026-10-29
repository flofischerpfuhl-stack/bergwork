// The operations of the CLI and the MCP server, defined once: parameters (CLI flags and MCP input schema are both
// generated from them), how a call maps onto the in-page operation (cli/page/entry.js) and where its outputs go.
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.mjs';

const PROFILES = ['vector', 'images', 'quality', 'balanced', 'small'];
const PROFILE_ALIASES = { lossless: 'vector', 'raster-220': 'quality', 'raster-150': 'balanced', 'raster-105': 'small' };

// Parameter types: path, paths (positional rest), string, strings (repeatable), secret (also --<name>-file), number,
// boolean, enum (values), object (CLI: JSON, @file or - for stdin), keyvalues (CLI: repeated key=value).
const file = { name: 'file', type: 'path', positional: true, required: true, description: 'Input PDF (local path).' };
const password = { name: 'password', type: 'secret', description: 'Password of an encrypted input PDF.' };
const pages = (description = 'Pages, 1-based: "1-3,5", "8-", "last", "odd", "even" or "all" (default all).') => ({ name: 'pages', type: 'string', short: 'p', description });
const output = (description = 'Output PDF path.', required = true) => ({ name: 'output', type: 'path', short: 'o', required, description });
const force = { name: 'force', type: 'boolean', short: 'f', description: 'Overwrite existing output files.' };

function stemOf(target) { return path.basename(target).replace(/\.[^.]+$/u, ''); }

/** Destination for the n-th of several outputs: a pattern with %d, a directory (trailing / or existing), or name-n.ext. */
export function numberedPath(target, n, ext, fallbackStem) {
  if (!target) return path.resolve(`${fallbackStem}-${n}${ext}`);
  if (target.includes('%d')) return path.resolve(target.replaceAll('%d', String(n)));
  const isDir = target.endsWith('/') || target.endsWith(path.sep) || (existsSync(target) && !path.extname(target));
  if (isDir) return path.resolve(target, `${fallbackStem}-${n}${ext}`);
  const extname = path.extname(target) || ext;
  return path.resolve(path.dirname(target), `${stemOf(target)}-${n}${extname}`);
}

async function assertWritable(targets, overwrite) {
  for (const target of targets) {
    if (!overwrite && existsSync(target)) throw new CliError('output-exists', `${target} exists (pass --force to overwrite)`);
  }
}

/** Moves a temporary output into place through a sibling temp file, so a failed copy never leaves half a file. */
async function place(tempFile, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.part-${process.pid}`;
  await fs.copyFile(tempFile, staging);
  await fs.rename(staging, target);
  await fs.rm(tempFile, { force: true });
  return target;
}

// One output PDF: precheck, run, move into place, report the path instead of the temporary name.
async function singleOutput(engine, op, args, params, inputs) {
  const target = path.resolve(args.output);
  await assertWritable([target], args.force);
  const { result, files } = await engine.run(op, params, inputs);
  if (result.output) {
    await place(files.get(result.output.name), target);
    result.output = { path: target, ...withoutName(result.output) };
  }
  return result;
}

const withoutName = ({ name, ...rest }) => rest;
const inputOf = (args) => [{ path: args.file, password: args.password }];

function pageSpec(args) { return args.pages ? String(args.pages) : undefined; }

export const COMMANDS = [
  {
    name: 'info',
    summary: 'Pages, sizes, rotation, text per page, metadata, encryption, forms, signatures.',
    params: [file, password, { name: 'textPages', type: 'number', description: 'Count text characters on the first N pages (default 200).' }],
    run: (engine, args) => engine.run('info', { textPages: args.textPages ?? 200 }, inputOf(args)).then((r) => r.result),
  },
  {
    name: 'text',
    summary: 'Extract the text of pages (PDFium text, or PDF.js like the editor\'s Extract text).',
    params: [file, password, pages(), { name: 'engine', type: 'enum', values: ['pdfium', 'pdfjs'], description: 'Text extractor (default pdfium).' },
      output('Write the text to this file instead of printing it.', false), force],
    async run(engine, args) {
      const { result } = await engine.run('text', { pages: pageSpec(args), engine: args.engine || 'pdfium' }, inputOf(args));
      if (args.output) {
        const target = path.resolve(args.output);
        await assertWritable([target], args.force);
        await fs.writeFile(target, joinPages(result.pages));
        result.output = { path: target };
      }
      return result;
    },
  },
  {
    name: 'render',
    summary: 'Render pages to PNG files.',
    params: [file, password, pages('Pages to render (default 1).'), { name: 'dpi', type: 'number', description: 'Resolution (default 150).' },
      output('PNG path. With several pages: a pattern with %d, a directory, or name.png -> name-<page>.png.'), force],
    async run(engine, args) {
      const spec = pageSpec(args) || '1';
      // Outputs are known only after the page count is; check the obvious collision up front.
      const { result, files } = await engine.run('render', { pages: spec, dpi: args.dpi ?? 150, outPrefix: 'render' }, inputOf(args));
      const single = result.outputs.length === 1 && !args.output.includes('%d') && !args.output.endsWith('/');
      const targets = result.outputs.map((item) => (single ? path.resolve(args.output) : numberedPath(args.output, item.page, '.png', stemOf(args.file))));
      await assertWritable(targets, args.force);
      for (const [index, item] of result.outputs.entries()) {
        await place(files.get(item.name), targets[index]);
        result.outputs[index] = { path: targets[index], ...withoutName(item) };
      }
      return result;
    },
  },
  {
    name: 'ocr',
    summary: 'Recognise text with Tesseract (eng, deu, fra, spa, ita, por); with -o, also add an invisible text layer (Make searchable).',
    params: [file, password, pages(), { name: 'lang', type: 'enum', values: ['eng', 'deu', 'fra', 'spa', 'ita', 'por'], description: 'OCR language (default eng).' },
      output('Write a searchable PDF (the recognised words as an invisible text layer).', false), force],
    async run(engine, args) {
      const params = { pages: pageSpec(args), lang: args.lang || 'eng', layer: Boolean(args.output), out: 'ocr.pdf' };
      if (!args.output) return (await engine.run('ocr', params, inputOf(args))).result;
      return singleOutput(engine, 'ocr', args, params, inputOf(args));
    },
  },
  {
    name: 'redact',
    summary: 'Find terms or a regular expression and redact them: marked, then removed from the page content on save (verified).',
    params: [file, password, { name: 'term', type: 'strings', description: 'Text to redact (repeatable). Whitespace matches any whitespace.' },
      { name: 'regex', type: 'string', description: 'JavaScript regular expression (Unicode) to redact.' },
      { name: 'caseSensitive', type: 'boolean', description: 'Match case.' }, { name: 'wholeWord', type: 'boolean', description: 'Whole words only.' },
      pages(), { name: 'scrubMetadata', type: 'boolean', description: 'Also remove matches from the document properties.' }, output(), force],
    run: (engine, args) => singleOutput(engine, 'redact', args, {
      terms: args.term || [], regex: args.regex || null, caseSensitive: Boolean(args.caseSensitive), wholeWord: Boolean(args.wholeWord),
      pages: pageSpec(args), scrubMetadata: Boolean(args.scrubMetadata), out: 'redacted.pdf',
    }, inputOf(args)),
  },
  {
    name: 'replace-text',
    tool: 'pdf_replace_text',
    summary: 'Replace text inside native text runs the engine can rewrite safely; anything else is refused with the reason.',
    params: [file, password, { name: 'find', type: 'string', required: true, description: 'Text to find.' },
      { name: 'replace', type: 'string', required: true, description: 'Replacement (one line).' },
      { name: 'caseSensitive', type: 'boolean', description: 'Match case.' }, pages(),
      { name: 'partial', type: 'boolean', description: 'Save the safe replacements even if some occurrences cannot be replaced.' },
      { name: 'keepFonts', type: 'boolean', description: 'Refuse when the source font cannot draw the replacement and the engine would embed a fallback font.' }, output(), force],
    run: (engine, args) => singleOutput(engine, 'replaceText', args, {
      find: args.find, replace: args.replace, caseSensitive: Boolean(args.caseSensitive), pages: pageSpec(args), partial: Boolean(args.partial),
      keepFonts: Boolean(args.keepFonts), out: 'replaced.pdf',
    }, inputOf(args)),
  },
  {
    name: 'form-fields',
    tool: 'pdf_form_fields',
    summary: 'List the AcroForm fields: name, type, value, options, read-only.',
    params: [file, password],
    run: (engine, args) => engine.run('formFields', {}, inputOf(args)).then((r) => r.result),
  },
  {
    name: 'fill-form',
    tool: 'pdf_fill_form',
    summary: 'Fill AcroForm fields from {"field name": value} (check boxes true/false, choices by export value); optionally flatten.',
    params: [file, password, { name: 'values', type: 'object', required: true, description: 'Field values: JSON object (CLI: JSON text, @file.json or - for stdin).' },
      { name: 'flatten', type: 'boolean', description: 'Flatten the form (fields become page content).' }, output(), force],
    run: (engine, args) => singleOutput(engine, 'fillForm', args, { values: args.values || {}, flatten: Boolean(args.flatten), out: 'filled.pdf' }, inputOf(args)),
  },
  {
    name: 'pages',
    summary: 'Page operations: rotate, delete, move, extract, split (merge: see merge).',
    params: [{ name: 'action', type: 'enum', values: ['rotate', 'delete', 'move', 'extract', 'split'], positional: true, required: true, description: 'Page operation.' },
      file, password, pages('Pages to act on (rotate default all; delete/move/extract need it).'),
      { name: 'angle', type: 'number', description: 'rotate: degrees clockwise, a multiple of 90 (default 90).' },
      { name: 'to', type: 'number', description: 'move: the position (1-based) the first selected page moves to.' },
      { name: 'every', type: 'number', description: 'split: pages per part (default 1).' },
      { name: 'ranges', type: 'string', description: 'split: parts separated by ";", e.g. "1-3;4-6;7-".' },
      output('Output PDF; split: a pattern with %d, a directory, or name.pdf -> name-<part>.pdf.'), force],
    async run(engine, args) {
      const params = { action: args.action, pages: pageSpec(args), angle: args.angle ?? 90, to: args.to, every: args.every, ranges: args.ranges, out: 'pages.pdf', outPrefix: 'part' };
      if (['delete', 'move', 'extract'].includes(args.action) && !args.pages) throw new CliError('bad-argument', `pages ${args.action} needs --pages`);
      if (args.action === 'move' && args.to == null) throw new CliError('bad-argument', 'pages move needs --to');
      if (args.action !== 'split') return singleOutput(engine, 'pages', args, params, inputOf(args));
      const { result, files } = await engine.run('pages', params, inputOf(args));
      const targets = result.outputs.map((item) => numberedPath(args.output, item.part, '.pdf', stemOf(args.file)));
      await assertWritable(targets, args.force);
      for (const [index, item] of result.outputs.entries()) {
        await place(files.get(item.name), targets[index]);
        result.outputs[index] = { path: targets[index], ...withoutName(item) };
      }
      return result;
    },
  },
  {
    name: 'merge',
    summary: 'Append the pages of further PDFs to the first one (the editor\'s Insert pages from PDF).',
    params: [{ name: 'files', type: 'paths', positional: true, required: true, description: 'Input PDFs, in order (at least two).' },
      { name: 'passwords', type: 'strings', description: 'Passwords of encrypted inputs, in input order (repeatable; empty for none).' }, output(), force],
    run(engine, args) {
      if ((args.files || []).length < 2) throw new CliError('bad-argument', 'merge needs at least two PDFs');
      const inputs = args.files.map((item, index) => ({ path: item, password: args.passwords?.[index] || '' }));
      return singleOutput(engine, 'merge', args, { out: 'merged.pdf', multi: true }, inputs);
    },
  },
  {
    name: 'optimize',
    summary: 'Compress: lossless (default), images (recompress images, --dpi/--quality) or a raster copy (raster-220/-150/-105, text is lost).',
    params: [file, password, { name: 'profile', type: 'enum', values: ['lossless', 'images', 'raster-220', 'raster-150', 'raster-105', ...PROFILES.filter((item) => item !== 'images')], description: 'Optimisation profile (default lossless).' },
      { name: 'dpi', type: 'number', description: 'images: target resolution (default 150).' }, { name: 'quality', type: 'number', description: 'images: JPEG quality 0-1 (default 0.78).' }, output(), force],
    run(engine, args) {
      const profile = PROFILE_ALIASES[args.profile] || args.profile || 'vector';
      return singleOutput(engine, 'optimize', args, { profile, dpi: args.dpi, quality: args.quality, out: 'optimized.pdf' }, inputOf(args));
    },
  },
  {
    name: 'protect',
    summary: 'Encrypt with AES-256: owner password, optional opening password, restrictions.',
    params: [file, password, { name: 'ownerPassword', type: 'secret', required: true, description: 'Owner (permissions) password.' },
      { name: 'userPassword', type: 'secret', description: 'Password needed to open the PDF (default none).' },
      { name: 'restrict', type: 'strings', description: 'Forbid: print, edit, copy, annotate (repeatable or comma-separated).' }, output(), force],
    run: (engine, args) => singleOutput(engine, 'protect', args, {
      ownerPassword: args.ownerPassword, userPassword: args.userPassword || '',
      restrict: (args.restrict || []).flatMap((item) => String(item).split(',')).map((item) => item.trim()).filter(Boolean), out: 'protected.pdf',
    }, inputOf(args)),
  },
  {
    name: 'unlock',
    summary: 'Remove the encryption (with the password; permissions-only PDFs need none).',
    params: [file, password, output(), force],
    run: (engine, args) => singleOutput(engine, 'unlock', args, { out: 'unlocked.pdf' }, inputOf(args)),
  },
  {
    name: 'metadata',
    summary: 'Show the document properties; --set field=value (title, author, subject, keywords, creator, producer) or --strip writes a copy.',
    params: [file, password, { name: 'set', type: 'keyvalues', description: 'Fields to set: field=value (repeatable).' },
      { name: 'strip', type: 'boolean', description: 'Remove the Info dictionary and the XMP packet.' }, output('Output PDF (needed with --set/--strip).', false), force],
    async run(engine, args) {
      const changing = args.strip || (args.set && Object.keys(args.set).length);
      if (!changing) return (await engine.run('metadata', {}, inputOf(args))).result;
      if (!args.output) throw new CliError('bad-argument', 'metadata --set/--strip needs -o');
      return singleOutput(engine, 'metadata', args, { set: args.set || null, strip: Boolean(args.strip), out: 'metadata.pdf' }, inputOf(args));
    },
  },
];

export const commandByName = new Map(COMMANDS.map((item) => [item.name, item]));

export function joinPages(list) {
  return list.map((item) => (list.length > 1 ? `--- Page ${item.page} ---\n${item.text}\n` : `${item.text}\n`)).join('\n');
}
