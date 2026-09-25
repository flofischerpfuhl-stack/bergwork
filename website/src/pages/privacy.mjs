import config from '../../site.config.mjs';
import { escapeHtml } from '../lib/html.mjs';

export function render() {
  return {
    current: 'privacy',
    path: '/privacy/',
    title: 'Privacy',
    description: 'Privacy information for berg:work: no cookies or analytics, self-hosted assets, server logs and local service-worker storage.',
    body: `<header class="page-band"><div><p class="kicker">Information</p><h1>Privacy</h1><p>This website sets no cookies, runs no analytics and loads no fonts or scripts from third parties.</p></div></header>
    <article class="prose-card">
      <h2>Controller</h2>
      <p>The controller under Article 4(7) GDPR is the person named in the <a href="/legal/">legal notice</a>:</p>
      <address>Florian Fischer<br />Steig 4<br />88167 Grünenbach<br />Germany<br />Email: <a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a></address>

      <h2>Hosting</h2>
      <p>The website is delivered through Cloudflare Pages (Cloudflare, Inc., USA). Cloudflare participates in the EU–US Data Privacy Framework; Standard Contractual Clauses also apply.</p>

      <h2>Server logs</h2>
      <p>To deliver the pages, the host processes server logs that can contain the IP address, requested URL, user agent and TLS metadata. The purpose is delivery and technical operation, not advertising or audience measurement. The legal basis is Article 6(1)(f) GDPR: the legitimate interest in a secure, functioning website.</p>

      <h2>No cookies, analytics or third-party assets</h2>
      <p>This website sets no cookies and uses no analytics or tracking pixels. Fonts, scripts, images and videos are served from this site. It does not use localStorage or sessionStorage.</p>

      <h2>Offline storage</h2>
      <p>A service worker stores copies of this site's pages and static files in your browser's Cache Storage so the site can open offline. This cache contains site files, not personal data. You can remove it through your browser's site-data controls.</p>

      <h2>Email</h2>
      <p>If you use a notification or contact link, your email program opens a message to ${escapeHtml(config.contactEmail)}. Nothing is sent until you send that message.</p>

      <h2>Your rights</h2>
      <p>Where personal data is processed, you have the rights under Articles 15–21 and 77 GDPR: access, rectification, erasure, restriction, data portability, objection and the right to lodge a complaint with a supervisory authority.</p>
    </article>`,
  };
}
