#!/usr/bin/env node
// Collects the licences of everything berg:work PDF ships:
// - berg:work PDF itself and the Fernwork PDF editor (Business Source License 1.1),
// - the editor's third-party components, from the licence files and the optional `licenses.json` manifest that
//   come with the pinned build (apps/pdf/upstream/tools/vendor/…),
// - the Rust crates compiled into the app for the current target (cargo metadata, normal dependencies only),
//   each with the licence files its source package contains.
//
// Writes apps/pdf/dist/licenses.json (read by the app's Licences view) and, with --notices,
// apps/pdf/THIRD_PARTY_NOTICES.md (committed; `--check` fails when it is out of date).
//
// Usage: node scripts/collect-licenses.mjs [--notices] [--check]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '../..');
const upstreamVendor = path.join(appDir, 'upstream/tools/vendor');
const distFile = path.join(appDir, 'dist/licenses.json');
const noticesFile = path.join(appDir, 'THIRD_PARTY_NOTICES.md');
const writeNotices = process.argv.includes('--notices') || process.argv.includes('--check');
const checkOnly = process.argv.includes('--check');

const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense|copyright)([-._].*)?$/i;

function readText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();
}

function licenceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ file: name, text: readText(path.join(dir, name)) }));
}

function hostTarget() {
  const info = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  return /^host: (.+)$/m.exec(info)?.[1];
}

/** Rust crates reachable from `bergwork-pdf` through normal dependencies on the host target. */
function rustCrates() {
  const target = hostTarget();
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', target], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  }));
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const root = metadata.packages.find((pkg) => pkg.name === 'bergwork-pdf');
  const seen = new Set();
  const stack = [root.id];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps || []) {
      if (dep.dep_kinds.some((kind) => kind.kind === null)) stack.push(dep.pkg);
    }
  }
  seen.delete(root.id);
  return {
    target,
    crates: [...seen]
      .map((id) => packages.get(id))
      .filter((pkg) => pkg.source) // workspace members are berg:work's own code
      .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        licence: pkg.license || (pkg.license_file ? `see ${pkg.license_file}` : 'unspecified'),
        url: pkg.repository || pkg.homepage || `https://crates.io/crates/${pkg.name}`,
        texts: licenceFiles(path.dirname(pkg.manifest_path)),
      })),
  };
}

/** Components of the pinned editor build: its manifest if present, else the licence files next to it. */
function editorComponents() {
  const manifest = path.join(upstreamVendor, 'pdf-tools/licenses.json');
  if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).components || [];
  const components = [];
  for (const dir of ['pdf-tools', 'pdf-runtime', 'tesseract-5.0.4']) {
    const base = path.join(upstreamVendor, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const match = /^LICEN[CS]E-(.+?)\.(txt|md)$/i.exec(name);
      if (match) components.push({ name: match[1], licence: 'see text', texts: [{ file: `${dir}/${name}`, text: readText(path.join(base, name)) }] });
    }
    for (const text of licenceFiles(base)) {
      if (/^LICEN[CS]E-.+\.(txt|md)$/i.test(text.file)) continue;
      components.push({ name: dir, licence: 'see text', texts: [{ ...text, file: `${dir}/${text.file}` }] });
    }
  }
  return components;
}

const lock = JSON.parse(readFileSync(path.join(repoRoot, 'upstream.lock.json'), 'utf8'));
const { target, crates } = rustCrates();
const report = {
  generatedFor: target,
  app: {
    name: 'berg:work PDF',
    licence: 'BUSL-1.1',
    texts: [{ file: 'LICENSE', text: readText(path.join(repoRoot, 'LICENSE')) }],
  },
  editor: {
    name: 'Fernwork PDF editor',
    licence: 'BUSL-1.1',
    commit: lock.upstreams['fernwork-pdf'].commit,
    components: editorComponents(),
  },
  rust: crates,
};

if (!checkOnly) {
  mkdirSync(path.dirname(distFile), { recursive: true });
  writeFileSync(distFile, JSON.stringify(report));
}

if (writeNotices) {
  const lines = [
    '# berg:work PDF: third-party notices',
    '',
    'Generated by `apps/pdf/scripts/collect-licenses.mjs --notices`; do not edit. The app shows the same data under',
    `Settings → Licences. Rust crates are listed for \`${target}\`; other targets differ only by platform crates.`,
    '',
    '## berg:work PDF and the Fernwork PDF editor',
    '',
    `Business Source License 1.1, see [LICENSE](../../LICENSE). Editor build: Fernwork \`${report.editor.commit.slice(0, 7)}\`.`,
    '',
    '## Components of the editor build',
    '',
    ...report.editor.components.map((item) => `- ${item.name}${item.version ? ` ${item.version}` : ''}: ${item.licence}`),
    '',
    `## Rust crates (${crates.length})`,
    '',
    '| Crate | Version | Licence |',
    '| --- | --- | --- |',
    ...crates.map((item) => `| [${item.name}](${item.url}) | ${item.version} | ${item.licence} |`),
    '',
    '## Licence texts',
    '',
  ];
  const seenTexts = new Map();
  for (const item of [...report.editor.components, ...crates]) {
    for (const text of item.texts || []) {
      const key = text.text;
      if (!seenTexts.has(key)) seenTexts.set(key, []);
      seenTexts.get(key).push(`${item.name}${item.version ? ` ${item.version}` : ''}`);
    }
  }
  for (const [text, users] of seenTexts) {
    lines.push(`### ${users.slice(0, 6).join(', ')}${users.length > 6 ? ` and ${users.length - 6} more` : ''}`, '', '```text', text, '```', '');
  }
  const markdown = `${lines.join('\n').trimEnd()}\n`;
  if (checkOnly) {
    const current = existsSync(noticesFile) ? readFileSync(noticesFile, 'utf8') : '';
    if (current !== markdown) {
      console.error('THIRD_PARTY_NOTICES.md is out of date: run `npm run licenses -w @bergwork/pdf`.');
      process.exit(1);
    }
  } else {
    writeFileSync(noticesFile, markdown);
  }
}

console.log(`licenses: ${report.editor.components.length} editor components, ${crates.length} Rust crates (${target})`);
