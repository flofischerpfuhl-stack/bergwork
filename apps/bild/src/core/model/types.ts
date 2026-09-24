import type { LayerTransform, Point, Rect } from '../geometry';
import type { Raster } from '../raster';
import type { DocumentSelection } from '../selection';

/** All 27 Photoshop blend modes in its menu-group order (A8). */
export type BlendMode =
  | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'colorBurn' | 'linearBurn' | 'darkerColor'
  | 'lighten' | 'screen' | 'colorDodge' | 'linearDodge' | 'lighterColor'
  | 'overlay' | 'softLight' | 'hardLight' | 'vividLight' | 'linearLight' | 'pinLight' | 'hardMix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

/** Legacy UI registry; the complete engine union is `LayerAdjustmentKind`. */
export type AdjustmentKind = 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain';
export type LayerAdjustmentKind = AdjustmentKind
  | 'Basic' | 'Colour Lookup' | 'Colour' | 'Invert' | 'Threshold' | 'Posterize'
  | 'Brightness/Contrast' | 'Photo Filter' | 'Channel Mixer';
export type ColorLabel = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

export interface RGB { readonly red: number; readonly green: number; readonly blue: number }
export interface GradientStop { readonly offset: number; readonly color: RGB; readonly opacity: number }
export interface EffectGradient {
  readonly stops: readonly GradientStop[];
  readonly reverse?: boolean;
}
export type EffectFill =
  | { readonly kind: 'color'; readonly color: RGB }
  | { readonly kind: 'gradient'; readonly gradient: EffectGradient; readonly angle: number; readonly scale: number };
export type LevelsChannel = 'RGB' | 'Red' | 'Green' | 'Blue';
export type ColorRange = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
export interface RangeAdjustment { readonly hue: number; readonly saturation: number; readonly lightness: number }
export interface HueBand {
  readonly falloffStart: number; readonly rangeStart: number; readonly rangeEnd: number; readonly falloffEnd: number;
}
export interface HueSaturationSettings {
  readonly range: ColorRange; readonly colorize: boolean; readonly invertRange: boolean;
  readonly adjustments: Partial<Record<ColorRange, RangeAdjustment>>;
  readonly bands: Partial<Record<ColorRange, HueBand>>;
}
export interface LevelRange {
  readonly black: number; readonly gamma: number; readonly white: number;
  readonly outputBlack: number; readonly outputWhite: number;
}
export interface LevelsSettings { readonly channel: LevelsChannel; readonly ranges: readonly LevelRange[] }
export interface CurvePoint { readonly x: number; readonly y: number }
export interface CurvesSettings { readonly channel: LevelsChannel; readonly channels: readonly (readonly CurvePoint[])[] }
export interface ExposureSettings { readonly exposure: number; readonly offset: number; readonly gamma: number }
export interface GradientMapSettings { readonly shadows: RGB; readonly highlights: RGB; readonly reversed: boolean }
export interface GrainSettings { readonly amount: number; readonly size: number; readonly roughness: number; readonly seed: number }

/** P5's single photographic correction. Slider units are -100…100 except exposure (stops). */
export interface BasicSettings {
  readonly exposure: number; readonly contrast: number; readonly highlights: number; readonly shadows: number;
  readonly whites: number; readonly blacks: number; readonly texture: number; readonly clarity: number;
  readonly dehaze: number; readonly vibrance: number; readonly saturation: number;
  readonly temperature: number; readonly tint: number;
}
export type LutInterpolation = 'trilinear' | 'tetrahedral';
export interface ColourLookupSettings { readonly resourceId: string; readonly interpolation: LutInterpolation }
export interface BlackAndWhiteSettings {
  readonly enabled: boolean;
  readonly reds: number; readonly yellows: number; readonly greens: number;
  readonly cyans: number; readonly blues: number; readonly magentas: number;
  readonly tint: boolean; readonly tintColor: RGB;
}
export interface ColourBalanceTone { readonly cyanRed: number; readonly magentaGreen: number; readonly yellowBlue: number }
export type SelectiveColourRange = 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas'
  | 'Whites' | 'Neutrals' | 'Blacks';
export interface SelectiveColourValues { readonly cyan: number; readonly magenta: number; readonly yellow: number; readonly black: number }
export interface ColourSettings {
  readonly blackAndWhite: BlackAndWhiteSettings;
  readonly colourBalance: { readonly enabled: boolean; readonly shadows: ColourBalanceTone; readonly midtones: ColourBalanceTone;
    readonly highlights: ColourBalanceTone; readonly preserveLuminosity: boolean };
  readonly selectiveColour: { readonly mode: 'relative' | 'absolute';
    readonly ranges: Partial<Record<SelectiveColourRange, SelectiveColourValues>> };
}
export interface BrightnessContrastSettings { readonly brightness: number; readonly contrast: number; readonly legacy: boolean }
export interface PhotoFilterSettings { readonly color: RGB; readonly density: number; readonly preserveLuminosity: boolean }
export interface ChannelMixerChannel { readonly red: number; readonly green: number; readonly blue: number; readonly constant: number }
export interface ChannelMixerSettings {
  readonly monochrome: boolean; readonly red: ChannelMixerChannel; readonly green: ChannelMixerChannel;
  readonly blue: ChannelMixerChannel; readonly gray: ChannelMixerChannel;
}

export interface HueSaturationParameters {
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
  readonly colorize: boolean;
  readonly settings: HueSaturationSettings;
}

/** Strict live adjustment records. Legacy Codable records are normalised by project readers. */
export type LayerAdjustment =
  | { readonly kind: 'Hue/Saturation'; readonly schemaVersion: 1; readonly parameters: HueSaturationParameters }
  | { readonly kind: 'Levels'; readonly schemaVersion: 1; readonly parameters: LevelsSettings }
  | { readonly kind: 'Curves'; readonly schemaVersion: 1; readonly parameters: CurvesSettings }
  | { readonly kind: 'Exposure'; readonly schemaVersion: 1; readonly parameters: ExposureSettings }
  | { readonly kind: 'Gradient Map'; readonly schemaVersion: 1; readonly parameters: GradientMapSettings }
  | { readonly kind: 'Grain'; readonly schemaVersion: 1; readonly parameters: GrainSettings }
  | { readonly kind: 'Basic'; readonly schemaVersion: 1; readonly parameters: BasicSettings }
  | { readonly kind: 'Colour Lookup'; readonly schemaVersion: 1; readonly parameters: ColourLookupSettings }
  | { readonly kind: 'Colour'; readonly schemaVersion: 1; readonly parameters: ColourSettings }
  | { readonly kind: 'Invert'; readonly schemaVersion: 1; readonly parameters: Readonly<Record<string, never>> }
  | { readonly kind: 'Threshold'; readonly schemaVersion: 1; readonly parameters: { readonly level: number } }
  | { readonly kind: 'Posterize'; readonly schemaVersion: 1; readonly parameters: { readonly levels: number } }
  | { readonly kind: 'Brightness/Contrast'; readonly schemaVersion: 1; readonly parameters: BrightnessContrastSettings }
  | { readonly kind: 'Photo Filter'; readonly schemaVersion: 1; readonly parameters: PhotoFilterSettings }
  | { readonly kind: 'Channel Mixer'; readonly schemaVersion: 1; readonly parameters: ChannelMixerSettings };

export interface LayerShape {
  /** Absent on files created before the Phase-2 vector model. */
  readonly schemaVersion?: 1;
  readonly kind: 'Rectangle' | 'Ellipse' | 'Polygon' | 'Star' | 'Line';
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly cornerRadius: number;
  /** Rectangle radii in top-left, top-right, bottom-right, bottom-left order. */
  readonly cornerRadii?: readonly [number, number, number, number];
  readonly sides?: number;
  readonly innerRatio?: number;
  readonly lineWidth?: number;
}

export interface LayerLocks {
  readonly transparency: boolean;
  readonly pixels: boolean;
  readonly position: boolean;
  readonly all: boolean;
}

export interface LayerMask {
  readonly raster: Raster;
  readonly enabled: boolean;
  readonly placement: LayerTransform | null;
  readonly linked: boolean;
}

export interface VectorPath {
  /** Absent in early v2 files; readers migrate those records to version 1. */
  readonly schemaVersion?: 1;
  readonly closed: boolean;
  readonly fillRule?: 'nonzero' | 'evenodd';
  readonly points: readonly {
    readonly anchor: Point;
    readonly in: Point;
    readonly out: Point;
    readonly kind?: 'corner' | 'smooth';
  }[];
}
export interface VectorMask {
  readonly schemaVersion?: 1;
  readonly enabled: boolean;
  readonly inverted: boolean;
  /** Photoshop-compatible strength, 0..1. */
  readonly density?: number;
  /** Gaussian feather radius in document pixels. */
  readonly feather?: number;
  readonly paths: readonly VectorPath[];
}
export interface CropParameters { readonly rect: Rect; readonly feather: number }
export interface WarpQuad { readonly kind: 'quad'; readonly schemaVersion: 1; readonly corners: readonly [Point, Point, Point, Point] }

export type LayerEffect =
  | { readonly kind: 'dropShadow'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number;
      readonly angle: number; readonly distance: number; readonly blur: number; readonly color: RGB;
      readonly blendMode?: BlendMode; readonly useGlobalLight?: boolean; readonly spread?: number;
      readonly size?: number; readonly contour?: 'linear'; readonly noise?: 0; readonly knockout?: boolean }
  | { readonly kind: 'stroke'; readonly schemaVersion: 1; readonly enabled: boolean; readonly width: number;
      readonly position: 'inside' | 'center' | 'outside'; readonly color?: RGB; readonly fill?: EffectFill;
      readonly opacity?: number; readonly blendMode?: BlendMode }
  | { readonly kind: 'outerGlow'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number;
      readonly color: RGB; readonly blendMode: BlendMode; readonly spread: number; readonly size: number;
      readonly contour: 'linear'; readonly noise: 0 }
  | { readonly kind: 'colorOverlay'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number;
      readonly color: RGB; readonly blendMode?: BlendMode }
  | { readonly kind: 'gradientOverlay'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number;
      readonly blendMode: BlendMode; readonly angle: number; readonly scale: number; readonly gradient: EffectGradient };

export type LiveFilter =
  | { readonly kind: 'gaussianBlur'; readonly schemaVersion: 1; readonly enabled: boolean; readonly radius: number }
  | { readonly kind: 'motionBlur'; readonly schemaVersion: 1; readonly enabled: boolean; readonly angle: number; readonly distance: number }
  | { readonly kind: 'noise'; readonly schemaVersion: 1; readonly enabled: boolean; readonly amount: number;
      readonly gaussian: boolean; readonly monochromatic: boolean }
  | { readonly kind: 'lensCorrection'; readonly schemaVersion: 1; readonly enabled: boolean; readonly distortion: number }
  | { readonly kind: 'unsharpMask'; readonly schemaVersion: 1; readonly enabled: boolean;
      readonly amount: number; readonly radius: number; readonly threshold: number }
  | { readonly kind: 'smartSharpen'; readonly schemaVersion: 1; readonly enabled: boolean;
      readonly amount: number; readonly radius: number; readonly threshold: number; readonly reduceNoise: number }
  | { readonly kind: 'highPass'; readonly schemaVersion: 1; readonly enabled: boolean; readonly radius: number }
  | { readonly kind: 'denoise'; readonly schemaVersion: 1; readonly enabled: boolean;
      readonly luminance: number; readonly colour: number };

export interface LayerCommon {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  /** Derived compatibility projection of `locks.all`; never read as authoritative state. */
  readonly locked: boolean;
  readonly parentId: string | null;
  readonly opacity: number;
  readonly fillOpacity: number;
  readonly blendMode: BlendMode;
  readonly locks: LayerLocks;
  readonly colorLabel: ColorLabel;
  readonly transform: LayerTransform;
  readonly warp: WarpQuad | null;
  readonly crop: CropParameters | null;
  readonly mask: LayerMask | null;
  readonly vectorMask: VectorMask | null;
  readonly maskSourceId: string | null;
  readonly effects: readonly LayerEffect[];
  readonly filters: readonly LiveFilter[];
}

interface WithoutAdjustment { readonly adjustment?: never }
interface WithoutRaster { readonly raster?: never }
interface WithoutSourceShape { readonly sourceShape?: never }

export interface PixelLayer extends LayerCommon, WithoutAdjustment, WithoutSourceShape {
  readonly kind: 'pixel';
  /** A newly-created blank pixel layer has no allocated tiles until its first edit. */
  readonly raster: Raster | null;
}
export interface GroupLayer extends LayerCommon, WithoutAdjustment, WithoutRaster, WithoutSourceShape { readonly kind: 'group' }
export interface AdjustmentLayer extends LayerCommon, WithoutRaster, WithoutSourceShape {
  readonly kind: 'adjustment'; readonly adjustment: LayerAdjustment;
}
export type FillParameters =
  | { readonly kind: 'solid'; readonly schemaVersion: 1; readonly color: RGB }
  | { readonly kind: 'gradient'; readonly schemaVersion: 1; readonly angle: number; readonly stops: readonly { offset: number; color: RGB; opacity: number }[] }
  | { readonly kind: 'pattern'; readonly schemaVersion: 1; readonly assetId: string; readonly scale: number; readonly angle: number };
export interface FillLayer extends LayerCommon, WithoutAdjustment, WithoutRaster, WithoutSourceShape {
  readonly kind: 'fill'; readonly fill: FillParameters;
}
export interface VectorStyle {
  readonly schemaVersion?: 1;
  readonly fill: FillParameters | null;
  readonly stroke: {
    readonly paint?: FillParameters;
    /** Compatibility colour for early v2 records. `paint` is authoritative when present. */
    readonly color: RGB;
    readonly width: number;
    readonly alignment: 'inside' | 'center' | 'outside';
    readonly cap?: 'butt' | 'round' | 'square';
    readonly join?: 'miter' | 'round' | 'bevel';
    readonly miterLimit?: number;
    readonly dash?: readonly number[];
    readonly dashOffset?: number;
    readonly startMarker?: 'none' | 'arrow' | 'openArrow' | 'circle' | 'square';
    readonly endMarker?: 'none' | 'arrow' | 'openArrow' | 'circle' | 'square';
    readonly markerSize?: number;
  } | null;
}
export interface VectorLayer extends LayerCommon, WithoutAdjustment {
  readonly kind: 'vector';
  readonly paths: readonly VectorPath[];
  readonly style: VectorStyle;
  /** Rendered cache used until the vector renderer owns this layer end-to-end. */
  readonly raster: Raster | null;
  /** Editable primitive metadata; paths/style remain the canonical vector representation. */
  readonly sourceShape: LayerShape | null;
}
export type TextKerning = 'metric' | 'optical' | 'none';
export type TextOpenTypeFeature = 'liga' | 'dlig' | 'tnum' | 'lnum' | 'onum' | 'smcp';
export interface TextRunStyle {
  readonly schemaVersion: 1;
  /** The requested family is retained even when rendering uses a substitute (PRODUCT-PLAN P11). */
  readonly fontFamily: string;
  readonly fontStyle: 'normal' | 'italic' | 'oblique';
  readonly fontWeight: number;
  /** Typographic points, converted with the document resolution at layout time. */
  readonly fontSize: number;
  readonly color: RGB & { readonly alpha?: number };
  /** Thousandths of an em, matching Photoshop's tracking unit. */
  readonly tracking: number;
  readonly kerning: TextKerning;
  /** Explicit line height in points, or null for the font's normal leading. */
  readonly leading: number | null;
  readonly baselineShift: number;
  readonly features: Readonly<Partial<Record<TextOpenTypeFeature, boolean>>>;
  readonly axes: Readonly<Record<string, number>>;
}
export interface TextRun {
  readonly from: number;
  readonly to: number;
  readonly style: TextRunStyle;
}
export interface LegacyTextRun {
  readonly from: number;
  readonly to: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly color: RGB;
}
export interface TextParagraphStyle {
  readonly schemaVersion: 1;
  readonly alignment: 'left' | 'center' | 'right' | 'justify';
  readonly direction: 'auto' | 'ltr' | 'rtl';
  readonly firstLineIndent: number;
  readonly startIndent: number;
  readonly endIndent: number;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
}
export interface TextParagraph { readonly from: number; readonly to: number; readonly style: TextParagraphStyle }
export interface TextLayer extends LayerCommon, WithoutAdjustment, WithoutSourceShape {
  readonly kind: 'text'; readonly text: string; readonly runs: readonly TextRun[];
  readonly paragraphs: readonly TextParagraph[];
  readonly box: { readonly width: number; readonly height: number } | null;
  /** Compatibility projection for pre-P2 callers; paragraphs are authoritative. */
  readonly alignment: 'left' | 'center' | 'right' | 'justify';
  /** Rendered cache while font/vector rendering is loaded lazily. */
  readonly raster: Raster | null;
  /** Placement of an imported/saved preview; null means the editable transform. */
  readonly renderedTransform: LayerTransform | null;
}
export interface EmbeddedLayer extends LayerCommon, WithoutAdjustment, WithoutSourceShape {
  readonly kind: 'embedded';
  readonly content: { readonly mode: 'embedded' | 'linked'; readonly mediaType: 'image' | 'svg' | 'pdf' | 'project';
    readonly assetId?: string; readonly uri?: string; readonly sourceName: string };
  /** Rendered cache for embedded content. */
  readonly raster: Raster | null;
}

export type ModelLayer = PixelLayer | GroupLayer | AdjustmentLayer | FillLayer | VectorLayer | TextLayer | EmbeddedLayer;
export type Layer = ModelLayer;

export interface Guide { readonly id: string; readonly orientation: 'horizontal' | 'vertical'; readonly position: number }

export interface Artboard {
  readonly id: string;
  readonly name: string;
  readonly rect: Rect;
  readonly background: RGB & { readonly alpha: number };
  readonly colorLabel: ColorLabel;
}

export interface DocumentResource {
  readonly id: string;
  readonly role: 'pattern' | 'embedded' | 'font' | 'lut';
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface DocumentFont {
  readonly id: string;
  readonly family: string;
  readonly style: string;
  readonly weight: number;
  readonly source: 'bundled' | 'system' | 'local' | 'embedded';
  readonly postscriptName?: string;
  /** Present only when the licence permits embedding and the bytes are a document resource. */
  readonly resourceId?: string;
  readonly embeddingAllowed: boolean;
}

export interface CanvasDocument {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  /** Photoshop-compatible shared lighting angle in degrees; 120 when absent in older documents. */
  readonly globalLightAngle?: number;
  readonly layers: readonly Layer[];
  readonly artboards?: readonly Artboard[];
  /** Ruler guides in document pixels (PRODUCT-PLAN 6.1). */
  readonly guides?: readonly Guide[];
  readonly resources?: readonly DocumentResource[];
  readonly fonts?: readonly DocumentFont[];
  readonly selection: DocumentSelection | null;
}

export type { Point };
