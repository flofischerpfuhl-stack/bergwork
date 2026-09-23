# HEIC decoding in a Tauri host

The web editor accepts optional methods on its existing `HostAdapter`; `contracts.ts` does not change. A Tauri shell can expose the native decoder and leave `heicDecoder` unset so the LGPL WebAssembly module is never loaded:

```ts
import { invoke } from '@tauri-apps/api/core';
import type { FileTargetHost } from '../src/platform/browserHost';
import type { HostDecodedImage } from '../src/platform/imageDecoder';

export const host: FileTargetHost = {
  // chooseImages, chooseProject, saveFile and reportError omitted here
  async decodeImage(bytes, mime): Promise<HostDecodedImage | null> {
    const result = await invoke<{ width: number; height: number; rgba: number[]; orientation: number } | null>(
      'decode_image', { bytes: Array.from(bytes), mime },
    );
    return result && { ...result, rgba: Uint8Array.from(result.rgba), orientation: result.orientation as 1|2|3|4|5|6|7|8 };
  },
};
```

For large images, use a Tauri raw-byte/channel or custom IPC response instead of JSON arrays. The command result is un-oriented, straight-alpha sRGB RGBA8 plus EXIF orientation; the TypeScript importer applies orientation exactly once.

```rust
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DecodedImage {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    orientation: u8,
}

#[tauri::command]
fn decode_image(bytes: Vec<u8>, mime: String) -> Result<Option<DecodedImage>, String> {
    if mime != "image/heic" && mime != "image/heif" { return Ok(None); }
    platform::decode_rgba8(&bytes).map(Some)
}
```

On macOS, implement `platform::decode_rgba8` with ImageIO/CoreGraphics bindings: create a `CGImageSource` from `CFData`, read `kCGImagePropertyOrientation` (default 1), call `CGImageSourceCreateImageAtIndex(source, 0, ...)`, and draw the `CGImage` into an sRGB `CGBitmapContext` configured for 8-bit RGBA. Do not ask ImageIO to orient the bitmap because the returned orientation is applied by the importer.

On Windows, use the `windows` crate and WIC: create `IWICImagingFactory`, an `IWICStream` over the input, then `CreateDecoderFromStream` and `GetFrame(0)`. Convert through `IWICFormatConverter` to `GUID_WICPixelFormat32bppRGBA`, call `CopyPixels`, and query EXIF tag 274 with `IWICMetadataQueryReader` (commonly `/app1/ifd/{ushort=274}`), defaulting to 1. WIC codecs installed by the OS determine HEIC availability.

Linux generally needs libheif or another HEVC-capable codec. libheif and libde265 are LGPL-3.0, so a Linux host using them must meet the same relinking/source obligations as the optional WASM decoder. HEVC may also be patent-encumbered in the countries where the application is distributed.

To opt into the separately shipped browser decoder instead, omit `decodeImage` or return `null` and set `heicDecoder: 'lgpl-wasm'` on the host. Native browser decoding remains first in the pipeline in either configuration.
