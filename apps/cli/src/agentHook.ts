/**
 * Freshness-hook installer (ft-1, Layer 2).
 *
 * "Set up FACTS for agents" installs a Claude Code `PostToolUse` hook that
 * re-runs `factstack analyze --minimal` after every Edit/Write, so
 * `.facts/agent.pack` + MEMORY.md track the agent's changes. That's the
 * (A) half of the skill contract the renderers teach ("keep the pack
 * fresh") — automated instead of relying on the agent's goodwill.
 *
 * Lands in `.claude/settings.local.json` (personal, gitignored) rather than
 * the shared `settings.json`: it's a per-developer "set up my environment"
 * action, and a committed hook that shells out to a tool a teammate may not
 * have installed is a footgun. The merge is non-destructive and idempotent.
 *
 * Split into a pure merge (`ensureFreshnessHook`) + a thin fs wrapper
 * (`installFreshnessHook`) so the merge logic is unit-testable without
 * touching disk — mirrors @factstack/skills' FileWriter seam.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** The command the hook runs. `npx` resolves a local dep or a global
 *  install, so this works whether the consumer project has factstack as a
 *  devDependency or installed globally. `--minimal` writes just
 *  agent.pack + human.json + MEMORY.md — the fast path for a hot edit loop. */
export const FRESHNESS_HOOK_COMMAND = 'npx factstack analyze --minimal';

/** Fires after the agent's file-mutating tools. The harness exposes these
 *  as `Edit` and `Write`; the pipe is Claude Code's matcher-or syntax. */
export const FRESHNESS_HOOK_MATCHER = 'Edit|Write';

interface CommandHook {
  type: 'command';
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: CommandHook[];
}
export interface ClaudeSettings {
  hooks?: { PostToolUse?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Pure, non-destructive merge: ensure `settings` carries a PostToolUse
 * entry that runs the freshness command. Returns a NEW settings object
 * (the input is never mutated) plus whether anything changed — `added`
 * is `false` on an idempotent re-run, so callers can skip the disk write.
 *
 * Every existing key and hook is preserved; only the missing piece is
 * appended. If an entry with the same matcher already exists, the command
 * is added to it rather than duplicating the matcher.
 */
export function ensureFreshnessHook(
  settings: ClaudeSettings,
  command: string = FRESHNESS_HOOK_COMMAND,
  matcher: string = FRESHNESS_HOOK_MATCHER,
): { settings: ClaudeSettings; added: boolean } {
  // Shallow-clone the touched path so the caller's object graph is untouched.
  const next: ClaudeSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const existing = next.hooks!.PostToolUse;
  const post: HookEntry[] = Array.isArray(existing)
    ? existing.map((e) => ({
        ...e,
        hooks: Array.isArray(e.hooks) ? [...e.hooks] : e.hooks,
      }))
    : [];

  // Already present anywhere in PostToolUse? → no-op (idempotent).
  const present = post.some(
    (e) =>
      Array.isArray(e.hooks) &&
      e.hooks.some((h) => h && h.type === 'command' && h.command === command),
  );
  if (present) {
    next.hooks!.PostToolUse = post;
    return { settings: next, added: false };
  }

  // Prefer attaching to an existing same-matcher entry; else add a new one.
  const sameMatcher = post.find((e) => e.matcher === matcher);
  if (sameMatcher) {
    sameMatcher.hooks = [...(sameMatcher.hooks ?? []), { type: 'command', command }];
  } else {
    post.push({ matcher, hooks: [{ type: 'command', command }] });
  }
  next.hooks!.PostToolUse = post;
  return { settings: next, added: true };
}

export interface InstallHookResult {
  /** Absolute path to the settings file that was (or would be) written. */
  settingsPath: string;
  /** True when the hook was newly added; false when it was already present. */
  added: boolean;
  /** The command the hook runs (echoed for the caller's confirmation UI). */
  command: string;
}

/**
 * Side-effecting install: read `.claude/settings.local.json` under `root`
 * (or start from `{}`), ensure the freshness hook, and write it back
 * pretty-printed. Creates `.claude/` if missing.
 *
 * Never throws on a missing or hand-corrupted settings file — a malformed
 * JSON falls back to `{}` so "Set up agents" can't be bricked by an
 * unrelated edit to the settings file. (It does NOT silently swallow write
 * errors — a failed write should surface to the caller.)
 */
export function installFreshnessHook(
  root: string,
  command: string = FRESHNESS_HOOK_COMMAND,
): InstallHookResult {
  const settingsPath = join(root, '.claude', 'settings.local.json');

  let current: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as ClaudeSettings;
      }
    } catch {
      // Corrupt/hand-edited file — start fresh rather than fail setup.
      current = {};
    }
  }

  const { settings, added } = ensureFreshnessHook(current, command);
  if (added) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return { settingsPath, added, command };
}
