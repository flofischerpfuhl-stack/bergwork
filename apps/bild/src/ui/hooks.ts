import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { EditorSession } from '../core/session';
import type { EditorController } from './controller';
import type { UiState } from './store';

/** Re-renders on document/UI changes of a session; pan/zoom-only changes are ignored unless asked. */
export function useSession(session: EditorSession, includeView = false): EditorSession {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe((kind) => { if (includeView || kind !== 'view') bump(); }), [session, includeView]);
  return session;
}

export function useWorkspace(controller: EditorController): void {
  useSyncExternalStore((callback) => controller.workspace.subscribe(callback), () => controller.workspace.revision);
}

export function useUi<T>(controller: EditorController, selector: (state: UiState) => T): T {
  return useStore(controller.ui, selector);
}
