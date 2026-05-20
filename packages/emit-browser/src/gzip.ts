/**
 * Browser-side gzip — replaces node:zlib for the bundle-size estimator
 * when the analyzer runs in a Worker / Chrome ext / web app.
 *
 * Uses the platform `CompressionStream` (Baseline 2023, present in every
 * browser shipping FSA — no polyfill needed). The Node-side counterpart
 * lives at @factstack/emit/src/gzip.ts; both export the same API except
 * the browser version is async (CompressionStream has no sync mode).
 *
 * Why we route through `Response`:
 *   The cleanest way to drain a ReadableStream into a buffer in the
 *   browser is `new Response(stream).arrayBuffer()`. It's documented,
 *   handles backpressure for us, and avoids the manual reader.read()
 *   loop. ~3 lines instead of 15.
 */

/**
 * `shouldGzip(ext)` is a pure predicate (regex over the extension). It
 * lives in @factstack/emit/gzip.ts next to the Node implementation, but
 * we re-implement it here rather than importing it because pulling that
 * file in would drag node:zlib types into the browser tier. Two lines
 * of duplication beats a Node-tier dep on the browser package.
 */
function shouldGzip(ext: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|html|css|scss|json)$/i.test(ext);
}

/**
 * Async because `CompressionStream` is a streaming API. The Node twin
 * is sync (zlib.gzipSync), so this is the one place the analyzer must
 * await when targeting the browser.
 */
export async function browserGzippedBytes(text: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  /* CompressionStream is a TransformStream<Uint8Array, Uint8Array>. We
     wrap the input bytes in a one-shot ReadableStream, pipe through gzip,
     drain via Response → arrayBuffer. */
  const stream = new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
  );
  const buf = await stream.arrayBuffer();
  return buf.byteLength;
}

/* Re-export the predicate so callers can do `if (shouldGzip(ext))` against
 * a single import path regardless of which gzip module they imported the
 * gzipper from. */
export { shouldGzip };
