/**
 * UTF-8 BOM parity (INV7). Windows editors and PowerShell 5 save files with a
 * leading U+FEFF. The browser hosts strip it (Blob.text(), TextDecoder), but
 * fs.readFile(p, 'utf8') keeps it — so `JSON.parse` of a BOM-prefixed
 * package.json threw on the CLI only, and its deps, frameworks and scripts
 * vanished from the CLI artifact (and from the CVE scan) while the browser saw
 * them. Every FactsFS must hand analyze the same text for the same bytes.
 *
 * NodeFS is checked here against the WHATWG decoder the browser hosts use.
 * MemoryFS (the GitHub path and fixtures) has the same check in its own
 * package (packages/fs-memory/test/bom.test.ts), FileListFS in fs-browser —
 * fs-node does not depend on either, so it does not import them.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as Spec from '@factstack/spec';
import { stripLeadingBom } from '@factstack/spec';
import { NodeFS } from '../src/index.js';

// Pass-through spy: the rule itself lives once, in @factstack/spec.
vi.mock('@factstack/spec', async (importOriginal) => {
  const orig = await importOriginal<typeof Spec>();
  return { ...orig, stripLeadingBom: vi.fn(orig.stripLeadingBom) };
});

/** U+FEFF, built from its code point so formatters can't turn it invisible. */
const BOM = String.fromCharCode(0xfeff);
const PKG = '{"name":"bom-app","dependencies":{"express":"^4.18.0"},"scripts":{"start":"node ."}}';
const BOM_BYTES = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PKG, 'utf8')]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-node-bom-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('readText strips a leading UTF-8 BOM on every host', () => {
  it('NodeFS returns the same text the browser decoders produce', async () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), BOM_BYTES);
    const browserText = new TextDecoder().decode(BOM_BYTES); // FSA Blob.text() / GitHub path
    const nodeText = await new NodeFS(tmp).readText('package.json');
    expect(nodeText).toBe(browserText);
    expect(nodeText).toBe(PKG);
    expect(JSON.parse(nodeText).dependencies).toEqual({ express: '^4.18.0' });
  });

  it('strips only ONE leading BOM and leaves an inner U+FEFF alone', async () => {
    fs.writeFileSync(path.join(tmp, 'twice.txt'), `${BOM}${BOM}a${BOM}b`, 'utf8');
    const bytes = fs.readFileSync(path.join(tmp, 'twice.txt'));
    expect(await new NodeFS(tmp).readText('twice.txt')).toBe(`${BOM}a${BOM}b`);
    expect(await new NodeFS(tmp).readText('twice.txt')).toBe(new TextDecoder().decode(bytes));
    // readFile (raw bytes, used for sizes) is untouched on every host.
    expect((await new NodeFS(tmp).readFile('package.json')).byteLength).toBe(BOM_BYTES.length);
  });

  it('delegates to the shared @factstack/spec rule instead of its own copy', async () => {
    fs.writeFileSync(path.join(tmp, 'one.txt'), BOM_BYTES);
    vi.mocked(stripLeadingBom).mockClear();
    await new NodeFS(tmp).readText('one.txt');
    expect(stripLeadingBom).toHaveBeenCalledWith(`${BOM}${PKG}`);
  });
});
