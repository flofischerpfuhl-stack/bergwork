import type { EditorHandle, HostAdapter, Matrix2D } from './contracts';

export type AssetIdV2 = string;
export type LayerIdV2 = string;
export type PointV2 = Readonly<{ x: number; y: number }>;
export type RectV2 = Readonly<{ x: number; y: number; width: number; height: number }>;
export type RGBV2 = Readonly<{ red: number; green: number; blue: number }>;
export interface EffectGradientV2 {
  stops: readonly { offset: number; color: RGBV2; opacity: number }[];
  reverse?: boolean;
}
export type EffectFillV2 =
  | { kind: 'color'; color: RGBV2 }
  | { kind: 'gradient'; gradient: EffectGradientV2; angle: number; scale: number };

export interface AssetRecordV2 {
  id: AssetIdV2;
  path: string;
  mime: string;
  width?: number;
  height?: number;
  channels?: 1 | 4;
  sha256: string;
  role: 'image' | 'mask' | 'pattern' | 'embedded' | 'font' | 'lut' | 'history-tile' | 'brushes';
}

export interface TextRunStyleRecordV2 {
  schemaVersion: 1;
  fontFamily: string;
  fontStyle: 'normal' | 'italic' | 'oblique';
  fontWeight: number;
  fontSize: number;
  color: RGBV2 & { alpha?: number };
  tracking: number;
  kerning: 'metric' | 'optical' | 'none';
  leading: number | null;
  baselineShift: number;
  features: Partial<Record<'liga' | 'dlig' | 'tnum' | 'lnum' | 'onum' | 'smcp', boolean>>;
  axes: Record<string, number>;
}
export interface TextRunRecordV2 { from: number; to: number; style: TextRunStyleRecordV2 }
export interface TextParagraphStyleRecordV2 {
  schemaVersion: 1;
  alignment: 'left' | 'center' | 'right' | 'justify';
  direction: 'auto' | 'ltr' | 'rtl';
  firstLineIndent: number;
  startIndent: number;
  endIndent: number;
  spaceBefore: number;
  spaceAfter: number;
}
export interface TextParagraphRecordV2 { from: number; to: number; style: TextParagraphStyleRecordV2 }
export interface DocumentFontRecordV2 {
  id: string;
  family: string;
  style: string;
  weight: number;
  source: 'bundled' | 'system' | 'local' | 'embedded';
  postscriptName?: string;
  resourceId?: AssetIdV2;
  embeddingAllowed: boolean;
}

export interface LayerTransformV2 {
  origin: PointV2;
  size: Readonly<{ width: number; height: number }>;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  sampling: 'Nearest' | 'Smooth' | 'High quality';
}

export type LayerWarpV2 =
  | { kind: 'quad'; schemaVersion: 1; corners: readonly [PointV2, PointV2, PointV2, PointV2] }
  | { kind: 'mesh'; schemaVersion: 1; splits: Readonly<{ x: number; y: number }>; points: readonly PointV2[];
      preset?: 'custom' | 'arc' | 'flag' | 'bulge' | 'wave' | 'fish' | 'rise' | 'inflate' | 'squeeze' };

export interface LayerCommonV2 {
  id: LayerIdV2;
  parentId: LayerIdV2 | null;
  name: string;
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: string;
  locks: { transparency: boolean; pixels: boolean; position: boolean; all: boolean };
  colorLabel: 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';
  transform: LayerTransformV2;
  warp: LayerWarpV2 | null;
  crop: { rect: RectV2; feather: number } | null;
  mask: { assetId: AssetIdV2; transform: LayerTransformV2 | null; linked: boolean; enabled: boolean } | null;
  vectorMask: VectorMaskRecordV2 | null;
  clippedTo: LayerIdV2 | null;
  effects: readonly EffectRecordV2[];
  filters: readonly FilterRecordV2[];
}

export interface VectorPathRecordV2 {
  schemaVersion?: 1;
  closed: boolean;
  fillRule?: 'nonzero' | 'evenodd';
  points: readonly { anchor: PointV2; in: PointV2; out: PointV2; kind?: 'corner' | 'smooth' }[];
}
/** Text on a path (Phase 3): the path in the layer's frame pixels, range fractions, flip and baseline offset (points). */
export interface TextPathRecordV2 {
  schemaVersion: 1;
  path: VectorPathRecordV2;
  start: number;
  end: number;
  flipped: boolean;
  baselineOffset: number;
}
/** Warp Text envelope (Phase 3); percentages −100…100. */
export interface TextWarpRecordV2 {
  schemaVersion: 1;
  style: 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge' | 'shellLower' | 'shellUpper' | 'flag' | 'wave' | 'fish' | 'rise'
    | 'fisheye' | 'inflate' | 'squeeze' | 'twist';
  orientation: 'horizontal' | 'vertical';
  bend: number;
  horizontalDistortion: number;
  verticalDistortion: number;
}
export interface VectorMaskRecordV2 { schemaVersion?: 1; enabled: boolean; inverted: boolean; density?: number; feather?: number; paths: readonly VectorPathRecordV2[] }

export interface VectorStrokeRecordV2 {
  paint?: FillRecordV2;
  color: RGBV2;
  width: number;
  alignment: 'inside' | 'center' | 'outside';
  cap?: 'butt' | 'round' | 'square';
  join?: 'miter' | 'round' | 'bevel';
  miterLimit?: number;
  dash?: readonly number[];
  dashOffset?: number;
  startMarker?: 'none' | 'arrow' | 'openArrow' | 'circle' | 'square';
  endMarker?: 'none' | 'arrow' | 'openArrow' | 'circle' | 'square';
  markerSize?: number;
}

export interface ParametricShapeRecordV2 {
  schemaVersion?: 1;
  kind: 'Rectangle' | 'Ellipse' | 'Polygon' | 'Star' | 'Line';
  red: number; green: number; blue: number; cornerRadius: number;
  cornerRadii?: readonly [number, number, number, number];
  sides?: number;
  innerRatio?: number;
  lineWidth?: number;
}

export type EffectRecordV2 =
  | { kind: 'dropShadow'; schemaVersion: 1; enabled: boolean; opacity: number; angle: number; distance: number; blur: number;
      color: RGBV2; blendMode?: string; useGlobalLight?: boolean; spread?: number; size?: number; contour?: 'linear'; noise?: 0; knockout?: boolean }
  | { kind: 'stroke'; schemaVersion: 1; enabled: boolean; width: number; position: 'inside' | 'center' | 'outside';
      color?: RGBV2; fill?: EffectFillV2; opacity?: number; blendMode?: string }
  | { kind: 'outerGlow'; schemaVersion: 1; enabled: boolean; opacity: number; color: RGBV2; blendMode: string;
      spread: number; size: number; contour: 'linear'; noise: 0 }
  | { kind: 'colorOverlay'; schemaVersion: 1; enabled: boolean; opacity: number; color: RGBV2; blendMode?: string }
  | { kind: 'gradientOverlay'; schemaVersion: 1; enabled: boolean; opacity: number; blendMode: string; angle: number;
      scale: number; gradient: EffectGradientV2 }
  | { kind: 'innerShadow'; schemaVersion: 1; enabled: boolean; opacity: number; blendMode: string; color: RGBV2;
      angle: number; useGlobalLight: boolean; distance: number; choke: number; size: number; contour: 'linear' }
  | { kind: 'innerGlow'; schemaVersion: 1; enabled: boolean; opacity: number; blendMode: string; color: RGBV2;
      source: 'edge' | 'center'; choke: number; size: number; contour: 'linear' }
  | { kind: 'bevelEmboss'; schemaVersion: 1; enabled: boolean; style: 'innerBevel' | 'outerBevel' | 'emboss' | 'pillowEmboss';
      technique: 'smooth' | 'chiselHard' | 'chiselSoft'; depth: number; direction: 'up' | 'down'; size: number; soften: number;
      angle: number; altitude: number; useGlobalLight: boolean; highlightMode: string; highlightColor: RGBV2;
      highlightOpacity: number; shadowMode: string; shadowColor: RGBV2; shadowOpacity: number; glossContour: 'linear' }
  | { kind: 'satin'; schemaVersion: 1; enabled: boolean; opacity: number; blendMode: string; color: RGBV2;
      angle: number; distance: number; size: number; invert: boolean; contour: 'linear' }
  | { kind: 'patternOverlay'; schemaVersion: 1; enabled: boolean; opacity: number; blendMode: string;
      resourceId: AssetIdV2; patternWidth: number; patternHeight: number; scale: number; angle: number;
      linkWithLayer: boolean; phase?: PointV2 };

export type FilterRecordV2 =
  | { kind: 'gaussianBlur'; schemaVersion: 1; enabled: boolean; radius: number }
  | { kind: 'motionBlur'; schemaVersion: 1; enabled: boolean; angle: number; distance: number }
  | { kind: 'noise'; schemaVersion: 1; enabled: boolean; amount: number; gaussian: boolean; monochromatic: boolean }
  | { kind: 'lensCorrection'; schemaVersion: 1; enabled: boolean; distortion: number }
  | { kind: 'unsharpMask'; schemaVersion: 1; enabled: boolean; amount: number; radius: number; threshold: number }
  | { kind: 'smartSharpen'; schemaVersion: 1; enabled: boolean; amount: number; radius: number; threshold: number; reduceNoise: number }
  | { kind: 'highPass'; schemaVersion: 1; enabled: boolean; radius: number }
  | { kind: 'denoise'; schemaVersion: 1; enabled: boolean; luminance: number; colour: number };

export interface HueSaturationParametersV1 {
  hue: number; saturation: number; lightness: number; colorize: boolean;
  settings: {
    range: 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
    colorize: boolean;
    invertRange: boolean;
    adjustments: Partial<Record<'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas',
      { hue: number; saturation: number; lightness: number }>>;
    bands: Partial<Record<'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas',
      { falloffStart: number; rangeStart: number; rangeEnd: number; falloffEnd: number }>>;
  };
}
export interface LevelsParametersV1 { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; ranges: readonly { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }[] }
export interface CurvesParametersV1 { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; channels: readonly (readonly { x: number; y: number }[])[] }
export interface ExposureParametersV1 { exposure: number; offset: number; gamma: number }
export interface GradientMapParametersV1 { shadows: RGBV2; highlights: RGBV2; reversed: boolean }
export interface GrainParametersV1 { amount: number; size: number; roughness: number; seed: number }
export interface BasicParametersV1 {
  exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number;
  texture: number; clarity: number; dehaze: number; vibrance: number; saturation: number; temperature: number; tint: number;
}
export interface ColourLookupParametersV1 { resourceId: AssetIdV2; interpolation: 'trilinear' | 'tetrahedral' }
export interface ColourParametersV1 {
  blackAndWhite: { enabled: boolean; reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number;
    tint: boolean; tintColor: RGBV2 };
  colourBalance: { enabled: boolean; shadows: { cyanRed: number; magentaGreen: number; yellowBlue: number };
    midtones: { cyanRed: number; magentaGreen: number; yellowBlue: number };
    highlights: { cyanRed: number; magentaGreen: number; yellowBlue: number }; preserveLuminosity: boolean };
  selectiveColour: { mode: 'relative' | 'absolute'; ranges: Partial<Record<
    'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas' | 'Whites' | 'Neutrals' | 'Blacks',
    { cyan: number; magenta: number; yellow: number; black: number }>> };
}
export type AdjustmentRecordV2 =
  | { kind: 'Hue/Saturation'; schemaVersion: 1; parameters: HueSaturationParametersV1 }
  | { kind: 'Levels'; schemaVersion: 1; parameters: LevelsParametersV1 }
  | { kind: 'Curves'; schemaVersion: 1; parameters: CurvesParametersV1 }
  | { kind: 'Exposure'; schemaVersion: 1; parameters: ExposureParametersV1 }
  | { kind: 'Gradient Map'; schemaVersion: 1; parameters: GradientMapParametersV1 }
  | { kind: 'Grain'; schemaVersion: 1; parameters: GrainParametersV1 }
  | { kind: 'Basic'; schemaVersion: 1; parameters: BasicParametersV1 }
  | { kind: 'Colour Lookup'; schemaVersion: 1; parameters: ColourLookupParametersV1 }
  | { kind: 'Colour'; schemaVersion: 1; parameters: ColourParametersV1 }
  | { kind: 'Invert'; schemaVersion: 1; parameters: Record<string, never> }
  | { kind: 'Threshold'; schemaVersion: 1; parameters: { level: number } }
  | { kind: 'Posterize'; schemaVersion: 1; parameters: { levels: number } }
  | { kind: 'Brightness/Contrast'; schemaVersion: 1; parameters: { brightness: number; contrast: number; legacy: boolean } }
  | { kind: 'Photo Filter'; schemaVersion: 1; parameters: { color: RGBV2; density: number; preserveLuminosity: boolean } }
  | { kind: 'Channel Mixer'; schemaVersion: 1; parameters: { monochrome: boolean;
      red: { red: number; green: number; blue: number; constant: number }; green: { red: number; green: number; blue: number; constant: number };
      blue: { red: number; green: number; blue: number; constant: number }; gray: { red: number; green: number; blue: number; constant: number } } };

export type FillRecordV2 =
  | { kind: 'solid'; schemaVersion: 1; color: RGBV2 }
  | { kind: 'gradient'; schemaVersion: 1; angle: number; stops: readonly { offset: number; color: RGBV2; opacity: number }[] }
  | { kind: 'pattern'; schemaVersion: 1; assetId: AssetIdV2; scale: number; angle: number };

export type LayerRecordV2 =
  | (LayerCommonV2 & { kind: 'pixel'; assetId: AssetIdV2 | null })
  | (LayerCommonV2 & { kind: 'group' })
  | (LayerCommonV2 & { kind: 'adjustment'; adjustment: AdjustmentRecordV2 })
  | (LayerCommonV2 & { kind: 'fill'; fill: FillRecordV2 })
  | (LayerCommonV2 & { kind: 'vector'; paths: readonly VectorPathRecordV2[]; style: { schemaVersion?: 1; fill: FillRecordV2 | null; stroke: VectorStrokeRecordV2 | null }; previewAssetId: AssetIdV2 | null;
      sourceShape: ParametricShapeRecordV2 | null })
  | (LayerCommonV2 & { kind: 'text'; textSchemaVersion: 1; text: string; runs: readonly TextRunRecordV2[];
      paragraphs: readonly TextParagraphRecordV2[]; box: { width: number; height: number } | null;
      alignment: 'left' | 'center' | 'right' | 'justify'; previewAssetId: AssetIdV2 | null;
      previewTransform: LayerTransformV2 | null;
      /** Optional; absent in files written before Phase 3 (read as none). */
      textPath?: TextPathRecordV2 | null; textWarp?: TextWarpRecordV2 | null })
  | (LayerCommonV2 & { kind: 'embedded'; content: { mode: 'embedded' | 'linked'; mediaType: 'image' | 'svg' | 'pdf' | 'project'; assetId?: AssetIdV2; uri?: string; sourceName: string }; previewAssetId: AssetIdV2 | null });

export interface ArtboardRecordV2 {
  id: string;
  name: string;
  rect: RectV2;
  background: RGBV2 & { alpha: number };
  colorLabel: LayerCommonV2['colorLabel'];
}

export interface HistorySnapshotRecordV2 {
  id: string;
  path: string;
  activeLayerId: LayerIdV2 | null;
  revision: number;
}
export interface HistoryCommandRecordV2 { name: string; before: string; after: string }
export interface ProjectHistoryV2 {
  schemaVersion: 1;
  enabled: boolean;
  retainedByteLimit: number;
  cursor: number;
  commands: readonly HistoryCommandRecordV2[];
  snapshots: readonly HistorySnapshotRecordV2[];
}

export interface ProjectManifestV2 {
  format: 'fernwork-image';
  version: 2;
  id: string;
  name: string;
  width: number;
  height: number;
  resolution: number;
  /** Shared Photoshop-style lighting angle, clockwise in document coordinates. */
  globalLightAngle?: number;
  colorSpace: 'srgb';
  activeLayerId: LayerIdV2 | null;
  layers: readonly LayerRecordV2[];
  artboards: readonly ArtboardRecordV2[];
  /** Ruler guides (optional; absent in files written before guides existed). */
  guides?: readonly { id: string; orientation: 'horizontal' | 'vertical'; position: number }[];
  assets: readonly AssetRecordV2[];
  fonts?: readonly DocumentFontRecordV2[];
  /** Document swatch groups (optional; absent in files written before swatches existed). sRGB floats 0…1. */
  swatches?: readonly SwatchGroupRecordV2[];
  history?: ProjectHistoryV2;
  extensions?: Record<string, unknown>;
}

/** Additive host surface; the v1 `EditorHandle` remains source-compatible. */
export interface EditorHandleV2 extends EditorHandle {
  getManifestV2(): ProjectManifestV2;
}

export type EditorProfileId = 'pro' | 'lite';
export interface MountEditorOptionsV2 {
  host: HostAdapter;
  locale?: 'de' | 'en';
  theme?: 'dark' | 'light';
  profile?: EditorProfileId;
}
export type MountEditorV2 = (root: HTMLElement, options: MountEditorOptionsV2) => Promise<EditorHandleV2>;

/** Migration readers may use v1 affine matrices while reconstructing semantic transforms. */
export type LegacyMatrixV1 = Matrix2D;

export interface SwatchGroupRecordV2 {
  id: string;
  name: string;
  swatches: readonly { id: string; name: string; color: { red: number; green: number; blue: number } }[];
}
