# HEIC decoding in the Tauri host

Fernwork's importer asks the versioned `CodecHost` capability in `src/platform/hosts/types.ts` after native browser
decoding is unavailable. The current Tauri adapter advertises `codecs: { version: 1 }` but does not yet implement a
native HEIC decoder. It therefore behaves like the browser fallback and does not claim OS-codec support.

A future native integration belongs on `host.capabilities.codecs.decodeImage`, without changing frozen
`contracts.ts`:

```ts
const codecs: CodecHost = {
  version: 1,
  async decodeImage(bytes, mime) {
    const result = await invoke<NativeDecodedImage | null>('decode_image', { bytes: Array.from(bytes), mime });
    return result && { ...result, rgba: Uint8Array.from(result.rgba) };
  },
};
```

The command must return un-oriented, straight-alpha sRGB RGBA8 and an EXIF orientation from 1 through 8. The
TypeScript importer applies orientation exactly once. Large-image production code should use Tauri's raw-byte or
channel transport rather than JSON number arrays.

On macOS, ImageIO/CoreGraphics can create a `CGImageSource`, read `kCGImagePropertyOrientation`, and draw into an
sRGB 8-bit RGBA bitmap. On Windows, WIC can decode the first frame, convert it to
`GUID_WICPixelFormat32bppRGBA`, and read EXIF tag 274. Availability on both platforms depends on installed OS
codecs and must be reported as `null` when unsupported.

Linux generally requires libheif plus a HEVC decoder. The separately replaceable web component combines libheif
and libde265 under LGPL-3.0-or-later and is deliberately opt-in: a host must set
`codecs.heicDecoder = 'lgpl-wasm'`. Its sources, relinking path, complete licence texts, and checksums are recorded
in `THIRD_PARTY_NOTICES.md` and `src/wasm/heif/`. HEVC can also carry patent obligations that are separate from the
software licence; distributors must assess those obligations.

Native browser decoding remains first in the import pipeline. A host decoder comes next, and the LGPL WASM path is
considered only when the host explicitly enables it.
