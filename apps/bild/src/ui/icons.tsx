/**
 * Monochrome line icons standing in for the SF Symbols the macOS app uses
 * (NavigationTool.symbol in EditorSession.swift and the Layers panel buttons).
 */

import type { ReactElement } from 'react';

type IconName =
  | 'move' | 'marquee' | 'marqueeEllipse' | 'lasso' | 'polygonalLasso' | 'wand' | 'crop' | 'brush' | 'eraser'
  | 'spotHealing' | 'cloneStamp' | 'blur' | 'gradient' | 'shape' | 'eyedropper' | 'hand' | 'zoom' | 'idle'
  | 'eye' | 'eyeSlash' | 'folder' | 'chevronRight' | 'chevronDown' | 'plusSquare' | 'folderPlus' | 'mask'
  | 'adjustment' | 'trash' | 'link' | 'plus' | 'close' | 'zoomIn' | 'zoomOut' | 'swap' | 'reset' | 'menu'
  | 'layers' | 'sliders' | 'levels' | 'curves' | 'exposure' | 'grain' | 'gradientMap' | 'more';

const paths: Record<IconName, ReactElement> = {
  move: <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  marquee: <rect x="4" y="5" width="16" height="14" rx="1" strokeDasharray="3 2.2" />,
  marqueeEllipse: <ellipse cx="12" cy="12" rx="8.5" ry="7" strokeDasharray="3 2.2" />,
  lasso: <><path d="M5.5 13.5C3.6 10.4 6.4 5.5 12.4 5.1c5.4-.3 8.6 2.6 7.9 5.7-.7 3.3-6 5.2-10.8 4.1" /><path d="M9.6 14.9c-1.8.8-2.1 2.9-.4 3.6 1.2.5 2.6-.4 2.1-1.8" /></>,
  polygonalLasso: <><path d="M5 15 7 5l11 2 2 8-8.5 1" /><path d="M11.5 16c-1.7.7-2 2.8-.4 3.4 1.2.5 2.5-.4 2-1.7" /></>,
  wand: <><path d="M4 20 15 9" /><path d="M16 3v3M16 12v-1.5M19 6h2M11 6h2M18.5 3.5 17.5 4.5M13.5 8.5l1-1M18.5 8.5l-1-1" /></>,
  crop: <><path d="M6 2v16h16" /><path d="M2 6h16v16" /></>,
  brush: <><path d="M20 3 10 13" /><path d="M10 13c-2.6-.6-5.2 1-5.2 4.3 0 1.2-.7 2.1-1.8 2.7 3.7 1 7.8-.4 8.4-4.1z" /></>,
  eraser: <><path d="m4 15 9-9 7 7-6 6H8z" /><path d="M9 10l7 7M8 19h13" /></>,
  spotHealing: <><rect x="3" y="8.5" width="18" height="7" rx="3.5" transform="rotate(-45 12 12)" /><path d="M11 11h.01M13 13h.01M11 13h.01M13 11h.01" strokeWidth="2.2" /></>,
  cloneStamp: <><path d="M9 4h6v5l3 3H6l3-3z" /><path d="M5 15h14v3H5zM7 21h10" /></>,
  blur: <path d="M12 3.5c3 4 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.5 6-10.5z" />,
  gradient: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 12h16v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor" /></>,
  shape: <><rect x="3" y="3" width="11" height="11" rx="1" /><circle cx="15" cy="15" r="6" /></>,
  eyedropper: <><path d="m14 4 6 6M12.5 6.5l5 5L9 20H4v-5z" /></>,
  hand: <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13M17 11a1.5 1.5 0 0 1 3 0v3c0 4-3 7-7 7-3 0-4.4-1.3-6-4l-2.3-4.1a1.5 1.5 0 0 1 2.6-1.5L8 13" />,
  zoom: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  idle: <path d="M5 5l14 14M19 5 5 19" />,
  eye: <><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeSlash: <><path d="M2 12s3.6-6.5 10-6.5c2 0 3.7.6 5.1 1.5M22 12s-3.6 6.5-10 6.5c-2 0-3.7-.6-5.1-1.5" /><path d="M4 4l16 16" /></>,
  folder: <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  plusSquare: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></>,
  folderPlus: <><path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" /><path d="M12 10v6M9 13h6" /></>,
  mask: <><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="7" y="8.5" width="10" height="7" rx="1" fill="currentColor" /></>,
  adjustment: <><circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>,
  trash: <><path d="M4 7h16M9 7V4.5h6V7M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M7 7l10 10M17 7 7 17" />,
  zoomIn: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M10.5 7.5v6M7.5 10.5h6" /></>,
  zoomOut: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M7.5 10.5h6" /></>,
  swap: <path d="M7 17 17 7M13 7h4v4M11 17H7v-4" />,
  reset: <path d="M5 12a7 7 0 1 0 2.1-5M5 4v4h4" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  layers: <><path d="m12 4 9 5-9 5-9-5z" /><path d="m3 14 9 5 9-5" /></>,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4" />,
  levels: <path d="M4 7h16M4 12h16M4 17h16M8 5v4M15 10v4M11 15v4" />,
  curves: <><path d="M4 20C10 20 9 4 20 4" /><circle cx="4" cy="20" r="1.5" /><circle cx="20" cy="4" r="1.5" /></>,
  exposure: <><circle cx="12" cy="12" r="8" /><path d="M9 9h4M11 7v4M9 15h6" /></>,
  grain: <path d="M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01" strokeWidth="3" />,
  gradientMap: <><path d="M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2.5-1.5H18a3 3 0 0 0 3-3c0-5-4-9-9-9z" /><path d="M7.5 11h.01M10 7.5h.01M14.5 7.5h.01" strokeWidth="2.5" /></>,
  more: <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="3" />,
};

export function Icon({ name, size = 18, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  );
}

export type { IconName };
