/**
 * The berg:work PDF window: the design base's title bar (mark, wordmark, product, document, about, appearance and,
 * in the desktop app, the window buttons) above the editor. The editor follows html[data-theme], which
 * useAppearance sets, so the appearance menu switches both. Same window as berg:work Image (apps/image/src/app/shell.tsx).
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Info, ScrollText } from 'lucide-react';
import { MenuButton, TITLE_BAR_DE, TITLE_BAR_EN, TitleBar, TooltipLayer, resolvedTheme, useAppearance } from '@bergwork/ui';
import { DesktopOverlays, desktop, installDesktopDocuments, openDialogDescription, reopenWindows, shouldClaimOrphans } from './desktopDocuments';
import { appVersion, desktopWindow, setWindowFullscreen, setWindowTitle, windowCall, wireDesktopWindow } from './desktopWindow';
import { mountEditor } from './editor';
import { HomeLink } from './homeLink';
import { SAMPLE_LABEL, openSample, takeSampleRequest } from './sample';
import { installLaunchQueue, openSharedFiles } from './launch-files';
// @ts-expect-error plain ES module without types
import { showLicences } from './licenses-view.js';
// @ts-expect-error plain ES module without types
import { editorReady, installNativeFiles, openDocumentsFromSystem } from './native-files.js';

const APP_NAME = 'berg:work PDF';
const locale: 'de' | 'en' = navigator.language.startsWith('de') ? 'de' : 'en';
/** The desktop app (Tauri) keeps a plain logo and offers no sample; the web app at /app/pdf/ links back to the site. */
const inDesktopApp = '__TAURI__' in globalThis;
const ABOUT = locale === 'de' ? { about: 'Über berg:work PDF', licences: 'Lizenzen…' } : { about: 'About berg:work PDF', licences: 'Licences…' };

function Shell() {
  const [appearance, setAppearance] = useAppearance();
  const [document, setDocument] = useState<{ readonly title: string; readonly dirty: boolean }>({ title: '', dirty: false });
  const [version, setVersion] = useState<string>();
  const stage = useRef<HTMLDivElement>(null);
  const window = useRef<HTMLDivElement>(null);
  const theme = resolvedTheme(appearance.theme);

  const mounted = useRef(false);
  useEffect(() => {
    // The editor has no unmount, so it mounts once per page; StrictMode's second effect run finds it mounted.
    if (mounted.current) return;
    mounted.current = true;
    installNativeFiles({ openDialogDescription });
    void appVersion().then(setVersion);
    const sample = inDesktopApp ? undefined : { label: SAMPLE_LABEL, open: () => void openSample() };
    void mountEditor(stage.current!, {
      setTitle: (title, { dirty = false } = {}) => setDocument({ title, dirty }), sample, desktop,
      claimOrphans: shouldClaimOrphans, setFullscreen: setWindowFullscreen,
    })
      .then((orphans) => {
        installDesktopDocuments();
        void openDocumentsFromSystem();
        void reopenWindows(orphans);
        // bergwork.app links to /app/pdf/?sample: the sample opens once the editor has restored its workspace.
        if (sample && takeSampleRequest()) void editorReady().then(openSample);
        // The installed web app: "Open with" and "Share" (see launch-files.ts).
        if (!inDesktopApp) void editorReady().then(() => { installLaunchQueue(); void openSharedFiles(); });
      });
  }, []);

  useEffect(() => {
    const titleBar = window.current?.querySelector<HTMLElement>('.bw-titlebar');
    return titleBar ? wireDesktopWindow(titleBar) : undefined;
  }, []);

  useEffect(() => {
    setWindowTitle(document.title ? `${document.dirty ? '• ' : ''}${document.title} — ${APP_NAME}` : APP_NAME);
  }, [document]);

  const mark = `${import.meta.env.BASE_URL}${theme === 'light' ? 'icon-light.svg' : 'icon-dark.svg'}`;
  return (
    <div ref={window} className="bw-window">
      <TitleBar mark={<img src={mark} alt="" width={20} height={20} draggable={false} />} product="PDF"
        document={document.title ? `${document.dirty ? '• ' : ''}${document.title}` : ''}
        appearance={appearance} onAppearance={setAppearance} strings={locale === 'de' ? TITLE_BAR_DE : TITLE_BAR_EN}
        actions={(
          <MenuButton className="bw-titlebar-button" label={ABOUT.about} tip={ABOUT.about} entries={[
            { label: version ? `${APP_NAME} ${version}` : APP_NAME, disabled: true },
            { type: 'divider' },
            { label: ABOUT.licences, icon: <ScrollText size={16} strokeWidth={1.7} />, onSelect: () => void showLicences() },
          ]}>
            <Info size={15} strokeWidth={1.7} />
          </MenuButton>
        )}
        windowControls={desktopWindow ? {
          onMinimize: () => windowCall('minimize'), onMaximize: () => windowCall('toggleMaximize'), onClose: () => windowCall('close'),
        } : undefined} />
      {inDesktopApp ? null : <HomeLink root={window} />}
      <div ref={stage} id="pdf-workbench-root" className="bw-stage" />
      {inDesktopApp ? <DesktopOverlays /> : null}
      <TooltipLayer />
    </div>
  );
}

export function renderShell(root: HTMLElement): void {
  createRoot(root).render(<StrictMode><Shell /></StrictMode>);
}
