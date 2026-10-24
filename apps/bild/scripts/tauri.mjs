// Cross-platform entry for `npm run tauri:dev` / `tauri:build`. Linux needs the rootless WebKitGTK environment from
// scripts/tauri-*.sh; Windows and macOS run the Tauri CLI directly, so neither WSL's bash.exe nor CRLF checkouts matter.
import { spawnSync } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (command !== 'dev' && command !== 'build') {
  console.error('usage: node scripts/tauri.mjs dev|build [tauri options]');
  process.exit(2);
}
const result = process.platform === 'linux'
  ? spawnSync('bash', [`scripts/tauri-${command}.sh`, ...args], { stdio: 'inherit' })
  : spawnSync(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', command, ...args], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
