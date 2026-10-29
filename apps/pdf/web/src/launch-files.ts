/**
 * Files handed to the installed web app by the system: "Open with berg:work PDF" (the manifest's file_handlers,
 * delivered through window.launchQueue in Chromium browsers) and "Share → berg:work PDF" on Android (the manifest's
 * share_target: the site's service worker receives the POST, keeps the files in the `bergwork-share` cache and
 * redirects to /app/pdf/?shared). Both reach the editor like a file opened from the system.
 */
const SHARE_CACHE = 'bergwork-share';

function openInEditor(file: File): void {
  document.dispatchEvent(new CustomEvent('oo-open-file-pdf', { detail: { file } }));
}

type LaunchParams = { readonly files: readonly { getFile(): Promise<File> }[] };
type LaunchQueue = { setConsumer(consumer: (params: LaunchParams) => void): void };

/** Registers the launch consumer; call once the editor listens for files. */
export function installLaunchQueue(): void {
  const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
  if (!queue) return;
  queue.setConsumer((params) => {
    for (const handle of params.files || []) {
      void handle.getFile().then(openInEditor, (error) => console.error('[bergwork] a launched file could not be read', error));
    }
  });
}

/** Opens files a share left in the service worker's cache (?shared) and drops the parameter and the files. */
export async function openSharedFiles(): Promise<void> {
  const url = new URL(location.href);
  if (!url.searchParams.has('shared')) return;
  url.searchParams.delete('shared');
  history.replaceState(history.state, '', url);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHARE_CACHE);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (response) {
        const name = decodeURIComponent(response.headers.get('x-file-name') || 'shared.pdf');
        const type = response.headers.get('content-type') || 'application/pdf';
        openInEditor(new File([await response.blob()], name, { type }));
      }
      await cache.delete(request);
    }
  } catch (error) {
    console.error('[bergwork] shared files could not be opened', error);
  }
}
