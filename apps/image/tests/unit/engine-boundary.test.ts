import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname, extname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import { EditorSession } from '../../src/core/session';
import { Raster } from '../../src/core/raster';
import { flattenDocument } from '../../src/core/composite';
import { adjustRaster } from '../../src/core/adjust/raster';
import { decodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';

const ROOT = resolve(import.meta.dirname, '../..');
const ENGINE = ['src/core', 'src/render', 'src/io', 'src/workers', 'src/text'];
const PLATFORM_TYPE_EXCEPTIONS = new Set(['src/platform/imageDecoder.ts', 'src/platform/hosts/types.ts']);
const DOM_RUNTIME_EXCEPTIONS = new Set(['src/io/export.ts', 'src/io/heic.ts', 'src/io/imageImport.ts']);

function engineFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (['.ts', '.tsx'].includes(extname(path))) files.push(path);
    }
  };
  for (const directory of ENGINE) visit(resolve(ROOT, directory));
  return files;
}

interface AstNode { readonly type: string; readonly start: number; readonly end: number; readonly [key: string]: unknown }
const isAstNode = (value: unknown): value is AstNode => typeof value === 'object' && value !== null
  && typeof (value as { type?: unknown }).type === 'string';
function astChildren(node: AstNode): AstNode[] {
  const result: AstNode[] = [];
  for (const value of Object.values(node)) {
    if (isAstNode(value)) result.push(value);
    else if (Array.isArray(value)) for (const item of value) if (isAstNode(item)) result.push(item);
  }
  return result;
}
function nodeField(node: AstNode, field: string): AstNode | null { const value = node[field]; return isAstNode(value) ? value : null; }
function identifierName(node: AstNode | null): string | null {
  return node?.type === 'Identifier' && typeof node.name === 'string' ? node.name : null;
}

function globalDomUses(file: string): number[] {
  const text = readFileSync(file, 'utf8');
  const root = parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }) as unknown as AstNode;
  const parents = new Map<AstNode, AstNode>();
  const bindings = new Map<AstNode, Set<string>>();
  const scopes = new Set(['Program', 'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'BlockStatement', 'CatchClause']);
  const addPattern = (scope: AstNode, pattern: AstNode | null): void => {
    if (!pattern) return;
    const name = identifierName(pattern);
    if (name) { const names = bindings.get(scope) ?? new Set<string>(); names.add(name); bindings.set(scope, names); return; }
    if (pattern.type === 'Property') addPattern(scope, nodeField(pattern, 'value'));
    else if (pattern.type === 'RestElement') addPattern(scope, nodeField(pattern, 'argument'));
    else if (pattern.type === 'AssignmentPattern') addPattern(scope, nodeField(pattern, 'left'));
    else for (const child of astChildren(pattern)) addPattern(scope, child);
  };
  const collect = (node: AstNode, scope: AstNode): void => {
    const declaration = node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration';
    if (declaration) addPattern(scope, nodeField(node, 'id'));
    const current = node !== root && scopes.has(node.type) ? node : scope;
    if (node.type === 'VariableDeclarator') addPattern(current, nodeField(node, 'id'));
    if (node.type.startsWith('Import')) addPattern(root, nodeField(node, 'local'));
    if (node.type === 'CatchClause') addPattern(current, nodeField(node, 'param'));
    const params = node.params;
    if (Array.isArray(params)) for (const parameter of params) if (isAstNode(parameter)) addPattern(current, parameter);
    for (const child of astChildren(node)) { parents.set(child, node); collect(child, current); }
  };
  collect(root, root);
  const isBound = (node: AstNode, name: string): boolean => {
    for (let current: AstNode | undefined = node; current; current = parents.get(current)) {
      if (bindings.get(current)?.has(name)) return true;
    }
    return false;
  };
  const line = (offset: number): number => text.slice(0, offset).split('\n').length;
  const lines: number[] = [];
  const visit = (node: AstNode): void => {
    const parent = parents.get(node);
    const name = identifierName(node);
    if (node.type === 'MemberExpression' && identifierName(nodeField(node, 'object')) === 'globalThis') {
      const member = identifierName(nodeField(node, 'property'));
      if (member === 'window' || member === 'document') lines.push(line(node.start));
    } else if ((name === 'window' || name === 'document') && parent) {
      const propertyName = (parent.type === 'MemberExpression' && nodeField(parent, 'property') === node && parent.computed === false)
        || (['Property', 'MethodDefinition', 'PropertyDefinition', 'TSPropertySignature'].includes(parent.type)
          && nodeField(parent, 'key') === node && parent.computed !== true);
      if (!propertyName && !isBound(node, name)) lines.push(line(node.start));
    }
    for (const child of astChildren(node)) visit(child);
  };
  visit(root);
  return [...new Set(lines)];
}

describe('engine boundary (PRODUCT-PLAN A0)', () => {
  it('keeps engine imports independent of React, UI and app modules', () => {
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const source = readFileSync(file, 'utf8');
      const imports = source.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g);
      for (const match of imports) {
        const specifier = match[1]!;
        if (specifier === 'react' || specifier.startsWith('react/')) violations.push(`${relative(ROOT, file)} imports ${specifier}`);
        if (!specifier.startsWith('.')) continue;
        const target = relative(ROOT, resolve(dirname(file), specifier)).replaceAll('\\', '/').replace(/\.(js|tsx?)$/, '');
        if (target.startsWith('src/ui/') || target.startsWith('src/app/')) violations.push(`${relative(ROOT, file)} imports ${specifier}`);
        if (target.startsWith('src/platform/') && ![...PLATFORM_TYPE_EXCEPTIONS].some((allowed) => target === allowed.replace(/\.ts$/, ''))) {
          violations.push(`${relative(ROOT, file)} imports platform runtime ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not access window/document globals outside documented codec and renderer exceptions', () => {
    const violations: string[] = [];
    for (const file of engineFiles()) {
      const name = relative(ROOT, file).replaceAll('\\', '/');
      if (name.startsWith('src/render/') || DOM_RUNTIME_EXCEPTIONS.has(name)) continue;
      for (const line of globalDomUses(file)) violations.push(`${name}:${line} uses DOM global`);
    }
    expect(violations).toEqual([]);
  });

  it('runs create, paint, adjustment and .fwimg reopen headlessly', async () => {
    expect(globalThis).not.toHaveProperty('window');
    expect(globalThis).not.toHaveProperty('document');
    const session = new EditorSession();
    session.createDocument(2, 1, true);
    const pixelId = session.activeLayerId!;
    const painted = Raster.fromPixels(2, 1, 4, [64, 64, 64, 255, 128, 128, 128, 255]);
    session.replaceLayerPixels(pixelId, painted, 'Paint');
    const exposure = { kind: 'Exposure', schemaVersion: 1,
      parameters: { exposure: 1, offset: 0, gamma: 1 } } as const;
    session.replaceLayerPixels(pixelId, adjustRaster(painted, session.layer(pixelId)!.transform, exposure), 'Apply Exposure');
    session.addAdjustment('Exposure');
    const adjustment = session.activeLayer!;
    if (adjustment.adjustment?.kind !== 'Exposure') throw new Error('Expected exposure adjustment');
    session.updateAdjustment(adjustment.id, exposure);
    const before = flattenDocument(session.document!).toPixels();
    expect(before[0]).toBeGreaterThan(64);

    const archive = writeArchive(session.document!, 'Headless', session.activeLayerId).blob;
    const loaded = await readArchive(archive, async (bytes) => {
      const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data };
    });
    expect(loaded.name).toBe('Headless');
    expect(Array.from(flattenDocument(loaded.document).toPixels())).toEqual(Array.from(before));
  });
});
