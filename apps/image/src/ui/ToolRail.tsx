import styles from './editor.module.css';
import type { EditorController } from './controller';
import { useSessionSelector, useUi, useWorkspaceSelector } from './hooks';
import { Icon, type IconName } from './icons';
import { TOOL_LABELS, TOOLS, type Tool } from '../core/session';
import { markUiRender } from './performance';

function toolIcon(controller: EditorController, tool: Tool): IconName {
  const extra = controller.toolIcon?.(tool);
  if (extra) return extra;
  return tool as IconName;
}

export function ToolRail({ controller }: { controller: EditorController }) {
  markUiRender('ToolRail');
  useUi(controller, () => controller.toolIcon);
  useWorkspaceSelector(controller, (workspace) => workspace.selectedId);
  const session = controller.session;
  useSessionSelector(session, (current) => {
    const foreground = current.paletteColor(false), background = current.paletteColor(true);
    const activeIcon = controller.toolIcon?.(current.tool) ?? '';
    return `${controller.availableTools.size}|${current.tool}|${activeIcon}|${current.canEditPalette ? 1 : 0}|${foreground.red},${foreground.green},${foreground.blue}|${background.red},${background.green},${background.blue}`;
  });
  const t = controller.t;
  const color = (c: { red: number; green: number; blue: number }) => `rgb(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)})`;
  const fg = session.paletteColor(false), bg = session.paletteColor(true);
  return (
    <div className={styles.rail} role="toolbar" aria-label={t('Tools')} aria-orientation="vertical">
      {TOOLS.map((tool) => {
        const available = controller.availableTools.has(tool);
        const label = controller.t(TOOL_LABELS[tool]);
        return (
          <button key={tool} type="button" className={`${styles.tool} ${session.tool === tool ? styles.toolOn : ''}`}
            aria-pressed={session.tool === tool} aria-label={label} title={label}
            disabled={!available} data-testid={`tool-${tool}`} onClick={() => void controller.activateTool(tool)}>
            <Icon name={toolIcon(controller, tool)} size={18} />
          </button>
        );
      })}
      <div className={styles.palette}>
        <button type="button" className={`${styles.swatch} ${styles.swatchBack}`} style={{ background: color(bg) }}
          aria-label={t('Background color')} title={t('Background color')} disabled={!session.canEditPalette}
          onClick={() => controller.openColorPicker?.(true)} />
        <button type="button" className={`${styles.swatch} ${styles.swatchFront}`} style={{ background: color(fg) }}
          aria-label={t('Foreground color')} title={t('Foreground color')} disabled={!session.canEditPalette}
          onClick={() => controller.openColorPicker?.(false)} />
        <button type="button" className={styles.paletteMini} style={{ left: 27, top: -3 }} aria-label={t('Swap colors')} title={`${t('Swap colors')} (X)`}
          onClick={() => session.swapPaletteColors()}><Icon name="swap" size={10} /></button>
        <button type="button" className={styles.paletteMini} style={{ left: -1, top: 27 }} aria-label={t('Default colors')} title={`${t('Default colors')} (D)`}
          onClick={() => session.resetPaletteColors()}><Icon name="reset" size={9} /></button>
      </div>
    </div>
  );
}
