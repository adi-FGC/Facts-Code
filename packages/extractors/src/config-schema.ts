/**
 * @factstack/extractors — env-var + config-schema extractor.
 *
 * Detects every place the codebase reads an environment variable, with
 * the line number, the optional default value, and the access pattern.
 * The result feeds the new top-level `config.envVars` field in
 * `agent.json` plus a "Required env vars" panel in the UI's Config tab.
 *
 * What we detect (JS/TS via Babel AST):
 *
 *   1. `process.env.FOO`                   — MemberExpression
 *   2. `process.env['FOO']`                — MemberExpression (computed)
 *   3. `process.env["FOO"]`                — same, double-quoted
 *   4. `import.meta.env.FOO`               — Vite-style
 *   5. `import.meta.env['FOO']`            — Vite, computed
 *   6. `const { FOO } = process.env`       — ObjectPattern destructuring
 *   7. `process.env.FOO ?? 'default'`      — captures default literal
 *   8. `process.env.FOO || 'default'`      — same, || form
 *
 * Python detection is regex-based today (no Python AST yet — that's
 * v0.4 scope). We catch:
 *
 *   1. `os.getenv("FOO")` / `os.getenv("FOO", "default")`
 *   2. `os.environ["FOO"]` / `os.environ.get("FOO")`
 *   3. `os.environ.get("FOO", "default")`
 *
 * Zod / Pydantic *config schema* extraction (the "schema" part of the
 * roadmap entry) is a stretch goal — it requires resolving the
 * left-hand-side type of `z.object({...})` definitions to a usable
 * config shape. That ships in a follow-up commit; this file emits
 * `schema: null` everywhere for now.
 *
 * Pure / isomorphic per constraint C1: no Node imports.
 */

import { isParseable, parseJS, walkAst, type ParsedFile } from './parse.js';
import { isPython } from './imports-python.js';

export type EnvVarAccess =
  | 'process.env'
  | 'import.meta.env'
  | 'os.getenv'
  | 'os.environ'
  | 'destructure'
  | 'unknown';

export interface EnvVarRead {
  /** The variable name as written in source (case-preserving). */
  name: string;
  /** Pattern used to read it. Multiple reads of the same name aggregate. */
  access: EnvVarAccess;
  /** Line number of the read site. */
  line: number;
  /**
   * Optional default literal captured from `?? '…'` / `|| '…'` /
   * `os.getenv("FOO", "default")`. Null when no default is in source.
   */
  defaultValue: string | null;
}

/** Babel AST node type — too dynamic to type fully; treat as permissive. */
type AnyNode = {
  type?: string;
  object?: AnyNode;
  property?: AnyNode;
  computed?: boolean;
  name?: string;
  value?: unknown;
  meta?: AnyNode;
  loc?: { start?: { line?: number } };
  // extras used in destructuring / logical / call walks
  id?: AnyNode;
  init?: AnyNode;
  properties?: AnyNode[];
  key?: AnyNode;
  left?: AnyNode;
  right?: AnyNode;
  operator?: string;
  callee?: AnyNode;
  arguments?: AnyNode[];
};

/* Returns true when `node` is the chain `process.env`. */
function isProcessEnv(node: AnyNode | null | undefined): boolean {
  if (!node || node.type !== 'MemberExpression') return false;
  return (
    node.object?.type === 'Identifier' &&
    node.object?.name === 'process' &&
    node.property?.type === 'Identifier' &&
    node.property?.name === 'env'
  );
}

/* Returns true when `node` is the chain `import.meta.env`. */
function isImportMetaEnv(node: AnyNode | null | undefined): boolean {
  if (!node || node.type !== 'MemberExpression') return false;
  // `import.meta` itself is a MetaProperty: {meta: {name:'import'}, property: {name:'meta'}}.
  const obj = node.object;
  const isImportMeta =
    obj?.type === 'MetaProperty' &&
    obj.meta?.type === 'Identifier' &&
    obj.meta?.name === 'import' &&
    obj.property?.type === 'Identifier' &&
    obj.property?.name === 'meta';
  return Boolean(
    isImportMeta &&
      node.property?.type === 'Identifier' &&
      node.property?.name === 'env',
  );
}

/* Pull the variable name from a property access on `process.env.X` or
 * `process.env['X']`. The `computed` flag lives on the *outer*
 * MemberExpression — pass it in so we know whether `propertyNode` is
 * an Identifier (`.X`) or an expression in brackets (`['X']` or `[k]`).
 *
 * Returns null for computed-non-literal accesses (e.g.,
 * `process.env[runtimeKey]`) — the agent contract is no-guess. */
function readKey(propertyNode: AnyNode, computed: boolean): string | null {
  if (!propertyNode) return null;
  if (!computed) {
    return propertyNode.type === 'Identifier' && typeof propertyNode.name === 'string'
      ? propertyNode.name
      : null;
  }
  // computed: must be a string literal to be safe
  if (propertyNode.type === 'StringLiteral' && typeof propertyNode.value === 'string') {
    return propertyNode.value;
  }
  return null;
}

/**
 * Walk the parent (containing) node looking for `?? 'default'` or
 * `|| 'default'`. The Babel walker doesn't give us parents directly,
 * so callers pass the LogicalExpression context when known.
 */
function captureDefaultFromLogical(parent: AnyNode | null, self: AnyNode): string | null {
  if (!parent) return null;
  if (parent.type !== 'LogicalExpression') return null;
  const op = parent.operator;
  if (op !== '??' && op !== '||') return null;
  // The default is the OTHER side of the LogicalExpression.
  const other = parent.left === self ? parent.right : parent.left;
  if (other?.type === 'StringLiteral' && typeof other.value === 'string') return other.value;
  return null;
}

export function extractEnvVarsJS(source: string, ext: string, parsed?: ParsedFile | null): EnvVarRead[] {
  if (!isParseable(ext)) return [];
  const pf = parsed ?? parseJS(source, ext);
  if (!pf) return [];
  const out: EnvVarRead[] = [];

  /* Walker keeps a stack of ancestors so we can look one frame up
     when we hit a property access — that's how we pull `??`/`||`
     defaults without needing a second pass. */
  const ancestors: AnyNode[] = [];
  walkAst(pf.ast, (n: AnyNode | null) => {
    if (!n || typeof n !== 'object') return;
    // The walkAst implementation appears to be pre-order without an
    // exit hook; we can still get rough parent context by tracking
    // the last visited MemberExpression / VariableDeclarator we saw.
    // Use an inline visitor that tracks ancestry by collecting
    // structural matches at this node.

    // Pattern 1 + 2 + 3 + 4 + 5: <env-chain>.<key>
    if (n.type === 'MemberExpression') {
      const parent = ancestors[ancestors.length - 1] ?? null;
      // process.env.X / process.env['X']
      if (isProcessEnv(n.object)) {
        const key = readKey(n.property!, Boolean(n.computed));
        if (key) {
          out.push({
            name: key,
            access: 'process.env',
            line: n.loc?.start?.line ?? 0,
            defaultValue: captureDefaultFromLogical(parent, n),
          });
        }
      }
      // import.meta.env.X / import.meta.env['X']
      if (isImportMetaEnv(n.object)) {
        const key = readKey(n.property!, Boolean(n.computed));
        if (key) {
          out.push({
            name: key,
            access: 'import.meta.env',
            line: n.loc?.start?.line ?? 0,
            defaultValue: captureDefaultFromLogical(parent, n),
          });
        }
      }
    }

    // Pattern 6: const { FOO, BAR } = process.env  (or import.meta.env)
    if (
      n.type === 'VariableDeclarator' &&
      n.id?.type === 'ObjectPattern' &&
      (isProcessEnv(n.init ?? null) || isImportMetaEnv(n.init ?? null))
    ) {
      const access: EnvVarAccess = isProcessEnv(n.init ?? null) ? 'process.env' : 'import.meta.env';
      const props = n.id.properties ?? [];
      for (const p of props) {
        // ObjectProperty: { key: { name }, value: ... } — for plain `{ FOO }` shorthand value === key
        if (p.type === 'ObjectProperty' && p.key?.type === 'Identifier' && typeof p.key.name === 'string') {
          out.push({
            name: p.key.name,
            access,
            line: p.loc?.start?.line ?? n.loc?.start?.line ?? 0,
            defaultValue: null,
          });
        }
      }
    }

    // Maintain ancestor stack — set the just-visited node as the next
    // child's parent for the purpose of LogicalExpression detection.
    ancestors.push(n);
    if (ancestors.length > 32) ancestors.shift(); // bound the stack
  });

  return dedupeAndSort(out);
}

/* ─────────────────────────────────────────────────────────────────
 * Python detection — regex-only.
 *
 * The two surface forms we care about look like:
 *
 *   os.getenv("FOO")
 *   os.getenv("FOO", "default")
 *   os.environ["FOO"]
 *   os.environ.get("FOO")
 *   os.environ.get("FOO", "default")
 *
 * Quotes can be single or double. We require a string literal (no
 * f-strings, no concatenation) — those produce false positives and
 * the agent contract is "evidence-first, no guesses".
 * ─────────────────────────────────────────────────────────────── */

const PY_GETENV   = /\bos\.getenv\s*\(\s*(['"])([^'"\\]+)\1\s*(?:,\s*(['"])([^'"\\]*)\3)?\s*\)/g;
const PY_ENV_BRK  = /\bos\.environ\s*\[\s*(['"])([^'"\\]+)\1\s*\]/g;
const PY_ENV_GET  = /\bos\.environ\.get\s*\(\s*(['"])([^'"\\]+)\1\s*(?:,\s*(['"])([^'"\\]*)\3)?\s*\)/g;

export function extractEnvVarsPython(source: string): EnvVarRead[] {
  const out: EnvVarRead[] = [];
  // Translate match offset → line number cheaply via newline-prefix count.
  const lineOffsets: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10 /*\n*/) lineOffsets.push(i + 1);
  const lineOf = (offset: number): number => {
    // Binary search for largest lineOffsets[i] <= offset.
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const sweeps: Array<{ rx: RegExp; access: EnvVarAccess; nameGroup: number; defaultGroup: number | null }> = [
    { rx: PY_GETENV,  access: 'os.getenv',  nameGroup: 2, defaultGroup: 4 },
    { rx: PY_ENV_BRK, access: 'os.environ', nameGroup: 2, defaultGroup: null },
    { rx: PY_ENV_GET, access: 'os.environ', nameGroup: 2, defaultGroup: 4 },
  ];

  for (const { rx, access, nameGroup, defaultGroup } of sweeps) {
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(source)) !== null) {
      const name = m[nameGroup];
      if (!name) continue;
      const def = defaultGroup != null ? (m[defaultGroup] ?? null) : null;
      out.push({
        name,
        access,
        line: lineOf(m.index),
        defaultValue: def,
      });
    }
  }

  return dedupeAndSort(out);
}

/* Combine + dedupe + stable order. We dedupe per (name, access, line)
 * triple — same line + same access + same name is one read. Different
 * lines, even with the same name, emit separate entries because the UI
 * displays each read site. The aggregated "this var is read 12 times"
 * comes from the consumer counting entries per name. */
function dedupeAndSort(xs: EnvVarRead[]): EnvVarRead[] {
  const seen = new Set<string>();
  const out: EnvVarRead[] = [];
  for (const x of xs) {
    const k = `${x.name}|${x.access}|${x.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  out.sort((a, b) => (a.name === b.name ? a.line - b.line : a.name < b.name ? -1 : 1));
  return out;
}

/**
 * Top-level dispatch. Picks JS/TS or Python based on extension; emits
 * an empty array for everything else (HTML, CSS, JSON, manifests).
 */
export function extractEnvVars(source: string, ext: string, parsed?: ParsedFile | null): EnvVarRead[] {
  if (isParseable(ext)) return extractEnvVarsJS(source, ext, parsed);
  if (isPython(ext)) return extractEnvVarsPython(source);
  return [];
}
