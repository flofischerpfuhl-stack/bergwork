import { Unzlib } from 'fflate';
import { Raster, TILE } from '../core/raster';
import type { PixelArray, RasterFormat } from '../core/pixel/format';
import type { RasterResidency, StoredRasterTiles } from '../core/storage';
import type { TileAsset } from '../core/storage/tileCache';
import type { StreamingSha256 } from './sha256';
import type { PngLimits } from './png';

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export interface StreamedPngRaster {
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly format: RasterFormat;
  readonly tiles: readonly (TileAsset | null)[];
  readonly reduced: Raster;
  readonly sha256: string;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! * 0x1000000 + (bytes[offset + 1]! << 16)
    + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
}

function typeName(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Incrementally turns the editor's non-interlaced gray/RGBA PNG assets into scratch-backed tiles. */
export class PngTileStreamDecoder {
  private carry = new Uint8Array();
  private signature = false;
  private chunkType = '';
  private chunkRemaining = 0;
  private crcRemaining = 0;
  private headerPayload: Uint8Array | null = null;
  private inflater: Unzlib | null = null;
  private widthValue = 0;
  private heightValue = 0;
  private channelsValue: 1 | 4 = 4;
  private bitDepth: 8 | 16 = 8;
  private rowBytes = 0;
  private bytesPerPixel = 0;
  private scanCarry = new Uint8Array();
  private previous = new Uint8Array();
  private y = 0;
  private bandTiles: PixelArray[] = [];
  private bandRow = -1;
  private readonly assets: (TileAsset | null)[] = [];
  private reduced: Uint8Array | Uint16Array | null = null;
  private storeChain = Promise.resolve();
  private error: Error | null = null;
  private ended = false;

  constructor(private readonly residency: RasterResidency, private readonly limits: PngLimits,
    private readonly hash: StreamingSha256) {}

  push(chunk: Uint8Array): void {
    if (this.error) return;
    this.hash.update(chunk);
    const input = new Uint8Array(this.carry.byteLength + chunk.byteLength);
    input.set(this.carry); input.set(chunk, this.carry.byteLength);
    let offset = 0;
    try {
      while (offset < input.byteLength) {
        if (!this.signature) {
          if (input.byteLength - offset < SIGNATURE.byteLength) break;
          for (let i = 0; i < SIGNATURE.byteLength; i++) if (input[offset + i] !== SIGNATURE[i]) throw new Error('Invalid PNG signature');
          offset += SIGNATURE.byteLength; this.signature = true;
          continue;
        }
        if (!this.chunkType) {
          if (input.byteLength - offset < 8) break;
          this.chunkRemaining = u32(input, offset);
          this.chunkType = typeName(input, offset + 4);
          this.crcRemaining = 4;
          offset += 8;
          if (this.chunkType === 'IHDR') {
            if (this.chunkRemaining !== 13) throw new Error('Invalid PNG header');
            this.headerPayload = new Uint8Array(13);
          }
          continue;
        }
        if (this.chunkRemaining) {
          const take = Math.min(this.chunkRemaining, input.byteLength - offset);
          const part = input.subarray(offset, offset + take);
          if (this.chunkType === 'IDAT') {
            if (!this.inflater) throw new Error('PNG image data precedes its header');
            this.inflater.push(part);
          } else if (this.chunkType === 'IHDR') {
            this.headerPayload!.set(part, 13 - this.chunkRemaining);
          }
          this.chunkRemaining -= take; offset += take;
          if (this.chunkRemaining) break;
          if (this.chunkType === 'IHDR') this.acceptHeader(this.headerPayload!);
          continue;
        }
        if (this.crcRemaining) {
          const take = Math.min(this.crcRemaining, input.byteLength - offset);
          this.crcRemaining -= take; offset += take;
          if (this.crcRemaining) break;
        }
        const finished = this.chunkType;
        this.chunkType = ''; this.headerPayload = null;
        if (finished === 'IEND') {
          this.inflater?.push(new Uint8Array(), true);
          this.ended = true;
        }
      }
    } catch (cause) { this.error = cause instanceof Error ? cause : new Error(String(cause)); }
    this.carry = input.slice(offset);
  }

  private acceptHeader(bytes: Uint8Array): void {
    const width = u32(bytes, 0), height = u32(bytes, 4), depth = bytes[8]!, colorType = bytes[9]!, interlace = bytes[12]!;
    if (!width || !height || width > this.limits.maxSide || height > this.limits.maxSide || width * height > this.limits.maxPixels) {
      throw new Error('PNG dimensions exceed the document limit');
    }
    if ((depth !== 8 && depth !== 16) || (colorType !== 0 && colorType !== 6) || interlace !== 0
      || (colorType === 0 && depth !== 8)) throw new Error('Streaming requires a non-interlaced gray8, RGBA8, or RGBA16 PNG');
    this.widthValue = width; this.heightValue = height;
    this.channelsValue = colorType === 0 ? 1 : 4;
    this.bitDepth = depth;
    this.bytesPerPixel = this.channelsValue * (depth / 8);
    this.rowBytes = width * this.bytesPerPixel;
    this.previous = new Uint8Array(this.rowBytes);
    const reducedWidth = Math.ceil(width / 8), reducedHeight = Math.ceil(height / 8);
    this.reduced = depth === 16 ? new Uint16Array(reducedWidth * reducedHeight * this.channelsValue)
      : new Uint8Array(reducedWidth * reducedHeight * this.channelsValue);
    this.inflater = new Unzlib((data) => this.acceptInflated(data));
  }

  private acceptInflated(data: Uint8Array): void {
    const bytes = new Uint8Array(this.scanCarry.byteLength + data.byteLength);
    bytes.set(this.scanCarry); bytes.set(data, this.scanCarry.byteLength);
    const scanline = this.rowBytes + 1;
    let offset = 0;
    while (offset + scanline <= bytes.byteLength) {
      this.acceptRow(bytes[offset]!, bytes.subarray(offset + 1, offset + scanline));
      offset += scanline;
    }
    this.scanCarry = bytes.slice(offset);
  }

  private acceptRow(filter: number, encoded: Uint8Array): void {
    if (this.y >= this.heightValue || filter > 4) throw new Error('Invalid or excessive PNG scanline data');
    const row = new Uint8Array(this.rowBytes);
    if (filter === 0) row.set(encoded);
    else for (let i = 0; i < row.length; i++) {
        const left = i >= this.bytesPerPixel ? row[i - this.bytesPerPixel]! : 0;
        const up = this.previous[i]!;
        const upperLeft = i >= this.bytesPerPixel ? this.previous[i - this.bytesPerPixel]! : 0;
        const prediction = filter === 1 ? left : filter === 2 ? up
          : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
        row[i] = encoded[i]! + prediction;
      }
    const tileRow = Math.floor(this.y / TILE);
    if (tileRow !== this.bandRow) this.startBand(tileRow);
    const localY = this.y - tileRow * TILE;
    for (let col = 0; col < this.bandTiles.length; col++) {
      const width = Math.min(TILE, this.widthValue - col * TILE);
      const samples = width * this.channelsValue;
      const target = this.bandTiles[col]!;
      if (this.bitDepth === 8) target.set(row.subarray(col * TILE * this.channelsValue, col * TILE * this.channelsValue + samples), localY * samples);
      else {
        const out = target as Uint16Array, source = col * TILE * this.channelsValue * 2;
        for (let i = 0; i < samples; i++) out[localY * samples + i] = (row[source + i * 2]! << 8) | row[source + i * 2 + 1]!;
      }
    }
    if ((this.y & 7) === 0) this.sampleReduced(row);
    this.previous = row; this.y++;
    if (this.y === this.heightValue || this.y % TILE === 0) this.finishBand();
  }

  private startBand(tileRow: number): void {
    this.bandRow = tileRow;
    const height = Math.min(TILE, this.heightValue - tileRow * TILE);
    const format: RasterFormat = this.bitDepth === 16 ? 'rgba16' : this.channelsValue === 4 ? 'rgba8' : 'gray8';
    this.bandTiles = Array.from({ length: Math.ceil(this.widthValue / TILE) }, (_, col) => {
      const length = Math.min(TILE, this.widthValue - col * TILE) * height * this.channelsValue;
      return format === 'rgba16' ? new Uint16Array(length) : new Uint8Array(length);
    });
  }

  private finishBand(): void {
    const tiles = this.bandTiles;
    const format: RasterFormat = this.bitDepth === 16 ? 'rgba16' : this.channelsValue === 4 ? 'rgba8' : 'gray8';
    this.bandTiles = [];
    this.storeChain = this.storeChain.then(async () => {
      for (const tile of tiles) {
        let nonzero = false;
        for (let i = 0; i < tile.length; i++) if (tile[i]) { nonzero = true; break; }
        this.assets.push(nonzero ? await this.residency.cache.store(tile, format) : null);
      }
    }).catch((cause: unknown) => { this.error = cause instanceof Error ? cause : new Error(String(cause)); });
  }

  private sampleReduced(row: Uint8Array): void {
    const reduced = this.reduced!;
    const reducedWidth = Math.ceil(this.widthValue / 8), targetY = this.y >> 3;
    for (let x = 0; x < this.widthValue; x += 8) {
      const target = (targetY * reducedWidth + (x >> 3)) * this.channelsValue;
      const source = x * this.bytesPerPixel;
      for (let channel = 0; channel < this.channelsValue; channel++) {
        reduced[target + channel] = this.bitDepth === 8 ? row[source + channel]!
          : (row[source + channel * 2]! << 8) | row[source + channel * 2 + 1]!;
      }
    }
  }

  async idle(): Promise<void> { await this.storeChain; if (this.error) throw this.error; }

  async finish(): Promise<StreamedPngRaster> {
    await this.idle();
    if (this.error) throw this.error;
    if (!this.ended || this.y !== this.heightValue || this.scanCarry.byteLength || !this.reduced) {
      throw new Error(`Truncated PNG stream (IEND=${this.ended}, rows=${this.y}/${this.heightValue}, residual=${this.scanCarry.byteLength})`);
    }
    const format: RasterFormat = this.bitDepth === 16 ? 'rgba16' : this.channelsValue === 4 ? 'rgba8' : 'gray8';
    const width = Math.ceil(this.widthValue / 8), height = Math.ceil(this.heightValue / 8);
    return { width: this.widthValue, height: this.heightValue, channels: this.channelsValue, format,
      tiles: this.assets, reduced: Raster.fromPixels(width, height, this.channelsValue, this.reduced, { format }),
      sha256: this.hash.digestHex() };
  }
}

export function restoreStreamedPng(record: StreamedPngRaster, id: string, residency: RasterResidency): Raster {
  const stored: StoredRasterTiles = { width: record.width, height: record.height, channels: record.channels,
    format: record.format, id, tiles: record.tiles };
  return residency.restore(stored, record.reduced, { mime: 'image/png', sha256: record.sha256 });
}

/** Keeps the legacy reader's gray/RGBA coercion without joining the full image. */
export async function convertStreamedPng(record: StreamedPngRaster, channels: 1 | 4,
  residency: RasterResidency): Promise<StreamedPngRaster> {
  if (record.channels === channels) return record;
  const format: RasterFormat = channels === 1 ? 'gray8' : record.format === 'rgba16' ? 'rgba16' : 'rgba8';
  const maximum = format === 'rgba16' ? 65535 : 255;
  const tiles: (TileAsset | null)[] = [];
  const cols = Math.ceil(record.width / TILE), rows = Math.ceil(record.height / TILE);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const asset = record.tiles[row * cols + col];
      if (!asset) { tiles.push(null); continue; }
      const source = await residency.cache.load(asset);
      const pixels = source.length / record.channels;
      const target: PixelArray = format === 'rgba16' ? new Uint16Array(pixels * channels) : new Uint8Array(pixels * channels);
      if (channels === 1) {
        for (let i = 0; i < pixels; i++) target[i] = source[i * 4]!;
      } else {
        for (let i = 0; i < pixels; i++) {
          const value = source[i]!;
          target[i * 4] = value; target[i * 4 + 1] = value; target[i * 4 + 2] = value; target[i * 4 + 3] = maximum;
        }
      }
      tiles.push(await residency.cache.store(target, format));
    }
  }
  const sourceReduced = record.reduced.toPixelsNative(), pixels = sourceReduced.length / record.channels;
  const reduced: PixelArray = format === 'rgba16' ? new Uint16Array(pixels * channels) : new Uint8Array(pixels * channels);
  if (channels === 1) {
    for (let i = 0; i < pixels; i++) reduced[i] = sourceReduced[i * 4]!;
  } else {
    for (let i = 0; i < pixels; i++) {
      const value = sourceReduced[i]!;
      reduced[i * 4] = value; reduced[i * 4 + 1] = value; reduced[i * 4 + 2] = value; reduced[i * 4 + 3] = maximum;
    }
  }
  return { ...record, channels, format, tiles,
    reduced: Raster.fromPixels(record.reduced.width, record.reduced.height, channels, reduced, { format }) };
}
