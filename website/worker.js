// The bergwork Worker serves the static site from ./dist. It runs before the assets only for page addresses
// (`run_worker_first` in wrangler.jsonc), where it sends plain-HTTP visits to HTTPS; the wrangler login cannot switch
// on the zone's "Always Use HTTPS". Everything else goes straight to the assets.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      url.protocol = 'https:';
      return Response.redirect(url.href, 301);
    }
    return env.ASSETS.fetch(request);
  },
};
