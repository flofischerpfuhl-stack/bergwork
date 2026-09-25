import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/** Generated QA corpus (tests/qa-tools/make_files.py); made on first use so the specs are self-contained. */
export const QA_DIR = process.env.QA_FILES ?? '/tmp/fw-qa-files/import';

export interface QaCase {
  file: string; mime: string; width: number; height: number; max: number;
  alpha?: boolean; bits?: 8 | 16; note?: string;
}

let unavailable: string | null = null;

/** Why the generated corpus is missing (e.g. no numpy/Pillow in a sandbox), or null when it is there. */
export function qaCorpusUnavailable(): string | null { return unavailable; }

export function qaCorpus(): QaCase[] {
  if (!fs.existsSync(path.join(QA_DIR, 'manifest.json'))) {
    try {
      execFileSync('python3', [fileURLToPath(new URL('../qa-tools/make_files.py', import.meta.url)), QA_DIR], { stdio: 'pipe' });
    } catch (error) {
      // The generator needs python3 with numpy and Pillow; environments without them skip these specs instead of failing.
      unavailable = `QA corpus generator unavailable: ${(error as Error).message.split('\n')[0]}`;
      return [];
    }
  }
  return JSON.parse(fs.readFileSync(path.join(QA_DIR, 'manifest.json'), 'utf8')) as QaCase[];
}

/** Mounts the editor with a minimal host (as own-files.spec.ts does) and returns once a project exists. */
export async function mountBare(page: Page, size = { width: 64, height: 64 }): Promise<void> {
  await page.goto('/?harness=qa');
  await page.evaluate(async (size) => {
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const { mountEditor } = await load('/src/index.ts');
    const w = window as any;
    w.__errors = [];
    const host = { async chooseImages() { return []; }, async chooseProject() { return null; },
      async saveFile() {}, reportError(e: unknown) { w.__errors.push(e); } };
    w.__handle = await mountEditor(document.getElementById('root')!, { host });
    await w.__handle.newProject({ name: 'qa', width: size.width, height: size.height });
  }, size);
}

/** Imports bytes through the public handle; returns the new layer's raster as straight RGBA8 (16-bit reduced /257). */
export async function importAndRead(page: Page, bytes: Buffer, name: string): Promise<{
  width: number; height: number; format: string; pixels: Uint8Array; pixels16: Uint16Array | null; error?: string;
}> {
  const result = await page.evaluate(async ({ b64, name }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    try { await (window as any).__handle.importImage(new Blob([data]), name); }
    catch (error) { return { error: String((error as Error)?.message ?? error) }; }
    const session = (window as any).__editorForTests.session;
    const raster = session.document.layers.at(-1).raster;
    const raw = raster.toPixelsNative() as Uint8Array | Uint16Array;
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { width: raster.width, height: raster.height, format: raster.format as string, is16: raw instanceof Uint16Array, b64: btoa(binary) };
  }, { b64: bytes.toString('base64'), name });
  if ('error' in result) return { width: 0, height: 0, format: '', pixels: new Uint8Array(), pixels16: null, error: result.error };
  const buf = Buffer.from(result.b64, 'base64');
  let pixels16: Uint16Array | null = null;
  let pixels: Uint8Array;
  if (result.is16) {
    pixels16 = new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    pixels = Uint8Array.from(pixels16, (v) => Math.round(v / 257));
  } else pixels = new Uint8Array(buf);
  return { width: result.width, height: result.height, format: result.format, pixels, pixels16 };
}

/** Mean |Δ| of RGB where the reference alpha is at least `minAlpha`, and mean |Δ| of alpha everywhere. */
export function compareRgba(got: Uint8Array, ref: Uint8Array, minAlpha = 255): { rgb: number; alpha: number; maxRgb: number } {
  let sum = 0, n = 0, asum = 0, max = 0;
  for (let i = 0; i < ref.length; i += 4) {
    asum += Math.abs(got[i + 3]! - ref[i + 3]!);
    if (ref[i + 3]! < minAlpha) continue;
    for (let c = 0; c < 3; c++) { const d = Math.abs(got[i + c]! - ref[i + c]!); sum += d; n++; if (d > max) max = d; }
  }
  return { rgb: sum / Math.max(1, n), alpha: asum / (ref.length / 4), maxRgb: max };
}

/** A dark ramp 0 … 25 % grey, written as a real 8- or 16-bit PNG (no colour chunks). */
export function rampPng(bits: 8 | 16, W = 2048, H = 8): Buffer {
  const bpp = bits === 16 ? 6 : 3;
  const raw = Buffer.alloc(H * (1 + W * bpp));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * bpp);
    for (let x = 0; x < W; x++) {
      const v = x / (W - 1) * 0.25;
      for (let c = 0; c < 3; c++) {
        if (bits === 16) raw.writeUInt16BE(Math.round(v * 65535), row + 1 + x * 6 + c * 2);
        else raw[row + 1 + x * 3 + c] = Math.round(v * 255);
      }
    }
  }
  const crc = (buf: Buffer) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (tag: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(tag, 'ascii'), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = bits; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

