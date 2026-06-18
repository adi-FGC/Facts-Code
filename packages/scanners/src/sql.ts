/**
 * F11 — SQL DDL parser (whole-stack modalities, data layer).
 *
 * A PURE, deterministic, regex-based parser for an ANSI-SQL DDL subset:
 * `CREATE TABLE` (columns + inline/table-level `FOREIGN KEY … REFERENCES`) and
 * `CREATE VIEW … AS … FROM/JOIN`. It is intentionally NOT a full SQL grammar —
 * dialect-specific clauses (partitioning, T-SQL specifics, etc.) are ignored,
 * not errored. Anything it can't classify is simply dropped (degrade to fewer
 * facts, never crash) — matching the spec's "start with ANSI subset" guidance.
 *
 * Isomorphic (constraint C1): no node:* imports, pure text manipulation.
 * Deterministic (INV2): single forward pass, source-order output, no maps with
 * unstable iteration. Line numbers are 1-indexed.
 */

/** A column in a CREATE TABLE. `type` is the declared type token (e.g.
 *  `VARCHAR(255)`, `INT`, `NUMERIC(10,2)`) — best-effort, for display. */
export interface SqlColumn {
  name: string;
  type: string;
}

/** A foreign-key relationship discovered in a table (inline `REFERENCES` on a
 *  column, or a table-level `FOREIGN KEY (...) REFERENCES ...`). */
export interface SqlForeignKey {
  fromColumns: string[];
  /** Target table as written (bare or `schema.table`); resolved by the caller. */
  toTable: string;
  toColumns: string[];
  line: number;
}

export interface SqlTable {
  schema: string | null;
  name: string;
  /** `schema.name` when schema-qualified, else `name`. */
  qualified: string;
  columns: SqlColumn[];
  foreignKeys: SqlForeignKey[];
  line: number;
}

export interface SqlView {
  schema: string | null;
  name: string;
  qualified: string;
  /** Tables named in FROM/JOIN of the view's SELECT (bare or qualified). */
  referencedTables: string[];
  line: number;
}

export interface ParsedSql {
  tables: SqlTable[];
  views: SqlView[];
}

/** An identifier: double-quoted, backtick-quoted, [bracketed], or bare. */
const IDENT = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';

/**
 * Blank out comments + single-quoted string literals, replacing their interiors
 * with spaces (newlines preserved) so line numbers + character offsets stay
 * exact. Double-quoted / backtick / bracket *identifiers* are preserved verbatim
 * — they carry table/column names the parser needs. This single string-aware
 * pass is what makes the downstream regex/paren scanning robust: a `'… (, --,
 * /* …'` inside a string can no longer fabricate a foreign key, split a column,
 * or unbalance `matchParen`. An unterminated block comment / string is consumed
 * to EOF (matching real SQL semantics).
 */
function sanitizeSql(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    // -- line comment
    if (c === '-' && c2 === '-') {
      while (i < n && sql[i] !== '\n') {
        out.push(' ');
        i++;
      }
      continue;
    }
    // /* block comment */ (to EOF if unterminated)
    if (c === '/' && c2 === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out.push(sql[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    // '…' string literal → blank interior (`''` is an escaped quote)
    if (c === "'") {
      out.push(' ');
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out.push(' ', ' ');
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out.push(' ');
          i++;
          break;
        }
        out.push(sql[i] === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    // Quoted identifiers — preserve verbatim (carry names). Skip to close/EOL.
    if (c === '"' || c === '`' || c === '[') {
      const close = c === '"' ? '"' : c === '`' ? '`' : ']';
      out.push(c);
      i++;
      while (i < n && sql[i] !== close && sql[i] !== '\n') {
        out.push(sql[i]!);
        i++;
      }
      if (i < n && sql[i] === close) {
        out.push(close);
        i++;
      }
      continue;
    }
    out.push(c!);
    i++;
  }
  return out.join('');
}

/** Remove surrounding quotes/brackets from an identifier. */
function unquote(id: string): string {
  const t = id.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === '`' && b === '`')) return t.slice(1, -1);
    if (a === '[' && b === ']') return t.slice(1, -1);
  }
  return t;
}

/** 1-indexed line number of a character offset. */
function lineAt(text: string, index: number): number {
  let line = 1;
  const cap = Math.min(index, text.length);
  for (let i = 0; i < cap; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Index of the `)` matching the `(` at `openIdx`, or -1 if unbalanced. */
function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a parenthesized body by top-level commas, tracking each segment's
 *  absolute offset in `source` (for line numbers). */
function splitTopLevel(body: string, baseIndex: number): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ text: body.slice(start, i), index: baseIndex + start });
      start = i + 1;
    }
  }
  out.push({ text: body.slice(start), index: baseIndex + start });
  return out;
}

/** Build `schema.name` (qualified) from optional schema + name idents. */
function qualify(schema: string | null, name: string): string {
  return schema ? `${schema}.${name}` : name;
}

const REF_RE = new RegExp(`REFERENCES\\s+(${IDENT})(?:\\.(${IDENT}))?\\s*(?:\\(([^)]*)\\))?`, 'i');
const FK_RE = new RegExp(
  `FOREIGN\\s+KEY\\s*\\(([^)]*)\\)\\s*REFERENCES\\s+(${IDENT})(?:\\.(${IDENT}))?\\s*(?:\\(([^)]*)\\))?`,
  'i',
);
const COL_RE = new RegExp(`^(${IDENT})\\s+([A-Za-z0-9_]+(?:\\s*\\([^)]*\\))?)`);

/** Parse a comma-separated id list (`a, "b", [c]`) into bare names. */
function parseIdentList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

function resolveTarget(schema: string | undefined, name: string): string {
  return qualify(schema ? unquote(schema) : null, unquote(name));
}

/** Parse one CREATE TABLE body into columns + foreign keys. */
function parseTableBody(source: string, body: string, baseIndex: number): {
  columns: SqlColumn[];
  foreignKeys: SqlForeignKey[];
} {
  const columns: SqlColumn[] = [];
  const foreignKeys: SqlForeignKey[] = [];

  for (const seg of splitTopLevel(body, baseIndex)) {
    const trimmed = seg.text.trim();
    if (!trimmed) continue;
    const leadOffset = seg.text.length - seg.text.trimStart().length;
    const line = lineAt(source, seg.index + leadOffset);

    // Table-level (or named CONSTRAINT … ) FOREIGN KEY.
    if (/\bFOREIGN\s+KEY\b/i.test(trimmed)) {
      const m = FK_RE.exec(trimmed);
      if (m) {
        foreignKeys.push({
          fromColumns: parseIdentList(m[1] ?? ''),
          toTable: resolveTarget(m[3] ? m[2] : undefined, m[3] ?? m[2] ?? ''),
          toColumns: parseIdentList(m[4] ?? ''),
          line,
        });
      }
      continue;
    }

    // Other table-level constraints — not columns; skip.
    if (/^\s*(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT|KEY|INDEX|EXCLUDE|LIKE)\b/i.test(trimmed)) {
      continue;
    }

    // Column definition: `name TYPE …`.
    const cm = COL_RE.exec(trimmed);
    if (!cm) continue;
    const colName = unquote(cm[1] ?? '');
    columns.push({ name: colName, type: (cm[2] ?? '').replace(/\s+/g, ' ').trim() });

    // Inline `… REFERENCES other(col)` on this column.
    const rm = REF_RE.exec(trimmed);
    if (rm) {
      foreignKeys.push({
        fromColumns: [colName],
        toTable: resolveTarget(rm[2] ? rm[1] : undefined, rm[2] ?? rm[1] ?? ''),
        toColumns: parseIdentList(rm[3] ?? ''),
        line,
      });
    }
  }

  return { columns, foreignKeys };
}

const TABLE_RE = new RegExp(
  `CREATE\\s+(?:GLOBAL\\s+|LOCAL\\s+|TEMP\\s+|TEMPORARY\\s+|UNLOGGED\\s+)*TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})(?:\\.(${IDENT}))?\\s*\\(`,
  'gi',
);
const VIEW_RE = new RegExp(
  `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})(?:\\.(${IDENT}))?\\s+AS\\b`,
  'gi',
);
const FROM_JOIN_RE = new RegExp(`\\b(?:FROM|JOIN)\\s+(${IDENT})(?:\\.(${IDENT}))?`, 'gi');

/**
 * Parse a `.sql` source into tables + views (with foreign-key + view-reference
 * relationships). Always returns a (possibly empty) result; never throws.
 */
export function parseSql(source: string): ParsedSql {
  const sql = sanitizeSql(source);
  const tables: SqlTable[] = [];
  const views: SqlView[] = [];

  // ── Tables ──
  TABLE_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TABLE_RE.exec(sql)) !== null) {
    const schema = tm[2] ? unquote(tm[1] ?? '') : null;
    const name = unquote(tm[2] ?? tm[1] ?? '');
    if (!name) continue;
    const openIdx = sql.indexOf('(', tm.index + tm[0].length - 1);
    if (openIdx < 0) continue;
    const closeIdx = matchParen(sql, openIdx);
    if (closeIdx < 0) continue;
    const body = sql.slice(openIdx + 1, closeIdx);
    const { columns, foreignKeys } = parseTableBody(sql, body, openIdx + 1);
    tables.push({
      schema,
      name,
      qualified: qualify(schema, name),
      columns,
      foreignKeys,
      line: lineAt(sql, tm.index),
    });
  }

  // ── Views ──
  VIEW_RE.lastIndex = 0;
  let vm: RegExpExecArray | null;
  while ((vm = VIEW_RE.exec(sql)) !== null) {
    const schema = vm[2] ? unquote(vm[1] ?? '') : null;
    const name = unquote(vm[2] ?? vm[1] ?? '');
    if (!name) continue;
    const bodyStart = vm.index + vm[0].length;
    const semi = sql.indexOf(';', bodyStart);
    const body = sql.slice(bodyStart, semi < 0 ? undefined : semi);

    const referenced: string[] = [];
    const seen = new Set<string>();
    FROM_JOIN_RE.lastIndex = 0;
    let fm: RegExpExecArray | null;
    while ((fm = FROM_JOIN_RE.exec(body)) !== null) {
      const target = resolveTarget(fm[2] ? fm[1] : undefined, fm[2] ?? fm[1] ?? '');
      if (target && !seen.has(target)) {
        seen.add(target);
        referenced.push(target);
      }
    }
    views.push({
      schema,
      name,
      qualified: qualify(schema, name),
      referencedTables: referenced,
      line: lineAt(sql, vm.index),
    });
  }

  return { tables, views };
}
