import { gzipSync } from 'node:zlib';

/**
 * Compute gzipped byte count of text. Used for the bundle-size estimate
 * on JS/TS/HTML/CSS files. Lives in @factstack/emit (Node-only) because
 * node:zlib isn't available in the isomorphic zone.
 *
 * Browser analyzers in v0.4 can compute this via `CompressionStream`.
 */
export function gzippedBytes(text: string): number {
  return gzipSync(Buffer.from(text, 'utf8')).byteLength;
}

export function shouldGzip(ext: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|json)$/i.test(ext);
}
