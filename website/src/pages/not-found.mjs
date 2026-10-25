export function render() {
  return {
    current: 'not-found',
    path: '/404.html',
    title: 'Page not found',
    description: 'The requested page was not found on the berg:work website.',
    body: `<section class="message-page"><p class="kicker">404</p><h1>Page not found.</h1><p>There is no page at this address. Maybe one of these?</p><p class="band-actions"><a class="button button--red" href="/">Home page</a> <a class="text-link" href="/app/pdf/">PDF editor <span aria-hidden="true">→</span></a> <a class="text-link" href="/app/image/">Image editor <span aria-hidden="true">→</span></a></p></section>`,
  };
}
