import type { HostDecodedRaw } from '../../src/platform/hosts';
import type { RawDecodeOptions } from '../../src/io/dng';
import { loadLittleCms } from '../../src/wasm/lcms';

export type NativeInvoke = (command: string, args: Record<string, unknown> | Uint8Array) => Promise<unknown>;

export interface NativeRawIpcTiming {
  readonly totalMs: number;
  readonly encodedInputBytes: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
}

const recentIpcTimings: NativeRawIpcTiming[] = [];
export function nativeRawIpcTimings(): readonly NativeRawIpcTiming[] { return [...recentIpcTimings]; }
export function clearNativeRawIpcTimings(): void { recentIpcTimings.length = 0; }

export function rawBackendFor(userAgent: string): 'wic' | 'system-libraw' {
  return /Windows/i.test(userAgent) ? 'wic' : 'system-libraw';
}

/** Typed IPC boundary shared by WIC and LibRaw; kept pure so Windows behaviour is testable off-Windows. */
export async function invokeRawDecoder(invoke: NativeInvoke, bytes: Uint8Array, options: RawDecodeOptions,
  allowSystemLibraw: boolean, nativeColorSpace: 'srgb' | 'linear-prophoto' = 'srgb'): Promise<HostDecodedRaw | null> {
  const started = performance.now();
  const header = new TextEncoder().encode(JSON.stringify({ options, allowSystemLibraw }));
  const request = new Uint8Array(4 + header.byteLength + bytes.byteLength);
  new DataView(request.buffer).setUint32(0, header.byteLength, true);
  request.set(header, 4); request.set(bytes, 4 + header.byteLength);
  const response = new Uint8Array(await invoke('decode_raw_binary', request) as ArrayBuffer);
  recentIpcTimings.push({ totalMs: performance.now() - started, encodedInputBytes: bytes.byteLength,
    requestBytes: request.byteLength, responseBytes: response.byteLength });
  if (recentIpcTimings.length > 32) recentIpcTimings.shift();
  if (!response.byteLength) return null;
  if (response.byteLength < 8) throw new Error('The native RAW codec returned an invalid bitmap.');
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  const width = view.getUint32(0, true), height = view.getUint32(4, true);
  const samples = width * height * 4;
  if (!Number.isSafeInteger(samples) || width < 1 || height < 1 || response.byteLength !== 8 + samples * 2) {
    throw new Error('The native RAW codec returned an invalid bitmap.');
  }
  let rgba: Uint16Array<ArrayBufferLike> = new Uint16Array(response.buffer, response.byteOffset + 8, samples);
  if (nativeColorSpace === 'linear-prophoto') {
    const pixels = width * height, rgb = new Uint16Array(pixels * 3), alpha = new Uint16Array(pixels);
    for (let p = 0; p < pixels; p++) {
      rgb[p * 3] = rgba[p * 4]!; rgb[p * 3 + 1] = rgba[p * 4 + 1]!; rgb[p * 3 + 2] = rgba[p * 4 + 2]!; alpha[p] = rgba[p * 4 + 3]!;
    }
    const lcms = await loadLittleCms();
    const proPhoto = lcms.createRgbProfile({ white: [0.3457, 0.3585], red: [0.7347, 0.2653], green: [0.1596, 0.8404], blue: [0.0366, 0.0001] }, 1);
    rgba = lcms.transform16(proPhoto, rgb, 'rgb', alpha);
  }
  return { width, height, rgba };
}
