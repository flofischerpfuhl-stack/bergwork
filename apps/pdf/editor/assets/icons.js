/**
 * Small shared Lucide-style icon catalog.
 *
 * Keeping the paths local makes the static app work offline and gives every
 * authored tool the same 24px outline language without shipping a runtime
 * dependency. Mathematical glyphs and third-party brand marks stay separate.
 */

const ICONS = {
  'save-as': '<path d="M10 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10.2a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V10"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/><path d="M7 21v-6a1 1 0 0 1 1-1h3"/><path d="M21.4 13.6a1.9 1.9 0 0 0-2.7-2.7L14 15.6v2.7h2.7z"/>',
  'minimize': '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  'file-down': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
  'ellipsis': '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  'file-x': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m14.5 12.5-5 5"/><path d="m9.5 12.5 5 5"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  'form-input': '<rect width="20" height="12" x="2" y="6" rx="2"/><path d="M12 12h.01"/><path d="M17 12h.01"/><path d="M7 12h.01"/>',
  'arrow-up-to-line': '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
  'arrow-down-to-line': '<path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/>',
  'align-center': '<line x1="6" x2="18" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="8" x2="16" y1="18" y2="18"/>',
  'align-justify': '<line x1="3" x2="21" y1="6" y2="6"/><line x1="3" x2="21" y1="12" y2="12"/><line x1="3" x2="21" y1="18" y2="18"/>',
  'align-left': '<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="14" y1="12" y2="12"/><line x1="4" x2="18" y1="18" y2="18"/>',
  'align-right': '<line x1="4" x2="20" y1="6" y2="6"/><line x1="10" x2="20" y1="12" y2="12"/><line x1="6" x2="20" y1="18" y2="18"/>',
  // Aligning objects: an edge or centre line and two boxes against it.
  'objects-align-left': '<path d="M4 3v18"/><rect x="7" y="5" width="12" height="5" rx="1.5"/><rect x="7" y="14" width="7" height="5" rx="1.5"/>',
  'objects-align-center': '<path d="M12 3v18"/><rect x="5" y="5" width="14" height="5" rx="1.5"/><rect x="8" y="14" width="8" height="5" rx="1.5"/>',
  'objects-align-right': '<path d="M20 3v18"/><rect x="5" y="5" width="12" height="5" rx="1.5"/><rect x="10" y="14" width="7" height="5" rx="1.5"/>',
  'objects-align-top': '<path d="M3 4h18"/><rect x="5" y="7" width="5" height="12" rx="1.5"/><rect x="14" y="7" width="5" height="7" rx="1.5"/>',
  'objects-align-middle': '<path d="M3 12h18"/><rect x="5" y="5" width="5" height="14" rx="1.5"/><rect x="14" y="8" width="5" height="8" rx="1.5"/>',
  'objects-align-bottom': '<path d="M3 20h18"/><rect x="5" y="5" width="5" height="12" rx="1.5"/><rect x="14" y="10" width="5" height="7" rx="1.5"/>',
  'objects-distribute-horizontal': '<path d="M3 3v18"/><path d="M21 3v18"/><rect x="9" y="7" width="6" height="10" rx="1.5"/>',
  'objects-distribute-vertical': '<path d="M3 3h18"/><path d="M3 21h18"/><rect x="7" y="9" width="10" height="6" rx="1.5"/>',
  'angle': '<path d="m21 16-8-8-8 8"/><path d="M17 16a4 4 0 0 0-8 0"/><path d="M3 20h18"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-left-right': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  'book-open': '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h5a3 3 0 0 1 3 3v15a3 3 0 0 0-3-3Z"/><path d="M21 18a1 1 0 0 0 1-1V5a2 2 0 0 0-2-2h-5a3 3 0 0 0-3 3v15a3 3 0 0 1 3-3Z"/>',
  'bookmark': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  'boxes': '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'calculator': '<rect width="16" height="20" x="4" y="2" rx="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="16" x2="16" y1="14" y2="18"/><path d="M16 10h.01"/><path d="M12 10h.01"/><path d="M8 10h.01"/><path d="M12 14h.01"/><path d="M8 14h.01"/><path d="M12 18h.01"/><path d="M8 18h.01"/>',
  'chart-line': '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
  'chart-no-axes-combined': '<path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0l-3.292-3.292a.5.5 0 0 0-.708 0L2 15"/><path d="M4 18v3"/><path d="M8 14v7"/>',
  'check': '<path d="m20 6-11 11-5-5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  'circle-help': '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 1 1 5.83 1c-.83 1.17-2.83 1.5-2.83 3"/><path d="M12 17h.01"/>',
  'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  'circle': '<circle cx="12" cy="12" r="9"/>',
  'clipboard': '<rect width="14" height="18" x="5" y="3" rx="2"/><path d="M9 3V1h6v2"/><path d="M9 7h6"/><path d="M9 11h6"/>',
  'combine': '<rect width="8" height="8" x="2" y="2" rx="2"/><path d="M14 2c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h6c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2Z"/><path d="M5 14v6c0 1.1.9 2 2 2h6"/><path d="M9 18h6"/>',
  'copy': '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  // Three pages stacked behind each other.
  'files': '<path d="M21 11v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h6z"/><path d="M18 8v3h3"/><path d="M7 19V7a2 2 0 0 1 2-2h8"/><path d="M4 16V4a2 2 0 0 1 2-2h8"/>',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
  'diamond': '<path d="M12 3 21 12 12 21 3 12Z"/>',
  'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  'eraser': '<path d="m7 21-4-4a2 2 0 0 1 0-3L14 3a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L10 21"/><path d="M22 21H7"/><path d="m5 12 5 5"/>',
  'eye': '<path d="M2.1 12a10 10 0 0 1 19.8 0 10 10 0 0 1-19.8 0"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M10.7 5.1A10 10 0 0 1 21.9 12a10.6 10.6 0 0 1-2.4 3.3"/><path d="M14.1 14.2a3 3 0 0 1-4.2-4.2"/><path d="M17.5 17.5A10.1 10.1 0 0 1 2.1 12a10.7 10.7 0 0 1 4.4-5.4"/><path d="m2 2 20 20"/>',
  'file': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  'filter': '<path d="M22 3H2l8 9.46V19l4 2v-8.54Z"/>',
  'flask-conical': '<path d="M10 2v7.31"/><path d="M14 9.3V2"/><path d="M8.5 2h7"/><path d="M14 9.3a6.5 6.5 0 1 1-4 0"/><path d="M5.52 16h12.96"/>',
  'folder-open': '<path d="m6 14 1.5-3h13l-2 8H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v3"/>',
  'fuel': '<line x1="3" x2="15" y1="22" y2="22"/><line x1="4" x2="14" y1="9" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9l-3-3"/>',
  'gauge': '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  // Dashed vertical and horizontal drawing guide.
  'guides': '<path d="M9 2v20" stroke-dasharray="3 3"/><path d="M2 15h20" stroke-dasharray="3 3"/><rect x="5" y="5" width="14" height="14" rx="1" opacity="0.45"/>',
  'magnet': '<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>',
  'underline': '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  'strikethrough': '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  'printer': '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  'highlighter': '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1 0-2.8L12 2Z"/>',
  'hand': '<path d="M18 11V6a2 2 0 0 0-4 0v3"/><path d="M14 10V4a2 2 0 0 0-4 0v5"/><path d="M10 10V5a2 2 0 0 0-4 0v9"/><path d="M6 14V9a2 2 0 0 0-4 0v5c0 4.4 3.6 8 8 8h2a8 8 0 0 0 8-8v-3a2 2 0 1 0-4 0v1"/>',
  'history': '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/><path d="M12 7v5l4 2"/>',
  'image': '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  'indent-decrease': '<path d="M21 6H9"/><path d="M21 12H9"/><path d="M21 18H9"/><path d="m3 8 4 4-4 4"/>',
  'indent-increase': '<path d="M21 6H9"/><path d="M21 12H9"/><path d="M21 18H9"/><path d="m7 8-4 4 4 4"/>',
  'key-round': '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21h2.172a2 2 0 0 0 1.414-.586l8.704-8.704"/><circle cx="16" cy="8" r="6"/>',
  'library': '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  'layers': '<path d="m12 3 10 5-10 5L2 8Z"/><path d="m2 12 10 5 10-5"/><path d="m2 16 10 5 10-5"/>',
  'link': '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'list': '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  'list-checks': '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  'list-ordered': '<path d="M10 6h11"/><path d="M10 12h11"/><path d="M10 18h11"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  'lock': '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  'maximize': '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  'menu': '<path d="M4 12h16"/><path d="M4 6h16"/><path d="M4 18h16"/>',
  'minus': '<path d="M5 12h14"/>',
  'monitor': '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  'moon': '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9"/>',
  'mouse-pointer-2': '<path d="m4 4 7.1 17 2.7-7.2L21 11Z"/><path d="m13.8 13.8 5.2 5.2"/>',
  'palette': '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 22a10 10 0 1 1 10-10c0 3-2 5-5 5h-1.4a1.6 1.6 0 0 0-1.4 2.4l.3.5A1.4 1.4 0 0 1 13.3 22Z"/>',
  'panel-right': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  'pen-tool': '<path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/>',
  'pencil': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'gamepad-2': '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/>',
  'pause': '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  'pipette': '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3-3a2.1 2.1 0 0 1 3 3l-3 3"/><path d="m9 12 6 6"/><path d="m14 7 3 3"/>',
  'play': '<polygon points="6 3 20 12 6 21 6 3"/>',
  'plug-zap': '<path d="m13 2-2 2.5h3L12 7"/><path d="M12 22v-3"/><path d="M10 13v-2.5"/><path d="M14 13v-2.5"/><path d="M16 13v2a4 4 0 0 1-8 0v-2Z"/>',
  'plus': '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'quote': '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2H4c-1.25 0-2 .75-2 2v4c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2a1 1 0 0 0-1 1.1V20c0 1 .6 1 1 1Z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2h-4c-1.25 0-2 .75-2 2v4c0 1.25.75 2 2 2h.75c0 3.5-.75 4-1.75 4a1 1 0 0 0-1 1v4c0 1 .6 1 1 1Z"/>',
  'radio': '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2a6 6 0 0 1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>',
  'redo-2': '<path d="m15 14 5-5-5-5"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/>',
  'refresh-cw': '<path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"/><path d="M16 16h5v5"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  'rotate-cw': '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  'ruler': '<path d="m16 2 6 6L8 22l-6-6Z"/><path d="m14 4 6 6"/><path d="m12 8 2 2"/><path d="m8 12 2 2"/><path d="m4 16 2 2"/>',
  'save': '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',
  'scale': '<path d="m16 16 3-8 3 8a5 5 0 0 1-6 0"/><path d="m2 16 3-8 3 8a5 5 0 0 1-6 0"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h18"/>',
  'scissors': '<circle cx="6" cy="7" r="3"/><path d="m8.7 8.7 3.6 3.6"/><path d="m8.7 15.3 3.6-3.6"/><circle cx="6" cy="17" r="3"/><path d="M12.3 12.3 19 19"/><path d="m12.3 11.7 6.7-6.7"/>',
  'search': '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  'settings': '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
  'shapes': '<rect width="8" height="8" x="3" y="3" rx="1"/><circle cx="17" cy="7" r="4"/><path d="m14 14 4 7H10Z"/>',
  'shield': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/>',
  'shuffle': '<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.5c4 0 6.5-12 10.5-12h8"/><path d="M2 6h1.5c1.6 0 2.9 1.9 4.1 4"/><path d="M14.5 18H22"/>',
  'smile': '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" x2="9.01" y1="9" y2="9"/><line x1="15" x2="15.01" y1="9" y2="9"/>',
  'sparkles': '<path d="m12 3-1.9 5.1L5 10l5.1 1.9L12 17l1.9-5.1L19 10l-5.1-1.9Z"/><path d="m5 3-.5 1.5L3 5l1.5.5L5 7l.5-1.5L7 5l-1.5-.5Z"/><path d="m19 17-.5 1.5L17 19l1.5.5L19 21l.5-1.5L21 19l-1.5-.5Z"/>',
  'split': '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-7"/><path d="M12 15 5.5 8.5"/><path d="m12 15 6.5-6.5"/>',
  'square': '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  'square-dashed': '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>',
  'stamp': '<path d="M5 22h14"/><path d="M5 16h14"/><path d="M7 16v-2a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v2"/><path d="M9 10V4a3 3 0 0 1 6 0v6"/>',
  'sticky-note': '<path d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"/><path d="M16 3v5h5"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'table': '<path d="M12 3v18"/><path d="M3 12h18"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  'thermometer': '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  'timer': '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  'trending-up': '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  'triangle-alert': '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'type': '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
  'undo-2': '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  'unlock': '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  'wrap-text': '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
  'wrench': '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94Z"/>',
  'x': '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'zap': '<path d="M4 14a1 1 0 0 1-.78-1.63l9-11a.5.5 0 0 1 .87.44l-1.69 6.7A1 1 0 0 0 12.37 10H20a1 1 0 0 1 .78 1.63l-9 11a.5.5 0 0 1-.87-.44l1.69-6.7A1 1 0 0 0 11.63 14Z"/>',
};

function attrs(options = {}) {
  return Object.entries(options)
    .filter(([name]) => name !== 'className')
    .filter(([, value]) => value !== false && value != null)
    .map(([name, value]) => `${name === 'className' ? 'class' : name}="${String(value).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

export function icon(name, options = {}) {
  const extra = attrs(options);
  return `<svg ${extra ? `${extra} ` : ''}class="${options.className || 'oo-icon'}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || '<circle cx="12" cy="12" r="9"/>'}</svg>`;
}

export function iconNode(name, options = {}) {
  const template = document.createElement('template');
  template.innerHTML = icon(name, options).trim();
  return template.content.firstElementChild;
}
