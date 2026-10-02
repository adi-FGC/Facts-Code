/**
 * Hardening shared by every git spawn that reads a repository — mineGitStats
 * (git.ts) and mineGitTopology (topology.ts).
 *
 * We run git INSIDE checkouts we did not create: an analyzed archive keeps its
 * .git/config and .git/info/attributes, and topology probes nested repos and
 * junction targets. Several config keys are shell commands git runs on its
 * own, so a hostile repo would get code execution from a read-only analyze:
 *
 *   - core.fsmonitor            anything that reads the index (`git status`)
 *   - filter.<driver>.clean /   `git status` pipes each stat-dirty file through
 *     .process                  its clean filter to compare it with the index
 *   - core.hooksPath            post-index-change, should the index be written
 *   - gpg.program               `git log` when log.showSignature=true
 *   - remote.*.uploadpack,      a partial clone lazily fetching a missing
 *     core.sshCommand, …        object (also a network call — INV6)
 *
 * `-c` beats every config level, so SAFE_GIT_ARGS pins the fixed keys, and
 * filterOverrides() disarms whichever filter drivers the repo defines.
 * Global/system config is deliberately NOT dropped: `safe.directory` lives
 * there and dropping it would break legitimate scans.
 *
 * INHERITED GIT ENV: when analyze runs from a git hook, GIT_DIR /
 * GIT_INDEX_FILE / GIT_WORK_TREE point at the hook's repo and would hijack
 * every call we make for OTHER roots. gitEnv() strips them.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import os from 'node:os';

export const SAFE_GIT_ARGS: readonly string[] = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${os.devNull}`,
  '-c',
  'log.showSignature=false',
];

/** A status/probe spawn that outlives this is abandoned (its result unused). */
export const GIT_TIMEOUT_MS = 30_000;

/** Deliberately tighter bound for topology's many small ref reads (rev-parse,
 *  for-each-ref, rev-list --count, worktree list …), dozens per scan across
 *  nested repos: one stuck call must not hold the scan for GIT_TIMEOUT_MS. */
export const GIT_PLUMBING_TIMEOUT_MS = 20_000;

const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_INDEX_VERSION',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_NAMESPACE',
  'GIT_GRAFT_FILE',
];

export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Never fetch a partial clone's missing objects (git >= 2.44; older git
    // ignores it). Fetching runs the remote's transport commands from config.
    GIT_NO_LAZY_FETCH: '1',
  };
  for (const k of INHERITED_GIT_ENV) delete env[k];
  return env;
}

/**
 * `-c` overrides that disarm every filter driver `cwd`'s config defines (at
 * any level, includes followed): an empty clean/process command is skipped,
 * and required=false stops a skipped driver from failing the command.
 * Pass them to any git command that reads worktree content (`git status`).
 * Disarmed, a filtered file is compared raw; at worst a stat-dirty file that
 * a real filter (git-lfs) would have called clean reads as modified.
 *
 * Returns null when the drivers cannot be read or cannot be overridden (`-c`
 * splits at the first '=', so a driver named `a=b` is out of reach): the
 * caller must then skip its content-reading command.
 */
export function filterOverrides(cwd: string): string[] | null {
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync('git', [...SAFE_GIT_ARGS, 'config', '--null', '--get-regexp', '^filter\\.'], {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (r.error) return null;
  if (r.status === 1) return []; // no filter.* key at all
  if (r.status !== 0) return null;
  const names = new Set<string>();
  // `--null`: `<key>\n<value>\0` per entry (just `<key>\0` for a bare key).
  for (const entry of r.stdout.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (m) names.add(m[1]!);
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.includes('=')) return null;
    out.push(
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.process=`,
      '-c',
      `filter.${name}.required=false`,
    );
  }
  return out;
}
