import type { Tool } from '../core/session';
import type { CapabilityName, HostCapabilityMap } from '../platform/hosts';

export type EditorProfileId = 'pro' | 'lite';
export type FeatureModuleId = 'canvas' | 'selection' | 'painting' | 'retouch' | 'adjustments' | 'subject' | 'guides' | 'styles' | 'artboards'
  | 'text' | 'vector' | 'color';

export interface EditorProfile {
  readonly id: EditorProfileId;
  readonly documentLimits: { readonly maximumPixels: number; readonly maximumSide: number };
  readonly modules: readonly FeatureModuleId[];
  readonly tools: readonly Tool[];
  readonly panels: readonly ('layers' | 'history' | 'adjustments' | 'color')[];
  readonly menuFeatures: readonly string[];
  readonly aiModels: readonly ('fast' | 'best')[];
  /** Features in this table are exposed only when the named host capability is present. */
  readonly hostFeatures: Readonly<Record<string, CapabilityName>>;
}

const CURRENT_TOOLS: readonly Tool[] = [
  'move', 'artboard', 'marquee', 'lasso', 'wand', 'objectSelect', 'crop', 'brush', 'spotHealing', 'cloneStamp', 'blur', 'gradient',
  'shape', 'eyedropper', 'hand', 'zoom', 'idle',
  'text', 'pen', 'directSelect',
];
const CURRENT_MODULES: readonly FeatureModuleId[] = ['canvas', 'selection', 'painting', 'retouch', 'adjustments', 'subject', 'guides', 'styles', 'artboards',
  'text', 'vector', 'color'];

/** PRODUCT-PLAN sections 5, 6 and A10: one configuration per product profile, never an engine fork. */
export const EDITOR_PROFILES: Readonly<Record<EditorProfileId, EditorProfile>> = {
  pro: {
    id: 'pro', documentLimits: { maximumPixels: 300_000_000, maximumSide: 60_000 },
    modules: CURRENT_MODULES, tools: CURRENT_TOOLS, panels: ['layers', 'history', 'adjustments', 'color'],
    menuFeatures: ['current', 'raw', 'softproof', 'cmyk-export', 'text-on-path', 'local-generative-fill', 'upscale'],
    aiModels: ['fast', 'best'],
    hostFeatures: { raw: 'codecs', 'system-fonts': 'fonts', 'monitor-profile': 'color', 'native-compute': 'compute' },
  },
  lite: {
    id: 'lite', documentLimits: { maximumPixels: 100_000_000, maximumSide: 30_000 },
    modules: CURRENT_MODULES, tools: CURRENT_TOOLS, panels: ['layers', 'history', 'adjustments', 'color'],
    menuFeatures: ['current'], aiModels: ['fast', 'best'],
    hostFeatures: { 'local-fonts': 'fonts', 'file-system-access': 'files' },
  },
};

export function profileFor(id: EditorProfileId): EditorProfile { return EDITOR_PROFILES[id]; }

export function profileHasFeature(profile: EditorProfile, feature: string, capabilities: HostCapabilityMap = {}): boolean {
  if (!profile.menuFeatures.includes(feature)) return false;
  const required = profile.hostFeatures[feature];
  return !required || (capabilities[required]?.version ?? 0) >= 1;
}
