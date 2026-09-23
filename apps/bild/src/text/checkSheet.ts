import { Raster } from '../core/raster';
import type { ParagraphMetrics, ParagraphRequest, TextEngine } from './types';

export const BUNDLED_FONTS = [
  { id: 'noto-sans-variable', family: 'Noto Sans', url: '/fonts/NotoSans-Variable.ttf' },
  { id: 'noto-sans-arabic-variable', family: 'Noto Sans Arabic', url: '/fonts/NotoSansArabic-Variable.ttf' },
  { id: 'noto-sans-devanagari-variable', family: 'Noto Sans Devanagari', url: '/fonts/NotoSansDevanagari-Variable.ttf' },
] as const;

const PERFORMANCE_SOURCE = 'Fernwork Bildeditor lays out a long paragraph with kerning, ligatures, umlauts, '
  + 'Arabic العربية and Devanagari देवनागरी. The same HarfBuzz shaping and Skia rasterization must remain '
  + 'predictable in every supported host while wrapping words over several measured lines. ';

export const PERFORMANCE_PARAGRAPH = PERFORMANCE_SOURCE.repeat(3).slice(0, 500);

export interface IntegrationSheetResult {
  readonly raster: Raster;
  readonly paragraphMetrics: readonly ParagraphMetrics[];
  readonly unresolvedCodepoints: readonly number[];
}

export async function loadBundledFonts(engine: TextEngine): Promise<void> {
  for (const font of BUNDLED_FONTS) {
    const response = await fetch(font.url);
    if (!response.ok) throw new Error(`Could not load bundled font ${font.url}: HTTP ${response.status}`);
    engine.registerFont({ ...font, source: font.url, bytes: await response.arrayBuffer() });
  }
}

function fillOpaque(pixels: Uint8Array, red: number, green: number, blue: number): void {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
}

function composite(destination: Uint8Array, destinationWidth: number, destinationHeight: number,
  source: Raster, left: number, top: number): void {
  const pixels = source.toPixels();
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const x1 = Math.min(destinationWidth, left + source.width), y1 = Math.min(destinationHeight, top + source.height);
  for (let y = y0; y < y1; y++) {
    let src = ((y - top) * source.width + x0 - left) * 4;
    let dst = (y * destinationWidth + x0) * 4;
    for (let x = x0; x < x1; x++, src += 4, dst += 4) {
      const alpha = pixels[src + 3]!;
      if (alpha === 0) continue;
      const inverse = 255 - alpha;
      destination[dst] = Math.round((pixels[src]! * alpha + destination[dst]! * inverse) / 255);
      destination[dst + 1] = Math.round((pixels[src + 1]! * alpha + destination[dst + 1]! * inverse) / 255);
      destination[dst + 2] = Math.round((pixels[src + 2]! * alpha + destination[dst + 2]! * inverse) / 255);
      destination[dst + 3] = 255;
    }
  }
}

/** A5 acceptance sheet: shaping/fallback, variable axes, PathOps, gradients and dashed joins. */
export function renderIntegrationSheet(engine: TextEngine): IntegrationSheetResult {
  const width = 960, height = 680;
  const pixels = new Uint8Array(width * height * 4);
  fillOpaque(pixels, 248, 249, 252);
  const metrics: ParagraphMetrics[] = [];
  const unresolved = new Set<number>();
  const families = ['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari'];
  const drawText = (request: ParagraphRequest, x: number, y: number) => {
    const layout = engine.layoutParagraph(request);
    try {
      metrics.push({
        width: layout.width, height: layout.height, longestLine: layout.longestLine, lineCount: layout.lineCount,
        alphabeticBaseline: layout.alphabeticBaseline, exceededMaxLines: layout.exceededMaxLines,
        unresolvedCodepoints: layout.unresolvedCodepoints,
      });
      for (const codepoint of layout.unresolvedCodepoints) unresolved.add(codepoint);
      composite(pixels, width, height, engine.rasterizeParagraph(layout, 2).raster, x - 2, y - 2);
    } finally {
      layout.dispose();
    }
  };

  drawText({ text: 'Fernwork text/vector integration sheet', width: 900, fontFamilies: families, fontSize: 30,
    color: { red: 18, green: 31, blue: 53 }, fontVariations: [{ axis: 'wght', value: 720 }] }, 30, 22);
  drawText({ text: 'AVATAR · office affine efficient · Übergrößenträger · 0123456789', width: 900,
    fontFamilies: families, fontSize: 25, color: { red: 35, green: 45, blue: 65 },
    fontFeatures: [{ name: 'kern', value: 1 }, { name: 'liga', value: 1 }] }, 30, 76);
  drawText({ text: 'اللغة العربية جميلة — تشكيل النص بمحرك HarfBuzz', width: 900,
    fontFamilies: families, fontSize: 27, direction: 'rtl', alignment: 'right', color: { red: 20, green: 78, blue: 105 } }, 30, 122);
  drawText({ text: 'देवनागरी में संयुक्त अक्षर: क्ष त्र ज्ञ — सुंदर अक्षर विन्यास', width: 900,
    fontFamilies: families, fontSize: 27, color: { red: 98, green: 48, blue: 113 } }, 30, 168);
  drawText({ text: 'Variable font: condensed light  <->  expanded bold', width: 900, fontFamilies: families, fontSize: 31,
    color: { red: 112, green: 65, blue: 18 }, fontVariations: [{ axis: 'wdth', value: 70 }, { axis: 'wght', value: 300 }] }, 30, 216);
  drawText({ text: 'Variable font: condensed light  <->  expanded bold', width: 900, fontFamilies: families, fontSize: 31,
    color: { red: 112, green: 65, blue: 18 }, fontVariations: [{ axis: 'wdth', value: 100 }, { axis: 'wght', value: 850 }] }, 30, 258);
  drawText({ text: PERFORMANCE_PARAGRAPH, width: 900, fontFamilies: families, fontSize: 15,
    color: { red: 42, green: 49, blue: 66 }, heightMultiplier: 1.25 }, 30, 310);

  const first = 'M25 25H130V130H25Z';
  const second = 'M80 5L155 77L80 150L5 77Z';
  const union = engine.combinePaths(first, second, 'union');
  const difference = engine.combinePaths(first, second, 'difference');
  composite(pixels, width, height, engine.rasterizePath({ width: 170, height: 160, svgPath: union,
    fill: { kind: 'linear-gradient', start: [0, 0], end: [170, 160],
      colors: [{ red: 24, green: 160, blue: 176 }, { red: 43, green: 83, blue: 184 }] } }).raster, 40, 500);
  composite(pixels, width, height, engine.rasterizePath({ width: 170, height: 160, svgPath: difference,
    fill: { kind: 'solid', color: { red: 226, green: 83, blue: 94 } } }).raster, 255, 500);
  composite(pixels, width, height, engine.rasterizePath({ width: 430, height: 160,
    svgPath: 'M15 125L95 25L175 125L255 25L335 125L415 25',
    stroke: { color: { red: 30, green: 41, blue: 59 }, width: 13, dash: [24, 12], dashPhase: 5,
      join: 'round', cap: 'round' } }).raster, 480, 500);

  return { raster: Raster.fromPixels(width, height, 4, pixels), paragraphMetrics: metrics,
    unresolvedCodepoints: [...unresolved] };
}

export interface PerformanceResult {
  readonly runs: number;
  readonly characterCount: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export function measureParagraphPerformance(engine: TextEngine, runs = 50): PerformanceResult {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError('Run count must be a positive integer');
  const request: ParagraphRequest = {
    text: PERFORMANCE_PARAGRAPH, width: 620,
    fontFamilies: ['Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari'], fontSize: 16,
    heightMultiplier: 1.25, fontFeatures: [{ name: 'kern', value: 1 }, { name: 'liga', value: 1 }],
  };
  const run = () => {
    const started = performance.now();
    const layout = engine.layoutParagraph(request);
    try { engine.rasterizeParagraph(layout); } finally { layout.dispose(); }
    return performance.now() - started;
  };
  for (let i = 0; i < 5; i++) run();
  const samples = new Array<number>(runs);
  for (let i = 0; i < runs; i++) samples[i] = run();
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    runs, characterCount: PERFORMANCE_PARAGRAPH.length, samplesMs: samples,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    maxMs: sorted[sorted.length - 1]!,
  };
}
