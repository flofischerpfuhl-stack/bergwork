import { useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSession, useWorkspace } from './hooks';
import { CanvasView } from './canvas/CanvasView';
import { NewCanvasSheet } from './Dialogs';
import { Icon } from './icons';
import type { LayerLockBlocker } from '../core/locks';

/** Project archives: `.fwimg`, and `.zip` as written by earlier builds. */
const PROJECT_FILE = /\.(fwimg|zip)$/i;

/** Hosts the canvas view; shows the New Canvas welcome when the tab has no document; accepts file drops. */
export function CanvasPane({ controller }: { controller: EditorController }) {
  const host = useRef<HTMLDivElement>(null);
  useWorkspace(controller);
  const session = useSession(controller.session);
  const [dropping, setDropping] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const view = new CanvasView(controller);
    host.current!.append(view.element);
    controller.canvasView = view;
    for (const setup of controller.canvasSetups) setup(view);
    void view.start().then(() => {
      if (view.failure) setFailure(view.failure);
      controller.attachCanvas(view);
    });
    return () => {
      controller.attachCanvas(null);
      controller.canvasView = null;
      view.destroy();
    };
  }, [controller]);
  return (
    <div ref={host} className={`${styles.canvasPane} ${dropping ? styles.dropTarget : ''}`} data-testid="canvas-pane"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDropping(false);
        const files = [...event.dataTransfer.files];
        const archives = files.filter((f) => PROJECT_FILE.test(f.name));
        const images = files.filter((f) => !PROJECT_FILE.test(f.name));
        for (const archive of archives) void controller.openArchive(archive).catch((error) => controller.reportError('open-failed', error));
        if (images.length) {
          const rect = host.current!.getBoundingClientRect();
          const doc = controller.session.document;
          const point = doc ? controller.session.viewport.documentPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, doc) : null;
          void controller.importFiles(images, controller.workspace.current, point);
        }
      }}>
      {!session.document ? <NewCanvasSheet controller={controller} welcome /> : null}
      {failure ? <div className={styles.canvasMessage} role="alert">{failure}</div> : null}
      <LockNotice controller={controller} />
    </div>
  );
}

const LOCK_MESSAGES: Record<LayerLockBlocker['code'], string> = {
  'layer-lock-all': 'is locked.',
  'layer-lock-pixels': 'has locked pixels.',
  'layer-lock-position': 'has a locked position.',
};

/**
 * Says why an edit did nothing when a layer lock refused it (Photoshop: "Could not complete your request because the layer
 * is locked"). Not modal: it fades after a few seconds, so a refused brush stroke does not need a click to dismiss.
 */
function LockNotice({ controller }: { controller: EditorController }) {
  const session = useSession(controller.session);
  const t = controller.t;
  const blocker = session.lastEditBlocker;
  const [shown, setShown] = useState<LayerLockBlocker | null>(null);
  useEffect(() => {
    if (!blocker) return;
    setShown(blocker);
    const timer = setTimeout(() => setShown(null), 3500);
    return () => clearTimeout(timer);
  }, [blocker]);
  if (!shown) return null;
  const source = session.layer(shown.sourceLayerId);
  const layer = session.layer(shown.layerId);
  const name = source?.name ?? layer?.name ?? '';
  const inherited = shown.sourceLayerId !== shown.layerId && source?.kind === 'group';
  const quoted = controller.locale === 'de' ? `„${name}“` : `“${name}”`;
  return (
    <div className={styles.lockNotice} role="status" data-testid="lock-notice" data-code={shown.code}>
      <Icon name="lock" size={14} />
      <span>{inherited ? `${t('Folder')} ${quoted} ${t(LOCK_MESSAGES[shown.code])}` : `${quoted} ${t(LOCK_MESSAGES[shown.code])}`}</span>
    </div>
  );
}
