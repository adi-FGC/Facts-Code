/**
 * Test helpers for running CLI commands in-process (tech-debt#6): a CliIO
 * that captures stdout/stderr and turns `io.exit(code)` into a thrown
 * CliExit, plus the throw-away fixture project the command tests share.
 * Not a test file itself (vitest collects *.test.ts only).
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CliIO } from '../src/io.js';

/** What `io.exit(code)` throws in-process — the binary would have exited. */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface CliRun {
  /** The exit code: io.exit's, else io.setExitCode's, else 0. */
  code: number;
  stdout: string;
  stderr: string;
}

/** Run one command against a capturing CliIO. */
export async function runCli(fn: (io: CliIO) => unknown): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  const io: CliIO = {
    stdout: {
      write: (s: string) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s: string) => {
        stderr += s;
      },
    },
    exit: (code: number): never => {
      throw new CliExit(code);
    },
    setExitCode: (code: number) => {
      exitCode = code;
    },
  };
  try {
    await fn(io);
    return { code: exitCode ?? 0, stdout, stderr };
  } catch (err) {
    if (err instanceof CliExit) return { code: err.code, stdout, stderr };
    throw err;
  }
}

/** Text without ANSI colour codes (kleur may be on in the test runner). */
export function plain(s: string): string {
  return stripVTControlCharacters(s);
}

/** src/a.ts ⇄ src/c.ts (an import cycle) and src/b.ts → src/a.ts, plus a
 *  package.json declaring lodash — the same shape as cli-e2e's fixture. */
export function fixtureProject(prefix = 'facts-cli-cmd-'): string {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.0' } }),
  );
  writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    "import { c } from './c';\nexport const a = () => c();\n",
  );
  writeFileSync(
    path.join(dir, 'src', 'c.ts'),
    "import { a } from './a';\nexport const c = () => 1;\nexport const loop = () => a();\n",
  );
  writeFileSync(path.join(dir, 'src', 'b.ts'), "import { a } from './a';\nexport default a;\n");
  return dir;
}

/** Keep git, transcripts and remote telemetry out of in-process runs:
 *  git must not discover a repository above the temp dir, the Worktrees
 *  collector must not read session transcripts, nothing is sent anywhere.
 *  Returns the restore function. */
export function hermeticEnv(): () => void {
  const keys = [
    'GIT_CEILING_DIRECTORIES',
    'FACTSTACK_AGENT_REQUESTS',
    'FACTSTACK_TELEMETRY_URL',
    'FACTSTACK_HOOK_COMMAND',
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env.GIT_CEILING_DIRECTORIES = realpathSync.native(tmpdir());
  delete process.env.FACTSTACK_AGENT_REQUESTS;
  process.env.FACTSTACK_TELEMETRY_URL = '';
  process.env.FACTSTACK_HOOK_COMMAND = '';
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
