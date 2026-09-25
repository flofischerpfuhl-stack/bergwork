export function render() {
  return {
    current: 'not-found',
    path: '/404.html',
    title: 'Page not found',
    description: 'The requested page was not found on the berg:work website.',
    body: `<section class="message-page"><p class="kicker">404</p><h1>Page not found.</h1><p>The address does not match a page on this site.</p><a class="button button--red" href="/">Go to the home page</a></section>`,
  };
}
