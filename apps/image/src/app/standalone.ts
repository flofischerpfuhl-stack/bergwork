/**
 * Standalone page: berg:work Image in its window — the berg:work title bar on top, the editor below, one product
 * tooltip for both. The shell loads with the editor; mounting it never blocks on the editor's own start-up.
 */
export async function startStandalone(root: HTMLElement): Promise<void> {
  const { renderShell } = await import('./shell');
  renderShell(root);
}
