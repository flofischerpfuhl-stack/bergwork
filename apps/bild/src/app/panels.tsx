/** Shared pieces of the non-modal tool panels (FloatingPanel.swift). */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import styles from '../ui/editor.module.css';

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/** A movable, non-modal panel (FloatingPanel.swift): it never dims the editor and reopens where it was left. */
const panelPositions = new Map<string, { x: number; y: number }>();

export function FloatingPanel({ name, title, children, onClose, closeLabel, testId = 'adjustment-panel', secondary = false, className }: {
  name: string; title: string; children: ReactNode; onClose: () => void; closeLabel: string; testId?: string;
  /** Extra class for panels with their own size (Layer Style). */
  className?: string;
  /** Opened from another panel (the color picker): drawn above it and, the first time, beside it. */
  secondary?: boolean;
}) {
  const [position, setPosition] = useState(() => panelPositions.get(name) ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button')) return;
    const panel = ref.current, parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => {
      const next = {
        x: clamp(start.left + e.clientX - start.x, 0, Math.max(0, parent.clientWidth - panel.offsetWidth)),
        y: clamp(start.top + e.clientY - start.y, 0, Math.max(0, parent.clientHeight - 40)),
      };
      panelPositions.set(name, next);
      setPosition(next);
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };
  return (
    <div ref={ref} className={`${styles.floatingPanel} ${secondary ? styles.floatingPanelSecondary : ''} ${className ?? ''}`} role="dialog" aria-label={title} data-testid={testId}
      style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}
      onKeyDown={(event) => event.stopPropagation()}>
      <div className={styles.panelHeader} onPointerDown={drag}>
        <h2 className={styles.dialogTitle}>{title}</h2>
        <button type="button" className={styles.iconButton} aria-label={closeLabel} onClick={onClose}>×</button>
      </div>
      {children}
    </div>
  );
}

