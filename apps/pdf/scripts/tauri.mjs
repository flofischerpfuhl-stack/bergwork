// Cross-platform entry for `npm run tauri:dev` / `tauri:build`. Linux needs the rootless WebKitGTK environment from
// scripts/tauri-*.sh; Windows and macOS run the Tauri CLI directly, so neither WSL's bash.exe nor CRLF checkouts matter.
// The CLI is hoisted to the repository's node_modules by npm workspaces, so it is resolved rather than hard-coded.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (command !== 'dev' && command !== 'build') {
  console.error('usage: node scripts/tauri.mjs dev|build [tauri options]');
  process.exit(2);
}
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const options = { cwd: appDir, stdio: 'inherit', env: { ...process.env, TAURI_CLI_JS: cli } };
const result = process.platform === 'linux'
  ? spawnSync('bash', [`scripts/tauri-${command}.sh`, ...args], options)
  : spawnSync(process.execPath, [cli, command, ...args], options);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
