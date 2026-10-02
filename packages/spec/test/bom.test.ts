/**
 * stripLeadingBom — the one BOM rule every host's readText calls (INV7):
 * NodeFS, MemoryFS and NodeFileWriter. It mirrors the WHATWG UTF-8 decoder
 * (FSA Blob.text(), TextDecoder): drop exactly one leading U+FEFF. The host
 * packages' bom tests pin each host against a real TextDecoder; this package
 * compiles without DOM/Node libs, so the expectations here are spelled out.
 */
import { describe, expect, it } from 'vitest';
import { stripLeadingBom } from '../src/index.js';

/** U+FEFF, built from its code point so formatters can't turn it invisible. */
const BOM = String.fromCharCode(0xfeff);

describe('stripLeadingBom', () => {
  it.each([
    ['empty', '', ''],
    ['no BOM', '{"a":1}', '{"a":1}'],
    ['one leading BOM', `${BOM}{"a":1}`, '{"a":1}'],
    ['two leading BOMs (only one goes)', `${BOM}${BOM}x`, `${BOM}x`],
    ['inner BOM only', `a${BOM}b`, `a${BOM}b`],
    ['a lone BOM', BOM, ''],
  ])('%s', (_label, text, want) => {
    expect(stripLeadingBom(text)).toBe(want);
  });
});
