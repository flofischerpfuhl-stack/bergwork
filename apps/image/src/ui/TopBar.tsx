import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import { droppedFiles } from './dropFiles';
import type { EditorController } from './controller';
import { useSessionSelector, useUi, useWorkspaceSelector } from './hooks';
import { Icon } from './icons';
import { cachedMenus, shortcutLabel, type Menu, type MenuEntry, type MenuItem } from './menus';
import { isProjectFile } from './projectFiles';
import { markUiRender } from './performance';

export function MenuPopup({ items, anchor, onClose, controller, flipRight }: {
  items: MenuEntry[]; anchor: { x: number; y: number }; onClose: () => void; controller: EditorController;
  /** For a submenu: where its right edge goes when it does not fit to the right (the parent menu's left edge). */
  flipRight?: number;
}) {
  markUiRender('MenuPopup');
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ items: MenuEntry[]; anchor: { x: number; y: number }; flipRight: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Menus stay inside the editor's box, not the window: an embedding app may put its own title bar around it.
    const editor = element.closest('.fw-image-editor')?.getBoundingClientRect() ?? { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    // A menu fits below its anchor (and never slides up over its own title); only anchors near the bottom (panel
    // footers) let it use the editor's full height.
    const below = editor.bottom - anchor.y - 8;
    element.style.maxHeight = `${Math.max(120, below >= 240 ? below : editor.bottom - editor.top - 16)}px`;
    const rect = element.getBoundingClientRect();
    const x = flipRight !== undefined && anchor.x + rect.width > editor.right - 4 ? flipRight - rect.width : anchor.x;
    element.style.left = `${Math.max(editor.left + 4, Math.min(x, editor.right - rect.width - 4))}px`;
    element.style.top = `${Math.max(editor.top + 4, Math.min(anchor.y, editor.bottom - rect.height - 4))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [anchor.x, anchor.y, flipRight]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !(event.target as Element).closest?.('[data-menu-popup]')) onClose(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        event.preventDefault();
      }
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <>
      <div ref={ref} className={styles.menuPopup} style={{ left: anchor.x, top: anchor.y }} role="menu" data-menu-popup>
        {items.map((item, index) => item === 'separator'
          ? <div key={index} className={styles.menuSeparator} role="separator" />
          : (
            <button key={index} type="button" role="menuitem" className={styles.menuItem} disabled={!item.enabled}
              title={item.note} data-testid={item.testId}
              onPointerEnter={(event) => {
                if (item.submenu) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setSubmenu({ items: item.submenu, anchor: { x: rect.right - 4, y: rect.top - 5 }, flipRight: rect.left + 4 });
                } else setSubmenu(null);
              }}
              onClick={(event) => {
                if (item.submenu) {
                  const rect = event.currentTarget.getBoundingClientRect();
                  setSubmenu({ items: item.submenu, anchor: { x: rect.right - 4, y: rect.top - 5 }, flipRight: rect.left + 4 });
                  return;
                }
                onClose();
                item.run?.();
              }}>
              {item.checked ? <span className={styles.menuCheck}>✓</span> : null}
              <span>{item.label}</span>
              {item.submenu ? <span className={styles.shortcut}>›</span> : item.shortcut ? <span className={styles.shortcut}>{shortcutLabel(item.shortcut)}</span> : null}
            </button>
          ))}
      </div>
      {submenu ? <MenuPopup items={submenu.items} anchor={submenu.anchor} flipRight={submenu.flipRight} controller={controller} onClose={onClose} /> : null}
    </>
  );
}

/** Undo and Redo beside the tabs (Fernwork PDF's top bar); isolated so history changes redraw only these two buttons. */
function HistoryButtons({ controller }: { controller: EditorController }) {
  markUiRender('HistoryButtons');
  useWorkspaceSelector(controller, (workspace) => workspace.selectedId);
  const session = controller.session;
  useSessionSelector(session, (current) => `${current.canUndo ? 1 : 0}${current.canRedo ? 1 : 0}|${current.history.undoName}|${current.history.redoName}`);
  const t = controller.t;
  const undo = session.history.canUndo ? `${t('Undo')} ${t(session.history.undoName)}` : t('Undo');
  const redo = session.history.canRedo ? `${t('Redo')} ${t(session.history.redoName)}` : t('Redo');
  return (
    <span className={styles.chromeGroup}>
      <button type="button" className={styles.chromeButton} disabled={!session.canUndo} data-testid="toolbar-undo"
        aria-label={t('Undo')} title={`${undo} (${shortcutLabel('mod+z')})`} onClick={() => session.undo()}><Icon name="undo" size={16} /></button>
      <button type="button" className={styles.chromeButton} disabled={!session.canRedo} data-testid="toolbar-redo"
        aria-label={t('Redo')} title={`${redo} (${shortcutLabel('mod+shift+z')})`} onClick={() => session.redo()}><Icon name="redo" size={16} /></button>
    </span>
  );
}

/** Shows or hides the panel stack (Fernwork PDF's Layers button); Shift+Tab does the same. */
function PanelsButton({ controller, label }: { controller: EditorController; label: boolean }) {
  markUiRender('PanelsButton');
  const open = useUi(controller, (s) => s.panelsOpen && !s.chromeHidden);
  const t = controller.t;
  return (
    <button type="button" className={`${styles.chromeButton} ${label ? styles.chromeButtonText : ''} ${open ? styles.chromeButtonOn : ''}`}
      aria-pressed={open} aria-label={label ? undefined : t('Panels')} data-testid="toggle-panels"
      title={`${t('Show or hide the panels')} (${shortcutLabel('shift+tab')})`} onClick={() => controller.togglePanels()}>
      <Icon name="layers" size={16} />{label ? t('Panels') : null}
    </button>
  );
}

/**
 * `compact`: the phone layouts. `width` narrows the desktop bar: 'dense' drops the file buttons (they are in the File
 * menu) and the Panels label; 'narrow' (tablets) folds the menus into one menu button as on phones.
 */
export function TopBar({ controller, compact, width = 'full' }: { controller: EditorController; compact: boolean; width?: 'full' | 'dense' | 'narrow' }) {
  markUiRender('TopBar');
  useWorkspaceSelector(controller, (workspace) => JSON.stringify([
    workspace.selectedId, workspace.canSwitch,
    workspace.tabs.map((tab) => [tab.id, tab.title, tab.session.isModified, !!tab.session.document]),
  ]));
  const session = controller.session;
  const openMenu = useUi(controller, (s) => s.openMenu);
  const t = controller.t;
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const workspaceForDrag = controller.workspace;
  /** Dragging a tab sideways reorders the tabs (Compositor 1.4.1); the tab follows the pointer until it is let go. */
  const startTabDrag = (event: React.PointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0 || event.pointerType === 'touch' || !tabStrip.current) return;
    const strip = tabStrip.current, startX = event.clientX;
    const element = strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`);
    let dragging = false;
    const target = (x: number) => [...strip.querySelectorAll<HTMLElement>('[data-tab-id]')]
      .filter((other) => other !== element).filter((other) => { const r = other.getBoundingClientRect(); return r.left + r.width / 2 < x; }).length;
    const move = (e: PointerEvent) => {
      if (!dragging && Math.abs(e.clientX - startX) < 6) return;
      dragging = true;
      if (element) { element.style.transform = `translateX(${e.clientX - startX}px)`; element.style.zIndex = '1'; element.dataset.dragging = 'true'; }
    };
    const up = (e: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (element) { element.style.transform = ''; element.style.zIndex = ''; delete element.dataset.dragging; }
      if (dragging && e.type === 'pointerup') workspaceForDrag.moveTab(id, target(e.clientX));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  };
  // Feature modules warm up after start-up; opening a menu loads the rest at once and redraws it with their entries.
  const [, setFeaturesLoaded] = useState(0);
  const loadMenuFeatures = () => { void controller.loadAllFeatures?.().then(() => setFeaturesLoaded((value) => value + 1)); };
  const menus: Menu[] = cachedMenus(controller);
  const workspace = controller.workspace;
  const document = session.document;
  const open = (title: string, element: HTMLElement) => {
    loadMenuFeatures();
    const rect = element.getBoundingClientRect();
    anchorRef.current = { x: rect.left, y: rect.bottom + 4 };
    controller.ui.setState({ openMenu: openMenu === title ? null : title });
  };
  const anchor = anchorRef.current;
  const current = menus.find((m) => m.title === openMenu);
  const menuButton = compact || width === 'narrow';
  const allItems: MenuEntry[] = menuButton ? menus.flatMap((m, i) => [...(i ? ['separator' as const] : []), { label: m.title, enabled: true, submenu: m.items.filter((x): x is MenuItem => x !== 'separator') }]) : [];
  return (
    <div className={styles.topBar} role="toolbar" aria-label="Editor">
      {/* Islands like the Builder's bars: the menus, the project tabs, the document actions. */}
      <div className={styles.topIsland}>
      {menuButton ? (
        <button type="button" className={styles.iconButton} aria-label={t('Menu')} aria-haspopup="menu" data-testid="compact-menu"
          onClick={(event) => open('__all', event.currentTarget)}><Icon name="menu" /></button>
      ) : (
        <nav className={styles.menuBar} aria-label={t('Menu bar')} data-testid="menu-bar">
          {menus.map((menu) => (
            <button key={menu.title} type="button" className={`${styles.menuTitle} ${openMenu === menu.title ? styles.menuTitleOpen : ''}`}
              aria-haspopup="menu" aria-expanded={openMenu === menu.title} data-testid={`menu-${menu.title}`}
              onClick={(event) => open(menu.title, event.currentTarget)}
              onPointerEnter={(event) => { if (openMenu && openMenu !== menu.title) open(menu.title, event.currentTarget); }}>
              {menu.title}
            </button>
          ))}
        </nav>
      )}
      </div>
      <div className={`${styles.topIsland} ${styles.topIslandTabs}`}>
      <button type="button" className={compact ? styles.iconButton : styles.chromeButton} aria-label={t('New canvas')} title={`${t('New canvas')} (${shortcutLabel('mod+alt+n')}) · ${t('Drop images here for new tabs')}`}
        disabled={!workspace.canSwitch} onClick={() => { workspace.newCanvas(); }} data-testid="new-canvas" data-new-tab
        onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
        onDrop={(event) => {
          // Dock/new-tab drops open one project per image (ProjectWorkspace.receive).
          event.preventDefault();
          for (const file of [...event.dataTransfer.files]) {
            if (isProjectFile(file.name)) { void controller.openArchive(file).catch((error) => controller.reportError('open-failed', error)); continue; }
            const tab = workspace.addTab();
            void controller.importFiles([file], tab);
          }
        }}><Icon name="plus" size={compact ? 18 : 16} /></button>
      <div ref={tabStrip} className={styles.tabs} role="tablist" aria-label={t('Project tabs')}>
        {workspace.tabs.map((tab) => {
          const active = tab.id === workspace.selectedId;
          return (
            <div key={tab.id} className={`${styles.tab} ${active ? styles.tabActive : ''}`} data-tab-id={tab.id}
              onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
              onDrop={(event) => {
                event.preventDefault();
                workspace.select(tab.id);
                void droppedFiles(event.dataTransfer).then(({ files }) => {
                  // Projects open in their own tab (as on the canvas); images, a folder's included, are imported into this one.
                  for (const archive of files.filter((f) => isProjectFile(f.name))) void controller.openArchive(archive).catch((error) => controller.reportError('open-failed', error));
                  const images = files.filter((f) => !isProjectFile(f.name));
                  if (images.length) void controller.importFiles(images, tab);
                });
              }}>
              <button type="button" role="tab" aria-selected={active} className={styles.tabLabel} title={tab.title}
                disabled={!workspace.canSwitch && !active} onClick={() => workspace.select(tab.id)}
                onPointerDown={(event) => startTabDrag(event, tab.id)}>
                {tab.session.isModified && tab.session.document ? <span className={styles.tabDot} aria-label={t('Unsaved changes')} /> : null}
                {tab.title}
              </button>
              <button type="button" className={styles.tabClose} aria-label={`${t('Close')} ${tab.title}`} disabled={!workspace.canSwitch}
                onClick={() => void controller.closeTab(tab.id)}><Icon name="close" size={11} /></button>
            </div>
          );
        })}
      </div>
      </div>
      {compact ? (
        // Phones: zoom and the Layers sheet here; the desktop status bar holds zoom.
        <div className={`${styles.topIsland} ${styles.topIslandEnd} ${styles.zoomGroup}`}>
          <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom out')} onClick={() => session.zoomTo(session.viewport.zoom / 1.25)}><Icon name="zoomOut" /></button>
          <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom in')} onClick={() => session.zoomTo(session.viewport.zoom * 1.25)}><Icon name="zoomIn" /></button>
          <button type="button" className={styles.iconButton} aria-label={t('Layers')} data-testid="open-layers"
            onClick={() => controller.ui.setState((s) => ({ sheet: s.sheet === 'layers' ? null : 'layers' }))}><Icon name="layers" /></button>
        </div>
      ) : (
        <div className={`${styles.topIsland} ${styles.topIslandEnd}`}>
          {width === 'full' ? <span className={styles.chromeGroup}>
            <button type="button" className={styles.chromeButton} disabled={!workspace.canSwitch} data-testid="toolbar-open"
              aria-label={t('Open')} title={`${t('Open Project…')} (${shortcutLabel('mod+o')})`} onClick={() => void controller.chooseAndOpen()}>
              <Icon name="open" size={16} /></button>
            <button type="button" className={styles.chromeButton} disabled={!document || !workspace.canSwitch} data-testid="toolbar-save"
              aria-label={t('Save')} title={`${t('Save')} (${shortcutLabel('mod+s')})`} onClick={() => void controller.save()}>
              <Icon name="save" size={16} /></button>
            <button type="button" className={styles.chromeButton} disabled={!document || !workspace.canSwitch} data-testid="toolbar-export"
              aria-label={t('Export As…')} title={`${t('Export As…')} (${shortcutLabel('mod+alt+shift+w')})`} onClick={() => controller.showDialog({ kind: 'export' })}>
              <Icon name="export" size={16} /></button>
          </span> : null}
          {width === 'full' ? <span className={styles.chromeDivider} aria-hidden /> : null}
          <HistoryButtons controller={controller} />
          <span className={styles.chromeDivider} aria-hidden />
          <PanelsButton controller={controller} label={width === 'full'} />
        </div>
      )}
      {openMenu && anchor ? (
        <MenuPopup controller={controller} anchor={anchor} items={openMenu === '__all' ? allItems : current?.items ?? []}
          onClose={() => controller.ui.setState({ openMenu: null })} />
      ) : null}
    </div>
  );
}
