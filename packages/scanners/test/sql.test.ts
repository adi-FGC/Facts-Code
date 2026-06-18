/**
 * Tests for the F11 SQL DDL parser (ANSI subset): tables, columns, foreign
 * keys (inline + table-level), views with FROM/JOIN references, comment
 * stripping, quoted/schema-qualified identifiers, and line accuracy.
 */

import { describe, expect, it } from 'vitest';
import { parseSql } from '../src/sql.js';

const SCHEMA = `-- users table
CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  org_id INT REFERENCES public.orgs(id)
);

CREATE TABLE IF NOT EXISTS public.orgs (
  id SERIAL PRIMARY KEY,
  name TEXT
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users (id)
);

/* a reporting view */
CREATE VIEW reporting.active_orders AS
  SELECT o.id, u.email FROM orders o JOIN public.users u ON o.user_id = u.id;
`;

describe('parseSql', () => {
  const { tables, views } = parseSql(SCHEMA);

  it('finds all tables', () => {
    expect(tables.map((t) => t.qualified).sort()).toEqual(['orders', 'public.orgs', 'public.users']);
  });

  it('captures columns with types', () => {
    const users = tables.find((t) => t.name === 'users')!;
    expect(users.columns.map((c) => c.name)).toEqual(['id', 'email', 'org_id']);
    expect(users.columns.find((c) => c.name === 'email')!.type).toBe('VARCHAR(255)');
  });

  it('captures inline REFERENCES foreign keys', () => {
    const users = tables.find((t) => t.name === 'users')!;
    expect(users.foreignKeys).toHaveLength(1);
    expect(users.foreignKeys[0]).toMatchObject({
      fromColumns: ['org_id'],
      toTable: 'public.orgs',
      toColumns: ['id'],
    });
  });

  it('captures table-level FOREIGN KEY (incl. named CONSTRAINT)', () => {
    const orders = tables.find((t) => t.name === 'orders')!;
    expect(orders.foreignKeys).toHaveLength(1);
    expect(orders.foreignKeys[0]).toMatchObject({
      fromColumns: ['user_id'],
      toTable: 'public.users',
    });
    // The CONSTRAINT segment is not mistaken for a column.
    expect(orders.columns.map((c) => c.name)).toEqual(['id', 'user_id']);
  });

  it('parses views + their FROM/JOIN references', () => {
    expect(views).toHaveLength(1);
    expect(views[0]!.qualified).toBe('reporting.active_orders');
    expect(views[0]!.referencedTables.sort()).toEqual(['orders', 'public.users']);
  });

  it('reports accurate 1-indexed line numbers', () => {
    expect(tables.find((t) => t.name === 'users')!.line).toBe(2);
    expect(views[0]!.line).toBe(20);
  });

  it('strips comments (a commented FK is not parsed)', () => {
    const sql = `CREATE TABLE a (
      id INT
      -- , other_id INT REFERENCES b(id)
    );`;
    const r = parseSql(sql);
    expect(r.tables[0]!.foreignKeys).toHaveLength(0);
    expect(r.tables[0]!.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('handles quoted + bracketed identifiers and bare (no schema) names', () => {
    const r = parseSql('CREATE TABLE "My Table" ( "a b" INT, c INT REFERENCES [Other] (id) );');
    expect(r.tables[0]!.name).toBe('My Table');
    expect(r.tables[0]!.schema).toBeNull();
    expect(r.tables[0]!.columns[0]!.name).toBe('a b');
    expect(r.tables[0]!.foreignKeys[0]!.toTable).toBe('Other');
  });

  it('returns empty result for non-DDL input', () => {
    const r = parseSql('SELECT 1; UPDATE x SET y = 2;');
    expect(r.tables).toEqual([]);
    expect(r.views).toEqual([]);
  });

  it('is deterministic', () => {
    expect(parseSql(SCHEMA)).toEqual(parseSql(SCHEMA));
  });
});

describe('parseSql — string-literal & comment robustness (adversarial-verify regressions)', () => {
  it('does not fabricate a foreign key from REFERENCES inside a string literal', () => {
    const r = parseSql(
      `CREATE TABLE test (col1 INT REFERENCES users(id), col2 VARCHAR(255) DEFAULT 'This REFERENCES malicious(id)');`,
    );
    expect(r.tables[0]!.foreignKeys.map((f) => f.toTable)).toEqual(['users']);
  });

  it('treats an unterminated block comment as commenting to EOF', () => {
    const r = parseSql('CREATE TABLE test (id INT); /* unclosed\nCREATE TABLE hidden (id INT);');
    expect(r.tables.map((t) => t.name)).toEqual(['test']);
  });

  it('does not drop a table when a string default contains an unbalanced paren', () => {
    const r = parseSql("CREATE TABLE t (note TEXT DEFAULT '(');");
    expect(r.tables.map((t) => t.name)).toEqual(['t']);
    expect(r.tables[0]!.columns.map((c) => c.name)).toEqual(['note']);
  });

  it('does not split a column on a comma inside a string default', () => {
    const r = parseSql("CREATE TABLE t (a INT, label TEXT DEFAULT 'a, b', c INT);");
    expect(r.tables[0]!.columns.map((c) => c.name)).toEqual(['a', 'label', 'c']);
  });
});
