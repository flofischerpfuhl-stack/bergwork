/** Standalone page: the ordinary Vite index mounts one editor with the browser host. */
export async function startStandalone(root: HTMLElement): Promise<void> {
  const { mountEditor } = await import('../index');
  const { createBrowserHost } = await import('../platform/browserHost');
  await mountEditor(root, { host: createBrowserHost(), locale: navigator.language.startsWith('de') ? 'de' : 'en', theme: 'dark' });
}
