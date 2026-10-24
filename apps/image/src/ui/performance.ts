import type { ChangeKind, EditorSession } from '../core/session';
import type { EditorController } from './controller';

export interface UiPerformanceSnapshot {
  readonly renders: Readonly<Record<string, number>>;
  readonly sessionNotifications: Readonly<Record<ChangeKind, number>>;
  readonly workspaceNotifications: number;
  readonly thumbnails: {
    readonly renders: number;
    readonly draws: number;
    readonly previewRequests: number;
    readonly cacheHits: number;
    readonly builds: number;
  };
  readonly longTasks: { readonly supported: boolean; readonly count: number; readonly totalMs: number; readonly maxMs: number };
}

interface MutableAudit {
  renders: Record<string, number>;
  sessionNotifications: Record<ChangeKind, number>;
  workspaceNotifications: number;
  thumbnails: { renders: number; draws: number; previewRequests: number; cacheHits: number; builds: number };
  longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number };
  observer: PerformanceObserver | null;
  offSession: (() => void) | null;
  offWorkspace: (() => void) | null;
}

let audit: MutableAudit | null = null;

function blankAudit(): MutableAudit {
  return {
    renders: {},
    sessionNotifications: { document: 0, view: 0, ui: 0, overlay: 0 },
    workspaceNotifications: 0,
    thumbnails: { renders: 0, draws: 0, previewRequests: 0, cacheHits: 0, builds: 0 },
    longTasks: { supported: false, count: 0, totalMs: 0, maxMs: 0 },
    observer: null,
    offSession: null,
    offWorkspace: null,
  };
}

function observeSession(current: MutableAudit, session: EditorSession): void {
  current.offSession?.();
  current.offSession = session.subscribe((kind) => { current.sessionNotifications[kind]++; });
}

export function startUiPerformanceAudit(controller: EditorController): void {
  stopUiPerformanceAudit();
  const current = blankAudit();
  audit = current;
  observeSession(current, controller.session);
  let session = controller.session;
  current.offWorkspace = controller.workspace.subscribe(() => {
    current.workspaceNotifications++;
    if (controller.session !== session) {
      session = controller.session;
      observeSession(current, session);
    }
  });
  const supported = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  current.longTasks.supported = supported;
  if (supported) {
    current.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        current.longTasks.count++;
        current.longTasks.totalMs += entry.duration;
        current.longTasks.maxMs = Math.max(current.longTasks.maxMs, entry.duration);
      }
    });
    current.observer.observe({ type: 'longtask', buffered: false });
  }
}

export function stopUiPerformanceAudit(): void {
  if (!audit) return;
  audit.observer?.disconnect();
  audit.offSession?.();
  audit.offWorkspace?.();
  audit = null;
}

export function uiPerformanceSnapshot(): UiPerformanceSnapshot {
  const current = audit ?? blankAudit();
  return {
    renders: { ...current.renders },
    sessionNotifications: { ...current.sessionNotifications },
    workspaceNotifications: current.workspaceNotifications,
    thumbnails: { ...current.thumbnails },
    longTasks: { ...current.longTasks },
  };
}

export function markUiRender(component: string): void {
  if (audit) audit.renders[component] = (audit.renders[component] ?? 0) + 1;
}

export function markThumbnail(event: keyof MutableAudit['thumbnails']): void {
  if (audit) audit.thumbnails[event]++;
}

export interface UiPerformanceAuditApi {
  start(): void;
  stop(): void;
  snapshot(): UiPerformanceSnapshot;
}

export function uiPerformanceAuditApi(controller: EditorController): UiPerformanceAuditApi {
  return {
    start: () => startUiPerformanceAudit(controller),
    stop: stopUiPerformanceAudit,
    snapshot: uiPerformanceSnapshot,
  };
}
