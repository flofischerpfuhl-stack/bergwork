// Command-line front end: argument parsing from the command definitions, human or JSON output, exit codes.
import { readFileSync } from 'node:fs';
import { COMMANDS, commandByName, joinPages } from './commands.mjs';
import { EngineHost } from './engine-host.mjs';
import { CliError, EXIT, errorPayload, exitCodeFor } from './errors.mjs';

const kebab = (name) => name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

function readStdin() {
  return readFileSync(0, 'utf8');
}

function parseObject(raw, name) {
  let text = raw;
  if (raw === '-') text = readStdin();
  else if (raw.startsWith('@')) {
    try { text = readFileSync(raw.slice(1), 'utf8'); } catch (error) { throw new CliError('bad-argument', `--${kebab(name)}: cannot read ${raw.slice(1)}: ${error.message}`); }
  }
  let value;
  try { value = JSON.parse(text); } catch (error) { throw new CliError('bad-argument', `--${kebab(name)} is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('bad-argument', `--${kebab(name)} must be a JSON object`);
  return value;
}

/** Parses `argv` (after the command name) against a command's parameters. */
export function parseCommandArgs(def, argv) {
  const args = { json: false, timeout: null };
  const byFlag = new Map();
  for (const param of def.params) {
    if (param.positional) continue;
    byFlag.set(`--${kebab(param.name)}`, param);
    if (param.short) byFlag.set(`-${param.short}`, param);
    if (param.type === 'secret') byFlag.set(`--${kebab(param.name)}-file`, { ...param, fromFile: true });
  }
  const positional = def.params.filter((param) => param.positional);
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    let token = argv[i];
    if (token === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (token === '--json') { args.json = true; continue; }
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    let inline = null;
    if (token.startsWith('--') && token.includes('=')) { inline = token.slice(token.indexOf('=') + 1); token = token.slice(0, token.indexOf('=')); }
    if (token === '--timeout') {
      const value = Number(inline ?? argv[(i += 1)]);
      if (!(value > 0)) throw new CliError('bad-argument', '--timeout needs a number of seconds');
      args.timeout = value; continue;
    }
    if (!token.startsWith('-') || token === '-') { rest.push(token); continue; }
    const param = byFlag.get(token);
    if (!param) throw new CliError('bad-argument', `Unknown option ${token} for ${def.name} (see ${def.name} --help)`);
    if (param.type === 'boolean') {
      if (inline != null) args[param.name] = !/^(0|false|no)$/i.test(inline);
      else args[param.name] = true;
      continue;
    }
    const value = inline ?? argv[(i += 1)];
    if (value == null) throw new CliError('bad-argument', `${token} needs a value`);
    if (param.fromFile) {
      try { args[param.name] = readFileSync(value, 'utf8').replace(/\r?\n$/, ''); } catch (error) { throw new CliError('bad-argument', `${token}: ${error.message}`); }
    } else if (param.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new CliError('bad-argument', `${token} needs a number, not "${value}"`);
      args[param.name] = number;
    } else if (param.type === 'strings') {
      (args[param.name] ||= []).push(value);
    } else if (param.type === 'keyvalues') {
      const at = value.indexOf('=');
      if (at <= 0) throw new CliError('bad-argument', `${token} needs field=value, not "${value}"`);
      (args[param.name] ||= {})[value.slice(0, at)] = value.slice(at + 1);
    } else if (param.type === 'object') {
      args[param.name] = parseObject(value, param.name);
    } else if (param.type === 'enum') {
      if (!param.values.includes(value)) throw new CliError('bad-argument', `${token} must be one of ${param.values.join(', ')}`);
      args[param.name] = value;
    } else args[param.name] = value;
  }
  for (const param of positional) {
    if (param.type === 'paths') { args[param.name] = rest.splice(0); continue; }
    const value = rest.shift();
    if (value == null) continue;
    if (param.type === 'enum' && !param.values.includes(value)) throw new CliError('bad-argument', `${param.name} must be one of ${param.values.join(', ')}, not "${value}"`);
    args[param.name] = value;
  }
  if (rest.length) throw new CliError('bad-argument', `Unexpected argument ${rest[0]}`);
  if (args.help) return args;
  for (const param of def.params) {
    const value = args[param.name];
    if (param.required && (value == null || (Array.isArray(value) && !value.length))) {
      throw new CliError('bad-argument', `${def.name}: ${param.positional ? `<${param.name}>` : `--${kebab(param.name)}`} is required`);
    }
  }
  return args;
}

export function commandHelp(def) {
  const usage = [def.name === 'pages' ? 'pages <action> <file>' : `${def.name} ${def.params.filter((p) => p.positional).map((p) => (p.type === 'paths' ? `<${p.name}...>` : `<${p.name}>`)).join(' ')}`];
  const lines = [`bergwork-pdf-cli ${usage[0]} [options]`, '', def.summary, ''];
  for (const param of def.params) {
    if (param.positional) { lines.push(`  <${param.name}>  ${param.description}${param.values ? ` (${param.values.join(', ')})` : ''}`); continue; }
    const flag = `${param.short ? `-${param.short}, ` : ''}--${kebab(param.name)}${param.type === 'boolean' ? '' : ` <${param.type === 'keyvalues' ? 'field=value' : param.type === 'secret' ? 'text' : param.type}>`}`;
    lines.push(`  ${flag.padEnd(34)} ${param.description}${param.values ? ` (${param.values.join(', ')})` : ''}${param.required ? ' [required]' : ''}`);
    if (param.type === 'secret') lines.push(`  ${`--${kebab(param.name)}-file <path>`.padEnd(34)} Read it from a file instead (keeps it out of the process list).`);
  }
  lines.push(`  ${'--json'.padEnd(34)} Print one JSON object: {"ok": true, "command", "result"} or {"ok": false, "error"}.`);
  lines.push(`  ${'--timeout <seconds>'.padEnd(34)} Give up after this long (default 300).`);
  return lines.join('\n');
}

export function mainHelp() {
  return [
    'bergwork-pdf-cli <command> [options]   berg:work PDF editor engine, headless',
    '',
    'Commands:',
    ...COMMANDS.map((def) => `  ${def.name.padEnd(13)} ${def.summary}`),
    `  ${'mcp'.padEnd(13)} Run as an MCP server over stdio with these operations as tools.`,
    '',
    'Run `bergwork-pdf-cli <command> --help` for its options. Every command takes --json and --timeout.',
    'Exit codes: 0 ok, 1 failed, 2 usage, 3 not applied (refused/unsupported/no match), 4 input (unreadable, password), 5 setup.',
  ].join('\n');
}

function human(def, result) {
  if (def.name === 'text' && !result.output) return joinPages(result.pages).trimEnd();
  if (def.name === 'ocr' && !result.output) return joinPages(result.pages).trimEnd();
  if (def.name === 'info') {
    const lines = [
      `${result.file}: ${result.pageCount} page${result.pageCount === 1 ? '' : 's'}, PDF ${result.pdfVersion || '?'}, ${result.bytes} bytes`,
      `encrypted: ${result.encrypted ? `yes${result.protectionRemovedOnOpen ? ` (opened: ${result.protectionRemovedOnOpen})` : ''}` : 'no'}, signed: ${result.signed ? 'yes' : 'no'}, editable: ${result.editable ? 'yes' : 'no'}`,
      `form: ${result.form.fields} fields (${result.form.fillable} fillable)${result.form.xfa ? ', XFA' : ''}, bookmarks: ${result.bookmarks}`,
      ...Object.entries(result.metadata || {}).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`),
      ...result.pages.map((page) => `page ${page.page}: ${page.width} x ${page.height} pt, rotation ${page.rotation}${page.textChars != null ? `, ${page.textChars} text chars` : ''}`),
    ];
    return lines.join('\n');
  }
  if (def.name === 'form-fields') {
    if (!result.fields.length) return 'No form fields.';
    return result.fields.map((field) => `${field.name}\t${field.type}${field.readOnly ? ' (read-only)' : ''}\t${JSON.stringify(field.value ?? null)}${field.options ? `\t[${field.options.join(', ')}]` : ''}`).join('\n');
  }
  if (def.name === 'metadata' && !result.output) {
    return Object.entries(result.metadata || {}).map(([key, value]) => `${key}: ${value ?? ''}`).concat(`xmp: ${result.xmpMetadata ? 'yes' : 'no'}`).join('\n');
  }
  const written = [...(result.output ? [result.output] : []), ...(result.outputs || [])].filter((item) => item.path);
  const lines = written.map((item) => `wrote ${item.path}${item.pages != null ? ` (${item.pages} page${item.pages === 1 ? '' : 's'})` : ''}`);
  if (def.name === 'redact') lines.unshift(`${result.matches} match${result.matches === 1 ? '' : 'es'} redacted on ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}${result.elsewhere?.metadata?.length ? `; also in metadata: ${result.elsewhere.metadata.join(', ')}${result.metadataScrubbed?.length ? ' (scrubbed)' : ''}` : ''}`);
  if (def.name === 'replace-text') lines.unshift(`${result.replaced.reduce((sum, item) => sum + item.count, 0)} occurrence(s) replaced in ${result.replaced.length} text run(s)${result.refused.length ? `, ${result.refused.length} refused` : ''}`);
  if (def.name === 'optimize') lines.unshift(`${result.inputBytes} -> ${result.outputBytes} bytes (${result.label}${result.textPreserved ? '' : ', text not preserved'})`);
  if (result.warning) lines.push(`warning: ${result.warning}`);
  return lines.join('\n');
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    const target = name === 'help' && rest[0] ? commandByName.get(rest[0]) : null;
    process.stdout.write(`${target ? commandHelp(target) : mainHelp()}\n`);
    return EXIT.ok;
  }
  if (name === 'mcp') {
    const { runMcpServer } = await import('./mcp.mjs');
    await runMcpServer();
    return null;
  }
  const commandName = name === 'pages' && rest[0] === 'merge' ? 'merge' : name;
  const def = commandByName.get(commandName);
  const json = argv.includes('--json');
  const emitError = (error) => {
    const payload = errorPayload(error);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, command: commandName, error: payload })}\n`);
    else process.stderr.write(`bergwork-pdf-cli: ${payload.message}${payload.code !== 'internal' ? ` [${payload.code}]` : ''}\n${payload.details && !json ? `${JSON.stringify(payload.details, null, 2)}\n` : ''}`);
    return exitCodeFor(payload.code);
  };
  if (!def) return emitError(new CliError('bad-argument', `Unknown command ${name} (run bergwork-pdf-cli --help)`));
  let args;
  try {
    args = parseCommandArgs(def, commandName === 'merge' && name === 'pages' ? rest.slice(1) : rest);
  } catch (error) { return emitError(error); }
  if (args.help) { process.stdout.write(`${commandHelp(def)}\n`); return EXIT.ok; }
  const engine = new EngineHost({ timeoutMs: (args.timeout ?? 300) * 1000 });
  // Interrupted: still close the browser and remove the temporary folder.
  const onSignal = () => { engine.close().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const result = await def.run(engine, args);
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, command: commandName, result })}\n`);
    else { const text = human(def, result); if (text) process.stdout.write(`${text}\n`); }
    return EXIT.ok;
  } catch (error) {
    return emitError(error);
  } finally {
    await engine.close();
  }
}
