import { Fragment, useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useUi, useWorkspace } from './hooks';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';
import { ContextBar, StatusBar } from './ContextBar';
import { CanvasPane } from './CanvasPane';
import { LayersPanel } from './LayersPanel';
import { DialogHost } from './Dialogs';
import { buildMenus, shortcutMap, shortcutOf } from './menus';
import { Icon } from './icons';
import { modifiersOf } from './canvas/CanvasView';
import type { Tool } from '../core/session';

type Layout = 'desktop' | 'compact' | 'compactLandscape';

function layoutFor(width: number, height: number): Layout {
  if (width >= 768 && height >= 500) return 'desktop';
  return width > height ? 'compactLandscape' : 'compact';
}

const TOOL_KEYS: Record<string, Tool> = {
  a: 'idle', v: 'move', m: 'marquee', l: 'lasso', w: 'wand', c: 'crop', b: 'brush', e: 'brush', j: 'spotHealing',
  s: 'cloneStamp', r: 'blur', g: 'gradient', u: 'shape', i: 'eyedropper', h: 'hand', z: 'zoom',
};

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return element.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes((element as HTMLInputElement).type));
}

export function EditorRoot({ controller }: { controller: EditorController }) {
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>('desktop');
  useWorkspace(controller);
  const sheet = useUi(controller, (s) => s.sheet);

  useEffect(() => {
    const element = root.current!;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = layoutFor(rect.width, rect.height);
      setLayout(next);
      controller.ui.setState({ compact: next !== 'desktop' });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [controller]);

  // The editor takes keyboard focus when it mounts (CanvasView.consumeFocusRequest), so shortcuts work at once.
  // Focus also comes back when the focused control disappears (the new-canvas sheet after Create, a closed panel):
  // while the editor held focus and nothing else took it, the next change refocuses the editor. Chrome reports the
  // removal as a focusout of a detached element; Firefox reports nothing, hence the check on workspace changes.
  useEffect(() => {
    const element = root.current!;
    let holds = true;
    element.focus({ preventScroll: true });
    const focusIn = () => { holds = true; };
    const focusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next ? !element.contains(next) : (event.target as Element).isConnected) holds = false;
    };
    const refocus = () => {
      if (holds && element.isConnected && (!document.activeElement || document.activeElement === document.body)) element.focus({ preventScroll: true });
    };
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    const later = () => queueMicrotask(refocus);
    element.addEventListener('focusout', later);
    const unwatch = controller.workspace.subscribe(() => queueMicrotask(refocus));
    return () => {
      element.removeEventListener('focusin', focusIn); element.removeEventListener('focusout', focusOut); element.removeEventListener('focusout', later); unwatch();
    };
  }, [controller]);

  // Engine errors left on a session (brush, retouch, transform, bake: EditorSession+Brush.brushError) become alerts.
  useEffect(() => {
    const check = () => {
      const session = controller.session;
      const message = session.errorMessage;
      if (!message || controller.ui.getState().dialog) return;
      session.errorMessage = null;
      controller.reportError('editor-error', new Error(message));
    };
    // The workspace relays every tab's session changes.
    check();
    return controller.workspace.subscribe(check);
  }, [controller]);

  // Closing the page with unsaved tabs asks first (ProjectWorkspace.confirmQuit). Browsers only allow their own
  // generic prompt here; per-tab Save/Don't Save questions are asked by the host shell or when closing a tab.
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.workspace.tabs.some((tab) => tab.session.document && tab.session.isModified)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    addEventListener('beforeunload', beforeUnload);
    return () => removeEventListener('beforeunload', beforeUnload);
  }, [controller]);

  useEffect(() => {
    const element = root.current!;
    const onKeyDown = (event: KeyboardEvent) => {
      if (controller.ui.getState().dialog) return;
      const session = controller.session;
      const view = controller.canvasView;
      if (isTextTarget(event.target)) return;
      const shortcut = shortcutOf(event);
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      // ⌘V goes through the browser's paste event, which carries clipboard images without a prompt.
      if (shortcut === 'mod+v') return;
      // Menu shortcuts first (CompositorApp commands).
      const item = shortcutMap(buildMenus(controller, controller.features)).get(shortcut);
      if (item) {
        event.preventDefault();
        if (item.enabled) item.run?.();
        return;
      }
      if (controller.keyHandlers.some((handler) => handler(event))) { event.preventDefault(); return; }
      view?.refreshCursor(event);
      if (event.key === ' ' && !event.repeat) {
        controller.ui.setState({ spaceHeld: true });
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        if (view?.cancelGesture()) { event.preventDefault(); return; }
        if (session.transformEdit) { if (view) view.distortArmed = false; session.cancelTransform(); event.preventDefault(); return; }
      }
      if (event.key === 'Enter' && session.transformEdit) {
        if (view) view.distortArmed = false;
        session.commitTransform();
        event.preventDefault();
        return;
      }
      if (!modified && event.shiftKey && (event.key === '+' || event.key === '_' || event.code === 'Equal' || event.code === 'Minus')) {
        session.cycleBlendMode(event.key === '+' || event.code === 'Equal');
        event.preventDefault();
        return;
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !modified) {
        if (session.tool === 'move' && session.document) {
          const step = event.shiftKey ? 10 : 1;
          session.nudgeLayer(event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
            event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0);
          event.preventDefault();
        }
        return;
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !modified) {
        if (controller.features.deleteKey) controller.features.deleteKey.run();
        else void session.deleteLayerOrMask();
        event.preventDefault();
        return;
      }
      if (modified) return;
      const key = event.key.toLowerCase();
      if (/^[0-9]$/.test(key) && session.usesOpacityKeys) {
        const handled = controller.opacityKey?.(Number(key));
        if (!handled) session.typeOpacityDigit(Number(key));
        event.preventDefault();
        return;
      }
      if (key === 'x') { session.swapPaletteColors(); event.preventDefault(); return; }
      if (key === 'd') { session.resetPaletteColors(); event.preventDefault(); return; }
      const tool = TOOL_KEYS[key];
      if (tool && controller.availableTools.has(tool)) {
        if (!event.repeat) controller.selectToolByKey(tool, key, event.shiftKey);
        event.preventDefault();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') controller.ui.setState({ spaceHeld: false });
      controller.canvasView?.refreshCursor(event);
      void modifiersOf;
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextTarget(event.target) || controller.ui.getState().dialog) return;
      if (controller.pasteEvent?.(event)) event.preventDefault();
    };
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('keyup', onKeyUp);
    element.addEventListener('paste', onPaste);
    return () => { element.removeEventListener('keydown', onKeyDown); element.removeEventListener('keyup', onKeyUp); element.removeEventListener('paste', onPaste); };
  }, [controller]);

  const className = `${styles.root} ${controller.theme === 'light' ? styles.light : ''} ${layout === 'compact' ? styles.compact : layout === 'compactLandscape' ? styles.compactLandscape : ''}`;
  return (
    <div ref={root} className={className} tabIndex={-1} lang={controller.locale} data-testid="compositor-editor" data-layout={layout}>
      <TopBar controller={controller} compact={layout !== 'desktop'} />
      <ContextBar controller={controller} />
      <ToolRail controller={controller} />
      <CanvasPane controller={controller} />
      {layout === 'desktop' ? <LayersPanel controller={controller} /> : null}
      {layout === 'desktop' ? <StatusBar controller={controller} /> : null}
      {layout !== 'desktop' && sheet === 'layers' ? (
        <>
          <div className={styles.sheetBackdrop} onClick={() => controller.ui.setState({ sheet: null })} />
          <div className={styles.sheet} role="dialog" aria-label={controller.t('Layers')} data-testid="layers-sheet">
            <div className={styles.sheetGrabber} />
            <button type="button" className={`${styles.iconButton} ${styles.sheetClose}`} aria-label={controller.t('Close')}
              onClick={() => controller.ui.setState({ sheet: null })}><Icon name="close" /></button>
            <LayersPanel controller={controller} inSheet />
          </div>
        </>
      ) : null}
      {controller.panels.map((panel, index) => <Fragment key={index}>{panel()}</Fragment>)}
      <DialogHost controller={controller} />
    </div>
  );
}
