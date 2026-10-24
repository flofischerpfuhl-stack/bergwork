/**
 * Fernwork — Shared Utility Functions
 */

/**
 * Escape a string for use in HTML text or a quoted attribute value.
 * Use it for every file name or other user-supplied string placed in an HTML template.
 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * Format bytes to human-readable size
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0);
  return `${size} ${units[i]}`;
}

/**
 * Download a blob as a file
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Download multiple files as a ZIP
 * Requires JSZip to be loaded
 */
export async function downloadZip(files, zipName = 'download.zip') {
  // files: Array of { name: string, blob: Blob }
  if (typeof JSZip === 'undefined') {
    // Vendored copy: ZIP downloads must work offline and without a CDN.
    await loadScript('/tools/vendor/jszip-3.10.1/jszip.min.js');
  }
  
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, file.blob);
  }
  
  const content = await zip.generateAsync({ type: 'blob' });
  downloadBlob(content, zipName);
}

/**
 * Copy text to clipboard with toast feedback
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    const { showToast } = await import('./toast.js');
    showToast('Copied to clipboard', 'success');
    return true;
  } catch {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    const { showToast } = await import('./toast.js');
    showToast('Copied to clipboard', 'success');
    return true;
  }
}

/**
 * Debounce a function
 */
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Load a script from URL
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
}

/**
 * Load a CSS file from URL
 */
export function loadCSS(href) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`link[href="${href}"]`)) {
      resolve();
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`Failed to load CSS: ${href}`));
    document.head.appendChild(link);
  });
}

/**
 * Get file extension from filename
 */
export function getExtension(filename) {
  return filename.split('.').pop()?.toLowerCase() || '';
}

/**
 * Get filename without extension
 */
export function getBaseName(filename) {
  const parts = filename.split('.');
  if (parts.length > 1) parts.pop();
  return parts.join('.');
}

/**
 * Generate a unique ID
 */
export function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Wait/sleep for ms milliseconds
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Read a file as ArrayBuffer
 */
export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read a file as Data URL
 */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Read a file as text
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

/**
 * Create an image element from a file or URL
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    if (src instanceof Blob) {
      img.src = URL.createObjectURL(src);
    } else {
      img.src = src;
    }
  });
}
