import config from '../../site.config.mjs';
import { escapeHtml } from '../lib/html.mjs';

export function render() {
  return {
    current: 'legal',
    path: '/legal/',
    title: 'Legal notice (Impressum)',
    description: 'Legal notice and provider details for the berg:work website.',
    body: `<header class="page-band"><div><p class="kicker">Information</p><h1>Legal notice.</h1><p>Impressum. Information pursuant to Section 5 DDG (German Digital Services Act).</p></div></header>
    <article class="prose-card">
      <h2>Provider</h2>
      <address>Florian Fischer<br />Steig 4<br />88167 Grünenbach<br />Germany</address>
      <h2>Contact</h2>
      <p>Email: <a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a></p>
      <h2>Responsible for content</h2>
      <p>Florian Fischer, address as above.</p>
    </article>`,
  };
}
