import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Spec from '@factstack/spec';
import { stripLeadingBom } from '@factstack/spec';
import { NodeFileWriter } from '../src/node-writer.js';

// Pass-through spy: the BOM rule lives once, in @factstack/spec (INV7).
vi.mock('@factstack/spec', async (importOriginal) => {
  const orig = await importOriginal<typeof Spec>();
  return { ...orig, stripLeadingBom: vi.fn(orig.stripLeadingBom) };
});

let tmp: string;

beforeEach(() => {
  tmp = join(
    tmpdir(),
    `factstack-node-writer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Temp cleanup should never hide the actual test result.
  }
});

describe('NodeFileWriter — cross-platform filesystem targets', () => {
  it('writes root artifact files under .facts for project paths with spaces', async () => {
    const projectRoot = join(tmp, 'Project Root (Windows macOS Linux)');
    mkdirSync(projectRoot, { recursive: true });
    const writer = new NodeFileWriter(projectRoot);

    const bytes = await writer.writeText('agent.json', '{"ok":true}\n');

    const artifactPath = join(projectRoot, '.facts', 'agent.json');
    expect(bytes).toBe(Buffer.byteLength('{"ok":true}\n'));
    expect(existsSync(artifactPath)).toBe(true);
    expect(readFileSync(artifactPath, 'utf8')).toBe('{"ok":true}\n');
    expect(existsSync(join(projectRoot, 'agent.json'))).toBe(false);
  });

  it('creates nested artifact directories from POSIX writer paths', async () => {
    const writer = new NodeFileWriter(tmp);

    await writer.writeText('snapshots/2026-05-25T00-00-00-000Z.json', '{}');

    const snapshotPath = join(tmp, '.facts', 'snapshots', '2026-05-25T00-00-00-000Z.json');
    expect(existsSync(snapshotPath)).toBe(true);
    expect(await writer.listKeys('snapshots')).toEqual(['2026-05-25T00-00-00-000Z.json']);
  });

  it('lists missing directories as empty and removes entries idempotently', async () => {
    const writer = new NodeFileWriter(tmp);

    expect(await writer.listKeys('snapshots')).toEqual([]);
    await writer.writeText('snapshots/a.json', '{}');
    await writer.removeEntry('snapshots', 'a.json');
    await writer.removeEntry('snapshots', 'a.json');

    expect(await writer.listKeys('snapshots')).toEqual([]);
  });
});

describe('NodeFileWriter.readText (lets buildSkillsTo refresh FACTS-managed files)', () => {
  it('reads back a file, and returns null where there is no file', async () => {
    // Root-scoped, like `export-skills` / `setup-agents` use it.
    const writer = new NodeFileWriter(tmp, '');
    await writer.writeText('.github/copilot-instructions.md', '<!-- factstack:managed -->\nhi\n');
    expect(await writer.readText('.github/copilot-instructions.md')).toBe(
      '<!-- factstack:managed -->\nhi\n',
    );
    expect(await writer.readText('.cursorrules')).toBeNull(); // missing file
    expect(await writer.readText('nope/.cursorrules')).toBeNull(); // missing dir
    expect(await writer.readText('.github')).toBeNull(); // a directory, not a file
  });

  it('drops one leading BOM, like the browser writer (INV7)', async () => {
    const writer = new NodeFileWriter(tmp, '');
    const bom = String.fromCharCode(0xfeff);
    await writer.writeText('.cursorrules', `${bom}# rules\n`);
    vi.mocked(stripLeadingBom).mockClear();
    expect(await writer.readText('.cursorrules')).toBe('# rules\n');
    // The shared @factstack/spec rule, not a local copy.
    expect(stripLeadingBom).toHaveBeenCalledWith(`${bom}# rules\n`);
  });

  it('still refuses a path that escapes the writer root', async () => {
    const writer = new NodeFileWriter(join(tmp, 'project'));
    await expect(writer.readText('../../outside.txt')).rejects.toThrow(/path escape/);
  });
});

describe('NodeFileWriter — atomic replace (FileWriter contract)', () => {
  it('a concurrent reader only ever sees a complete old or new file, never a torn one', async () => {
    const writer = new NodeFileWriter(tmp);
    const target = join(tmp, '.facts', 'agent.json');
    const body = (n: number): string =>
      JSON.stringify({ n, pad: 'x'.repeat(2 * 1024 * 1024 + n) }, null, 2);
    await writer.writeText('agent.json', body(0));

    let done = false;
    let reads = 0;
    const torn: number[] = [];
    /* A polling reader, like the MCP server or the hook re-reading the
       artifact. (Short gaps between reads: on Windows a rename cannot
       replace a file while ANY handle is open, so the writer retries into
       the gaps — a reader that never closes the file would stall it.) */
    const reader = (async () => {
      while (!done) {
        const text = await readFile(target, 'utf8');
        reads++;
        try {
          JSON.parse(text);
        } catch {
          torn.push(text.length);
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    try {
      for (let n = 1; n <= 15; n++) await writer.writeText('agent.json', body(n));
    } finally {
      done = true;
      await reader;
    }

    expect(reads).toBeGreaterThan(0);
    expect(torn).toEqual([]); // restoreVulnScan used to parse-fail on these and drop the CVE scan
    expect(JSON.parse(readFileSync(target, 'utf8')).n).toBe(15);
    // No temp files left behind next to the artifact.
    expect(await writer.listKeys('')).toEqual(['agent.json']);
  }, 30_000);
});
