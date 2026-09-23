import { useEffect, useRef, useState } from 'react';
import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSession, useWorkspace } from './hooks';
import { CanvasView } from './canvas/CanvasView';
import { NewCanvasSheet } from './Dialogs';

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
        const archives = files.filter((f) => /\.zip$/i.test(f.name));
        const images = files.filter((f) => !/\.zip$/i.test(f.name));
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
    </div>
  );
}
