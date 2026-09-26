import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSessionSelector, useUi, useWorkspaceSelector } from './hooks';
import { TopBar } from './TopBar';
import { ToolRail } from './ToolRail';
import { ContextBar, StatusBar } from './ContextBar';
import { CanvasPane } from './CanvasPane';
import { LayersPanel } from './LayersPanel';
import { DialogHost, dismissDialog } from './Dialogs';
import { buildMenus, shortcutMap, shortcutOf } from './menus';
import { Icon } from './icons';
import { modifiersOf } from './canvas/CanvasView';
import { TOOLS, type Tool } from '../core/session';
import { markUiRender } from './performance';

type Layout = 'desktop' | 'compact' | 'compactLandscape';

function layoutFor(width: number, height: number): Layout {
  if (width >= 768 && height >= 500) return 'desktop';
  return width > height ? 'compactLandscape' : 'compact';
}

/** The one-column tool palette needs this much height below the top bar and options bar; shorter editors get two columns. */
function railNeedsTwoColumns(height: number): boolean {
  // Touch screens get larger chrome (editor.module.css, pointer: coarse).
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  return height < (coarse ? 132 : 116) + TOOLS.length * (coarse ? 40 : 34) + 72;
}

/** Tab (and Shift+Tab) toggle the chrome only when the keyboard is on the editor or the canvas, never inside a control. */
function isChromeKeyTarget(target: EventTarget | null, root: HTMLElement): boolean {
  const element = target as HTMLElement | null;
  if (!element || element === root) return true;
  return !!element.closest?.('.compositor-canvas-host') && !isTextTarget(element);
}

const TOOL_KEYS: Record<string, Tool> = {
  a: 'directSelect', p: 'pen', v: 'move', m: 'marquee', l: 'lasso', w: 'wand', c: 'crop', b: 'brush', e: 'brush', j: 'spotHealing',
  s: 'cloneStamp', r: 'blur', g: 'gradient', u: 'shape', i: 'eyedropper', h: 'hand', z: 'zoom',
};

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return element.isContentEditable || tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'color'].includes((element as HTMLInputElement).type));
}

export function EditorRoot({ controller }: { controller: EditorController }) {
  markUiRender('EditorRoot');
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>('desktop');
  const [railTwo, setRailTwo] = useState(false);
  const [barWidth, setBarWidth] = useState<'full' | 'dense' | 'narrow'>('full');
  const sheet = useUi(controller, (s) => s.sheet);
  const chromeHidden = useUi(controller, (s) => s.chromeHidden);
  const panelsOpen = useUi(controller, (s) => s.panelsOpen);
  const layersWidth = useUi(controller, (s) => s.layersWidth);
  const theme = useUi(controller, (s) => s.theme);

  useEffect(() => {
    const element = root.current!;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const next = layoutFor(rect.width, rect.height);
      setLayout(next);
      setRailTwo(next === 'desktop' && railNeedsTwoColumns(rect.height));
      setBarWidth(rect.width < 900 ? 'narrow' : rect.width < 1180 ? 'dense' : 'full');
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
      if (next) { if (!element.contains(next)) holds = false; return; }
      // Focus went nowhere: a click outside keeps the target connected; a removed control (current Chrome reports
      // the focusout before React detaches it) does not. Decide once the removal is done.
      const target = event.target as Element;
      queueMicrotask(() => { if (target.isConnected) holds = false; });
    };
    const refocus = () => {
      if (holds && element.isConnected && (!document.activeElement || document.activeElement === document.body)) element.focus({ preventScroll: true });
    };
    element.addEventListener('focusin', focusIn);
    element.addEventListener('focusout', focusOut);
    // Only when focus went nowhere: during Tab navigation (or a click into the host page) the microtask would run
    // mid-transition, see the body focused and pull the focus back into the editor.
    const later = (event: FocusEvent) => { if (!event.relatedTarget) queueMicrotask(refocus); };
    element.addEventListener('focusout', later);
    // A mouse click on a chrome button gives the keyboard to the editor (the canvas), as in Photoshop: shortcuts, Space
    // and Tab keep working after using the toolbar (a text field being edited is left, as with any click). Dialogs and menus keep normal focus; keyboard users still Tab in.
    const keepFocus = (event: MouseEvent) => {
      const button = event.button === 0 ? (event.target as Element).closest?.('button') : null;
      if (!button || !element.contains(button) || button.closest('[role=dialog], [role=alertdialog], [role=menu]')) return;
      event.preventDefault();
      if (document.activeElement !== element) element.focus({ preventScroll: true });
    };
    element.addEventListener('mousedown', keepFocus);
    // After React has committed (the focused control may only disappear then), once per frame.
    let frame = 0;
    const unwatch = controller.workspace.subscribe(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; refocus(); });
    });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('focusin', focusIn); element.removeEventListener('focusout', focusOut); element.removeEventListener('focusout', later);
      element.removeEventListener('mousedown', keepFocus); unwatch();
    };
  }, [controller]);

  // An embedding page's theme switch (html[data-theme="light|dark"]) wins over the mount option, live.
  useEffect(() => {
    const html = document.documentElement;
    const initial = controller.theme;
    const sync = () => {
      const value = html.getAttribute('data-theme');
      const next = value === 'light' || value === 'dark' ? value : initial;
      if (controller.theme !== next) {
        controller.ui.setState({ theme: next });
        controller.canvasView?.redraw();
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
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
      if (controller.ui.getState().dialog) {
        // Focus may have fallen back to the editor (a focused control inside the dialog went away): Escape still closes it.
        if (event.key === 'Escape' && !(event.target as Element | null)?.closest?.('[role=dialog], [role=alertdialog]')) { dismissDialog(controller); event.preventDefault(); }
        return;
      }
      const session = controller.session;
      const view = controller.canvasView;
      if (isTextTarget(event.target)) return;
      // Photoshop: Tab shows or hides the tools, options bar and panels; Shift+Tab only the panels.
      if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && isChromeKeyTarget(event.target, element)) {
        if (event.shiftKey) controller.togglePanels();
        else controller.toggleChrome();
        event.preventDefault();
        return;
      }
      // Inside the chrome Tab moves the focus (keyboard access); the View menu only shows the shortcut.
      if (event.key === 'Tab') return;
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
      // Quick Mask's Q is feature-owned but does not select a tool. Load its owner on the first press, then dispatch
      // that same DOM event once installation has registered the handler.
      const lazyKey = !modified && !event.repeat ? controller.loadFeatureForKey?.(event.key.toLowerCase()) : null;
      if (lazyKey) {
        event.preventDefault();
        void lazyKey.then(() => { controller.keyHandlers.some((handler) => handler(event)); }).catch(() => undefined);
        return;
      }
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
        if (!event.repeat) void controller.activateTool(tool, key, event.shiftKey);
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

  const desktop = layout === 'desktop';
  const showsPanels = desktop && panelsOpen && !chromeHidden;
  const className = ['fw-image-editor', styles.root, theme === 'light' ? styles.light : '',
    layout === 'compact' ? styles.compact : layout === 'compactLandscape' ? styles.compactLandscape : '',
    chromeHidden ? styles.chromeHidden : '', !showsPanels ? styles.panelsClosed : '', railTwo && !chromeHidden ? styles.railTwo : '']
    .filter(Boolean).join(' ');
  // The canvas pane is first so the floating chrome paints over the canvas; the chrome follows in reading order.
  return (
    <div ref={root} className={className} tabIndex={-1} lang={controller.locale} data-testid="compositor-editor" data-layout={layout} data-theme={theme}
      data-chrome={chromeHidden ? 'hidden' : showsPanels ? 'all' : 'no-panels'} data-bar-width={barWidth}
      style={{ '--cmp-panel-w': `${layersWidth}px` } as CSSProperties}>
      <CanvasPane controller={controller} />
      <TopBar controller={controller} compact={!desktop} width={barWidth} />
      {!chromeHidden ? <ContextBar controller={controller} /> : null}
      {!chromeHidden ? <ToolRail controller={controller} /> : null}
      {showsPanels ? <LayersPanel controller={controller} /> : null}
      {desktop && !chromeHidden ? <div className={styles.statusDock}><StatusBar controller={controller} /></div> : null}
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
      <RegisteredPanels controller={controller} />
      <DialogHost controller={controller} />
    </div>
  );
}

/** Feature panels subscribe for themselves; only lazy text-panel installation needs its host refreshed. */
function RegisteredPanels({ controller }: { controller: EditorController }) {
  markUiRender('RegisteredPanels');
  useUi(controller, () => controller.panels.length);
  useWorkspaceSelector(controller, (workspace) => workspace.selectedId);
  const session = controller.session;
  useSessionSelector(session, (current) => {
    const textUiRelevant = current.tool === 'text' || !!current.document?.layers.some((layer) => layer.kind === 'text');
    return `${controller.panels.length}|${textUiRelevant ? `text:${current.revision}` : current.tool}`;
  });
  return controller.panels.map((panel, index) => <Fragment key={index}>{panel()}</Fragment>);
}
