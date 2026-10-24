/**
 * The berg:work Image window for the web: title bar (mark, wordmark, product, document, appearance) above the
 * editor. The editor follows the page's html[data-theme], which useAppearance sets, so the title bar's appearance
 * menu switches both. Desktop builds add the window buttons through their own host later.
 */
import '@bergwork/ui/styles.css';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TITLE_BAR_DE, TITLE_BAR_EN, TitleBar, TooltipLayer, resolvedTheme, useAppearance } from '@bergwork/ui';
import type { DocumentInfoV2, EditorHandleV2 } from '../../contracts-v2';
import markDark from './bergwork-image.svg';
import markLight from './bergwork-image-on-light.svg';

const locale: 'de' | 'en' = navigator.language.startsWith('de') ? 'de' : 'en';

function documentLabel(info: DocumentInfoV2 | null): string {
  if (!info) return '';
  const size = info.width && info.height ? ` — ${info.width} × ${info.height}` : '';
  return `${info.modified ? '• ' : ''}${info.title}${size}`;
}

function Shell() {
  const [appearance, setAppearance] = useAppearance();
  const [info, setInfo] = useState<DocumentInfoV2 | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const theme = resolvedTheme(appearance.theme);

  useEffect(() => {
    let handle: EditorHandleV2 | null = null, stop: (() => void) | undefined, cancelled = false;
    void (async () => {
      const [{ mountEditor }, { createBrowserHost }] = await Promise.all([import('../index'), import('../platform/browserHost')]);
      if (cancelled || !host.current) return;
      handle = await mountEditor(host.current, { host: createBrowserHost(), profile: 'lite', locale, theme });
      if (cancelled) { handle.destroy(); return; }
      stop = handle.subscribeDocument?.(setInfo);
    })();
    return () => { cancelled = true; stop?.(); handle?.destroy(); };
    // The editor mounts once; later theme changes reach it through html[data-theme].
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label = documentLabel(info);
  useEffect(() => { document.title = info?.width ? `${info.title} — berg:work Image` : 'berg:work Image'; }, [info]);
  return (
    <div className="bw-window">
      <TitleBar mark={<img src={theme === 'light' ? markLight : markDark} alt="" width={20} height={20} />} product="Image"
        document={label} appearance={appearance} onAppearance={setAppearance} strings={locale === 'de' ? TITLE_BAR_DE : TITLE_BAR_EN} />
      <div ref={host} className="bw-stage" />
      <TooltipLayer />
    </div>
  );
}

export function renderShell(root: HTMLElement): void {
  createRoot(root).render(<StrictMode><Shell /></StrictMode>);
}
