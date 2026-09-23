/**
 * Browser HostAdapter: file pickers through <input type=file>, downloads through an object URL.
 * Desktop shells (Tauri/Electron) supply their own adapter with native dialogs.
 */

import type { HostAdapter } from '../../contracts';

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

export function createBrowserHost(): HostAdapter {
  return {
    async chooseImages() { return pick('image/jpeg,image/png,image/heic,image/heif,image/tiff,.heic,.heif,.tif,.tiff', true); },
    async chooseProject() { return (await pick('.zip,application/zip', false))[0] ?? null; },
    async saveFile(blob, suggestedName) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggestedName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    reportError(error) { console.warn(`[compositor] ${error.code}: ${error.message}`); },
  };
}
