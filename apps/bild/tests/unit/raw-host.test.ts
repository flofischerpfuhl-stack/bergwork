import { describe, expect, test, vi } from 'vitest';
import { invokeRawDecoder, rawBackendFor } from '../../src-tauri/frontend/rawCodec';

describe('native RAW host bridge', () => {
  test('selects WIC for Windows and LibRaw elsewhere', () => {
    expect(rawBackendFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('wic');
    expect(rawBackendFor('Mozilla/5.0 (X11; Linux x86_64)')).toBe('system-libraw');
  });

  test('passes development controls to WIC logic and preserves 16-bit channel values', async () => {
    const invoke = vi.fn(async () => ({ width: 1, height: 1, rgba: [1, 1024, 65534, 65535] }));
    const settings = { exposure: 1.25, whiteBalance: 'custom' as const, temperature: 5200, tint: -12, highlightRecovery: false };
    const decoded = await invokeRawDecoder(invoke, Uint8Array.of(0x49, 0x49), settings, true);
    expect(invoke).toHaveBeenCalledWith('decode_raw', { bytes: [0x49, 0x49], options: settings, allowSystemLibraw: true });
    expect(decoded).toEqual({ width: 1, height: 1, rgba: new Uint16Array([1, 1024, 65534, 65535]) });
  });

  test('rejects malformed native buffers instead of creating corrupt layers', async () => {
    await expect(invokeRawDecoder(async () => ({ width: 2, height: 1, rgba: [1, 2, 3, 4] }), new Uint8Array(), {}, false))
      .rejects.toThrow(/invalid bitmap/);
  });

  test('Linux LibRaw linear ProPhoto output is converted through Little CMS to 16-bit sRGB', async () => {
    const decoded = await invokeRawDecoder(async () => ({ width: 1, height: 1, rgba: [32768, 32768, 32768, 40000] }),
      new Uint8Array(), {}, true, 'linear-prophoto');
    expect(decoded?.rgba[0]).toBeGreaterThan(47000);
    expect(Math.abs(decoded!.rgba[0]! - decoded!.rgba[1]!)).toBeLessThan(80);
    expect(decoded?.rgba[3]).toBe(40000);
  });
});
