import { describe, expect, it } from 'vitest';
import { scanTodos } from '../src/todos.js';

describe('scanTodos', () => {
  it('finds TODO markers', () => {
    const t = scanTodos('// TODO: implement this\nconst x = 1;\n');
    expect(t.length).toBe(1);
    expect(t[0]?.kind).toBe('TODO');
  });

  it('finds FIXME / HACK / XXX markers', () => {
    const t = scanTodos('// FIXME: bug here\n// HACK: workaround\n// XXX: explain this\n');
    expect(t.map((x) => x.kind).sort()).toEqual(['FIXME', 'HACK', 'XXX']);
  });

  it('returns line numbers', () => {
    const t = scanTodos('line one\n// TODO: fix\nline three\n');
    expect(t[0]?.line).toBe(2);
  });

  it('captures the comment text after the marker', () => {
    const t = scanTodos('// TODO: rewrite the auth flow\n');
    expect(t[0]?.text).toContain('rewrite the auth flow');
  });

  it('returns empty for clean code', () => {
    expect(scanTodos('export const x = 1;\n')).toEqual([]);
  });

  it('respects the limit argument', () => {
    const src = Array.from({ length: 60 }, (_, i) => `// TODO: ${i}`).join('\n');
    expect(scanTodos(src, 10).length).toBe(10);
    expect(scanTodos(src, 100).length).toBe(60);
  });

  it('handles empty input', () => {
    expect(scanTodos('')).toEqual([]);
  });
});
