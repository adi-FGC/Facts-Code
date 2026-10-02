/**
 * cli-rev-2: a held refresh (a later `ui --watch` save, export, quick) writes
 * with emit's `rotateBaseline: false`, so emit refuses it with a
 * StaleResaveError when agent.pack already holds an analysis that finished
 * AFTER this one — the per-edit `analyze --minimal` hook landed between this
 * analysis and its write. That is a fresh analysis, not a stale re-save: the
 * pipeline re-analyzes once instead of failing with "not re-saving … run
 * `factstack analyze`". Own file: it wraps emit's writeArtifacts to land the
 * hook's newer pack at exactly that moment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { writeArtifacts } from '@factstack/emit';
import type { CliIO } from '../src/io.js';
import { analyzeAndWrite, analyzeProject } from '../src/pipeline.js';
import { fixtureProject, hermeticEnv } from './cli-io.js';

type WriteOpts = Parameters<typeof writeArtifacts>[0];

const hook = vi.hoisted(() => ({
  /** Runs just before each writeArtifacts call; `calls` counts them. */
  before: vi.fn(),
  calls: 0,
}));

vi.mock('@factstack/emit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@factstack/emit')>();
  return {
    ...real,
    writeArtifacts: (opts: WriteOpts) => {
      hook.calls++;
      hook.before(opts);
      return real.writeArtifacts(opts);
    },
  };
});

const temps: string[] = [];
let restoreEnv: () => void = () => {};
beforeAll(() => {
  restoreEnv = hermeticEnv();
});
afterEach(() => {
  hook.before.mockReset();
  hook.calls = 0;
});
afterAll(() => {
  restoreEnv();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const T = 60_000;
/** Swallows the dim "no agent.diff.pack" line the stamped pack causes. */
const quiet: CliIO = {
  stdout: { write: () => true },
  stderr: { write: () => true },
  exit: (code) => {
    throw new Error(`exit ${code}`);
  },
  setExitCode: () => {},
};

/** Analyzed once, then refreshed once: the next refresh is a held one. */
async function heldProject(): Promise<string> {
  const root = fixtureProject('facts-pipeline-race-');
  temps.push(root);
  await analyzeProject(root, { cache: false });
  await analyzeAndWrite(root);
  hook.calls = 0;
  return root;
}

/** What the hook's run leaves: agent.pack stamped 1 ms after `at` (header
 *  field 8, `generated`). */
function landNewerPack(root: string, at: string): string {
  const p = path.join(root, '.facts', 'agent.pack');
  const body = readFileSync(p, 'utf8');
  const nl = body.indexOf('\n');
  const header = body.slice(0, nl).split('\t');
  expect(header[0]!.startsWith('#')).toBe(true);
  const newer = new Date(Date.parse(at) + 1).toISOString();
  header[7] = newer;
  writeFileSync(p, header.join('\t') + body.slice(nl));
  return newer;
}

describe('a held refresh racing the per-edit hook (cli-rev-2)', () => {
  it(
    're-analyzes once and writes the newer analysis — no StaleResaveError',
    async () => {
      const root = await heldProject();
      let hookAt = '';
      hook.before.mockImplementation((opts: WriteOpts) => {
        if (hook.calls === 1) hookAt = landNewerPack(opts.root, opts.agent.generatedAt);
      });
      const saved = await analyzeAndWrite(root, {}, quiet);
      expect(hook.calls).toBe(2);
      expect(Date.parse(saved.agent.generatedAt)).toBeGreaterThan(Date.parse(hookAt));
      const onDisk = JSON.parse(readFileSync(path.join(root, '.facts', 'agent.json'), 'utf8'));
      expect(onDisk.generatedAt).toBe(saved.agent.generatedAt);
    },
    T,
  );

  it(
    'a pack that is still newer after the retry: a plain error, nothing written',
    async () => {
      const root = await heldProject();
      const agentJson = path.join(root, '.facts', 'agent.json');
      const before = readFileSync(agentJson, 'utf8');
      hook.before.mockImplementation((opts: WriteOpts) => {
        landNewerPack(opts.root, opts.agent.generatedAt);
      });
      await expect(analyzeAndWrite(root, {}, quiet)).rejects.toThrow(
        /^not writing this analysis .*agent\.pack holds a newer one .*Nothing was written; run it again\.$/,
      );
      expect(hook.calls).toBe(2);
      expect(readFileSync(agentJson, 'utf8')).toBe(before);
    },
    T,
  );
});
