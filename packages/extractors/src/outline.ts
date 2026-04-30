/**
 * @factstack/extractors — VS Code-style outline extractor.
 *
 * Walks a JS/TS or Python source file and returns a hierarchical list of
 * declarations: functions, classes (with methods nested), interfaces,
 * type aliases, enums, top-level variables, imports / exports.
 *
 * Pure-JS: @babel/parser for JS/TS, regex for Python. No WASM, isomorphic.
 */

import { parseJS, type ParsedFile } from './parse.js';

export type OutlineKind =
  | 'function' | 'method' | 'arrow-function'
  | 'class' | 'interface' | 'type' | 'enum'
  | 'variable' | 'property'
  | 'import' | 'export'
  | 'region';

export interface OutlineNode {
  name: string;
  kind: OutlineKind;
  line: number;
  endLine?: number | undefined;
  signature?: string | undefined;
  children?: OutlineNode[] | undefined;
}

const JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

export function extractOutline(source: string, ext: string, parsed?: ParsedFile | null): OutlineNode[] {
  const e = ext.toLowerCase();
  if (JS_EXTS.has(e)) return extractJsOutline(source, e, parsed);
  if (e === '.py' || e === '.pyi') return extractPythonOutline(source);
  return [];
}

// ── JS / TS ─────────────────────────────────────────────────────────────

function extractJsOutline(source: string, ext: string, parsed?: ParsedFile | null): OutlineNode[] {
  // Share the parse with imports + symbols extractors via parseJS; the
  // optional pre-parsed ParsedFile means callers that already parsed
  // (core, MCP get_outline tool) don't pay for a second parse.
  const pf = parsed ?? parseJS(source, ext);
  if (!pf) return [];

  const out: OutlineNode[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (pf.ast as any)?.program?.body ?? [];

  for (const node of body) {
    const n = peelExport(node);
    const isExport = node && (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' || node.type === 'ExportAllDeclaration');
    const ol = declToOutline(n, isExport, source);
    if (ol) out.push(ol);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function peelExport(node: any): any {
  if (!node) return node;
  if (node.type === 'ExportNamedDeclaration' && node.declaration) return node.declaration;
  if (node.type === 'ExportDefaultDeclaration' && node.declaration) return node.declaration;
  return node;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function declToOutline(n: any, isExport: boolean, source: string): OutlineNode | null {
  if (!n) return null;
  const line = n.loc?.start?.line ?? 0;
  const endLine = n.loc?.end?.line ?? line;
  const prefix = isExport ? 'export ' : '';

  switch (n.type) {
    case 'FunctionDeclaration':
      if (!n.id?.name) return null;
      return {
        name: n.id.name,
        kind: 'function',
        line,
        endLine,
        signature: prefix + 'function ' + n.id.name + '(' + paramsToString(n.params) + ')' + returnTypeString(n),
      };
    case 'ClassDeclaration':
      if (!n.id?.name) return null;
      return {
        name: n.id.name,
        kind: 'class',
        line,
        endLine,
        signature: prefix + 'class ' + n.id.name + extendsString(n),
        children: classMembers(n),
      };
    case 'TSInterfaceDeclaration':
      return { name: n.id.name, kind: 'interface', line, endLine, signature: prefix + 'interface ' + n.id.name };
    case 'TSTypeAliasDeclaration':
      return { name: n.id.name, kind: 'type', line, endLine, signature: prefix + 'type ' + n.id.name };
    case 'TSEnumDeclaration':
      return { name: n.id.name, kind: 'enum', line, endLine, signature: prefix + 'enum ' + n.id.name };
    case 'VariableDeclaration': {
      const kindKw = n.kind || 'var';
      const names = (n.declarations || []).map((d: unknown) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decl = d as any;
        if (decl.id?.type === 'Identifier') return decl.id.name;
        return null;
      }).filter(Boolean);
      if (!names.length) return null;
      // If there's exactly one declarator AND it's an arrow/function expr,
      // promote to function kind.
      if (n.declarations?.length === 1) {
        const d = n.declarations[0];
        const init = d.init;
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          return {
            name: d.id.name,
            kind: 'arrow-function',
            line,
            endLine,
            // Surface `async` in the signature; the OutlineKind enum
            // doesn't split async/sync, it's captured here as prose.
            signature: prefix + kindKw + ' ' + d.id.name + ' = ' + (init.async ? 'async ' : '') + '(' + paramsToString(init.params) + ') =>',
          };
        }
      }
      return {
        name: names.join(', '),
        kind: 'variable',
        line,
        endLine,
        signature: prefix + kindKw + ' ' + names.join(', '),
      };
    }
    case 'ImportDeclaration':
      return {
        name: n.source?.value ?? '',
        kind: 'import',
        line,
        signature: source.split('\n')[line - 1]?.trim().slice(0, 80),
      };
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      return {
        name: n.source?.value ?? '(local)',
        kind: 'export',
        line,
        signature: source.split('\n')[line - 1]?.trim().slice(0, 80),
      };
    default:
      return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classMembers(cls: any): OutlineNode[] {
  const out: OutlineNode[] = [];
  for (const m of cls.body?.body ?? []) {
    const line = m.loc?.start?.line ?? 0;
    const endLine = m.loc?.end?.line ?? line;
    const name = m.key?.name ?? m.key?.value ?? '(anonymous)';
    if (m.type === 'ClassMethod' || m.type === 'ClassPrivateMethod') {
      const isCtor = m.kind === 'constructor';
      out.push({
        name: isCtor ? 'constructor' : name,
        kind: 'method',
        line,
        endLine,
        signature: (m.static ? 'static ' : '') + name + '(' + paramsToString(m.params) + ')' + returnTypeString(m),
      });
    } else if (m.type === 'ClassProperty' || m.type === 'PropertyDefinition') {
      out.push({
        name,
        kind: 'property',
        line,
        endLine,
        signature: (m.static ? 'static ' : '') + name,
      });
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paramsToString(params: any[]): string {
  if (!Array.isArray(params)) return '';
  return params.map((p) => paramName(p)).join(', ');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paramName(p: any): string {
  if (!p) return '';
  if (p.type === 'Identifier') return p.name;
  if (p.type === 'AssignmentPattern') return paramName(p.left) + '=…';
  if (p.type === 'RestElement') return '...' + paramName(p.argument);
  if (p.type === 'ObjectPattern') return '{…}';
  if (p.type === 'ArrayPattern') return '[…]';
  if (p.type === 'TSParameterProperty') return paramName(p.parameter);
  return '_';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function returnTypeString(n: any): string {
  // Keep signatures compact — omit return types in the outline; they're
  // visible in the code preview if the user wants them.
  return '';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extendsString(n: any): string {
  if (!n.superClass) return '';
  if (n.superClass.type === 'Identifier') return ' extends ' + n.superClass.name;
  return '';
}

// ── Python ──────────────────────────────────────────────────────────────

function extractPythonOutline(source: string): OutlineNode[] {
  const out: OutlineNode[] = [];
  const lines = source.split('\n');
  const stack: Array<{ node: OutlineNode; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine == null) continue;
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top || top.indent < indent) break;
      stack.pop();
    }

    // Accept multi-line def signatures. Python allows a `def` to open
    // on one line and close its param list several lines down — common
    // for typed code. If we see `def name(` without a closing `)` on
    // the same line, scan forward (bounded) collecting raw chars until
    // we balance parens. Only affects detection; the outline's
    // `signature` still captures the full param list.
    const defOpen = /^\s*(async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
    if (defOpen) {
      let paren = 0;
      let collected = '';
      let reachedClose = false;
      scan: for (let j = i; j < Math.min(lines.length, i + 20); j++) {
        const lineJ = lines[j];
        if (lineJ == null) continue;
        const src = j === i ? line.slice(defOpen.index + defOpen[0].length) : lineJ;
        for (const ch of src) {
          if (ch === '(') paren++;
          else if (ch === ')') {
            if (paren === 0) { reachedClose = true; break scan; }
            paren--;
          }
          collected += ch;
        }
        collected += ' ';
      }
      if (!reachedClose) continue;
      const defName = defOpen[2];
      if (!defName) continue;
      const entry: OutlineNode = {
        name: defName,
        kind: stack.length ? 'method' : 'function',
        line: i + 1,
        signature: (defOpen[1] ? 'async ' : '') + 'def ' + defName + '(' + collected.replace(/\s+/g, ' ').trim() + ')',
      };
      const top = stack[stack.length - 1];
      if (top) {
        top.node.children ??= [];
        top.node.children.push(entry);
      } else {
        out.push(entry);
      }
      stack.push({ node: entry, indent });
      continue;
    }

    const cls = /^\s*class\s+([A-Za-z_][\w]*)(?:\(([^)]*)\))?/.exec(line);
    if (cls && cls[1]) {
      const clsName = cls[1];
      const entry: OutlineNode = {
        name: clsName,
        kind: 'class',
        line: i + 1,
        signature: 'class ' + clsName + (cls[2] ? '(' + cls[2] + ')' : ''),
        children: [],
      };
      const top = stack[stack.length - 1];
      if (top) {
        top.node.children ??= [];
        top.node.children.push(entry);
      } else {
        out.push(entry);
      }
      stack.push({ node: entry, indent });
      continue;
    }

    // Module-level constant: `FOO = 1` / `SOME: int = 2`.
    if (indent === 0) {
      const v = /^([A-Z_][A-Z0-9_]*)\s*(?::\s*[^=]+)?=/.exec(line);
      if (v && v[1]) {
        out.push({ name: v[1], kind: 'variable', line: i + 1, signature: v[1] });
      }
    }
  }

  return out;
}
