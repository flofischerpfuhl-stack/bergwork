import config from '../../site.config.mjs';
import { escapeHtml } from '../lib/html.mjs';

export function render() {
  return {
    current: 'privacy',
    path: '/privacy/',
    title: 'Privacy',
    description: 'Privacy information for berg:work: no cookies, no analytics, files edited on your device, server logs, local storage of the web apps and the optional model download.',
    body: `<header class="page-band"><div><p class="kicker">Information</p><h1>Privacy.</h1><p>No cookies, no analytics, no third-party scripts. The editors work on your computer; your files are not uploaded.</p></div></header>
    <article class="prose-card">
      <h2>Controller</h2>
      <p>The controller under Article 4(7) GDPR is the person named in the <a href="/legal/">legal notice</a>:</p>
      <address>Florian Fischer<br />Steig 4<br />88167 Grünenbach<br />Germany<br />Email: <a href="mailto:${escapeHtml(config.contactEmail)}">${escapeHtml(config.contactEmail)}</a></address>

      <h2>Hosting</h2>
      <p>The website and the web apps are delivered by Cloudflare Workers (Cloudflare, Inc., USA). Cloudflare participates in the EU–US Data Privacy Framework; Standard Contractual Clauses also apply.</p>

      <h2>Server logs</h2>
      <p>To deliver the pages, the host processes server logs that can contain the IP address, requested URL, user agent and TLS metadata. The purpose is delivery and technical operation, not advertising or audience measurement. The legal basis is Article 6(1)(f) GDPR: the legitimate interest in a secure, functioning website.</p>

      <h2>No cookies, analytics or third-party assets</h2>
      <p>Neither the website nor the web apps set cookies or use analytics or tracking pixels. Fonts, scripts, images and videos are served from bergwork.app. The website pages themselves do not use localStorage or sessionStorage.</p>

      <h2>The web apps</h2>
      <p>berg:work PDF (<a href="/app/pdf/">/app/pdf/</a>) and berg:work Image (<a href="/app/image/">/app/image/</a>) open, edit and save your files inside your browser. The files are not sent to bergwork.app or anywhere else; the apps' content security policy only allows requests to bergwork.app, which serves the app files and accepts no uploads.</p>
      <p>To work, the apps keep some data in your browser on your device: settings such as the appearance, signatures you choose to save (berg:work PDF, localStorage), the working state of open documents (berg:work PDF, IndexedDB) and downloaded models. This data never leaves your device. You can delete it at any time through your browser's site-data controls for bergwork.app.</p>

      <h2>Optional model downloads</h2>
      <p>berg:work Image removes backgrounds with a small model that ships with the app. Some optional features need a larger model: the more accurate background removal, object selection, AI fill and upscaling. The app downloads such a model from Hugging Face (Hugging Face, Inc., USA; huggingface.co) only after you start one of these features. Hugging Face then receives the technical data of that request – your IP address, the requested file and your browser's user agent – but not your images: the model runs on your device and is cached there afterwards. The legal basis is Article 6(1)(b) and (f) GDPR: you asked for the download, and the app cannot provide the feature otherwise.</p>

      <h2>Offline storage</h2>
      <p>A service worker stores copies of this site's pages and static files in your browser's Cache Storage so the site can open offline. This cache contains site files, not personal data. You can remove it through your browser's site-data controls.</p>

      <h2>Email</h2>
      <p>If you use a notification or contact link, your email program opens a message to ${escapeHtml(config.contactEmail)}. Nothing is sent until you send that message.</p>

      <h2>Your rights</h2>
      <p>Where personal data is processed, you have the rights under Articles 15–21 and 77 GDPR: access, rectification, erasure, restriction, data portability, objection and the right to lodge a complaint with a supervisory authority.</p>
    </article>`,
  };
}
