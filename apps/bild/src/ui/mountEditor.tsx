/**
 * mountEditor (contracts.ts): mounts one independent editor into `root` and returns its handle.
 * Importing this module mounts nothing; destroy() unmounts React, releases the GPU context and
 * leaves `root` empty.
 */

import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { EditorHandle, MountEditor } from '../../contracts';
import { EditorController } from './controller';
import { EditorRoot } from './EditorRoot';
import { installFeatures } from '../app/features';

export const mountEditor: MountEditor = async (root, options) => {
  const controller = new EditorController(options.host, options.locale ?? 'en', options.theme ?? 'dark');
  installFeatures(controller);
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden';
  root.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<EditorRoot controller={controller} />));
  let destroyed = false;
  const handle: EditorHandle = controller.handle(() => {
    if (destroyed) return;
    destroyed = true;
    reactRoot.unmount();
    controller.destroy();
    container.remove();
  });
  return handle;
};
