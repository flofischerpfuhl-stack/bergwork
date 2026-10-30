/**
 * The sample document of the web app: offered in the editor's empty state next to the file picker and opened
 * right away for `?sample` (bergwork.app links to /app/pdf/?sample). It is the four-page fixture of the web smoke
 * test (scripts/fixtures/smoke.pdf), emitted by Vite into the built assets.
 */
import sampleUrl from '../../scripts/fixtures/smoke.pdf?url';

export const SAMPLE_LABEL = 'Try a sample PDF';
const SAMPLE_NAME = 'Site survey report.pdf';

/** Hands the sample to the editor like a file opened from the system (an open copy is switched to, not duplicated). */
export async function openSample(): Promise<void> {
  try {
    const response = await fetch(sampleUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = new File([await response.blob()], SAMPLE_NAME, { type: 'application/pdf' });
    document.dispatchEvent(new CustomEvent('oo-open-file-pdf', { detail: { file } }));
  } catch (error) {
    console.error('[bergwork] the sample PDF could not be loaded', error);
  }
}

/** True when the address asks for the sample; drops `?sample`, so a reload does not open it again. */
export function takeSampleRequest(): boolean {
  const url = new URL(location.href);
  if (!url.searchParams.has('sample')) return false;
  url.searchParams.delete('sample');
  history.replaceState(history.state, '', url);
  return true;
}
