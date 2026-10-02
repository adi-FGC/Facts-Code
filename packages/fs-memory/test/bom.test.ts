/**
 * UTF-8 BOM parity (INV7). MemoryFS backs the browser GitHub scan and every
 * fixture, so it must hand analyze the text the WHATWG decoder (FSA
 * Blob.text(), TextDecoder) and NodeFS produce: one leading U+FEFF dropped,
 * nothing else touched. Isomorphic (C1): no node:* imports in this package,
 * tests included — the reference is TextDecoder over the same bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Spec from '@factstack/spec';
import { stripLeadingBom } from '@factstack/spec';
import { MemoryFS, memoryFS } from '../src/index.js';

// Pass-through spy: the rule itself lives once, in @factstack/spec.
vi.mock('@factstack/spec', async (importOriginal) => {
  const orig = await importOriginal<typeof Spec>();
  return { ...orig, stripLeadingBom: vi.fn(orig.stripLeadingBom) };
});

/** U+FEFF, built from its code point so formatters can't turn it invisible. */
const BOM = String.fromCharCode(0xfeff);
const PKG = '{"name":"bom-app","dependencies":{"express":"^4.18.0"}}';

/** What a browser host decodes for `text` saved as UTF-8. */
const decoded = (text: string): string => new TextDecoder().decode(new TextEncoder().encode(text));

describe('MemoryFS.readText strips a leading UTF-8 BOM like every other host', () => {
  it('returns the decoder text for a BOM-prefixed package.json', async () => {
    const mem = new MemoryFS({ 'package.json': BOM + PKG });
    const text = await mem.readText('package.json');
    expect(text).toBe(PKG);
    expect(text).toBe(decoded(BOM + PKG));
    expect(JSON.parse(text).dependencies).toEqual({ express: '^4.18.0' });
  });

  it('strips only ONE leading BOM and leaves an inner U+FEFF alone', async () => {
    const body = `${BOM}${BOM}a${BOM}b`;
    const fs = memoryFS({ 'twice.txt': body });
    expect(await fs.readText('twice.txt')).toBe(`${BOM}a${BOM}b`);
    expect(await fs.readText('twice.txt')).toBe(decoded(body));
  });

  it('keeps the raw bytes (sizes) and BOM-less text unchanged', async () => {
    const mem = new MemoryFS({ 'a.txt': `${BOM}x`, 'b.txt': 'plain' });
    expect((await mem.readFile('a.txt')).byteLength).toBe(4); // EF BB BF 78
    expect(await mem.readText('b.txt')).toBe('plain');
  });

  it('delegates to the shared @factstack/spec rule instead of its own copy', async () => {
    vi.mocked(stripLeadingBom).mockClear();
    await new MemoryFS({ 'a.txt': `${BOM}x` }).readText('a.txt');
    expect(stripLeadingBom).toHaveBeenCalledWith(`${BOM}x`);
  });
});
