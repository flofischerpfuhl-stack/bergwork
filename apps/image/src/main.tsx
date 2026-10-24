// The standalone page mounts one editor; importing src/index.ts alone never mounts anything.
const root = document.getElementById('root');
const params = new URLSearchParams(location.search);
if (root && !params.has('common-acceptance') && !params.has('harness')) {
  void import('./app/standalone').then(({ startStandalone }) => startStandalone(root));
}
export {};
