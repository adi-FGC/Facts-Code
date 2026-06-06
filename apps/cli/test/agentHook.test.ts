/**
 * Tests for the freshness-hook installer (ft-1, Layer 2).
 *
 * The pure `ensureFreshnessHook` merge carries the load-bearing logic
 * (idempotency, non-destructive merge, matcher reuse), so most assertions
 * live there — no disk, microseconds. A few fs-level tests cover
 * `installFreshnessHook` against a temp dir to prove the read/merge/write
 * round-trip and the corrupt-file recovery.
 */

import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureFreshnessHook,
  installFreshnessHook,
  FRESHNESS_HOOK_COMMAND,
  FRESHNESS_HOOK_MATCHER,
} from '../src/agentHook.js';

describe('ensureFreshnessHook (pure merge)', () => {
  it('adds a PostToolUse hook to empty settings', () => {
    const { settings, added } = ensureFreshnessHook({});
    expect(added).toBe(true);
    const post = settings.hooks?.PostToolUse;
    expect(post).toHaveLength(1);
    expect(post![0]!.matcher).toBe(FRESHNESS_HOOK_MATCHER);
    expect(post![0]!.hooks).toEqual([
      { type: 'command', command: FRESHNESS_HOOK_COMMAND },
    ]);
  });

  it('is idempotent — a second run adds nothing', () => {
    const first = ensureFreshnessHook({});
    const second = ensureFreshnessHook(first.settings);
    expect(second.added).toBe(false);
    expect(second.settings.hooks!.PostToolUse).toHaveLength(1);
    expect(second.settings.hooks!.PostToolUse![0]!.hooks).toHaveLength(1);
  });

  it('preserves unrelated settings + existing hooks', () => {
    const input = {
      model: 'opus',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
        PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'echo read' }] }],
      },
    };
    const { settings, added } = ensureFreshnessHook(input as never);
    expect(added).toBe(true);
    expect((settings as { model?: string }).model).toBe('opus');
    expect(settings.hooks!.PreToolUse).toEqual(input.hooks.PreToolUse);
    const matchers = settings.hooks!.PostToolUse!.map((e) => e.matcher);
    expect(matchers).toContain('Read');
    expect(matchers).toContain(FRESHNESS_HOOK_MATCHER);
  });

  it('attaches to an existing same-matcher entry instead of duplicating it', () => {
    const input = {
      hooks: {
        PostToolUse: [
          { matcher: FRESHNESS_HOOK_MATCHER, hooks: [{ type: 'command', command: 'echo existing' }] },
        ],
      },
    };
    const { settings, added } = ensureFreshnessHook(input as never);
    expect(added).toBe(true);
    expect(settings.hooks!.PostToolUse).toHaveLength(1); // matcher reused, not duplicated
    expect(settings.hooks!.PostToolUse![0]!.hooks).toHaveLength(2);
    expect(settings.hooks!.PostToolUse![0]!.hooks!.map((h) => h.command)).toEqual([
      'echo existing',
      FRESHNESS_HOOK_COMMAND,
    ]);
  });

  it('does not mutate the input object', () => {
    const input = { hooks: { PostToolUse: [] as unknown[] } };
    const snapshot = JSON.stringify(input);
    ensureFreshnessHook(input as never);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('honors a custom command (configurable for self-hosting repos)', () => {
    const cmd = 'npx tsx apps/cli/src/cli.ts analyze --minimal';
    const { settings, added } = ensureFreshnessHook({}, cmd);
    expect(added).toBe(true);
    expect(settings.hooks!.PostToolUse![0]!.hooks![0]!.command).toBe(cmd);
  });
});

describe('installFreshnessHook (fs round-trip)', () => {
  it('creates .claude/settings.local.json with the hook, idempotently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const r1 = installFreshnessHook(dir);
      expect(r1.added).toBe(true);
      expect(r1.settingsPath.endsWith(join('.claude', 'settings.local.json'))).toBe(true);
      expect(existsSync(r1.settingsPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(r1.settingsPath, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);

      const r2 = installFreshnessHook(dir);
      expect(r2.added).toBe(false); // already present
      const parsed2 = JSON.parse(readFileSync(r2.settingsPath, 'utf8'));
      expect(parsed2.hooks.PostToolUse).toHaveLength(1);
      expect(parsed2.hooks.PostToolUse[0].hooks).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges into a pre-existing settings.local.json without clobbering', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(
        join(dir, '.claude', 'settings.local.json'),
        JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2),
      );
      const r = installFreshnessHook(dir);
      expect(r.added).toBe(true);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      expect(parsed.permissions).toEqual({ allow: ['Bash'] }); // preserved
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers from a corrupt settings.local.json (falls back to {})', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.local.json'), '{ not valid json ');
      const r = installFreshnessHook(dir);
      expect(r.added).toBe(true);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(FRESHNESS_HOOK_COMMAND);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a custom command when given one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'facts-hook-'));
    try {
      const cmd = 'pnpm exec factstack analyze --minimal';
      const r = installFreshnessHook(dir, cmd);
      expect(r.added).toBe(true);
      expect(r.command).toBe(cmd);
      const parsed = JSON.parse(readFileSync(r.settingsPath, 'utf8'));
      expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(cmd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
