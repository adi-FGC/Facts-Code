/**
 * Path-containment guard (SEC). The MCP server's live-read fallbacks
 * (get_outline, count_tokens) feed an untrusted `path` argument through
 * resolveInRoot — it must reject anything that escapes the project root.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { resolveInRoot } from '../src/paths.js';

const root = path.resolve('/projects/app');

describe('resolveInRoot — path traversal containment (SEC)', () => {
  it('resolves a normal project-relative path inside root', () => {
    expect(resolveInRoot(root, 'src/index.ts')).toBe(path.join(root, 'src/index.ts'));
  });

  it('allows root itself', () => {
    expect(resolveInRoot(root, '.')).toBe(root);
  });

  it('rejects a classic ../../ traversal escape', () => {
    expect(() => resolveInRoot(root, '../../etc/passwd')).toThrow(/outside project root/);
  });

  it('rejects an absolute path outside root', () => {
    expect(() => resolveInRoot(root, '/etc/passwd')).toThrow(/outside project root/);
  });

  it('rejects a sibling-directory prefix attack (root-foo vs root)', () => {
    // `..` then into a sibling whose name starts with the root's basename must
    // not slip past a naive startsWith(root) check — the guard uses root + sep.
    expect(() => resolveInRoot(root, '../app-evil/secret')).toThrow(/outside project root/);
  });

  it('keeps a deep but in-root path', () => {
    expect(resolveInRoot(root, 'a/b/c/d.ts')).toBe(path.join(root, 'a/b/c/d.ts'));
  });
});
