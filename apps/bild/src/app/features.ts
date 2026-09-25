/**
 * Small startup registry for feature modules. Heavy feature UI/engines are fetched on first use and
 * opportunistically during an idle period; the text/vector stubs stay eager because they already
 * defer CanvasKit and know how to hydrate documents that contain those layer kinds.
 */

import type { Tool } from '../core/session';
import type { EditorController } from '../ui/controller';
import type { FeatureRegistry } from '../ui/menus';
import { installText } from './textFeature';
import { installVector } from './vectorFeature';
import { installRaw } from './rawFeature';
import { installBatch } from './batch/install';
import { profileHasFeature, type EditorProfile, type FeatureModuleId } from './profiles';

// Raw import options and batch/recipes stay eager: both are small registrations that load their UI on first use.
type LazyFeature = Exclude<FeatureModuleId, 'text' | 'vector' | 'automation'> | 'objectSelection' | 'embedded' | 'warp' | 'genai';
type Installer = (controller: EditorController) => void;

const imports: Record<LazyFeature, () => Promise<Installer>> = {
  canvas: () => import('./canvasOpsFeature').then((module) => module.installCanvasOps),
  selection: () => import('./selectionFeature').then((module) => module.installSelection),
  painting: () => import('./paintingFeature').then((module) => module.installPainting),
  retouch: () => import('./retouchFeature').then((module) => module.installRetouch),
  adjustments: () => import('./adjustmentsFeature').then((module) => module.installAdjustments),
  subject: () => import('./subjectFeature').then((module) => module.installSubject),
  guides: () => import('./guidesFeature').then((module) => module.installGuides),
  styles: () => import('./layerStylesFeature').then((module) => module.installLayerStyles),
  artboards: () => import('./artboardFeature').then((module) => module.installArtboards),
  color: () => import('./color/colorFeature').then((module) => module.installColor),
  objectSelection: () => import('./objsel/install').then((module) => module.installObjectSelection),
  embedded: () => import('./embeddedFeature').then((module) => module.installEmbedded),
  warp: () => import('./warpFeature').then((module) => module.installWarp),
  genai: () => import('./genaiFeature').then((module) => module.installGenAi),
};

const toolOwners: Partial<Record<Tool, LazyFeature>> = {
  artboard: 'artboards', marquee: 'selection', lasso: 'selection', wand: 'retouch', objectSelect: 'objectSelection', crop: 'canvas',
  warp: 'warp', straighten: 'warp', liquify: 'warp',
  brush: 'painting', spotHealing: 'retouch', cloneStamp: 'painting', blur: 'painting', gradient: 'painting', eyedropper: 'painting',
};

const commandGroups: [LazyFeature, string[]][] = [
  ['canvas', ['canvasSize', 'imageSize']],
  ['selection', ['selectAll', 'deselect', 'inverse', 'loadLayerSelection', 'loadMaskSelection', 'expandSelection', 'contractSelection',
    'fillForeground', 'fillBackground', 'clearSelection', 'deleteKey', 'invert', 'copy', 'cut', 'copyMerged', 'paste', 'layerViaCopy', 'transformCommand']],
  ['retouch', ['contentAwareFill']],
  ['warp', ['warp', 'perspective', 'straighten', 'liquify']],
  ['genai', ['upscale']],
  ['adjustments', ['levels', 'curves', 'hueSaturation', 'exposure', 'gradientMap', 'grain', 'gaussianBlur', 'motionBlur', 'noise',
    'lensCorrection', 'editAdjustment', 'adjustmentLayers', 'denoise', 'unsharpMask', 'smartSharpen', 'highPass']],
  ['subject', ['removeBackground']],
  ['guides', ['toggleRulers', 'toggleGuides', 'lockGuides', 'snapToGuides', 'clearGuides', 'newGuide',
    'align-left', 'align-hcenter', 'align-right', 'align-top', 'align-vcenter', 'align-bottom',
    'distribute-hcenters', 'distribute-vcenters', 'distribute-hspacing', 'distribute-vspacing']],
  ['objectSelection', ['quickMask', 'refineEdge', 'colorRange', 'selectSubject']],
  ['embedded', ['placeEmbedded', 'placeLinked', 'replaceEmbedded', 'relinkEmbedded', 'editEmbedded', 'convertEmbeddedPixels',
    'convertToEmbedded', 'refreshLinked']],
];
const commandOwners: Readonly<Record<string, LazyFeature>> = Object.fromEntries(
  commandGroups.flatMap(([owner, names]) => names.map((name) => [name, owner])),
);

function idle(callback: () => void): void {
  if ('requestIdleCallback' in globalThis) {
    (globalThis as typeof globalThis & { requestIdleCallback(cb: () => void, options: { timeout: number }): number })
      .requestIdleCallback(callback, { timeout: 1_500 });
  } else setTimeout(callback, 0);
}

export function installFeatures(controller: EditorController, profile: EditorProfile = controller.profile): void {
  installRaw(controller);
  const enabled = new Set(profile.modules);
  const promises = new Map<LazyFeature, Promise<void>>();
  const installed = new Set<LazyFeature>();

  const load = (feature: LazyFeature): Promise<void> => {
    let pending = promises.get(feature);
    if (pending) return pending;
    pending = (async () => {
      // These installers extend registrations made by their prerequisite module.
      if (feature === 'retouch') await load('selection');
      if (feature === 'subject' || feature === 'styles') await load('adjustments');
      if (feature === 'color') await load('painting');
      if (feature === 'genai') await load('retouch');
      if (feature === 'objectSelection') await Promise.all([load('selection'), load('painting'), load('retouch')]);
      const install = await imports[feature]();
      const setupStart = controller.canvasSetups.length;
      install(controller);
      installed.add(feature);
      if (controller.canvasView) for (const setup of controller.canvasSetups.slice(setupStart)) setup(controller.canvasView);
      for (const tab of controller.workspace.tabs) tab.session.notify('ui');
    })().catch((error: unknown) => {
      controller.reportError('feature-load-failed', error);
      throw error;
    });
    promises.set(feature, pending);
    return pending;
  };

  // Text/vector are purpose-built lazy stubs: they load CanvasKit on tool choice or document open.
  if (enabled.has('text')) installText(controller);
  if (enabled.has('vector')) installVector(controller);

  if (enabled.has('automation')) installBatch(controller);

  const generativeFill = profileHasFeature(profile, 'local-generative-fill', controller.capabilities);
  const genai = generativeFill || profileHasFeature(profile, 'upscale', controller.capabilities);
  const allowed = (feature: LazyFeature) => feature === 'embedded' || feature === 'objectSelection' ? enabled.has('selection')
    : feature === 'warp' ? true : feature === 'genai' ? genai : enabled.has(feature);
  // Local generative fill replaces Content-Aware Fill, so that command loads the AI module (which loads Retouch first).
  const owner = (command: string, fallback: LazyFeature): LazyFeature => (command === 'contentAwareFill' && generativeFill ? 'genai' : fallback);
  for (const [command, fallback] of Object.entries(commandOwners)) {
    const commandOwner = owner(command, fallback);
    if (!allowed(commandOwner) || controller.features[command]) continue;
    let registration: FeatureRegistry[string];
    const placeholder: NonNullable<FeatureRegistry[string]> = {
      enabled: () => !!controller.session.document && !controller.session.isProjectBusy && !controller.session.isImporting,
      run: () => { void load(commandOwner).then(() => {
        const loaded = controller.features[command];
        if (loaded !== registration && loaded?.enabled()) loaded.run();
      }).catch(() => undefined); },
    };
    controller.features[command] = placeholder;
    registration = controller.features[command];
  }

  controller.loadFeatureForTool = async (tool) => {
    const owner = toolOwners[tool];
    if (owner && allowed(owner) && !installed.has(owner)) await load(owner);
  };
  for (const tool of profile.tools) controller.availableTools.add(tool);

  const lazyFeatures = (Object.keys(imports) as LazyFeature[]).filter(allowed);
  // Loading every split chunk in one early idle callback delayed first interaction by hundreds of
  // milliseconds, especially in WebKitGTK. Give the first frame and input a quiet window, then warm
  // one feature per idle period; direct tool/menu use still calls load() immediately above.
  let warmIndex = 0;
  const warmNext = (): void => {
    const feature = lazyFeatures[warmIndex++];
    if (!feature) return;
    idle(() => { void load(feature).catch(() => undefined).finally(() => setTimeout(warmNext, 50)); });
  };
  setTimeout(warmNext, 2_500);
}
