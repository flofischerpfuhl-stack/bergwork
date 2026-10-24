import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../src-tauri/frontend/vite.config';
import tauriConfig from '../../src-tauri/tauri.conf.json';

// The Tauri entry has its own Vite root; without an explicit publicDir the release build shipped no bundled fonts or models
// (Windows smoke test: default text became a 1×1 layer).
describe('Tauri frontend build', () => {
  it('ships the shared public folder (bundled fonts and models)', () => {
    const publicDir = (config as { publicDir?: string }).publicDir;
    expect(publicDir && path.resolve(publicDir)).toBe(path.resolve('public'));
    expect(fs.existsSync(path.join('public', 'fonts', 'NotoSans-Variable.ttf'))).toBe(true);
  });

  it('cross-origin isolates both the dev server and packaged app for threaded WASM', () => {
    const expected = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    };
    expect((config as { server?: { headers?: unknown } }).server?.headers).toEqual(expected);
    expect((config as { preview?: { headers?: unknown } }).preview?.headers).toEqual(expected);
    expect(tauriConfig.app.security.headers).toEqual(expected);
  });
});
