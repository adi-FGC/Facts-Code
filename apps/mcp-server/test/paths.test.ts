/**
 * Path-containment guard (SEC). The MCP server's live-read fallbacks
 * (get_outline, count_tokens) feed an untrusted `path` argument through
 * resolveInRoot — it must reject anything that escapes the project root.
 */

import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveInRoot } from '../src/paths.js';

const root = path.resolve('/projects/app');
const onWindows = process.platform === 'win32';

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

describe('resolveInRoot — cross-platform containment (XP-1)', () => {
  // The old lexical `startsWith(root + sep)` check rejected an in-root path
  // whose drive letter differed only in CASE (NTFS is case-insensitive). The
  // path.relative-based check accepts it. Windows-only — the bug is Windows-only.
  it.runIf(onWindows)('accepts an in-root path whose drive-letter case differs from root', () => {
    const upperRoot = 'C:\\projects\\app';
    const lowerAbs = 'c:\\projects\\app\\src\\index.ts';
    // Old guard: 'c:\\...'.startsWith('C:\\projects\\app\\') === false -> threw.
    const out = resolveInRoot(upperRoot, lowerAbs);
    expect(path.relative(upperRoot, out)).toBe(path.join('src', 'index.ts'));
  });

  it.runIf(onWindows)('handles a UNC root without false-rejecting its own files', () => {
    const uncRoot = '\\\\server\\share\\proj';
    expect(() => resolveInRoot(uncRoot, 'src\\x.ts')).not.toThrow();
    expect(path.relative(uncRoot, resolveInRoot(uncRoot, 'src\\x.ts'))).toBe(path.join('src', 'x.ts'));
  });

  it.runIf(onWindows)('still rejects a drive-absolute escape on Windows', () => {
    expect(() => resolveInRoot('C:\\projects\\app', 'C:\\Windows\\System32\\config')).toThrow(/outside project root/);
  });
});

describe('resolveInRoot — symlink escape (SEC-2)', () => {
  // Reject a leaf symlink outright so an in-root symlink (e.g. peek -> /etc/passwd)
  // can't read outside via get_outline/count_tokens. Skips when the platform
  // forbids unprivileged symlink creation (Windows without developer mode).
  it('rejects an in-root leaf symlink, but resolves the real sibling file', () => {
    // realpath the tmp root so the realpath recheck compares real-vs-real
    // (macOS /var is itself a symlink).
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'factstack-paths-')));
    try {
      const target = path.join(dir, 'real.ts');
      writeFileSync(target, 'export const x = 1;\n');
      const link = path.join(dir, 'link.ts');
      try {
        symlinkSync(target, link);
      } catch {
        return; // no symlink privilege (e.g. Windows non-admin) — skip
      }
      expect(() => resolveInRoot(dir, 'link.ts')).toThrow(/outside project root/);
      // control: the real file resolves cleanly
      expect(resolveInRoot(dir, 'real.ts')).toBe(realpathSync(target));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
