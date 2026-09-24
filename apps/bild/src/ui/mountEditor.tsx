/**
 * mountEditor (contracts.ts): mounts one independent editor into `root` and returns its handle.
 * Importing this module mounts nothing; destroy() unmounts React, releases the GPU context and
 * leaves `root` empty.
 */

import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { EditorHandleV2, MountEditorV2 } from '../../contracts-v2';
import { EditorController } from './controller';
import { EditorRoot } from './EditorRoot';
import { installFeatures } from '../app/features';
import { profileFor } from '../app/profiles';
import type { CapabilityHost } from '../platform/hosts';

export const mountEditor: MountEditorV2 = async (root, options) => {
  // Keep lazy-codec and CanvasKit requests observable in development even after
  // the expanded feature graph exceeds Chromium's default 250-resource buffer.
  if (import.meta.env.DEV) performance.setResourceTimingBufferSize(1_000);
  const profile = profileFor(options.profile ?? (options.host as CapabilityHost).defaultProfile ?? 'lite');
  const controller = new EditorController(options.host, options.locale ?? 'en', options.theme ?? 'dark', profile);
  installFeatures(controller, profile);
  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden';
  container.dataset.editorProfile = profile.id;
  root.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<EditorRoot controller={controller} />));
  const stopOpenEvents = controller.capabilities.files?.onOpenFiles((files) => { void controller.openHostFiles(files); });
  // Measurement and test hook; harmless in production (a property on the host window only in dev).
  if (import.meta.env.DEV) (window as unknown as { __editorForTests?: EditorController }).__editorForTests = controller;
  let destroyed = false;
  const handle: EditorHandleV2 = controller.handle(() => {
    if (destroyed) return;
    destroyed = true;
    stopOpenEvents?.();
    reactRoot.unmount();
    controller.destroy();
    container.remove();
  });
  void controller.startRecovery();
  return handle;
};
