import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import type { EditorSession } from '../core/session';
import type { ProjectWorkspace } from '../core/workspace';
import type { EditorController } from './controller';
import type { UiState } from './store';

/** Re-renders on document/UI changes of a session; pan/zoom-only changes are ignored unless asked. */
export function useSession(session: EditorSession, includeView = false): EditorSession {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => session.subscribe((kind) => { if (includeView || kind !== 'view') bump(); }), [session, includeView]);
  return session;
}

/**
 * Re-renders only when the selected session state changes. Selectors must return a snapshot (not a
 * mutable session-owned object) when the compared values can be mutated in place.
 */
export function useSessionSelector<T>(session: EditorSession, selector: (session: EditorSession) => T,
  equal: (left: T, right: T) => boolean = Object.is, includeView = false): T {
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  selectorRef.current = selector;
  equalRef.current = equal;
  const selected = selector(session);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => session.subscribe((kind) => {
    if (!includeView && kind === 'view') return;
    const next = selectorRef.current(session);
    if (equalRef.current(selectedRef.current, next)) return;
    selectedRef.current = next;
    bump();
  }), [session, includeView]);
  return selected;
}

export function useWorkspace(controller: EditorController): void {
  useSyncExternalStore((callback) => controller.workspace.subscribe(callback), () => controller.workspace.revision);
}

/** Workspace notifications also relay document edits; this keeps structural consumers off that hot path. */
export function useWorkspaceSelector<T>(controller: EditorController, selector: (workspace: ProjectWorkspace) => T,
  equal: (left: T, right: T) => boolean = Object.is): T {
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  selectorRef.current = selector;
  equalRef.current = equal;
  const selected = selector(controller.workspace);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [, bump] = useReducer((value: number) => value + 1, 0);
  useEffect(() => controller.workspace.subscribe(() => {
    const next = selectorRef.current(controller.workspace);
    if (equalRef.current(selectedRef.current, next)) return;
    selectedRef.current = next;
    bump();
  }), [controller]);
  return selected;
}

export function useUi<T>(controller: EditorController, selector: (state: UiState) => T): T {
  return useStore(controller.ui, selector);
}
