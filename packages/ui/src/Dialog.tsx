/** A modal dialog: title, Properties-style rows, buttons with the main action last at the right (§8c). */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly buttons: ReactNode;
  readonly onCancel: () => void;
  readonly onSubmit?: () => void;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const { onCancel } = props;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);
  return createPortal(
    <div className="bw-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <form ref={ref} className="bw-dialog" role="dialog" aria-modal aria-label={props.title}
        onSubmit={(event) => { event.preventDefault(); props.onSubmit?.(); }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
        <h2 className="bw-dialog-title">{props.title}</h2>
        <div className="bw-dialog-body">{props.children}</div>
        <div className="bw-dialog-buttons">{props.buttons}</div>
      </form>
    </div>,
    document.body,
  );
}
