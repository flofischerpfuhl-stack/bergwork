import { describe, expect, test, vi } from 'vitest';
import { clearNativeRawIpcTimings, invokeRawDecoder, nativeRawIpcTimings, rawBackendFor } from '../../src-tauri/frontend/rawCodec';

describe('native RAW host bridge', () => {
  test('selects WIC for Windows and LibRaw elsewhere', () => {
    expect(rawBackendFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('wic');
    expect(rawBackendFor('Mozilla/5.0 (X11; Linux x86_64)')).toBe('system-libraw');
  });

  test('passes development controls to WIC logic and preserves 16-bit channel values', async () => {
    clearNativeRawIpcTimings();
    const invoke = vi.fn(async (_command: string, body: Record<string, unknown> | Uint8Array) => {
      expect(body).toBeInstanceOf(Uint8Array);
      const request = body as Uint8Array, length = new DataView(request.buffer).getUint32(0, true);
      expect(JSON.parse(new TextDecoder().decode(request.subarray(4, 4 + length)))).toEqual({ options: settings, allowSystemLibraw: true });
      expect([...request.subarray(4 + length)]).toEqual([0x49, 0x49]);
      const response = new Uint8Array(16), view = new DataView(response.buffer);
      view.setUint32(0, 1, true); view.setUint32(4, 1, true);
      [1, 1024, 65534, 65535].forEach((value, index) => view.setUint16(8 + index * 2, value, true));
      return response.buffer;
    });
    const settings = { exposure: 1.25, whiteBalance: 'custom' as const, temperature: 5200, tint: -12, highlightRecovery: false };
    const decoded = await invokeRawDecoder(invoke, Uint8Array.of(0x49, 0x49), settings, true);
    expect(invoke.mock.calls[0]?.[0]).toBe('decode_raw_binary');
    expect(decoded).toEqual({ width: 1, height: 1, rgba: new Uint16Array([1, 1024, 65534, 65535]) });
    expect(nativeRawIpcTimings()).toMatchObject([{ encodedInputBytes: 2, responseBytes: 16 }]);
    expect(nativeRawIpcTimings()[0]!.requestBytes).toBeGreaterThan(2);
  });

  test('rejects malformed native buffers instead of creating corrupt layers', async () => {
    await expect(invokeRawDecoder(async () => new Uint8Array([1, 2, 3, 4]).buffer, new Uint8Array(), {}, false))
      .rejects.toThrow(/invalid bitmap/);
  });

  test('Linux LibRaw linear ProPhoto output is converted through Little CMS to 16-bit sRGB', async () => {
    const decoded = await invokeRawDecoder(async () => {
      const response = new Uint8Array(16), view = new DataView(response.buffer);
      view.setUint32(0, 1, true); view.setUint32(4, 1, true);
      [32768, 32768, 32768, 40000].forEach((value, index) => view.setUint16(8 + index * 2, value, true));
      return response.buffer;
    },
      new Uint8Array(), {}, true, 'linear-prophoto');
    expect(decoded?.rgba[0]).toBeGreaterThan(47000);
    expect(Math.abs(decoded!.rgba[0]! - decoded!.rgba[1]!)).toBeLessThan(80);
    expect(decoded?.rgba[3]).toBe(40000);
  });
});
