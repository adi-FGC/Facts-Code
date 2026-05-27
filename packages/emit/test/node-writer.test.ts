import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileWriter } from '../src/node-writer.js';

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `factstack-node-writer-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
