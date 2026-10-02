// Static XSS audit for the legacy prototype (legacy/prototype/index.html →
// apps/cli/src/ui/index.html). Every value that reaches an HTML sink —
// `x.innerHTML = …`, `x.outerHTML = …`, `x.srcdoc = …`, `x.insertAdjacentHTML(pos, …)`,
// document.write, Range/DOMParser parsing and the prototype's
// `h(tag, { html: … })` helper — must be provably safe: a literal,
// a sanitizer call (escapeHtml / num / cssColor / fmt*), arithmetic, or a
// local value/function whose every definition is itself safe. Anything read
// from the dataset (file/folder/repo names, messages, colors…) must pass a
// sanitizer before it is interpolated. Used by scripts/test/legacy-ui.test.ts;
// run directly with `node scripts/lib/ui-xss-audit.mjs` for a listing.
//
// Sanitizers are trusted by BINDING, not by name: a call counts only when it
// resolves to the one declaration the test executes against hostile input.
// Containers are tracked through writes (`arr.push(v)`, `obj.k = v`,
// `Object.assign(obj, …)`), aliases (`const b = a`) and local helper
// parameters (`add(parts, v)`). Still heuristic: a container smuggled through
// an object property or an unresolvable callee is not followed, so the DOM
// test (headless Chromium, hostile dataset) and the hash-only CSP stay the
// backstops.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

/** Sanitizers: their output is safe in both text and quoted-attribute
 *  context whatever they are given. The test executes each one against
 *  hostile input, so a weakened implementation fails loudly. */
export const SANITIZERS = [
  'escapeHtml',
  'num',
  'cssColor',
  'cssIdent',
  'fmtTok',
  'fmtBytes',
  'fmtNum',
];

/** Methods whose result is safe whenever the receiver (and args) are safe. */
const PASS_THROUGH = new Set([
  'toUpperCase',
  'toLowerCase',
  'trim',
  'trimStart',
  'trimEnd',
  'slice',
  'substring',
  'padStart',
  'padEnd',
  'repeat',
  'concat',
  'filter',
  'reverse',
  'sort',
  'toLocaleString',
]);
/** Methods that always return a number or boolean. */
const NUMERIC_METHODS = new Set([
  'toFixed',
  'indexOf',
  'lastIndexOf',
  'includes',
  'startsWith',
  'endsWith',
  'test',
  'has',
  'getTime',
]);
/** Layout coordinates computed by the tidy-tree / DAG code, never read from
 *  the dataset — safe to interpolate as SVG geometry. Dataset-shaped names
 *  (`size`, `length`) are NOT trusted: wrap them in num(). */
const COMPUTED_NUMERIC_PROPS = new Set(['x', 'y', 'depth']);
/** Globals whose result is a number/boolean, or a string of a safe argument. */
const NUMERIC_GLOBALS = new Set(['Number', 'parseInt', 'parseFloat', 'Boolean']);
/** Array methods that write their arguments into the receiver. */
const WRITE_METHODS = { push: 0, unshift: 0, splice: 2, fill: 0 };

/** Extract the prototype's main `<script type="module">` body. */
export function moduleScript(html) {
  const open = '<script type="module">';
  const s = html.indexOf(open);
  if (s < 0) throw new Error('module script not found');
  const start = s + open.length;
  const end = html.indexOf('</script>', start);
  return { code: html.slice(start, end), lineOffset: html.slice(0, start).split('\n').length - 1 };
}

class Scope {
  constructor(parent, isFunction) {
    this.parent = parent;
    this.isFunction = isFunction;
    this.bindings = new Map();
  }
  declare(name, binding) {
    const cur = this.bindings.get(name);
    if (cur) {
      cur.inits.push(...binding.inits);
      if (binding.tainted) cur.tainted = true;
      if (binding.fns.length) cur.fns.push(...binding.fns);
      return cur;
    }
    this.bindings.set(name, binding);
    return binding;
  }
  lookup(name) {
    return this.bindings.get(name) ?? this.parent?.lookup(name) ?? null;
  }
  fnScope() {
    return this.isFunction || !this.parent ? this : this.parent.fnScope();
  }
}

const newBinding = (extra = {}) => ({
  inits: [],
  assigns: [],
  pushes: [], // values written INTO the container (push, obj.k = v, …)
  flowsInto: [], // bindings that alias this container (const b = a, helper params)
  fns: [],
  tainted: false,
  ...extra,
});
/** `a` for `a`, `a.b[c].d`; null for `this.x`, `f().x`. */
const rootIdent = (n) => {
  while (n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression'))
    n = n.object;
  return n?.type === 'Identifier' ? n : null;
};
/** Identifiers whose container `n` may evaluate to (for alias tracking). */
function aliasRoots(n) {
  if (!n) return [];
  switch (n.type) {
    case 'ParenthesizedExpression':
      return aliasRoots(n.expression);
    case 'ConditionalExpression':
      return [...aliasRoots(n.consequent), ...aliasRoots(n.alternate)];
    case 'LogicalExpression':
      return [...aliasRoots(n.left), ...aliasRoots(n.right)];
    case 'SequenceExpression':
      return aliasRoots(n.expressions[n.expressions.length - 1]);
    case 'AssignmentExpression':
      return aliasRoots(n.right);
    default: {
      const r = rootIdent(n);
      return r ? [r] : [];
    }
  }
}
const isFn = (n) =>
  n &&
  (n.type === 'FunctionDeclaration' ||
    n.type === 'FunctionExpression' ||
    n.type === 'ArrowFunctionExpression');
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'leadingComments',
  'trailingComments',
  'innerComments',
  'extra',
  'range',
]);

function children(n) {
  const out = [];
  for (const k of Object.keys(n)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = n[k];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') out.push([k, c]);
    } else if (v && typeof v.type === 'string') out.push([k, v]);
  }
  return out;
}

function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern')
    for (const pr of p.properties)
      patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out);
  else if (p.type === 'ArrayPattern') for (const el of p.elements) patternNames(el, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

/**
 * Audit a prototype HTML document. Returns one finding per unsafe value that
 * reaches an HTML sink: { line, sink, expr }.
 */
export function auditHtmlSinks(html) {
  const { code, lineOffset } = moduleScript(html);
  const ast = parse(code, { sourceType: 'module' });
  const scopeOf = new Map(); // node → Scope it opens
  const refs = new Map(); // Identifier node → binding
  const fnOwner = new Map(); // return statement → owning function node
  const calls = []; // call expressions, for helper-parameter aliasing (pass 3)
  // The one declaration per sanitizer name that the test executes.
  const canonical = new Map(SANITIZERS.map((name) => [name, findFunctionNode(ast, name)]));

  // ── pass 1: scopes + declarations (hoisted) ──────────────────────────
  const root = new Scope(null, true);
  scopeOf.set(ast.program, root);
  (function declare(n, scope) {
    let inner = scope;
    if (isFn(n)) {
      inner = new Scope(scope, true);
      scopeOf.set(n, inner);
      if (n.type === 'FunctionDeclaration' && n.id)
        scope.declare(n.id.name, newBinding({ fns: [n] }));
      if (n.type === 'FunctionExpression' && n.id)
        inner.declare(n.id.name, newBinding({ fns: [n] }));
      for (const p of n.params)
        for (const name of patternNames(p)) inner.declare(name, newBinding({ tainted: true }));
    } else if (
      n.type === 'BlockStatement' ||
      n.type === 'ForStatement' ||
      n.type === 'ForOfStatement' ||
      n.type === 'ForInStatement' ||
      n.type === 'SwitchStatement' ||
      n.type === 'CatchClause'
    ) {
      inner = new Scope(scope, false);
      scopeOf.set(n, inner);
      if (n.type === 'CatchClause' && n.param)
        for (const name of patternNames(n.param))
          inner.declare(name, newBinding({ tainted: true }));
    }
    if (n.type === 'VariableDeclaration') {
      const target = n.kind === 'var' ? scope.fnScope() : scope;
      for (const d of n.declarations) {
        if (d.id.type === 'Identifier') {
          const b = newBinding();
          if (d.init) {
            b.inits.push(d.init);
            if (isFn(d.init)) b.fns.push(d.init);
          }
          target.declare(d.id.name, b);
        } else {
          for (const name of patternNames(d.id))
            target.declare(name, newBinding({ tainted: true }));
        }
      }
    }
    if (
      (n.type === 'ForOfStatement' || n.type === 'ForInStatement') &&
      n.left.type === 'VariableDeclaration'
    ) {
      // Loop variables carry whatever the iterable holds — treat as data.
      for (const d of n.left.declarations)
        for (const name of patternNames(d.id)) inner.declare(name, newBinding({ tainted: true }));
    }
    if (n.type === 'ClassDeclaration' && n.id)
      scope.declare(n.id.name, newBinding({ tainted: true }));
    for (const [k, c] of children(n)) {
      if ((n.type === 'ForOfStatement' || n.type === 'ForInStatement') && k === 'left') continue;
      declare(c, inner);
    }
  })(ast.program, root);

  // ── pass 2: resolve references, record assignments / pushes / returns ─
  const sinks = [];
  (function resolve(n, scope, fn) {
    const inner = scopeOf.get(n) ?? scope;
    const curFn = isFn(n) ? n : fn;
    if (n.type === 'ReturnStatement' && n.argument) fnOwner.set(n, curFn);
    if (n.type === 'AssignmentExpression') {
      const prop =
        n.left.type === 'MemberExpression'
          ? n.left.computed
            ? n.left.property.type === 'StringLiteral' && n.left.property.value
            : n.left.property.name
          : null;
      if (n.left.type === 'Identifier') {
        const b = inner.lookup(n.left.name);
        if (b) b.assigns.push(n);
      } else if (['innerHTML', 'outerHTML', 'srcdoc'].includes(prop)) {
        sinks.push({ node: n.right, scope: inner, sink: prop, fn: curFn });
      } else if (n.left.type === 'MemberExpression') {
        // arr[i] = v, obj.k = v, obj.a.b = v: a write into the root container.
        const r = rootIdent(n.left);
        const b = r && inner.lookup(r.name);
        if (b) b.pushes.push(n.right);
      }
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
      const m = n.callee.property.name;
      if (m === 'insertAdjacentHTML' && n.arguments[1])
        sinks.push({ node: n.arguments[1], scope: inner, sink: 'insertAdjacentHTML', fn: curFn });
      // Other markup parsers: document.write(ln), Range, DOMParser.
      if (['write', 'writeln', 'createContextualFragment', 'parseFromString'].includes(m))
        for (const a of m === 'parseFromString' ? n.arguments.slice(0, 1) : n.arguments)
          sinks.push({ node: a, scope: inner, sink: m, fn: curFn });
      if (Object.hasOwn(WRITE_METHODS, m)) {
        const r = rootIdent(n.callee.object);
        const b = r && inner.lookup(r.name);
        if (b) b.pushes.push(...n.arguments.slice(WRITE_METHODS[m]));
      }
      // Object.assign(target, …sources) writes every source value into target.
      if (
        m === 'assign' &&
        n.callee.object.type === 'Identifier' &&
        n.callee.object.name === 'Object'
      ) {
        const r = rootIdent(n.arguments[0]);
        const b = r && inner.lookup(r.name);
        if (b)
          for (const s of n.arguments.slice(1))
            if (s.type === 'ObjectExpression')
              for (const p of s.properties)
                b.pushes.push(p.type === 'ObjectProperty' ? p.value : p);
            else b.pushes.push(s);
      }
    }
    if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') calls.push(n);
    if (
      n.type === 'CallExpression' &&
      n.callee.type === 'Identifier' &&
      n.callee.name === 'h' &&
      n.arguments[1]?.type === 'ObjectExpression'
    ) {
      for (const p of n.arguments[1].properties) {
        const key = p.key?.name ?? p.key?.value;
        if (p.type === 'ObjectProperty' && key === 'html')
          sinks.push({ node: p.value, scope: inner, sink: 'h({html})', fn: curFn });
      }
    }
    for (const [k, c] of children(n)) {
      if (c.type === 'Identifier') {
        // Only references in expression position (skip keys / member props).
        if (
          (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') &&
          k === 'property' &&
          !n.computed
        )
          continue;
        if (
          (n.type === 'ObjectProperty' || n.type === 'ObjectMethod' || n.type === 'ClassMethod') &&
          k === 'key' &&
          !n.computed
        )
          continue;
        const b = inner.lookup(c.name);
        if (b) refs.set(c, b);
      }
      resolve(c, inner, curFn);
    }
  })(ast.program, root, null);

  // Return statements per function.
  const returnsOf = new Map();
  for (const [ret, owner] of fnOwner) {
    if (!returnsOf.has(owner)) returnsOf.set(owner, []);
    returnsOf.get(owner).push(ret.argument);
  }

  // ── pass 3: aliases. A write through `b` (const b = a) or through a helper's
  // parameter (add(parts, v) → a.push(v)) is a write into the caller's `a`.
  const link = (expr, to) => {
    for (const id of aliasRoots(expr)) {
      const from = refs.get(id);
      if (from && from !== to) from.flowsInto.push(to);
    }
  };
  for (const s of new Set(scopeOf.values()))
    for (const b of s.bindings.values()) {
      for (const i of b.inits) if (!isFn(i)) link(i, b);
      for (const a of b.assigns) if (a.operator === '=') link(a.right, b);
    }
  for (const c of calls) {
    const fns = isFn(c.callee)
      ? [c.callee]
      : c.callee.type === 'Identifier'
        ? (refs.get(c.callee)?.fns ?? [])
        : [];
    for (const f of fns) {
      const fs = scopeOf.get(f);
      f.params.forEach((p, i) => {
        const args = p.type === 'RestElement' ? c.arguments.slice(i) : [c.arguments[i]];
        for (const name of patternNames(p)) {
          const pb = fs.bindings.get(name);
          if (pb) for (const a of args) link(a, pb);
        }
      });
    }
  }

  const src = (n) => code.slice(n.start, n.end).replace(/\s+/g, ' ');
  const memo = new Map();

  function fnSafe(f, seen) {
    if (f.type === 'ArrowFunctionExpression' && f.body.type !== 'BlockStatement')
      return safe(f.body, seen);
    const rets = returnsOf.get(f) ?? [];
    return rets.every((r) => safe(r, seen));
  }

  /** Every value written into `b` — directly or through any alias of it — is safe. */
  function writesSafe(b, seen, via = new Set()) {
    if (via.has(b)) return true;
    via.add(b);
    return (
      b.pushes.every((p) => safe(p, seen)) && b.flowsInto.every((t) => writesSafe(t, seen, via))
    );
  }

  function bindingSafe(b, seen) {
    if (b.tainted) return false;
    if (seen.has(b)) return true; // optimistic on cycles (x += x)
    if (memo.has(b)) return memo.get(b);
    seen.add(b);
    const ok =
      b.inits.every((i) => (isFn(i) ? true : safe(i, seen))) &&
      b.assigns.every((a) => safe(a.right, seen)) &&
      writesSafe(b, seen);
    seen.delete(b);
    memo.set(b, ok);
    return ok;
  }

  /** A call to the sanitizer the test executes — not a shadowing local or
   *  parameter of the same name, and never reassigned. */
  function isSanitizerCall(callee) {
    const f = canonical.get(callee.name);
    const b = refs.get(callee);
    return !!f && !!b && !b.tainted && !b.assigns.length && b.fns.length === 1 && b.fns[0] === f;
  }

  function calleeSafe(callee, seen) {
    if (callee.type !== 'Identifier') return false;
    const b = refs.get(callee);
    if (!b || !b.fns.length || b.assigns.length) return false; // reassigned: unknown body
    if (seen.has(b)) return true;
    seen.add(b);
    const ok = b.fns.every((f) => fnSafe(f, seen));
    seen.delete(b);
    return ok;
  }

  /** True when `n` evaluates to an object literal (directly, via a const
   *  binding, or as the return value of a local function) whose every
   *  property value is safe. Inherited keys (`constructor`, `__proto__`)
   *  stringify to markup-free text, so any key lookup is safe. */
  function objectValuesSafe(n, seen) {
    if (!n) return false;
    if (n.type === 'ParenthesizedExpression') return objectValuesSafe(n.expression, seen);
    if (n.type === 'ObjectExpression') {
      return n.properties.every((p) => p.type === 'ObjectProperty' && safe(p.value, seen));
    }
    if (n.type === 'ConditionalExpression')
      return objectValuesSafe(n.consequent, seen) && objectValuesSafe(n.alternate, seen);
    if (n.type === 'Identifier') {
      const b = refs.get(n);
      if (!b || b.tainted || b.assigns.length || !b.inits.length) return false;
      if (seen.has(b)) return true;
      seen.add(b);
      // A table written to later (T.k = v, T[k] = v, via an alias…) is only
      // as safe as what is written into it.
      const ok = b.inits.every((i) => objectValuesSafe(i, seen)) && writesSafe(b, seen);
      seen.delete(b);
      return ok;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
      const b = refs.get(n.callee);
      if (!b || !b.fns.length || b.assigns.length) return false;
      if (seen.has(b)) return true;
      seen.add(b);
      const ok = b.fns.every((f) =>
        f.type === 'ArrowFunctionExpression' && f.body.type !== 'BlockStatement'
          ? objectValuesSafe(f.body, seen)
          : (returnsOf.get(f) ?? []).every((r) => objectValuesSafe(r, seen)),
      );
      seen.delete(b);
      return ok;
    }
    return false;
  }

  function safe(n, seen = new Set()) {
    if (!n) return true;
    switch (n.type) {
      case 'StringLiteral':
      case 'NumericLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'BigIntLiteral':
        return true;
      case 'TemplateLiteral':
        return n.expressions.every((e) => safe(e, seen));
      case 'ParenthesizedExpression':
        return safe(n.expression, seen);
      case 'SequenceExpression':
        return safe(n.expressions[n.expressions.length - 1], seen);
      case 'AssignmentExpression':
        return safe(n.right, seen);
      case 'ConditionalExpression':
        return safe(n.consequent, seen) && safe(n.alternate, seen);
      case 'LogicalExpression':
        // `a && b` yields a only when a is falsy ('' / 0 / null…) — harmless.
        return n.operator === '&&'
          ? safe(n.right, seen)
          : safe(n.left, seen) && safe(n.right, seen);
      case 'BinaryExpression':
        return n.operator === '+' ? safe(n.left, seen) && safe(n.right, seen) : true;
      case 'UnaryExpression':
      case 'UpdateExpression':
        return true;
      case 'ArrayExpression':
        return n.elements.every(
          (e) => !e || (e.type === 'SpreadElement' ? safe(e.argument, seen) : safe(e, seen)),
        );
      case 'Identifier': {
        if (n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity') return true;
        const b = refs.get(n);
        return b ? bindingSafe(b, seen) : false;
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression':
        if (!n.computed && COMPUTED_NUMERIC_PROPS.has(n.property.name)) return true;
        // Lookup in a code-defined table: `({ a: 'x', b: 'y' })[k]`, `TABLE[k]`.
        return objectValuesSafe(n.object, seen);
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const c = n.callee;
        if (isFn(c)) return fnSafe(c, seen); // IIFE
        if (c.type === 'Identifier') {
          if (SANITIZERS.includes(c.name) && isSanitizerCall(c)) return true;
          const global = !refs.get(c); // not shadowed by a local of the same name
          if (global && NUMERIC_GLOBALS.has(c.name)) return true;
          if (global && c.name === 'String') return safe(n.arguments[0], seen);
          return calleeSafe(c, seen);
        }
        if (c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') {
          if (c.computed) return false;
          const m = c.property.name;
          if (c.object.type === 'Identifier' && c.object.name === 'Math' && !refs.get(c.object))
            return true;
          if (NUMERIC_METHODS.has(m)) return true;
          if (m === 'join') return safe(c.object, seen) && n.arguments.every((a) => safe(a, seen));
          if (m === 'map' || m === 'flatMap') {
            const cb = n.arguments[0];
            return !!cb && isFn(cb) && fnSafe(cb, seen);
          }
          if (PASS_THROUGH.has(m)) {
            if (c.object.type === 'NewExpression' && c.object.callee.name === 'Date') return true;
            return safe(c.object, seen) && n.arguments.every((a) => safe(a, seen));
          }
        }
        return false;
      }
      default:
        return false;
    }
  }

  const findings = [];
  const seenReport = new Set();
  // The `h` helper's own `el.innerHTML = v` is the sink definition; its
  // callers are checked through the h({ html }) sink instead.
  const hFns = new Set(root.lookup('h')?.fns ?? []);
  for (const s of sinks) {
    if (!hFns.has(s.fn)) collect(s.node, s.sink);
  }
  // Report the smallest unsafe sub-expressions so a finding points at the
  // exact interpolation to escape, not the whole template.
  function collect(n, sink) {
    if (safe(n)) return;
    const parts =
      n.type === 'TemplateLiteral'
        ? n.expressions
        : n.type === 'BinaryExpression' && n.operator === '+'
          ? [n.left, n.right]
          : n.type === 'ConditionalExpression'
            ? [n.consequent, n.alternate]
            : n.type === 'LogicalExpression'
              ? n.operator === '&&'
                ? [n.right]
                : [n.left, n.right]
              : n.type === 'ParenthesizedExpression'
                ? [n.expression]
                : null;
    if (parts) {
      for (const p of parts) collect(p, sink);
      return;
    }
    if (n.type === 'Identifier') {
      const b = refs.get(n);
      if (b && !b.tainted) {
        if (seenReport.has(b)) return; // already expanded at another use
        seenReport.add(b);
        const before = findings.length;
        for (const i of b.inits) if (!isFn(i)) collect(i, sink);
        for (const a of b.assigns) collect(a.right, sink);
        const via = new Set();
        (function writes(x) {
          if (via.has(x)) return;
          via.add(x);
          for (const p of x.pushes) collect(p, sink);
          for (const t of x.flowsInto) writes(t);
        })(b);
        if (findings.length > before) return;
      }
    }
    if (
      (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') &&
      n.callee.type === 'MemberExpression' &&
      ['map', 'flatMap'].includes(n.callee.property?.name) &&
      isFn(n.arguments[0])
    ) {
      const cb = n.arguments[0];
      if (cb.type === 'ArrowFunctionExpression' && cb.body.type !== 'BlockStatement')
        return collect(cb.body, sink);
      for (const r of returnsOf.get(cb) ?? []) collect(r, sink);
      return;
    }
    if (
      (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') &&
      n.callee.type === 'MemberExpression' &&
      n.callee.property?.name === 'join'
    ) {
      return collect(n.callee.object, sink);
    }
    if (n.type === 'CallExpression' && isFn(n.callee)) {
      const f = n.callee;
      if (f.type === 'ArrowFunctionExpression' && f.body.type !== 'BlockStatement')
        return collect(f.body, sink);
      for (const r of returnsOf.get(f) ?? []) collect(r, sink);
      return;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier') {
      const b = refs.get(n.callee);
      // A reassigned helper is reported at the call: its body is unknown.
      if (b && b.fns.length && !b.assigns.length && !seenReport.has(b)) {
        seenReport.add(b);
        for (const f of b.fns) {
          if (f.type === 'ArrowFunctionExpression' && f.body.type !== 'BlockStatement')
            collect(f.body, sink);
          else for (const r of returnsOf.get(f) ?? []) collect(r, sink);
        }
        return;
      }
      if (b && seenReport.has(b)) return;
    }
    findings.push({ line: n.loc.start.line + lineOffset, sink, expr: src(n).slice(0, 140) });
  }
  return findings;
}

/** The first `function name(…) {…}` / `const name = (…) => …` in source
 *  order: the FunctionDeclaration node or the initializer function node. */
function findFunctionNode(ast, name) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n.type !== 'string') return;
    if (n.type === 'FunctionDeclaration' && n.id?.name === name) found = n;
    else if (
      n.type === 'VariableDeclarator' &&
      n.id.type === 'Identifier' &&
      n.id.name === name &&
      isFn(n.init)
    )
      found = n.init;
    for (const [, c] of children(n)) walk(c);
  })(ast.program);
  return found;
}

/** Pull `function name(…) {…}` / `const name = (…) => …` out of the module
 *  script so the test can execute a sanitizer in isolation. It is the same
 *  declaration the audit trusts (findFunctionNode). */
export function extractFunctionSource(html, name) {
  const { code } = moduleScript(html);
  const f = findFunctionNode(parse(code, { sourceType: 'module' }), name);
  if (!f) return null;
  return f.type === 'FunctionDeclaration'
    ? code.slice(f.start, f.end)
    : `const ${name} = ${code.slice(f.start, f.end)};`;
}

/* import.meta.main, not a path compare with argv[1] (deploy-infra#7): Node
   realpaths the module URL but not argv[1], so run through a junction or
   symlink the audit printed nothing and exited 0 — a silent pass. */
if (import.meta.main) {
  const file =
    process.argv[2] ?? new URL('../../../../legacy/prototype/index.html', import.meta.url);
  const findings = auditHtmlSinks(readFileSync(file, 'utf8'));
  for (const f of findings) console.log(`${f.line}  [${f.sink}]  ${f.expr}`);
  console.log(`${findings.length} unsafe value(s) reach an HTML sink`);
  process.exitCode = findings.length ? 1 : 0;
}
