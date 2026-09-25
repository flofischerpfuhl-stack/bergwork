import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useUi, useWorkspaceSelector } from './hooks';
import { Icon } from './icons';
import { buildMenus, shortcutLabel, type Menu, type MenuEntry, type MenuItem } from './menus';
import { isProjectFile } from './projectFiles';
import { markUiRender } from './performance';

export function MenuPopup({ items, anchor, onClose, controller, flipRight }: {
  items: MenuEntry[]; anchor: { x: number; y: number }; onClose: () => void; controller: EditorController;
  /** For a submenu: where its right edge goes when it does not fit to the right (the parent menu's left edge). */
  flipRight?: number;
}) {
  markUiRender('MenuPopup');
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  const [submenu, setSubmenu] = useState<{ items: MenuEntry[]; anchor: { x: number; y: number }; flipRight: number } | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const x = flipRight !== undefined && anchor.x + rect.width > innerWidth - 4 ? flipRight - rect.width : anchor.x;
    setPosition({ x: Math.max(4, Math.min(x, innerWidth - rect.width - 4)), y: Math.max(4, Math.min(anchor.y, innerHeight - rect.height - 4)) });
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
      <div ref={ref} className={styles.menuPopup} style={{ left: position.x, top: position.y }} role="menu" data-menu-popup>
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

export function TopBar({ controller, compact }: { controller: EditorController; compact: boolean }) {
  markUiRender('TopBar');
  useWorkspaceSelector(controller, (workspace) => JSON.stringify([
    workspace.selectedId, workspace.canSwitch,
    workspace.tabs.map((tab) => [tab.id, tab.title, tab.session.isModified, !!tab.session.document]),
  ]));
  const session = controller.session;
  const openMenu = useUi(controller, (s) => s.openMenu);
  const t = controller.t;
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const menus: Menu[] = buildMenus(controller, controller.features);
  const workspace = controller.workspace;
  const document = session.document;
  const open = (title: string, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.bottom + 4 });
    controller.ui.setState({ openMenu: openMenu === title ? null : title });
  };
  const current = menus.find((m) => m.title === openMenu);
  const allItems: MenuEntry[] = compact ? menus.flatMap((m, i) => [...(i ? ['separator' as const] : []), { label: m.title, enabled: true, submenu: m.items.filter((x): x is MenuItem => x !== 'separator') }]) : [];
  return (
    <div className={styles.topBar} role="toolbar" aria-label="Editor">
      {compact ? (
        <button type="button" className={styles.iconButton} aria-label={t('Menu')} aria-haspopup="menu" data-testid="compact-menu"
          onClick={(event) => open('__all', event.currentTarget)}><Icon name="menu" /></button>
      ) : (
        <nav className={styles.menuBar} aria-label={t('Menu bar')}>
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
      <button type="button" className={styles.iconButton} aria-label={t('New canvas')} title={`${t('New canvas')} (${shortcutLabel('mod+alt+n')}) · ${t('Drop images here for new tabs')}`}
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
        }}><Icon name="plus" /></button>
      <div className={styles.tabs} role="tablist" aria-label={t('Project tabs')}>
        {workspace.tabs.map((tab) => {
          const active = tab.id === workspace.selectedId;
          return (
            <div key={tab.id} className={`${styles.tab} ${active ? styles.tabActive : ''}`} data-tab-id={tab.id}
              onDragOver={(event) => { if ([...event.dataTransfer.types].includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
              onDrop={(event) => {
                event.preventDefault();
                workspace.select(tab.id);
                const files = [...event.dataTransfer.files];
                // Projects open in their own tab (as on the canvas); images are imported into this one.
                for (const archive of files.filter((f) => isProjectFile(f.name))) void controller.openArchive(archive).catch((error) => controller.reportError('open-failed', error));
                const images = files.filter((f) => !isProjectFile(f.name));
                if (images.length) void controller.importFiles(images, tab);
              }}>
              <button type="button" role="tab" aria-selected={active} className={styles.tabLabel} title={tab.title}
                disabled={!workspace.canSwitch && !active} onClick={() => workspace.select(tab.id)}>
                {tab.session.isModified && tab.session.document ? <span className={styles.tabDot} aria-label={t('Unsaved changes')} /> : null}
                {tab.title}
              </button>
              <button type="button" className={styles.tabClose} aria-label={`${t('Close')} ${tab.title}`} disabled={!workspace.canSwitch}
                onClick={() => void controller.closeTab(tab.id)}><Icon name="close" size={11} /></button>
            </div>
          );
        })}
      </div>
      <div className={styles.zoomGroup}>
        {!compact ? (
          <>
            <button type="button" className={styles.iconButton} disabled={!document} onClick={() => session.fit()} title={`${t('Fit Canvas')} (${shortcutLabel('mod+0')})`} data-testid="fit">{t('Fit')}</button>
            <button type="button" className={styles.iconButton} disabled={!document} onClick={() => session.zoomTo(1)} title={`${t('Actual Pixels')} (${shortcutLabel('mod+1')})`}>100%</button>
          </>
        ) : null}
        <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom out')} onClick={() => session.zoomTo(session.viewport.zoom / 1.25)}><Icon name="zoomOut" /></button>
        <button type="button" className={styles.iconButton} disabled={!document} aria-label={t('Zoom in')} onClick={() => session.zoomTo(session.viewport.zoom * 1.25)}><Icon name="zoomIn" /></button>
        {compact ? (
          <button type="button" className={styles.iconButton} aria-label={t('Layers')} data-testid="open-layers"
            onClick={() => controller.ui.setState((s) => ({ sheet: s.sheet === 'layers' ? null : 'layers' }))}><Icon name="layers" /></button>
        ) : null}
      </div>
      {openMenu && anchor ? (
        <MenuPopup controller={controller} anchor={anchor} items={openMenu === '__all' ? allItems : current?.items ?? []}
          onClose={() => controller.ui.setState({ openMenu: null })} />
      ) : null}
    </div>
  );
}
