// Every `throw new Error/TypeError/RangeError(...)` in the editor source, and which of them a run reached.
//
// "Reached" is measured by the message: a run that records the messages of every Error constructed in the page (see
// `ERROR_RECORDER`) or in Node (`recordErrorsInNode`) is matched against the literal parts of each site's message. A site
// whose message is built entirely at run time (`new Error(reason)`) cannot be told from another one by its message and is
// listed apart as `dynamic`. Errors thrown inside the PDF worker are separate JavaScript: the page only sees them when
// they come back as a toast, so those are matched through `matchMessage` as well but never counted from inside.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const THROW = /\bthrow\s+new\s+((?:Type|Range|Syntax|Reference|Eval|URI)?Error|\w+Error)\s*\(/gu;

/** Source of the page-side recorder: every constructed Error keeps its message in `window.__thrown`. */
export const ERROR_RECORDER = `(() => {
  const seen = window.__thrown = window.__thrown || new Map();
  for (const name of ['Error', 'TypeError', 'RangeError']) {
    const Original = globalThis[name];
    if (!Original || Original.__recorded) continue;
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        try {
          const message = String(args[0] ?? '').slice(0, 400);
          if (message) seen.set(message, (seen.get(message) || 0) + 1);
        } catch {}
        return Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
      },
      get(target, property, receiver) { return property === '__recorded' ? true : Reflect.get(target, property, receiver); },
    });
    globalThis[name] = Wrapped;
  }
})();`;

/** The same recorder for Node; returns the map of message to count. */
export function recordErrorsInNode() {
  const seen = new Map();
  for (const name of ['Error', 'TypeError', 'RangeError']) {
    const Original = globalThis[name];
    const Wrapped = new Proxy(Original, {
      construct(target, args, newTarget) {
        const message = String(args[0] ?? '').slice(0, 400);
        if (message) seen.set(message, (seen.get(message) || 0) + 1);
        return Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
      },
    });
    globalThis[name] = Wrapped;
  }
  return seen;
}

/** The text between the parentheses opened at `open`, with string and template literals skipped correctly. */
function argumentText(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\'' || char === '"') {
      for (index += 1; index < source.length && source[index] !== char; index += 1) if (source[index] === '\\') index += 1;
    } else if (char === '`') {
      for (index += 1; index < source.length && source[index] !== '`'; index += 1) {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '$' && source[index + 1] === '{') {
          let inner = 0;
          for (index += 1; index < source.length; index += 1) {
            if (source[index] === '{') inner += 1;
            else if (source[index] === '}' && !(inner -= 1)) break;
          }
        }
      }
    } else if (char === '(') depth += 1;
    else if (char === ')' && !(depth -= 1)) return source.slice(open + 1, index);
  }
  return source.slice(open + 1, open + 400);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** A pattern for the message from the literal pieces of the first argument; `.+` stands for anything computed. */
function messagePattern(argument) {
  const text = argument.trim();
  const parts = [];
  let literal = 0;
  let index = 0;
  const push = piece => { parts.push(piece); };
  while (index < text.length) {
    const char = text[index];
    if (char === '\'' || char === '"') {
      let value = '';
      let cursor = index + 1;
      for (; cursor < text.length && text[cursor] !== char; cursor += 1) {
        if (text[cursor] === '\\') { cursor += 1; value += text[cursor] === 'n' ? '\n' : text[cursor]; } else value += text[cursor];
      }
      push(escapeRegExp(value));
      literal += value.length;
      index = cursor + 1;
    } else if (char === '`') {
      let cursor = index + 1;
      let value = '';
      for (; cursor < text.length && text[cursor] !== '`'; cursor += 1) {
        if (text[cursor] === '\\') { cursor += 1; value += text[cursor]; } else if (text[cursor] === '$' && text[cursor + 1] === '{') {
          push(escapeRegExp(value));
          literal += value.length;
          value = '';
          let inner = 0;
          for (cursor += 1; cursor < text.length; cursor += 1) {
            if (text[cursor] === '{') inner += 1;
            else if (text[cursor] === '}' && !(inner -= 1)) break;
          }
          push('.*?');
        } else value += text[cursor];
      }
      push(escapeRegExp(value));
      literal += value.length;
      index = cursor + 1;
    } else if (char === '+' || /\s/u.test(char)) {
      index += 1;
    } else {
      // An identifier, call or conditional: the rest of this operand is computed.
      let depth = 0;
      let cursor = index;
      for (; cursor < text.length; cursor += 1) {
        const here = text[cursor];
        if ('([{'.includes(here)) depth += 1;
        else if (')]}'.includes(here)) depth -= 1;
        else if (!depth && (here === '+' || here === ',')) break;
        else if (here === '\'' || here === '"' || here === '`') {
          for (cursor += 1; cursor < text.length && text[cursor] !== here; cursor += 1) if (text[cursor] === '\\') cursor += 1;
        }
      }
      push('.*?');
      index = cursor;
      if (text[cursor] === ',') break;
    }
  }
  if (literal < 6) return { pattern: null, literal };
  return { pattern: new RegExp(`^${parts.join('')}$`, 'su'), literal };
}

/** Splits at commas outside brackets and literals. */
function splitArguments(text) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\'' || char === '"' || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1) if (text[index] === '\\') index += 1;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && !depth) { out.push(text.slice(from, index)); from = index + 1; }
  }
  out.push(text.slice(from));
  return out.filter(item => item.trim());
}

/** The message is the first argument, or the second when the first is an error code; a conditional lists both messages. */
function patternForArguments(argument) {
  for (const candidate of splitArguments(argument).slice(0, 2)) {
    const literals = [...candidate.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/gsu)].map(match => match[1] ?? match[2]);
    if (/\?[^?]/u.test(candidate.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/gsu, '')) && literals.length > 1) {
      const long = literals.filter(item => item.length >= 6);
      if (long.length) return { pattern: new RegExp(`^(?:${long.map(item => `${escapeRegExp(item)}.*?`).join('|')})$`, 'su') };
    }
    const result = messagePattern(candidate);
    if (result.pattern) return result;
  }
  return { pattern: null };
}

async function sourceFiles(root) {
  const out = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.(?:js|jsx|mjs)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

/** @returns {Promise<{ file: string, line: number, kind: string, message: string, pattern: RegExp | null }[]>} */
export async function extractThrowSites(root) {
  const sites = [];
  for (const file of (await sourceFiles(root)).sort()) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(THROW)) {
      const open = match.index + match[0].length - 1;
      const argument = argumentText(source, open);
      const { pattern } = patternForArguments(argument);
      sites.push({
        file: path.relative(root, file),
        line: source.slice(0, match.index).split('\n').length,
        kind: match[1],
        message: argument.replace(/\s+/gu, ' ').slice(0, 140),
        pattern,
      });
    }
  }
  return sites;
}

/** The sites whose message could have produced this text. */
export const matchMessage = (sites, message) => sites.filter(site => site.pattern && site.pattern.test(message));

/** @param {Map<string, number>} thrown message to count @returns the coverage of the sites */
export function throwCoverage(sites, thrown) {
  const hits = new Map();
  for (const [message, count] of thrown) {
    for (const site of matchMessage(sites, message)) hits.set(site, (hits.get(site) || 0) + count);
  }
  const dynamic = sites.filter(site => !site.pattern);
  const reached = sites.filter(site => hits.has(site));
  return { total: sites.length, dynamic, reached, unreached: sites.filter(site => site.pattern && !hits.has(site)), hits };
}

export function throwCoverageLines(coverage, { listUnreached = 25 } = {}) {
  const lines = [
    `Throw sites in the editor source: ${coverage.total}. Reached ${coverage.reached.length}, not reached ` +
      `${coverage.unreached.length}, message built at run time (cannot be told apart, not counted) ${coverage.dynamic.length}.`,
  ];
  const byFile = new Map();
  for (const site of coverage.unreached) byFile.set(site.file, (byFile.get(site.file) || 0) + 1);
  const files = [...byFile].sort((left, right) => right[1] - left[1]);
  lines.push('', 'Not reached, by file:', ...files.slice(0, 15).map(([file, count]) => `- ${file}: ${count}`));
  if (listUnreached) {
    lines.push('', `First ${listUnreached} not reached:`,
      ...coverage.unreached.slice(0, listUnreached).map(site => `- ${site.file}:${site.line} ${site.message}`));
  }
  return lines;
}

/** Folds the thrown-message maps of several runs into one (plain objects as written to disk). */
export function mergeThrown(...maps) {
  const merged = new Map();
  for (const map of maps) for (const [message, count] of Object.entries(map instanceof Map ? Object.fromEntries(map) : map || {})) {
    merged.set(message, (merged.get(message) || 0) + count);
  }
  return merged;
}
