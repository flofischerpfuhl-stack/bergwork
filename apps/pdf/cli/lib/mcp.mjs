// `bergwork-pdf-cli mcp`: an MCP server over stdio with the CLI's operations as tools. One headless engine page is
// started on the first call and kept for the server's lifetime. Tools read and write local paths only; nothing is
// uploaded anywhere (the engine's server listens on 127.0.0.1 and serves the page only to the local browser).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { COMMANDS } from './commands.mjs';
import { EngineHost } from './engine-host.mjs';
import { CliError, errorPayload } from './errors.mjs';

const VERSION = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
const READ_ONLY = new Set(['info', 'text', 'form-fields']);

export const toolName = (def) => def.tool || `pdf_${def.name.replace(/-/g, '_')}`;

function schemaFor(param) {
  let schema;
  switch (param.type) {
    case 'paths': schema = z.array(z.string()).min(1); break;
    case 'strings': schema = z.array(z.string()); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    case 'enum': schema = z.enum(param.values); break;
    case 'object': schema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])); break;
    case 'keyvalues': schema = z.record(z.string(), z.string()); break;
    default: schema = z.string();
  }
  const description = param.type === 'path' || param.type === 'paths' ? `${param.description} Local filesystem path; relative paths resolve against the server's working directory.` : param.description;
  schema = schema.describe(description);
  return param.required ? schema : schema.optional();
}

export function inputShape(def) {
  const shape = {};
  for (const param of def.params) shape[param.name] = schemaFor(param);
  if (def.name === 'render') shape.inline = z.boolean().optional().describe('Also return the PNGs as image content (at most 4 pages).');
  return shape;
}

// Only local files: no URLs, no file: or data: schemes.
function localPath(value, name) {
  if (typeof value !== 'string' || !value) throw new CliError('bad-argument', `${name} must be a local path`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) throw new CliError('bad-argument', `${name} must be a local path, not a URL (${value.slice(0, 40)})`);
  return path.resolve(value);
}

function normalize(def, args) {
  const out = { ...args };
  for (const param of def.params) {
    if (out[param.name] == null) continue;
    if (param.type === 'path') out[param.name] = localPath(out[param.name], param.name);
    if (param.type === 'paths') out[param.name] = out[param.name].map((item, index) => localPath(item, `${param.name}[${index}]`));
  }
  return out;
}

const text = (value) => ({ type: 'text', text: JSON.stringify(value, null, 2) });

export function createServer(engine) {
  const server = new McpServer({ name: 'bergwork-pdf', version: VERSION });
  for (const def of COMMANDS) {
    server.registerTool(toolName(def), {
      title: `berg:work PDF: ${def.name}`,
      description: `${def.summary} Uses the berg:work PDF editor engine headless; local paths only. Outputs are never overwritten unless force is true.`,
      inputSchema: inputShape(def),
      annotations: { readOnlyHint: READ_ONLY.has(def.name), destructiveHint: false, idempotentHint: READ_ONLY.has(def.name), openWorldHint: false },
    }, async (args) => {
      try {
        const result = await def.run(engine, normalize(def, args));
        const content = [text({ ok: true, result })];
        if (def.name === 'render' && args.inline) {
          for (const item of result.outputs.slice(0, 4)) content.push({ type: 'image', mimeType: 'image/png', data: (await fs.readFile(item.path)).toString('base64') });
        }
        return { content };
      } catch (error) {
        return { isError: true, content: [text({ ok: false, error: errorPayload(error) })] };
      }
    });
  }
  return server;
}

export async function runMcpServer() {
  const engine = new EngineHost({ timeoutMs: Number(process.env.BERGWORK_PDF_TIMEOUT_S || 300) * 1000 });
  const server = createServer(engine);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await engine.close().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await server.connect(transport);
}
