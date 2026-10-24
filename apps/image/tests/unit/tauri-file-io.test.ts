import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTauriHost } from '../../src-tauri/frontend/host';

describe('Tauri file I/O', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps multi-image selection lazy and reads only the requested file in bounded binary chunks', async () => {
    const contents = new Map([
      ['/photos/one.png', Uint8Array.from({ length: 1_500_000 }, (_, index) => index & 255)],
      ['/photos/two.jpg', new Uint8Array([9, 8, 7, 6])],
    ]);
    const readFile = vi.fn(async () => { throw new Error('eager fs.readFile must not be used'); });
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      const path = String(args?.path ?? '');
      const bytes = contents.get(path);
      if (command === 'file_size') return bytes?.byteLength ?? 0;
      if (command === 'read_file_chunk') {
        const offset = Number(args?.offset), length = Number(args?.length);
        return bytes!.slice(offset, offset + length).buffer;
      }
      throw new Error(`Unexpected command ${command}`);
    });
    vi.stubGlobal('window', { __TAURI__: {
      core: { invoke },
      dialog: { open: async () => [...contents.keys()], save: async () => null },
      fs: { readFile, writeFile: vi.fn() }, event: { listen: async () => () => {} },
    } });

    const host = createTauriHost();
    const files = await host.chooseImages();
    expect(files.map((file) => [file.name, file.size])).toEqual([['one.png', 1_500_000], ['two.jpg', 4]]);
    expect(files.map((file) => file.type)).toEqual(['', '']);
    expect(readFile).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([command]) => command === 'read_file_chunk')).toHaveLength(0);

    const restored = new Uint8Array(await files[0]!.arrayBuffer());
    expect(restored).toEqual(contents.get('/photos/one.png'));
    expect(readFile).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([command]) => command === 'read_file_chunk')).toHaveLength(2);

    const codecs = (host as unknown as { capabilities: { codecs: { decodeRaw(bytes: Uint8Array, options: object): Promise<unknown> } } }).capabilities.codecs;
    expect(await codecs.decodeRaw(new Uint8Array(4_000_000), {})).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === 'decode_raw_binary')).toBe(false);
  });
});
