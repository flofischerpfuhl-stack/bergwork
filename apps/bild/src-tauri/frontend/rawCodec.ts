import type { HostDecodedRaw } from '../../src/platform/hosts';
import type { RawDecodeOptions } from '../../src/io/dng';

export type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function rawBackendFor(userAgent: string): 'wic' | 'system-libraw' {
  return /Windows/i.test(userAgent) ? 'wic' : 'system-libraw';
}

/** Typed IPC boundary shared by WIC and LibRaw; kept pure so Windows behaviour is testable off-Windows. */
export async function invokeRawDecoder(invoke: NativeInvoke, bytes: Uint8Array, options: RawDecodeOptions,
  allowSystemLibraw: boolean): Promise<HostDecodedRaw | null> {
  const response = await invoke('decode_raw', {
    bytes: Array.from(bytes), options, allowSystemLibraw,
  }) as { width: number; height: number; rgba: number[] } | null;
  if (!response) return null;
  if (!Number.isInteger(response.width) || !Number.isInteger(response.height) || response.width < 1 || response.height < 1
    || response.rgba.length !== response.width * response.height * 4) throw new Error('The native RAW codec returned an invalid bitmap.');
  return { width: response.width, height: response.height, rgba: Uint16Array.from(response.rgba) };
}
