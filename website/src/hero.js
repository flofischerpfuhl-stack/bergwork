// One of four mine pictures per visit. The build fills in their URLs; the chosen one is preloaded at the size the
// stylesheet will ask for, so the first paint does not wait on a picture that is never shown.
const heroes = __HEROES__;
const names = Object.keys(heroes);
const name = names[Math.floor(Math.random() * names.length)];
document.documentElement.dataset.hero = name;
for (const [media, href] of [['(min-width: 701px)', heroes[name].wide], ['(max-width: 700px)', heroes[name].narrow]]) {
  const link = document.createElement('link');
  Object.assign(link, { rel: 'preload', as: 'image', href, media, type: 'image/webp' });
  link.setAttribute('fetchpriority', 'high');
  document.head.append(link);
}
