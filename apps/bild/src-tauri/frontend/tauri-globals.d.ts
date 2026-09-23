interface TauriDialogFilter {
  name: string;
  extensions: string[];
}

interface TauriGlobals {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  dialog: {
    open(options: { multiple: boolean; directory: boolean; filters: TauriDialogFilter[] }): Promise<string | string[] | null>;
    save(options: { defaultPath?: string; filters: TauriDialogFilter[] }): Promise<string | null>;
  };
  fs: {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
  };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

interface Window {
  __TAURI__: TauriGlobals;
}
