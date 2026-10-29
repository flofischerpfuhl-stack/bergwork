// The MCP server over stdio: tools/list, a read call and a writing call, checked with pdfinfo/pdftotext.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bin, pdfinfo, pdftotext, setupMissing, smoke, tempDir, tools } from './helpers.mjs';

test('mcp: tools/list and calls', { skip: setupMissing || (!tools.pdfinfo ? 'poppler is needed' : false) }, async (t) => {
  const dir = tempDir(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], stderr: 'pipe' });
  const client = new Client({ name: 'bergwork-pdf-cli-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());

  const { tools: list } = await client.listTools();
  const names = list.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['pdf_fill_form', 'pdf_form_fields', 'pdf_info', 'pdf_merge', 'pdf_metadata', 'pdf_ocr', 'pdf_optimize',
    'pdf_pages', 'pdf_protect', 'pdf_redact', 'pdf_render', 'pdf_replace_text', 'pdf_text', 'pdf_unlock']);
  const redactTool = list.find((tool) => tool.name === 'pdf_redact');
  assert.deepEqual(redactTool.inputSchema.required.sort(), ['file', 'output']);
  assert.equal(redactTool.inputSchema.properties.term.type, 'array');

  const info = await client.callTool({ name: 'pdf_info', arguments: { file: smoke } });
  assert.notEqual(info.isError, true, info.content[0].text);
  const payload = JSON.parse(info.content[0].text);
  assert.equal(payload.result.pageCount, pdfinfo(smoke).pages);

  const output = path.join(dir, 'redacted.pdf');
  const redact = await client.callTool({ name: 'pdf_redact', arguments: { file: smoke, term: ['Hillside Road'], output } });
  assert.notEqual(redact.isError, true, redact.content[0].text);
  assert.equal(JSON.parse(redact.content[0].text).result.output.path, output);
  assert.doesNotMatch(pdftotext(output), /Hillside Road/);

  // Only local paths.
  const remote = await client.callTool({ name: 'pdf_text', arguments: { file: 'https://example.com/a.pdf' } });
  assert.equal(remote.isError, true);
  assert.equal(JSON.parse(remote.content[0].text).error.code, 'bad-argument');
});
