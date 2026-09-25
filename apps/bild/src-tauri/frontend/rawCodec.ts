import type { HostDecodedRaw } from '../../src/platform/hosts';
import type { RawDecodeOptions } from '../../src/io/dng';
import { loadLittleCms } from '../../src/wasm/lcms';

export type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function rawBackendFor(userAgent: string): 'wic' | 'system-libraw' {
  return /Windows/i.test(userAgent) ? 'wic' : 'system-libraw';
}

/** Typed IPC boundary shared by WIC and LibRaw; kept pure so Windows behaviour is testable off-Windows. */
export async function invokeRawDecoder(invoke: NativeInvoke, bytes: Uint8Array, options: RawDecodeOptions,
  allowSystemLibraw: boolean, nativeColorSpace: 'srgb' | 'linear-prophoto' = 'srgb'): Promise<HostDecodedRaw | null> {
  const response = await invoke('decode_raw', {
    bytes: Array.from(bytes), options, allowSystemLibraw,
  }) as { width: number; height: number; rgba: number[] } | null;
  if (!response) return null;
  if (!Number.isInteger(response.width) || !Number.isInteger(response.height) || response.width < 1 || response.height < 1
    || response.rgba.length !== response.width * response.height * 4) throw new Error('The native RAW codec returned an invalid bitmap.');
  let rgba: Uint16Array = Uint16Array.from(response.rgba);
  if (nativeColorSpace === 'linear-prophoto') {
    const pixels = response.width * response.height, rgb = new Uint16Array(pixels * 3), alpha = new Uint16Array(pixels);
    for (let p = 0; p < pixels; p++) {
      rgb[p * 3] = rgba[p * 4]!; rgb[p * 3 + 1] = rgba[p * 4 + 1]!; rgb[p * 3 + 2] = rgba[p * 4 + 2]!; alpha[p] = rgba[p * 4 + 3]!;
    }
    const lcms = await loadLittleCms();
    const proPhoto = lcms.createRgbProfile({ white: [0.3457, 0.3585], red: [0.7347, 0.2653], green: [0.1596, 0.8404], blue: [0.0366, 0.0001] }, 1);
    rgba = lcms.transform16(proPhoto, rgb, 'rgb', alpha);
  }
  return { width: response.width, height: response.height, rgba };
}
