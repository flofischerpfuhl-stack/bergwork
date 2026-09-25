export type HardwareOperatingSystem = 'windows' | 'linux' | 'android' | 'macos' | 'other';
export type HardwareRendererBackend = 'webgpu' | 'webgl2' | 'software';
export type WebViewRuntime = 'webview2' | 'webkitgtk' | 'android-webview' | 'electron' | 'other';

export interface RendererFallbackDecision {
  readonly mode: 'software';
  readonly from: 'webgpu' | 'webgl2';
  readonly reason: string;
  readonly gpu: string;
  readonly driver: string;
  readonly decidedAt: string;
}

export type PersistedRendererFallback = { readonly mode: 'hardware' } | RendererFallbackDecision;

export interface RendererFallbackStore {
  status(): PersistedRendererFallback;
  useSoftware(input: {
    readonly from: 'webgpu' | 'webgl2';
    readonly reason: string;
    readonly gpu: string;
    readonly driver: string;
    readonly decidedAt?: string;
  }): RendererFallbackDecision;
  clear(): void;
}

/** Persistent store adapter for localStorage or another Web Storage implementation. */
export class WebStorageRendererFallbackStore implements RendererFallbackStore {
  readonly #storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly #key: string;

  constructor(
    storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    key = 'bergwork.rendererFallback.v1',
  ) {
    this.#storage = storage;
    this.#key = key;
  }

  status(): PersistedRendererFallback {
    const encoded = this.#storage.getItem(this.#key);
    if (encoded === null) return { mode: 'hardware' };
    try {
      const value: unknown = JSON.parse(encoded);
      return isRendererFallbackDecision(value) ? value : { mode: 'hardware' };
    } catch {
      return { mode: 'hardware' };
    }
  }

  useSoftware(input: {
    readonly from: 'webgpu' | 'webgl2';
    readonly reason: string;
    readonly gpu: string;
    readonly driver: string;
    readonly decidedAt?: string;
  }): RendererFallbackDecision {
    const decision: RendererFallbackDecision = {
      mode: 'software',
      from: input.from,
      reason: input.reason,
      gpu: input.gpu,
      driver: input.driver,
      decidedAt: input.decidedAt ?? new Date().toISOString(),
    };
    this.#storage.setItem(this.#key, JSON.stringify(decision));
    return decision;
  }

  clear(): void {
    this.#storage.removeItem(this.#key);
  }
}

export type GpuLossAction =
  | { readonly kind: 'retryCurrent'; readonly reason: string }
  | { readonly kind: 'fallbackWebgl2'; readonly reason: string }
  | { readonly kind: 'relaunchSoftware'; readonly status: RendererFallbackDecision }
  | { readonly kind: 'none' };

/** Session recovery ladder. A persisted software launch cannot enter a relaunch loop. */
export class RendererFallbackController {
  #gpuLosses = 0;
  #relaunchRequested = false;
  #backend: 'webgpu' | 'webgl2';
  readonly #store: RendererFallbackStore;

  constructor(store: RendererFallbackStore, initialBackend: 'webgpu' | 'webgl2' = 'webgpu') {
    this.#store = store;
    this.#backend = initialBackend;
  }

  gpuDeviceLost(reason: string, gpu: string, driver: string): GpuLossAction {
    if (this.#store.status().mode === 'software' || this.#relaunchRequested)
      return { kind: 'none' };
    this.#gpuLosses += 1;
    if (this.#gpuLosses === 1) return { kind: 'retryCurrent', reason };
    if (this.#backend === 'webgpu') {
      this.#backend = 'webgl2';
      return { kind: 'fallbackWebgl2', reason };
    }
    return this.requestSoftware(reason, gpu, driver);
  }

  /** Alias for shells that report a whole GPU process exit rather than a Web API device loss. */
  gpuProcessGone(reason: string, gpu: string, driver: string): GpuLossAction {
    return this.gpuDeviceLost(reason, gpu, driver);
  }

  requestSoftware(reason: string, gpu: string, driver: string): GpuLossAction {
    if (this.#store.status().mode === 'software' || this.#relaunchRequested)
      return { kind: 'none' };
    const status = this.#store.useSoftware({
      from: this.#backend,
      reason,
      gpu,
      driver,
    });
    this.#relaunchRequested = true;
    return { kind: 'relaunchSoftware', status };
  }

  tryHardwareAgain(): boolean {
    if (this.#relaunchRequested || this.#store.status().mode !== 'software') return false;
    this.#store.clear();
    this.#relaunchRequested = true;
    return true;
  }
}

export interface WebViewLaunchFacts {
  readonly runtime: 'webview2' | 'webkitgtk' | 'android-webview';
  readonly persistedFallback: PersistedRendererFallback;
}

export type WebViewLaunchSettings =
  | {
      readonly runtime: 'webview2';
      /** Join with spaces and expose as WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS before startup. */
      readonly additionalBrowserArguments: readonly string[];
    }
  | {
      readonly runtime: 'webkitgtk';
      /** Apply before GTK/WebKit initialization without replacing unrelated user variables. */
      readonly environment: Readonly<Record<string, string>>;
    }
  | {
      readonly runtime: 'android-webview';
      readonly launchOverrides: null;
      readonly note: string;
    };

/** Pure launch policy for the three Tauri WebView runtimes. */
export function deriveWebViewLaunchSettings(facts: WebViewLaunchFacts): WebViewLaunchSettings {
  const software = facts.persistedFallback.mode === 'software';
  switch (facts.runtime) {
    case 'webview2':
      return {
        runtime: 'webview2',
        additionalBrowserArguments: software ? ['--disable-gpu'] : [],
      };
    case 'webkitgtk':
      return {
        runtime: 'webkitgtk',
        environment: software ? { WEBKIT_DISABLE_COMPOSITING_MODE: '1' } : {},
      };
    case 'android-webview':
      return {
        runtime: 'android-webview',
        launchOverrides: null,
        note:
          'Android WebView has no supported per-app launch switches; honor persisted fallback in the renderer selection.',
      };
  }
}

export interface RendererAdapterFacts {
  readonly vendorId?: number;
  readonly deviceId?: number;
  readonly driver?: string;
  readonly isFallbackAdapter: boolean;
}

export interface RenderingStatusFacts {
  readonly persistedFallback: PersistedRendererFallback;
  readonly renderer: {
    readonly backend: HardwareRendererBackend;
    readonly adapter: RendererAdapterFacts;
  } | null;
  /** Optional shell evidence can demote a physical adapter when compositing is software-backed. */
  readonly runtimeAcceleration?: 'hardware' | 'software' | 'unknown';
  readonly unavailableReason?: string;
}

export type RenderingStatus =
  | {
      readonly state: 'initializing';
      readonly label: 'Initializing';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'webgpuHardware';
      readonly label: 'WebGPU (hardware)';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'webgl2Hardware';
      readonly label: 'WebGL2 (hardware)';
      readonly title: string;
      readonly degraded: false;
    }
  | {
      readonly state: 'software';
      readonly label: 'Software';
      readonly title: string;
      readonly degraded: true;
    }
  | {
      readonly state: 'unavailable';
      readonly label: 'Unavailable';
      readonly title: string;
      readonly degraded: true;
    };

/** Reports the backend that actually rendered; only a non-fallback adapter is called hardware. */
export function deriveRenderingStatus(facts: RenderingStatusFacts): RenderingStatus {
  if (facts.unavailableReason !== undefined) {
    return {
      state: 'unavailable',
      label: 'Unavailable',
      title: facts.unavailableReason,
      degraded: true,
    };
  }
  if (facts.persistedFallback.mode === 'software') {
    return {
      state: 'software',
      label: 'Software',
      title: facts.persistedFallback.reason,
      degraded: true,
    };
  }
  if (facts.renderer === null) {
    return {
      state: 'initializing',
      label: 'Initializing',
      title: 'Renderer capability verification is in progress.',
      degraded: false,
    };
  }
  if (
    facts.renderer.backend === 'software' ||
    facts.renderer.adapter.isFallbackAdapter ||
    facts.runtimeAcceleration === 'software'
  ) {
    return {
      state: 'software',
      label: 'Software',
      title: facts.renderer.adapter.isFallbackAdapter
        ? 'The active renderer uses a fallback adapter.'
        : facts.runtimeAcceleration === 'software'
          ? 'The WebView reports software-backed compositing.'
          : 'The editor selected software rendering.',
      degraded: true,
    };
  }
  return facts.renderer.backend === 'webgpu'
    ? {
        state: 'webgpuHardware',
        label: 'WebGPU (hardware)',
        title: 'WebGPU is active on a non-fallback adapter.',
        degraded: false,
      }
    : {
        state: 'webgl2Hardware',
        label: 'WebGL2 (hardware)',
        title: 'WebGL2 is active on its own non-fallback adapter.',
        degraded: false,
      };
}

export interface HardwareQuirkRule {
  readonly id: string;
  readonly priority: number;
  readonly match: {
    readonly os?: HardwareOperatingSystem;
    readonly vendorId?: number;
    readonly deviceId?: number;
    readonly driverMin?: string;
    readonly driverMax?: string;
    readonly backend?: HardwareRendererBackend;
    readonly sessionType?: string;
    readonly webview?: WebViewRuntime;
    readonly webviewVersionMin?: string;
    readonly webviewVersionMax?: string;
  };
  readonly actions: {
    readonly disableBackends?: readonly HardwareRendererBackend[];
    readonly forceSoftware?: boolean;
    readonly renderBudgetScale?: number;
    readonly computeBudgetScale?: number;
  };
  readonly reason: string;
  readonly expires: string;
}

export interface HardwareQuirkRegistry {
  readonly schemaVersion: 1;
  readonly rules: readonly HardwareQuirkRule[];
}

export interface HardwareQuirkFacts {
  readonly os: HardwareOperatingSystem;
  readonly vendorId?: number;
  readonly deviceId?: number;
  readonly driver?: string;
  readonly backend: HardwareRendererBackend;
  readonly sessionType?: string;
  readonly webview: WebViewRuntime;
  readonly webviewVersion?: string;
}

export interface ResolvedHardwareQuirks {
  readonly matchedIds: readonly string[];
  readonly disableBackends: readonly HardwareRendererBackend[];
  readonly forceSoftware: boolean;
  readonly renderBudgetScale: number;
  readonly computeBudgetScale: number;
}

const OPERATING_SYSTEMS = new Set(['windows', 'linux', 'android', 'macos', 'other']);
const RENDERER_BACKENDS = new Set(['webgpu', 'webgl2', 'software']);
const WEBVIEWS = new Set(['webview2', 'webkitgtk', 'android-webview', 'electron', 'other']);
const MATCH_KEYS = new Set([
  'os',
  'vendorId',
  'deviceId',
  'driverMin',
  'driverMax',
  'backend',
  'sessionType',
  'webview',
  'webviewVersionMin',
  'webviewVersionMax',
]);
const ACTION_KEYS = new Set([
  'disableBackends',
  'forceSoftware',
  'renderBudgetScale',
  'computeBudgetScale',
]);

export function validateQuirkRegistry(value: unknown): HardwareQuirkRegistry {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.rules))
    throw new TypeError('hardware quirk registry must use schemaVersion 1');
  const ids = new Set<string>();
  for (const candidate of value.rules) {
    if (
      !record(candidate) ||
      typeof candidate.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.id)
    )
      throw new TypeError('hardware quirk id is invalid');
    if (ids.has(candidate.id)) throw new TypeError(`duplicate hardware quirk id: ${candidate.id}`);
    ids.add(candidate.id);
    if (
      !Number.isInteger(candidate.priority) ||
      !record(candidate.match) ||
      !record(candidate.actions) ||
      typeof candidate.reason !== 'string' ||
      !candidate.reason.trim() ||
      typeof candidate.expires !== 'string' ||
      !validIsoDate(candidate.expires)
    )
      throw new TypeError(`hardware quirk ${candidate.id} is malformed`);
    if (
      Object.keys(candidate).some(
        (key) => !['id', 'priority', 'match', 'actions', 'reason', 'expires'].includes(key),
      ) ||
      Object.keys(candidate.match).some((key) => !MATCH_KEYS.has(key)) ||
      Object.keys(candidate.actions).some((key) => !ACTION_KEYS.has(key))
    )
      throw new TypeError(`hardware quirk ${candidate.id} has an unknown field`);
    validateMatch(candidate.id, candidate.match);
    validateActions(candidate.id, candidate.actions);
  }
  return value as unknown as HardwareQuirkRegistry;
}

/** Returns validated rules whose every declared field matches the supplied facts. */
export function matchQuirkRules(
  registryValue: unknown,
  facts: HardwareQuirkFacts,
): readonly HardwareQuirkRule[] {
  const registry = validateQuirkRegistry(registryValue);
  return registry.rules.filter((rule) => {
    const match = rule.match;
    return (
      optionalEqual(match.os, facts.os) &&
      optionalEqual(match.vendorId, facts.vendorId) &&
      optionalEqual(match.deviceId, facts.deviceId) &&
      versionInRange(facts.driver, match.driverMin, match.driverMax) &&
      optionalEqual(match.backend, facts.backend) &&
      optionalEqual(match.sessionType, facts.sessionType) &&
      optionalEqual(match.webview, facts.webview) &&
      versionInRange(facts.webviewVersion, match.webviewVersionMin, match.webviewVersionMax)
    );
  });
}

/** Matches and deterministically combines quirk actions in priority/id order. */
export function resolveHardwareQuirks(
  registryValue: unknown,
  facts: HardwareQuirkFacts,
): ResolvedHardwareQuirks {
  const matched = [...matchQuirkRules(registryValue, facts)].sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  );
  const disabled = new Set<HardwareRendererBackend>();
  let forceSoftware = false;
  let renderBudgetScale = 1;
  let computeBudgetScale = 1;
  for (const rule of matched) {
    for (const backend of rule.actions.disableBackends ?? []) disabled.add(backend);
    forceSoftware ||= rule.actions.forceSoftware ?? false;
    renderBudgetScale *= rule.actions.renderBudgetScale ?? 1;
    computeBudgetScale *= rule.actions.computeBudgetScale ?? 1;
  }
  return {
    matchedIds: matched.map(({ id }) => id),
    disableBackends: [...disabled].sort(),
    forceSoftware,
    renderBudgetScale,
    computeBudgetScale,
  };
}

function validateMatch(id: string, match: Record<string, unknown>): void {
  if (match.os !== undefined && !OPERATING_SYSTEMS.has(String(match.os)))
    throw new TypeError(`hardware quirk ${id} has an invalid os`);
  if (match.backend !== undefined && !RENDERER_BACKENDS.has(String(match.backend)))
    throw new TypeError(`hardware quirk ${id} has an invalid backend`);
  if (match.webview !== undefined && !WEBVIEWS.has(String(match.webview)))
    throw new TypeError(`hardware quirk ${id} has an invalid webview`);
  for (const field of ['vendorId', 'deviceId'] as const) {
    const value = match[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0))
      throw new TypeError(`hardware quirk ${id} has an invalid ${field}`);
  }
  for (const field of ['sessionType'] as const) {
    const value = match[field];
    if (value !== undefined && (typeof value !== 'string' || !value.trim()))
      throw new TypeError(`hardware quirk ${id} has an invalid ${field}`);
  }
  validateVersionRange(id, 'driver', match.driverMin, match.driverMax);
  validateVersionRange(id, 'webview', match.webviewVersionMin, match.webviewVersionMax);
}

function validateActions(id: string, actions: Record<string, unknown>): void {
  if (
    actions.disableBackends !== undefined &&
    (!Array.isArray(actions.disableBackends) ||
      actions.disableBackends.some((backend) => !RENDERER_BACKENDS.has(String(backend))))
  )
    throw new TypeError(`hardware quirk ${id} has invalid disableBackends`);
  if (actions.forceSoftware !== undefined && typeof actions.forceSoftware !== 'boolean')
    throw new TypeError(`hardware quirk ${id} has an invalid forceSoftware`);
  for (const field of ['renderBudgetScale', 'computeBudgetScale'] as const) {
    const scale = actions[field];
    if (
      scale !== undefined &&
      (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 1)
    )
      throw new TypeError(`hardware quirk ${id} has an invalid ${field}`);
  }
}

function validateVersionRange(
  id: string,
  field: string,
  minimum: unknown,
  maximum: unknown,
): void {
  for (const value of [minimum, maximum]) {
    if (value !== undefined && (typeof value !== 'string' || parseVersion(value) === null))
      throw new TypeError(`hardware quirk ${id} has an invalid ${field} version`);
  }
  if (
    typeof minimum === 'string' &&
    typeof maximum === 'string' &&
    compareVersions(minimum, maximum) > 0
  )
    throw new TypeError(`hardware quirk ${id} has a reversed ${field} range`);
}

function versionInRange(actual: string | undefined, minimum?: string, maximum?: string): boolean {
  if (minimum === undefined && maximum === undefined) return true;
  if (actual === undefined || parseVersion(actual) === null) return false;
  return (
    (minimum === undefined || compareVersions(actual, minimum) >= 0) &&
    (maximum === undefined || compareVersions(actual, maximum) <= 0)
  );
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) throw new TypeError('versions must use dotted numeric notation');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseVersion(value: string): readonly number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(value)) return null;
  const result = value.split('.').map(Number);
  return result.every((part) => Number.isSafeInteger(part)) ? result : null;
}

function optionalEqual<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || expected === actual;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isRendererFallbackDecision(value: unknown): value is RendererFallbackDecision {
  return (
    record(value) &&
    value.mode === 'software' &&
    (value.from === 'webgpu' || value.from === 'webgl2') &&
    typeof value.reason === 'string' &&
    typeof value.gpu === 'string' &&
    typeof value.driver === 'string' &&
    typeof value.decidedAt === 'string'
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
