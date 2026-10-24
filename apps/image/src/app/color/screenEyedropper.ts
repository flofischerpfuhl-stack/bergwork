/**
 * "Pipette überall" (PRODUCT-PLAN 6.1): sampling a colour from anywhere on the screen. In order:
 * 1. the browser EyeDropper API (Chromium, Edge, WebView2),
 * 2. the host's `ScreenColorHost` (Tauri on Linux X11 and Windows),
 * 3. otherwise the canvas: the caller arms a canvas eyedropper (`'canvas'`).
 */

import type { RGB } from '../../core/model/types';
import { parseColorText } from '../../core/color/convert';
import { getCapability, type HostCapabilityMap } from '../../platform/hosts';

interface EyeDropperResult { sRGBHex: string }
interface EyeDropperLike { open(options?: { signal?: AbortSignal }): Promise<EyeDropperResult> }
type EyeDropperConstructor = new () => EyeDropperLike;

export type ScreenPickMethod = 'browser' | 'host' | 'canvas';

export function screenPickMethod(capabilities: HostCapabilityMap): ScreenPickMethod {
  if (typeof (globalThis as { EyeDropper?: unknown }).EyeDropper === 'function') return 'browser';
  if (getCapability(capabilities, 'screenColor')) return 'host';
  return 'canvas';
}

/** A colour from the screen, `null` when cancelled, or `'canvas'` when only the canvas can be sampled here. */
export async function pickScreenColor(capabilities: HostCapabilityMap): Promise<RGB | null | 'canvas'> {
  const method = screenPickMethod(capabilities);
  if (method === 'browser') {
    const EyeDropper = (globalThis as unknown as { EyeDropper: EyeDropperConstructor }).EyeDropper;
    try {
      const result = await new EyeDropper().open();
      return parseColorText(result.sRGBHex);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    }
  }
  if (method === 'host') {
    try {
      const color = await getCapability(capabilities, 'screenColor')!.pickScreenColor();
      return color ? { red: color.red / 255, green: color.green / 255, blue: color.blue / 255 } : null;
    } catch {
      // Wayland sessions and systems without X11 cannot read the screen: sample the canvas instead.
      return 'canvas';
    }
  }
  return 'canvas';
}
