export function render() {
  return {
    current: 'offline',
    path: '/offline/',
    title: 'Offline',
    description: 'The requested berg:work page is not available offline.',
    body: `<section class="message-page"><p class="kicker">Connection status</p><h1>Offline.</h1><p>This page is not stored on your device. Reconnect and try again, or return to the stored home page.</p><a class="button button--red" href="/">Go to the home page</a></section>`,
  };
}
