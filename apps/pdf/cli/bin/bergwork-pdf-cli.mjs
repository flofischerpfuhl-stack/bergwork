#!/usr/bin/env node
// berg:work PDF agent CLI: the editor's engine without its UI. See apps/pdf/cli/README.md.
import { main } from '../lib/cli.mjs';

// `npm run cli -w @bergwork/pdf -- …` runs in apps/pdf; relative paths mean the caller's directory.
// Output piped into `head` and the like: drop the rest quietly and still clean up.
process.stdout.on('error', (error) => { if (error.code !== 'EPIPE') throw error; });
if (process.env.npm_lifecycle_event === 'cli' && process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

const code = await main(process.argv.slice(2));
if (code != null) process.exitCode = code;
