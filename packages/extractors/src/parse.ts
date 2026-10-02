/**
 * @factstack/extractors — shared Babel parse wrapper.
 *
 * All JS/TS extractors (imports, symbols, declarations, future calls)
 * parse the source ONCE through this module and share the resulting AST.
 * This avoids triple-parsing every TS file in a 100K-LOC monorepo.
 *
 * The `contentHash` is a non-cryptographic djb2 digest. It's stable,
 * fast, and good enough to key an in-memory cache across a single
 * project's file set. We can't use `node:crypto` here — C1 bars Node
 * built-ins from the extractors package.
 *
 * v0.3 adds a SQLite-backed cache keyed on this hash; that store is
 * Node-only (`node:sqlite`) and will live in `packages/emit`, not here.
 */

import { parse, type ParserPlugin } from '@babel/parser';

const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TS_EXTS = new Set(['.ts', '.tsx', '.cts', '.mts']);

export interface ParsedFile {
  /** Babel AST root (File node). Typed as unknown here because extractors
   *  walk it structurally; consumers cast when they need precise typing. */
  ast: unknown;
  /** Non-cryptographic djb2 hash of the raw source — stable cache key. */
  contentHash: string;
  /** Original extension (lowercase, with leading dot). */
  ext: string;
}

export function isParseable(ext: string): boolean {
  const e = ext.toLowerCase();
  return JS_EXTS.has(e) || TS_EXTS.has(e);
}

/** Parse a JS/TS source file. Returns null if the extension isn't
 *  parseable or if every Babel attempt errors out even with recovery on. */
export function parseJS(source: string, ext: string): ParsedFile | null {
  if (!isParseable(ext)) return null;
  const kind = TS_EXTS.has(ext.toLowerCase()) ? 'ts' : 'js';
  const first = plugins(kind, ext);
  /* Flow-typed .js (React Native, older Meta code: `// @flow`, `import type`,
     annotations) needs the flow plugin, which excludes `typescript` — so it is
     a JS-only retry, tried only after the plain parse fails. Files that parsed
     before parse exactly as before (INV2). */
  const ast =
    tryParse(source, first) ?? (kind === 'js' ? tryParse(source, [...first, 'flow']) : null);
  if (ast === null) return null;
  return { ast, contentHash: djb2(source), ext: ext.toLowerCase() };
}

function tryParse(source: string, pluginList: ParserPlugin[]): unknown {
  try {
    return parse(source, {
      sourceType: 'module',
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins: pluginList,
    });
  } catch {
    return null;
  }
}

function plugins(kind: 'js' | 'ts', ext: string): ParserPlugin[] {
  /* JSX in plain .js is the norm (CRA, React Native, Expo, Gatsby), and the
     jsx plugin is unambiguous in JS — only TS generics (`<T>(x)`) conflict,
     which is why .ts stays jsx-free. Without it such a file failed to parse
     and read as an empty module with no imports. */
  const jsx = kind === 'js' || ext.toLowerCase().endsWith('x');
  /* decoratorAutoAccessors: TS 4.9+/TC39 `accessor x = 1` class fields (Lit,
     standard decorators). It composes with decorators-legacy. */
  const base: ParserPlugin[] = ['importAssertions', 'decorators-legacy', 'decoratorAutoAccessors'];
  if (kind === 'ts') base.push('typescript');
  if (jsx) base.push('jsx');
  return base;
}

/**
 * djb2 hash — deterministic, dependency-free. Returns an 8-char hex
 * string (32-bit space ≈ 4B — ample for a per-project file set, not
 * adversary-resistant). The SQLite-backed cache in v0.3 can swap in a
 * real digest (sha256) where needed; this is just a per-session key.
 */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  // Unsigned 32-bit, always 8 hex chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Walk an AST depth-first, calling `visit` on every node that has a
 * `.type` property. Skips loc/source-location fields so we don't recurse
 * into position metadata. Shared with `imports.ts` and `symbols.ts`.
 *
 * The `any` on the callback is intentional — Babel node unions are
 * enormous and narrowing per-visit is the caller's job. Siblings in
 * `outline.ts` use the same pragma pattern.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function walkAst(node: unknown, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (typeof n.type === 'string') visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const c of v) walkAst(c, visit);
    } else if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') {
      walkAst(v, visit);
    }
  }
}
