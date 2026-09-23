export class JpegMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JpegMetaError';
  }
}

export interface JpegInfo {
  width: number;
  height: number;
  orientation: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  dpi: { x: number; y: number } | null;
}

interface Segment {
  marker: number;
  payloadOffset: number;
  payloadLength: number;
}

interface ExifInfo {
  orientation: JpegInfo['orientation'] | null;
  dpi: JpegInfo['dpi'];
}

/** Reads dimensions/orientation/density without sending pixels through a browser decoder. */
export function readJpegInfo(bytes: Uint8Array): JpegInfo {
  const segments = jpegSegments(bytes);
  let width = 0, height = 0;
  let orientation: JpegInfo['orientation'] = 1;
  let jfifDpi: JpegInfo['dpi'] = null;
  let exifDpi: JpegInfo['dpi'] = null;
  for (const segment of segments) {
    if (isSof(segment.marker)) {
      if (segment.payloadLength < 6) throw new JpegMetaError('Truncated JPEG SOF segment');
      height = readU16BE(bytes, segment.payloadOffset + 1);
      width = readU16BE(bytes, segment.payloadOffset + 3);
      const components = bytes[segment.payloadOffset + 5]!;
      if (components === 0 || segment.payloadLength !== 6 + components * 3) throw new JpegMetaError('Invalid JPEG SOF component table');
      if (width === 0 || height === 0) throw new JpegMetaError('JPEG dimensions must be positive');
    } else if (segment.marker === 0xe0 && isAscii(bytes, segment.payloadOffset, 'JFIF\0')) {
      jfifDpi = readJfifDensity(bytes, segment);
    } else if (segment.marker === 0xe1 && isAscii(bytes, segment.payloadOffset, 'Exif\0\0')) {
      const exif = readExif(bytes, segment);
      if (exif.orientation !== null) orientation = exif.orientation;
      if (exif.dpi !== null) exifDpi = exif.dpi;
    }
  }
  if (width === 0 || height === 0) throw new JpegMetaError('JPEG has no supported SOF dimensions');
  return { width, height, orientation, dpi: jfifDpi ?? exifDpi };
}

export function orientedSize(info: Pick<JpegInfo, 'width' | 'height' | 'orientation'>): { width: number; height: number } {
  return info.orientation >= 5
    ? { width: info.height, height: info.width }
    : { width: info.width, height: info.height };
}

/** Reassembles the ICC.1 multi-segment APP2 payload in sequence-number order. */
export function readJpegIccProfile(bytes: Uint8Array): Uint8Array | null {
  const chunks = new Map<number, Uint8Array>();
  let total = 0;
  for (const segment of jpegSegments(bytes)) {
    if (segment.marker !== 0xe2 || !isAscii(bytes, segment.payloadOffset, 'ICC_PROFILE\0')) continue;
    if (segment.payloadLength < 14) throw new JpegMetaError('Truncated JPEG ICC_PROFILE segment');
    const sequence = bytes[segment.payloadOffset + 12]!, count = bytes[segment.payloadOffset + 13]!;
    if (sequence < 1 || count < 1 || sequence > count || (total !== 0 && total !== count) || chunks.has(sequence)) {
      throw new JpegMetaError('Invalid JPEG ICC_PROFILE segment sequence');
    }
    total = count;
    chunks.set(sequence, bytes.slice(segment.payloadOffset + 14, segment.payloadOffset + segment.payloadLength));
  }
  if (total === 0) return null;
  if (chunks.size !== total) throw new JpegMetaError('Incomplete JPEG ICC_PROFILE segment sequence');
  let length = 0;
  for (let sequence = 1; sequence <= total; sequence++) length += chunks.get(sequence)!.length;
  const profile = new Uint8Array(length);
  let offset = 0;
  for (let sequence = 1; sequence <= total; sequence++) {
    const chunk = chunks.get(sequence)!; profile.set(chunk, offset); offset += chunk.length;
  }
  return profile;
}

/**
 * Adds/updates JFIF density after browser JPEG encoding, matching the resolution
 * metadata written by ImageExporter.jpeg (Compositor/IO/ImageExporter.swift).
 */
export function withJpegDensity(bytes: Uint8Array, dpi: number): Uint8Array {
  if (!Number.isFinite(dpi) || Math.round(dpi) < 1 || Math.round(dpi) > 0xffff) {
    throw new JpegMetaError('JPEG DPI must round to an integer from 1 through 65535');
  }
  const density = Math.max(1, Math.round(dpi));
  const segments = jpegSegments(bytes);
  for (const segment of segments) {
    if (segment.marker === 0xe0 && isAscii(bytes, segment.payloadOffset, 'JFIF\0')) {
      if (segment.payloadLength < 14) throw new JpegMetaError('Truncated JFIF segment');
      const output = bytes.slice();
      output[segment.payloadOffset + 7] = 1;
      writeU16BE(output, segment.payloadOffset + 8, density);
      writeU16BE(output, segment.payloadOffset + 10, density);
      return output;
    }
  }

  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // JFIF\0
    0x01, 0x02, 0x01,             // version 1.02, dots per inch
    density >>> 8, density & 255,
    density >>> 8, density & 255,
    0x00, 0x00,                   // no thumbnail
  ]);
  const output = new Uint8Array(bytes.length + app0.length);
  output.set(bytes.subarray(0, 2), 0);
  output.set(app0, 2);
  output.set(bytes.subarray(2), 2 + app0.length);
  return output;
}

function jpegSegments(bytes: Uint8Array): Segment[] {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new JpegMetaError('Invalid JPEG SOI marker');
  const segments: Segment[] = [];
  let offset = 2;
  let pendingMarker: number | null = null;
  while (pendingMarker !== null || offset < bytes.length) {
    let marker: number;
    if (pendingMarker !== null) {
      marker = pendingMarker;
      pendingMarker = null;
    } else {
      if (bytes[offset] !== 0xff) throw new JpegMetaError(`Expected JPEG marker at byte ${offset}`);
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) throw new JpegMetaError('Truncated JPEG marker');
      marker = bytes[offset++]!;
    }
    if (marker === 0x00) throw new JpegMetaError('Unexpected stuffed byte outside JPEG scan data');
    if (marker === 0xd9) return segments;
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) throw new JpegMetaError('Truncated JPEG SOS length');
      const length = readU16BE(bytes, offset);
      if (length < 2 || offset + length > bytes.length) throw new JpegMetaError('Truncated JPEG SOS segment');
      offset += length;
      let found = false;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        while (offset < bytes.length && bytes[offset] === 0xff) offset++;
        if (offset >= bytes.length) throw new JpegMetaError('Truncated JPEG scan marker');
        const foundMarker = bytes[offset++]!;
        if (foundMarker === 0x00 || (foundMarker >= 0xd0 && foundMarker <= 0xd7)) continue;
        pendingMarker = foundMarker;
        found = true;
        break;
      }
      if (!found) throw new JpegMetaError('Truncated JPEG scan without EOI');
      continue;
    }
    if (marker === 0xd8) throw new JpegMetaError('Unexpected JPEG SOI marker');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new JpegMetaError('Truncated JPEG segment length');
    const length = readU16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) throw new JpegMetaError('Truncated JPEG segment');
    segments.push({ marker, payloadOffset: offset + 2, payloadLength: length - 2 });
    offset += length;
  }
  throw new JpegMetaError('Truncated JPEG without SOS or EOI');
}

function readJfifDensity(bytes: Uint8Array, segment: Segment): JpegInfo['dpi'] {
  if (segment.payloadLength < 14) throw new JpegMetaError('Truncated JFIF segment');
  const units = bytes[segment.payloadOffset + 7]!;
  const x = readU16BE(bytes, segment.payloadOffset + 8);
  const y = readU16BE(bytes, segment.payloadOffset + 10);
  if (x === 0 || y === 0) return null;
  if (units === 1) return { x, y };
  if (units === 2) return { x: x * 2.54, y: y * 2.54 };
  return null;
}

function readExif(bytes: Uint8Array, segment: Segment): ExifInfo {
  const tiff = segment.payloadOffset + 6;
  const end = segment.payloadOffset + segment.payloadLength;
  if (tiff + 8 > end) throw new JpegMetaError('Truncated EXIF TIFF header');
  const byteOrder = String.fromCharCode(bytes[tiff]!, bytes[tiff + 1]!);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') throw new JpegMetaError('Invalid EXIF byte order');
  const u16 = (at: number): number => {
    checkExifBounds(at, 2, tiff, end);
    return little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
  };
  const u32 = (at: number): number => {
    checkExifBounds(at, 4, tiff, end);
    if (little) return (bytes[at]! + bytes[at + 1]! * 0x100 + bytes[at + 2]! * 0x10000 + bytes[at + 3]! * 0x1000000) >>> 0;
    return (bytes[at]! * 0x1000000 + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!) >>> 0;
  };
  if (u16(tiff + 2) !== 42) throw new JpegMetaError('Invalid EXIF TIFF header');
  const ifd = tiff + u32(tiff + 4);
  checkExifBounds(ifd, 2, tiff, end);
  const count = u16(ifd);
  if (count > Math.floor((end - ifd - 2) / 12)) throw new JpegMetaError('Truncated EXIF IFD');
  let orientation: JpegInfo['orientation'] | null = null;
  let xResolution: number | null = null, yResolution: number | null = null, resolutionUnit = 2;
  for (let index = 0; index < count; index++) {
    const entry = ifd + 2 + index * 12;
    const tag = u16(entry), type = u16(entry + 2), values = u32(entry + 4);
    if (tag === 0x0112 && type === 3 && values === 1) {
      const value = u16(entry + 8);
      if (value >= 1 && value <= 8) orientation = value as JpegInfo['orientation'];
    } else if ((tag === 0x011a || tag === 0x011b) && type === 5 && values === 1) {
      const at = tiff + u32(entry + 8);
      const numerator = u32(at), denominator = u32(at + 4);
      if (denominator !== 0) {
        if (tag === 0x011a) xResolution = numerator / denominator;
        else yResolution = numerator / denominator;
      }
    } else if (tag === 0x0128 && type === 3 && values === 1) {
      resolutionUnit = u16(entry + 8);
    }
  }
  let dpi: JpegInfo['dpi'] = null;
  if (xResolution !== null && yResolution !== null && xResolution > 0 && yResolution > 0) {
    if (resolutionUnit === 2) dpi = { x: xResolution, y: yResolution };
    else if (resolutionUnit === 3) dpi = { x: xResolution * 2.54, y: yResolution * 2.54 };
  }
  return { orientation, dpi };
}

function checkExifBounds(offset: number, length: number, start: number, end: number): void {
  if (!Number.isSafeInteger(offset) || offset < start || length < 0 || offset + length > end) {
    throw new JpegMetaError('EXIF offset is outside the APP1 segment');
  }
}

function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new JpegMetaError('Truncated JPEG integer');
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}
function writeU16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 8;
  bytes[offset + 1] = value;
}
