import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ALLOWED_LICENSES = new Set([
  'MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception', 'Zlib', 'CC0-1.0', 'Unlicense',
  'BSL-1.0', 'OFL-1.1', 'Unicode-3.0', 'MPL-2.0', 'IJG',
]);

const OPTIONAL_HOST_LICENSES = new Set(['LGPL-2.1-or-later', 'LGPL-3.0-or-later', 'CDDL-1.0']);
const TAURI_ONLY_LICENSES = new Set(['MPL-2.0', 'Unicode-3.0']);

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
}

function text(value, fallback = 'Not declared') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && typeof value.url === 'string') return value.url;
  return fallback;
}

function homepage(value, fallback) {
  return text(value, fallback).replace(/^git\+/, '').replace(/\.git$/, '');
}

export function npmPackages() {
  const rootPackage = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--json', '--long']));
  const packages = new Map();
  const visit = (dependencies = {}) => {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (!dependency || typeof dependency !== 'object' || typeof dependency.version !== 'string') continue;
      const version = dependency.version;
      const key = `${name}@${version}`;
      if (!packages.has(key)) {
        let manifest = {};
        try { manifest = JSON.parse(readFileSync(resolve(dependency.path, 'package.json'), 'utf8')); } catch { /* npm output remains authoritative */ }
        packages.set(key, {
          id: `npm:${key}`, name, version,
          license: text(dependency.license ?? manifest.license),
          category: 'bundled',
          homepage: homepage(dependency.repository ?? manifest.repository,
            homepage(dependency.homepage ?? manifest.homepage, `https://www.npmjs.com/package/${name}`)),
        });
      }
      visit(dependency.dependencies);
    }
  };
  visit(rootPackage.dependencies);
  return [...packages.values()];
}

export function rustPackages() {
  // tauri-env.sh pins the pkg-config/compiler environment used by the real desktop build.
  const metadata = JSON.parse(run('bash', ['-lc', 'source scripts/tauri-env.sh && cargo metadata --manifest-path src-tauri/Cargo.toml --locked --format-version 1']));
  return metadata.packages
    .filter((pkg) => pkg.name !== 'fernwork-bildeditor')
    .map((pkg) => ({
      id: `cargo:${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      license: text(pkg.license, pkg.license_file ? `See ${pkg.license_file}` : 'Not declared'),
      category: 'tauri-runtime',
      homepage: homepage(pkg.repository, homepage(pkg.homepage, `https://crates.io/crates/${pkg.name}`)),
      manifestPath: pkg.manifest_path,
    }));
}

const curated = [
  { id: 'wasm:compositor-kernels', name: 'Compositor rendering kernels', version: 'a19db90', license: 'MIT', category: 'bundled', homepage: 'https://github.com/wonderassembly/compositor' },
  { id: 'wasm:littlecms', name: 'Little CMS', version: '2.19.1', license: 'MIT', category: 'bundled', homepage: 'https://www.littlecms.com/' },
  { id: 'wasm:libwebp', name: 'libwebp', version: '1.6.0', license: 'BSD-3-Clause', category: 'bundled', homepage: 'https://chromium.googlesource.com/webm/libwebp/' },
  { id: 'wasm:libavif', name: 'libavif', version: '1.3.0', license: 'BSD-2-Clause', category: 'bundled', homepage: 'https://github.com/AOMediaCodec/libavif' },
  { id: 'wasm:dav1d', name: 'dav1d', version: '1.5.1', license: 'BSD-2-Clause', category: 'bundled', homepage: 'https://code.videolan.org/videolan/dav1d' },
  { id: 'wasm:libaom', name: 'libaom', version: '3.12.1', license: 'BSD-2-Clause', category: 'bundled', homepage: 'https://aomedia.googlesource.com/aom/' },
  { id: 'wasm:libyuv', name: 'libyuv', version: 'pinned subset', license: 'BSD-3-Clause', category: 'bundled', homepage: 'https://chromium.googlesource.com/libyuv/libyuv/' },
  { id: 'wasm:libjpeg-turbo', name: 'libjpeg-turbo', version: '3.1.2', license: 'IJG AND BSD-3-Clause AND Zlib', category: 'bundled', homepage: 'https://libjpeg-turbo.org/' },
  { id: 'font:noto-sans', name: 'Noto Sans variable fonts', version: '2026 pinned builds', license: 'OFL-1.1', category: 'bundled', homepage: 'https://fonts.google.com/noto' },
  { id: 'model:u2netp', name: 'U²-Netp', version: '25dee37a', license: 'Apache-2.0', category: 'bundled', homepage: 'https://github.com/xuebinqin/U-2-Net', downloadUrl: 'https://huggingface.co/edgetools/u2netp/resolve/25dee37ab19c5b6ad64ba6578eba63f1ae07720c/u2netp.onnx', sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8' },
  { id: 'model:birefnet-lite', name: 'BiRefNet_lite 1024', version: 'dc064531', license: 'MIT', category: 'optional-download', homepage: 'https://github.com/ZhengPeng7/BiRefNet', downloadUrl: 'https://huggingface.co/CoderViking/birefnet-lite-onnx/resolve/dc06453148f01ef4131f17e9b791345e32e8ee78/birefnet-lite-1024.onnx?download=true', sha256: '50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67' },
  { id: 'model:migan', name: 'MI-GAN 512 Places2 pipeline', version: '406830d0', license: 'MIT', category: 'optional-download', homepage: 'https://github.com/Picsart-AI-Research/MI-GAN', downloadUrl: 'https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx', sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b' },
  { id: 'model:realesrgan-x2', name: 'Real-ESRGAN x2plus', version: '766bac4b', license: 'BSD-3-Clause', category: 'optional-download', homepage: 'https://github.com/xinntao/Real-ESRGAN', downloadUrl: 'https://huggingface.co/fernandotonon/QtMeshEditor-realesrgan-onnx/resolve/766bac4b35aaeefe85a065ece8ee2f827b1314d8/RealESRGAN_x2plus.onnx', sha256: '35d016524a6eb7e9a99f192cfa81b6cf1f80fdf8f1b51605d77f0763f5ccba7f' },
  { id: 'model:realesrgan-x4', name: 'Real-ESRGAN x4plus', version: '766bac4b', license: 'BSD-3-Clause', category: 'optional-download', homepage: 'https://github.com/xinntao/Real-ESRGAN', downloadUrl: 'https://huggingface.co/fernandotonon/QtMeshEditor-realesrgan-onnx/resolve/766bac4b35aaeefe85a065ece8ee2f827b1314d8/RealESRGAN_x4plus.onnx', sha256: 'c999e5e3365a23cda6d627c407005076c160f420d6b122a0ef7c9d4210aee96a' },
  { id: 'model:slimsam-encoder', name: 'SlimSAM-77 Uniform encoder', version: 'f860d9a7', license: 'Apache-2.0', category: 'optional-download', homepage: 'https://github.com/czg1225/SlimSAM', downloadUrl: 'https://huggingface.co/skillsafe-ai/slimsam-77-uniform-fp16/resolve/f860d9a77028ebdafb86473e88b9c0eea67cd8fc/onnx/vision_encoder_fp16.onnx', sha256: '11aaeb49c75e7b3f4cbf8a32c2c819406520c6b3affb4068ff474b2240c8aa38' },
  { id: 'model:slimsam-decoder', name: 'SlimSAM-77 Uniform prompt decoder', version: 'f860d9a7', license: 'Apache-2.0', category: 'optional-download', homepage: 'https://github.com/czg1225/SlimSAM', downloadUrl: 'https://huggingface.co/skillsafe-ai/slimsam-77-uniform-fp16/resolve/f860d9a77028ebdafb86473e88b9c0eea67cd8fc/onnx/prompt_encoder_mask_decoder_fp16.onnx', sha256: 'df24d49a6f1a5dc0dbbecd84ca0fff9f14c76e63b81fd35c2b92c1321b007f71' },
  { id: 'host:libheif', name: 'libheif', version: '1.23.5', license: 'LGPL-3.0-or-later', category: 'opt-in-host', homepage: 'https://github.com/strukturag/libheif' },
  { id: 'host:libde265', name: 'libde265', version: '1.1.1', license: 'LGPL-3.0-or-later', category: 'opt-in-host', homepage: 'https://github.com/strukturag/libde265' },
  { id: 'host:libraw', name: 'system LibRaw', version: 'system supplied', license: 'LGPL-2.1-or-later OR CDDL-1.0', category: 'opt-in-host', homepage: 'https://www.libraw.org/' },
];

export function curatedPackages() { return curated.map((entry) => ({ ...entry })); }

export function tokenizeLicense(expression) {
  const normalized = expression.replaceAll('/', ' OR ');
  const tokens = [];
  const pattern = /\s*(Apache-2\.0\s+WITH\s+LLVM-exception|LGPL-[0-9.]+-or-later|[A-Za-z0-9.+-]+|\(|\)|AND|OR)\s*/gy;
  let at = 0;
  while (at < normalized.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(normalized);
    if (!match || match.index !== at) throw new Error(`Unrecognised licence expression: ${expression}`);
    tokens.push(match[1]);
    at = pattern.lastIndex;
  }
  return tokens;
}

function parseLicense(expression) {
  const tokens = tokenizeLicense(expression);
  let at = 0;
  const primary = () => {
    const token = tokens[at++];
    if (token === '(') {
      const value = or();
      if (tokens[at++] !== ')') throw new Error(`Unbalanced licence expression: ${expression}`);
      return value;
    }
    if (!token || token === ')' || token === 'AND' || token === 'OR') throw new Error(`Invalid licence expression: ${expression}`);
    return { atom: token };
  };
  const and = () => {
    let value = primary();
    while (tokens[at] === 'AND') { at++; value = { and: [value, primary()] }; }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[at] === 'OR') { at++; value = { or: [value, and()] }; }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`Invalid licence expression: ${expression}`);
  return value;
}

function permittedAtom(atom, category) {
  if (OPTIONAL_HOST_LICENSES.has(atom)) return category === 'opt-in-host';
  if (!ALLOWED_LICENSES.has(atom)) return false;
  return !TAURI_ONLY_LICENSES.has(atom) || category === 'tauri-runtime';
}

function choose(node, category) {
  if (node.atom) return permittedAtom(node.atom, category) ? [node.atom] : null;
  if (node.and) {
    const left = choose(node.and[0], category), right = choose(node.and[1], category);
    return left && right ? [...left, ...right] : null;
  }
  if (node.or) return choose(node.or[0], category) ?? choose(node.or[1], category);
  return null;
}

export function selectedLicenses(expression, category) {
  if (!expression || expression === 'Not declared' || expression.startsWith('See ')) return null;
  const selected = choose(parseLicense(expression), category);
  return selected ? [...new Set(selected)] : null;
}

function findRustPackage(rust, name) {
  const found = rust.find((pkg) => pkg.name === name);
  if (!found?.manifestPath) throw new Error(`Licence text source crate is missing: ${name}`);
  return dirname(found.manifestPath);
}

function firstExisting(paths) {
  const found = paths.find(existsSync);
  if (!found) throw new Error(`Licence text source is missing: ${paths.join(', ')}`);
  return readFileSync(found, 'utf8').trim() + '\n';
}

export function licenseText(license, rust) {
  const crate = (name, ...files) => firstExisting(files.map((file) => resolve(findRustPackage(rust, name), file)));
  switch (license) {
    case 'MIT': return firstExisting([resolve(root, 'src/wasm/c/LICENSE')]);
    case 'Apache-2.0': return firstExisting([resolve(root, 'public/models/u2netp.LICENSE.txt')]);
    case 'Apache-2.0 WITH LLVM-exception': return crate('target-lexicon', 'LICENSE');
    case 'BSD-3-Clause': return firstExisting([resolve(root, 'node_modules/canvaskit-wasm/LICENSE'), resolve(root, 'src/wasm/webp/LICENSE')]);
    case 'BSD-2-Clause': return firstExisting([resolve(root, 'src/wasm/avif/LICENSE')]);
    case 'ISC': return crate('libloading', 'LICENSE');
    case '0BSD': return crate('adler2', 'LICENSE-0BSD');
    case 'Zlib': return crate('zlib-rs', 'LICENSE');
    case 'OFL-1.1': return firstExisting([resolve(root, 'public/fonts/OFL.txt')]);
    case 'Unicode-3.0': return crate('icu_provider', 'LICENSE');
    case 'MPL-2.0': return crate('option-ext', 'LICENSE.txt', 'LICENSE');
    case 'IJG': return firstExisting([resolve(root, 'src/wasm/jpeg/README.ijg')]);
    case 'CC0-1.0': return crate('dunce', 'LICENSE');
    case 'Unlicense': return crate('aho-corasick', 'UNLICENSE', 'LICENSE-UNLICENSE');
    case 'LGPL-2.1-or-later': return firstExisting([
      resolve(root, 'scripts/license-texts/LGPL-2.1-or-later.txt'),
      '/usr/share/common-licenses/LGPL-2.1',
    ]);
    case 'LGPL-3.0-or-later': return firstExisting([resolve(root, 'src/wasm/heif/LICENSE.LGPL-3.0.txt')])
      + '\n--- Referenced GNU GPL version 3 text ---\n\n' + firstExisting([resolve(root, 'src/wasm/heif/LICENSE.GPL-3.0.txt')]);
    default: throw new Error(`No full licence text source for ${license}`);
  }
}

export function textIdFor(licenses) {
  return licenses.map((value) => value.replaceAll(' ', '_').replaceAll('+', 'plus')).join('_AND_');
}

export function inventory() {
  const npm = npmPackages();
  const rust = rustPackages();
  const entries = [...npm, ...rust, ...curatedPackages()].map((entry) => {
    const selected = selectedLicenses(entry.license, entry.category);
    return { ...entry, textId: selected ? textIdFor(selected) : '' };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  return { npm, rust, entries };
}

export function expectedVendoredFiles() {
  return [
    ...readdirSync(resolve(root, 'public/fonts')).filter((name) => name.endsWith('.ttf')).map((name) => `public/fonts/${name}`),
    ...readdirSync(resolve(root, 'public/models')).filter((name) => name.endsWith('.onnx')).map((name) => `public/models/${name}`),
    ...['avif', 'heif', 'jpeg', 'lcms', 'webp'].filter((name) => existsSync(resolve(root, `src/wasm/${name}`))).map((name) => `src/wasm/${name}`),
    'src/wasm/c', 'src/wasm/kernels.wasm',
  ].sort();
}

export const VENDORED_COVERAGE = new Set([
  'public/fonts/NotoSans-Variable.ttf', 'public/fonts/NotoSansArabic-Variable.ttf', 'public/fonts/NotoSansDevanagari-Variable.ttf',
  'public/models/u2netp.onnx', 'src/wasm/avif', 'src/wasm/c', 'src/wasm/heif', 'src/wasm/jpeg', 'src/wasm/kernels.wasm', 'src/wasm/lcms', 'src/wasm/webp',
]);
