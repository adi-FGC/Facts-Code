/**
 * F11 — whole-stack entity graph builder tests.
 *
 * Exercises buildEntities() across all three modalities (SQL + IaC + docs) and
 * asserts the DoD: a repo with .sql + .tf yields a CONNECTED app+data+infra
 * graph — bridged by doc `documents` edges (doc → code file, doc → table /
 * resource by name mention).
 */

import { describe, expect, it } from 'vitest';
import type { DocFile } from '@factstack/spec';
import {
  buildEntities,
  buildSqlEntities,
  buildIacEntities,
  buildDocEntities,
} from '../src/entities.js';

const SQL = `CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  org_id INT REFERENCES public.orgs(id)
);
CREATE TABLE public.orgs ( id SERIAL PRIMARY KEY, name TEXT );`;

const TF = `resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "app" { vpc_id = aws_vpc.main.id }`;

function makeDoc(over: Pick<DocFile, 'path' | 'name' | 'title'> & Partial<DocFile>): DocFile {
  return {
    path: over.path,
    name: over.name,
    ext: '.md',
    format: 'markdown',
    kind: 'doc',
    bytes: 0,
    loc: 0,
    title: over.title,
    wordCount: 0,
    readingMinutes: 0,
    headings: over.headings ?? [],
    todos: [],
    diagrams: [],
    links: over.links ?? [],
    tableCount: 0,
    content: over.content ?? null,
    truncated: false,
    lastModifiedMs: null,
  };
}

describe('buildSqlEntities', () => {
  it('emits table entities + a foreign-key edge (extracted)', () => {
    const { entities, entityEdges } = buildSqlEntities([{ path: 'db/schema.sql', text: SQL }]);
    expect(entities.map((e) => e.id).sort()).toEqual(['db:public.orgs', 'db:public.users']);
    expect(entityEdges).toContainEqual(
      expect.objectContaining({ from: 'db:public.users', to: 'db:public.orgs', kind: 'fk', confidence: 'extracted' }),
    );
    const users = entities.find((e) => e.id === 'db:public.users')!;
    expect(users.modality).toBe('sql');
    expect(users.detail).toContain('org_id');
  });
});

describe('buildIacEntities', () => {
  it('emits resource entities + a depends-on edge', () => {
    const { entities, entityEdges } = buildIacEntities([{ path: 'infra/main.tf', text: TF }]);
    expect(entities.map((e) => e.id).sort()).toEqual(['tf:aws_subnet.app', 'tf:aws_vpc.main']);
    expect(entityEdges).toContainEqual(
      expect.objectContaining({ from: 'tf:aws_subnet.app', to: 'tf:aws_vpc.main', kind: 'depends-on' }),
    );
  });
});

describe('buildDocEntities', () => {
  const dataInfra = [
    ...buildSqlEntities([{ path: 'db/schema.sql', text: SQL }]).entities,
    ...buildIacEntities([{ path: 'infra/main.tf', text: TF }]).entities,
  ];

  it('links a doc to a code file via a resolvable relative link (extracted)', () => {
    const doc = makeDoc({
      path: 'docs/data-model.md',
      name: 'data-model.md',
      title: 'Data Model',
      links: [{ text: 'the db layer', href: '../src/db.ts', line: 4, external: false }],
    });
    const { entityEdges } = buildDocEntities([doc], ['src/db.ts', 'docs/data-model.md'], dataInfra);
    expect(entityEdges).toContainEqual(
      expect.objectContaining({ from: 'doc:docs/data-model.md', to: 'src/db.ts', kind: 'documents', confidence: 'extracted' }),
    );
  });

  it('links a doc to a table/resource it names in a heading (inferred)', () => {
    const doc = makeDoc({
      path: 'docs/data-model.md',
      name: 'data-model.md',
      title: 'Data Model',
      headings: [{ depth: 2, text: 'The users table and the main vpc', slug: 'x', line: 3 }],
    });
    const { entityEdges } = buildDocEntities([doc], [], dataInfra);
    const docEdges = entityEdges.filter((e) => e.kind === 'documents');
    const targets = docEdges.map((e) => e.to);
    expect(targets).toContain('db:public.users'); // "users" (5 chars) → table
    expect(targets).toContain('tf:aws_vpc.main'); // "main" (4 chars) → resource
    expect(targets).not.toContain('tf:aws_subnet.app'); // "app" (3 chars) excluded
    expect(docEdges.find((e) => e.to === 'db:public.users')!.confidence).toBe('inferred');
  });

  it('does not match short (<4 char) name tokens', () => {
    // resource local name "app" is 3 chars → must be excluded from heading matching.
    const doc = makeDoc({
      path: 'd.md',
      name: 'd.md',
      title: 'd',
      headings: [{ depth: 1, text: 'app', slug: 'app', line: 1 }],
    });
    const { entityEdges } = buildDocEntities([doc], [], dataInfra);
    expect(entityEdges.map((e) => e.to)).not.toContain('tf:aws_subnet.app');
  });

  it('resolves Windows-style backslash links (cross-platform)', () => {
    const doc = makeDoc({
      path: 'docs/data-model.md',
      name: 'data-model.md',
      title: 'Data Model',
      links: [{ text: 'db', href: '..\\src\\db.ts', line: 1, external: false }],
    });
    const { entityEdges } = buildDocEntities([doc], ['src/db.ts'], dataInfra);
    expect(entityEdges).toContainEqual(
      expect.objectContaining({ from: 'doc:docs/data-model.md', to: 'src/db.ts', kind: 'documents' }),
    );
  });

  it('ignores external links', () => {
    const doc = makeDoc({
      path: 'r.md',
      name: 'r.md',
      title: 'r',
      links: [{ text: 'site', href: 'https://example.com/src/db.ts', line: 1, external: true }],
    });
    const { entityEdges } = buildDocEntities([doc], ['src/db.ts'], dataInfra);
    expect(entityEdges).toHaveLength(0);
  });
});

describe('buildEntities (whole-stack, DoD)', () => {
  const doc = makeDoc({
    path: 'docs/architecture.md',
    name: 'architecture.md',
    title: 'Architecture',
    // Mentions a table ("users") AND a resource ("main") → bridges data + infra;
    // the relative link bridges to app code.
    headings: [{ depth: 2, text: 'Users data model and the main network', slug: 'x', line: 5 }],
    links: [{ text: 'db client', href: '../src/db.ts', line: 7, external: false }],
  });
  const result = buildEntities({
    sqlSources: [{ path: 'db/schema.sql', text: SQL }],
    tfSources: [{ path: 'infra/main.tf', text: TF }],
    docs: [doc],
    filePaths: ['src/db.ts', 'db/schema.sql', 'infra/main.tf', 'docs/architecture.md'],
  });

  it('produces entities across all three modalities', () => {
    const mods = new Set(result.entities.map((e) => e.modality));
    expect(mods).toEqual(new Set(['sql', 'iac', 'doc']));
  });

  it('yields a CONNECTED app+data+infra graph via the doc bridge', () => {
    // Build an undirected adjacency over entity ids + file ids, then assert the
    // doc node reaches a code file AND a data entity AND (transitively) infra.
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string) => {
      (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
      (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
    };
    for (const e of result.entityEdges) link(e.from, e.to);

    const docId = 'doc:docs/architecture.md';
    // BFS from the doc node.
    const seen = new Set<string>([docId]);
    const queue = [docId];
    while (queue.length) {
      const n = queue.shift()!;
      for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); queue.push(m); }
    }
    // One connected component spanning all three modalities, reached from the doc:
    expect(seen.has('src/db.ts')).toBe(true); // app code (via link)
    expect(seen.has('db:public.users')).toBe(true); // data (via "users" mention)
    expect(seen.has('db:public.orgs')).toBe(true); // data (via fk from users)
    expect(seen.has('tf:aws_vpc.main')).toBe(true); // infra (via "main" mention)
    expect(seen.has('tf:aws_subnet.app')).toBe(true); // infra (via depends-on from main)
  });

  it('is deterministic (sorted, deduped)', () => {
    const again = buildEntities({
      sqlSources: [{ path: 'db/schema.sql', text: SQL }],
      tfSources: [{ path: 'infra/main.tf', text: TF }],
      docs: [doc],
      filePaths: ['src/db.ts', 'db/schema.sql', 'infra/main.tf', 'docs/architecture.md'],
    });
    expect(again).toEqual(result);
    // entities sorted by id.
    const ids = result.entities.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });
});
