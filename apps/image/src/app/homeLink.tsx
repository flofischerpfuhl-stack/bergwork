/**
 * The web app's way back to the site: the title bar's mark and wordmark link to bergwork.app (same tab). The design
 * base's TitleBar has no link slot, so a transparent link is portaled into its brand and laid over the mark and the
 * wordmark (shell.css). The desktop app keeps a plain logo: its frontend (src-tauri/frontend/) has no title bar, and
 * the shell renders this only outside Tauri. Same component as berg:work PDF's (apps/pdf/web/src/homeLink.tsx).
 */
import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export const HOME_URL = 'https://bergwork.app/';

export function HomeLink({ root }: { readonly root: RefObject<HTMLElement | null> }) {
  const [brand, setBrand] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number>();
  // A passive effect: the window's ref (a parent of this component) is attached after children's layout effects.
  useEffect(() => {
    const found = root.current?.querySelector<HTMLElement>('.bw-titlebar-brand') ?? null;
    setBrand(found);
    const wordmark = found?.querySelector<HTMLElement>('.bw-wordmark');
    if (!found || !wordmark) return undefined;
    // The link ends with the wordmark; its width changes once Bergschrift has loaded.
    const measure = () => setWidth(Math.ceil(wordmark.getBoundingClientRect().right - found.getBoundingClientRect().left));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wordmark);
    return () => observer.disconnect();
  }, [root]);
  if (!brand) return null;
  return createPortal(
    <a className="bw-home-link" href={HOME_URL} aria-label="berg:work home" data-tip="bergwork.app"
      style={width ? { width } : undefined} />,
    brand,
  );
}
